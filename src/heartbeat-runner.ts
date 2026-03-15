import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  HEARTBEAT_CHECKS_DIR,
  HEARTBEAT_INTERVAL_MINUTES,
  HEARTBEAT_TIMEZONE,
  HEARTBEAT_TRIAGE_MODEL,
  HEARTBEAT_ESCALATION_MODEL,
} from './config.js';
import { ContainerOutput, runContainerAgent } from './container-runner.js';
import { getDb, getDailyHeartbeatStats, logHeartbeatResult } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
import {
  CheckState,
  HeartbeatCheck,
  HeartbeatState,
  HeartbeatTickResult,
  TriageResult,
} from './heartbeat-types.js';
import { loadHeartbeatChecks } from './heartbeat-loader.js';

export interface HeartbeatDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

export interface HeartbeatRunner {
  runTick: () => Promise<HeartbeatTickResult>;
}

const STATE_PATH = path.join(GROUPS_DIR, 'personal', 'heartbeat-state.json');

// When a check errors (e.g. MCP unavailable), retry after this many minutes
// rather than the full cadence. This prevents a failing check from either
// monopolising ticks (if never updated) or waiting a full hour to retry.
const ERROR_BACKOFF_MINUTES = 5;

// Re-export checks so Telegram /heartbeat_status and tests can import from one place
export function getHeartbeatChecks(): HeartbeatCheck[] {
  return loadHeartbeatChecks(HEARTBEAT_CHECKS_DIR);
}

function readState(): HeartbeatState {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as HeartbeatState;
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read heartbeat state, using empty state');
  }
  return { checks: {}, lastTick: '' };
}

function writeState(state: HeartbeatState): void {
  const tmp = STATE_PATH + '.tmp';
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, STATE_PATH);
  } catch (err) {
    logger.warn({ err }, 'Failed to write heartbeat state');
  }
}

function getLocalHHMM(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  // Normalize "24:xx" (midnight edge case in some locales) to "00:xx"
  const h = hour === '24' ? '00' : hour;
  return `${h}:${minute}`;
}

function isWithinActiveWindow(
  check: HeartbeatCheck,
  now: Date,
  timezone: string,
): boolean {
  if (!check.activeWindow) return true;
  const current = getLocalHHMM(now, timezone);
  const { start, end } = check.activeWindow;
  if (start <= end) {
    return current >= start && current <= end;
  }
  // Wraps midnight
  return current >= start || current <= end;
}

export function pickNextCheck(
  checks: HeartbeatCheck[],
  state: HeartbeatState,
  now: Date,
  timezone: string,
): HeartbeatCheck | null {
  const nowMs = now.getTime();

  const candidates = checks.filter(
    (c) => c.enabled && isWithinActiveWindow(c, now, timezone),
  );

  let best: HeartbeatCheck | null = null;
  let bestScore = -Infinity;

  for (const check of candidates) {
    const cs: CheckState | undefined = state.checks[check.id];
    let overdueRatio: number;

    if (!cs) {
      overdueRatio = Infinity;
    } else {
      const lastRunMs = new Date(cs.lastRun).getTime();
      const minutesSince = (nowMs - lastRunMs) / 60_000;
      // Use a short backoff for errored checks so they retry quickly without
      // monopolising the tick queue; once they recover, full cadence resumes.
      const effectiveCadence =
        cs.lastResult === 'error' ? ERROR_BACKOFF_MINUTES : check.cadence;
      overdueRatio = minutesSince / effectiveCadence;
    }

    // Only consider checks that are due (overdueRatio >= 1) or never run
    if (overdueRatio !== Infinity && overdueRatio < 1) continue;

    const score =
      overdueRatio === Infinity ? Infinity : overdueRatio * check.priority;

    if (score > bestScore) {
      bestScore = score;
      best = check;
    }
  }

  return best;
}

/**
 * Parse the triage result from agent output.
 *
 * Supported plain-text format (preferred, Haiku-friendly):
 *   HEARTBEAT_OK
 * or:
 *   HEARTBEAT_ALERT
 *   action: notify_only | escalate_to_agent | escalate_to_browser
 *   summary: <text>
 *   priority: low | medium | high | critical
 *
 * Also accepts legacy JSON format for backward compatibility:
 *   TRIAGE_RESULT:
 *   {"status":"HEARTBEAT_OK",...}
 */
function parseTriageResult(text: string, checkId: string): TriageResult | null {
  // Plain-text format: scan for HEARTBEAT_OK or HEARTBEAT_ALERT
  const okIdx = text.lastIndexOf('HEARTBEAT_OK');
  const alertIdx = text.lastIndexOf('HEARTBEAT_ALERT');

  if (okIdx === -1 && alertIdx === -1) {
    // Fall back to legacy JSON format
    const marker = 'TRIAGE_RESULT:';
    const markerIdx = text.indexOf(marker);
    if (markerIdx === -1) {
      logger.warn(
        { text: text.slice(-300) },
        'No TRIAGE_RESULT found in agent output',
      );
      return null;
    }
    const after = text.slice(markerIdx + marker.length).trim();
    const lines = after.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        return JSON.parse(line) as TriageResult;
      } catch {
        continue;
      }
    }
    logger.warn(
      { after: after.slice(0, 200) },
      'Failed to parse TRIAGE_RESULT JSON',
    );
    return null;
  }

  // Use whichever appears later in the text (last occurrence wins in case of retries)
  if (okIdx > alertIdx) {
    return { status: 'HEARTBEAT_OK', checkId };
  }

  // Parse HEARTBEAT_ALERT block
  const block = text.slice(alertIdx);
  const lines = block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let actionNeeded: TriageResult['actionNeeded'];
  let summary: string | undefined;
  let priority: TriageResult['priority'];
  let detailsRaw: string | undefined;

  for (const line of lines.slice(1)) {
    if (line.startsWith('action:')) {
      const val = line.slice('action:'.length).trim();
      if (
        val === 'notify_only' ||
        val === 'escalate_to_agent' ||
        val === 'escalate_to_browser'
      ) {
        actionNeeded = val;
      }
    } else if (line.startsWith('summary:')) {
      summary = line.slice('summary:'.length).trim();
    } else if (line.startsWith('priority:')) {
      const val = line.slice('priority:'.length).trim();
      if (
        val === 'low' ||
        val === 'medium' ||
        val === 'high' ||
        val === 'critical'
      ) {
        priority = val;
      }
    } else if (line.startsWith('details:')) {
      detailsRaw = line.slice('details:'.length).trim();
    }
  }

  return {
    status: 'HEARTBEAT_ALERT',
    checkId,
    summary,
    priority,
    actionNeeded,
    details: detailsRaw ? { raw: detailsRaw } : undefined,
  };
}

async function runSingleCheck(
  check: HeartbeatCheck,
  group: RegisteredGroup,
  jid: string,
  deps: HeartbeatDependencies,
): Promise<{ triage: TriageResult | null; text: string; error?: string }> {
  const CLOSE_DELAY_MS = 10_000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let resultText = '';

  const scheduleClose = () => {
    if (closeTimer) return;
    closeTimer = setTimeout(() => {
      const inputDir = path.join(DATA_DIR, 'ipc', group.folder, 'input');
      try {
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, '_close'), '');
      } catch (err) {
        logger.warn(
          { err, checkId: check.id },
          'Heartbeat: failed to write close sentinel',
        );
      }
    }, CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: check.prompt,
        sessionId: undefined,
        groupFolder: group.folder,
        chatJid: jid,
        isMain: false,
        isScheduledTask: true,
        checkId: check.id,
        source: 'heartbeat_triage',
        modelOverride: HEARTBEAT_TRIAGE_MODEL,
        maxTurns: 5,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(jid, proc, containerName, group.folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          resultText = streamedOutput.result;
          scheduleClose();
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    const text = resultText || output.result || '';
    if (output.status === 'error') {
      return { triage: null, text, error: output.error || 'Container error' };
    }
    return { triage: parseTriageResult(text, check.id), text };
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    const error = err instanceof Error ? err.message : String(err);
    return { triage: null, text: '', error };
  }
}

/** Build a check-specific escalation prompt from triage result. */
function buildEscalationPrompt(
  check: HeartbeatCheck,
  triage: TriageResult,
  useBrowser: boolean,
): string {
  const details =
    (triage.details?.raw as string | undefined) ?? triage.summary ?? '';
  const priority = triage.priority ?? 'unknown';
  const browserHint = useBrowser
    ? '\nYou have browser automation available via the Bash tool (Playwright/Chromium). Use it if needed to complete web-based tasks.'
    : '';

  // Use the check's escalation prompt if available; fall back to a generic task line
  const rawEscalation = check.escalationPrompt
    ? check.escalationPrompt.replace(
        /\{\{details\}\}/g,
        details || `(see ${check.name})`,
      )
    : `Investigate and resolve the issue described in the triage summary. Details: ${details || '(no details)'}`;

  return `[HEARTBEAT ESCALATION: ${check.name}]
Priority: ${priority}
Triage summary: ${triage.summary || 'No summary provided.'}
${browserHint}

Your task: ${rawEscalation}

Use all available tools to complete this task. When done, provide a concise summary of:
1. What you found
2. What action you took
3. Any follow-up needed`;
}

/**
 * Returns true if the next scheduled run of this check would fall outside its
 * active window — i.e. this is the last run of the day.
 */
function isLastRunOfDay(
  check: HeartbeatCheck,
  now: Date,
  timezone: string,
): boolean {
  if (!check.activeWindow) return false;
  const hhmm = getLocalHHMM(now, timezone);
  const [h, m] = hhmm.split(':').map(Number);
  const currentMinutes = h * 60 + m;
  const [endH, endM] = check.activeWindow.end.split(':').map(Number);
  const endMinutes = endH * 60 + endM;
  return currentMinutes + check.cadence >= endMinutes;
}

/**
 * Spawn a short-lived container that appends the day's heartbeat summary
 * to today's Obsidian daily log. Called after the last daily_files run.
 */
async function sendEndOfDaySummary(
  now: Date,
  group: RegisteredGroup,
  jid: string,
  deps: HeartbeatDependencies,
): Promise<void> {
  const dateStr = now.toISOString().slice(0, 10);
  let stats: ReturnType<typeof getDailyHeartbeatStats>;
  try {
    stats = getDailyHeartbeatStats(getDb(), dateStr);
  } catch (err) {
    logger.warn({ err }, 'Heartbeat: failed to get daily stats for summary');
    return;
  }

  const alertLines =
    Object.entries(stats.alertsByCheck)
      .map(([id, n]) => `  - ${id}: ${n} alert${n !== 1 ? 's' : ''}`)
      .join('\n') || '  - (none)';

  const summaryBlock = [
    '## Heartbeat Summary',
    '',
    `- ${stats.totalTicks} ticks today, ${stats.totalAlerts} alert${stats.totalAlerts !== 1 ? 's' : ''} surfaced`,
    `- By check:\n${alertLines}`,
    `- Estimated cost: $${stats.totalCostUsd.toFixed(4)}`,
  ].join('\n');

  const prompt = `[HEARTBEAT END-OF-DAY SUMMARY]

Append the following section verbatim to today's daily log at:
/workspace/obsidian/Daily/${dateStr}.md

If the file does not exist, create it with just this content. Do NOT modify any existing content.

${summaryBlock}

After writing, reply with exactly: "Summary appended to ${dateStr}.md."`;

  const CLOSE_DELAY_MS = 15_000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId: undefined,
        groupFolder: group.folder,
        chatJid: jid,
        isMain: false,
        isScheduledTask: true,
        source: 'heartbeat_summary',
        modelOverride: HEARTBEAT_TRIAGE_MODEL,
        maxTurns: 3,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(jid, proc, containerName, group.folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result && !closeTimer) {
          closeTimer = setTimeout(() => {
            const inputDir = path.join(DATA_DIR, 'ipc', group.folder, 'input');
            try {
              fs.mkdirSync(inputDir, { recursive: true });
              fs.writeFileSync(path.join(inputDir, '_close'), '');
            } catch (err) {
              logger.warn({ err }, 'Heartbeat: failed to write close sentinel');
            }
          }, CLOSE_DELAY_MS);
        }
      },
    );
    if (closeTimer) clearTimeout(closeTimer);
    logger.info(
      { dateStr, stats },
      'Heartbeat: end-of-day summary written to Obsidian',
    );
    const result = output.result || '';
    if (result) {
      await deps
        .sendMessage(jid, `📊 ${result}`)
        .catch((err) =>
          logger.warn(
            { err },
            'Heartbeat: failed to send summary confirmation',
          ),
        );
    }
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    logger.warn({ err }, 'Heartbeat: failed to write end-of-day summary');
  }
}

/** Spawn a Sonnet container to perform real work based on triage alert. */
async function escalateToAgent(
  check: HeartbeatCheck,
  triage: TriageResult,
  group: RegisteredGroup,
  jid: string,
  deps: HeartbeatDependencies,
): Promise<void> {
  const CLOSE_DELAY_MS = 30_000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let resultText = '';

  const prompt = buildEscalationPrompt(check, triage, false);

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId: undefined,
        groupFolder: group.folder,
        chatJid: jid,
        isMain: false,
        isScheduledTask: true,
        checkId: check.id,
        source: 'heartbeat_escalation',
        modelOverride: HEARTBEAT_ESCALATION_MODEL,
        maxTurns: 30,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(jid, proc, containerName, group.folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          resultText = streamedOutput.result;
          if (!closeTimer) {
            closeTimer = setTimeout(() => {
              const inputDir = path.join(
                DATA_DIR,
                'ipc',
                group.folder,
                'input',
              );
              try {
                fs.mkdirSync(inputDir, { recursive: true });
                fs.writeFileSync(path.join(inputDir, '_close'), '');
              } catch (err) {
                logger.warn(
                  { err, checkId: check.id },
                  'Heartbeat: failed to write close sentinel',
                );
              }
            }, CLOSE_DELAY_MS);
          }
        }
      },
    );
    if (closeTimer) clearTimeout(closeTimer);

    const summary = resultText || output.result || '';
    if (summary) {
      logger.info(
        { checkId: check.id, summary: summary.slice(0, 200) },
        'Heartbeat: escalation completed (summary suppressed)',
      );
    }
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    logger.error({ err, checkId: check.id }, 'escalateToAgent failed');
  }
}

/** Same as escalateToAgent but with explicit browser-use hint in the prompt. */
async function escalateToBrowser(
  check: HeartbeatCheck,
  triage: TriageResult,
  group: RegisteredGroup,
  jid: string,
  deps: HeartbeatDependencies,
): Promise<void> {
  const CLOSE_DELAY_MS = 30_000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let resultText = '';

  const prompt = buildEscalationPrompt(check, triage, true);

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId: undefined,
        groupFolder: group.folder,
        chatJid: jid,
        isMain: false,
        isScheduledTask: true,
        checkId: check.id,
        source: 'heartbeat_escalation',
        modelOverride: HEARTBEAT_ESCALATION_MODEL,
        maxTurns: 30,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(jid, proc, containerName, group.folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          resultText = streamedOutput.result;
          if (!closeTimer) {
            closeTimer = setTimeout(() => {
              const inputDir = path.join(
                DATA_DIR,
                'ipc',
                group.folder,
                'input',
              );
              try {
                fs.mkdirSync(inputDir, { recursive: true });
                fs.writeFileSync(path.join(inputDir, '_close'), '');
              } catch (err) {
                logger.warn(
                  { err, checkId: check.id },
                  'Heartbeat: failed to write close sentinel',
                );
              }
            }, CLOSE_DELAY_MS);
          }
        }
      },
    );
    if (closeTimer) clearTimeout(closeTimer);

    const summary = resultText || output.result || '';
    if (summary) {
      logger.info(
        { checkId: check.id, summary: summary.slice(0, 200) },
        'Heartbeat: browser escalation completed (summary suppressed)',
      );
    }
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    logger.error({ err, checkId: check.id }, 'escalateToBrowser failed');
  }
}

/**
 * Route a triage alert to the appropriate action:
 *   ok / notify_only → notify via Telegram, done
 *   escalate_to_agent → spawn Sonnet container to do real work
 *   escalate_to_browser → spawn Sonnet + browser container
 */
async function processTriageResult(
  check: HeartbeatCheck,
  triage: TriageResult,
  group: RegisteredGroup,
  jid: string,
  deps: HeartbeatDependencies,
): Promise<boolean> {
  // returns true if escalated
  if (triage.status === 'HEARTBEAT_OK') return false;

  const action = triage.actionNeeded ?? 'notify_only';
  const notifyText = `⚠️ [${check.name}]${triage.summary ? ': ' + triage.summary : ''}`;

  // Always notify
  await deps
    .sendMessage(jid, notifyText)
    .catch((err) =>
      logger.warn({ err, jid }, 'Heartbeat: failed to send alert notification'),
    );

  if (action === 'escalate_to_agent') {
    logger.info({ checkId: check.id }, 'Heartbeat: escalating to agent');
    await escalateToAgent(check, triage, group, jid, deps);
    return true;
  }

  if (action === 'escalate_to_browser') {
    logger.info(
      { checkId: check.id },
      'Heartbeat: escalating to browser agent',
    );
    await escalateToBrowser(check, triage, group, jid, deps);
    return true;
  }

  // notify_only — already notified above
  return false;
}

async function tick(deps: HeartbeatDependencies): Promise<HeartbeatTickResult> {
  const groups = deps.registeredGroups();

  // Find the personal/telegram_eve group
  const groupEntry = Object.entries(groups).find(
    ([, g]) => g.folder === 'personal' || g.folder === 'telegram_eve',
  );

  if (!groupEntry) {
    logger.debug(
      'Heartbeat: no personal/telegram_eve group found, skipping tick',
    );
    return { checkId: null, checkName: null, status: 'skipped' };
  }

  const [jid, group] = groupEntry;
  const now = new Date();
  const state = readState();

  const checks = loadHeartbeatChecks(HEARTBEAT_CHECKS_DIR);
  const check = pickNextCheck(checks, state, now, HEARTBEAT_TIMEZONE);

  if (!check) {
    logger.debug('Heartbeat: no check due this tick');
    state.lastTick = now.toISOString();
    writeState(state);
    return { checkId: null, checkName: null, status: 'skipped' };
  }

  logger.info(
    { checkId: check.id, checkName: check.name },
    'Heartbeat: running check',
  );

  // Write currentRun BEFORE launching the container so /heartbeat_status can
  // show that something is in progress rather than appearing idle.
  state.currentRun = {
    checkId: check.id,
    checkName: check.name,
    startedAt: now.toISOString(),
  };
  writeState(state);

  const { triage, error } = await runSingleCheck(check, group, jid, deps);

  // Clear the in-progress marker
  state.currentRun = undefined;
  state.lastTick = now.toISOString();

  if (error) {
    logger.error({ checkId: check.id, error }, 'Heartbeat check error');
    // Record the error so pickNextCheck can apply the short ERROR_BACKOFF_MINUTES
    // cadence instead of retrying immediately (which would monopolise all ticks)
    // or waiting the full cadence (which would slow recovery once MCP comes back).
    const prev = state.checks[check.id];
    state.checks[check.id] = {
      lastRun: now.toISOString(),
      lastResult: 'error',
      lastSummary: error.slice(0, 200),
      consecutiveOks: 0,
    };
    void prev;
    writeState(state);
    return {
      checkId: check.id,
      checkName: check.name,
      status: 'error',
      summary: error,
    };
  }

  const isAlert = triage?.status === 'HEARTBEAT_ALERT';
  const summary = triage?.summary;

  // Update state
  const prev = state.checks[check.id];
  state.checks[check.id] = {
    lastRun: now.toISOString(),
    lastResult: isAlert ? 'alert' : 'ok',
    lastSummary: summary,
    consecutiveOks: isAlert ? 0 : (prev?.consecutiveOks ?? 0) + 1,
  };
  writeState(state);

  // Log to heartbeat_result_log (before escalation so it's recorded even if escalation fails)
  let escalated = false;
  try {
    logHeartbeatResult(getDb(), {
      checkId: check.id,
      result: isAlert ? 'HEARTBEAT_ALERT' : 'HEARTBEAT_OK',
      summary,
      escalated: false, // updated below if escalation actually runs
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to log heartbeat result to DB');
  }

  if (isAlert && triage) {
    // Suppress drive-inbox alerts when the inbox is actually empty
    // (triage LLM sometimes returns ALERT instead of OK for empty inbox)
    const driveEmptyPattern = /drive inbox is empty|nothing to file/i;
    if (check.id === 'drive-inbox' && driveEmptyPattern.test(summary ?? '')) {
      logger.info(
        { checkId: check.id, summary },
        'Heartbeat: suppressed drive-inbox empty alert',
      );
      // Correct the state to 'ok' since the inbox is actually empty
      state.checks[check.id]!.lastResult = 'ok';
      state.checks[check.id]!.consecutiveOks =
        (state.checks[check.id]!.consecutiveOks ?? 0) + 1;
      writeState(state);
    } else {
      logger.info({ checkId: check.id, summary }, 'Heartbeat ALERT');
      escalated = await processTriageResult(check, triage, group, jid, deps);
    }
  }

  void escalated; // used only for future DB update if needed

  // After the last daily_files run of the day, append a summary to Obsidian
  if (
    check.id === 'daily-files' &&
    isLastRunOfDay(check, now, HEARTBEAT_TIMEZONE)
  ) {
    logger.info('Heartbeat: writing end-of-day summary to Obsidian');
    await sendEndOfDaySummary(now, group, jid, deps);
  }

  if (isAlert) {
    return {
      checkId: check.id,
      checkName: check.name,
      status: 'alert',
      summary,
    };
  }

  logger.info({ checkId: check.id }, 'Heartbeat OK');
  return { checkId: check.id, checkName: check.name, status: 'ok', summary };
}

let running = false;

export function startHeartbeatRunner(
  deps: HeartbeatDependencies,
): HeartbeatRunner {
  if (running) return { runTick: () => tick(deps) };
  running = true;
  logger.info(
    { intervalMinutes: HEARTBEAT_INTERVAL_MINUTES },
    'Heartbeat runner started',
  );

  const loop = async () => {
    try {
      await tick(deps);
    } catch (err) {
      logger.error({ err }, 'Heartbeat error');
    }
    setTimeout(loop, HEARTBEAT_INTERVAL_MINUTES * 60_000);
  };

  loop();
  return { runTick: () => tick(deps) };
}

/** @internal - exported for use by Telegram /heartbeat_status command */
export { readState as readHeartbeatState };

/** @internal - for tests only. */
export function _resetHeartbeatRunnerForTests(): void {
  running = false;
}
