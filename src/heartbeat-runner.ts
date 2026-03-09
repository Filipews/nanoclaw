import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  HEARTBEAT_INTERVAL_MINUTES,
  HEARTBEAT_TIMEZONE,
  HEARTBEAT_TRIAGE_MODEL,
  HEARTBEAT_ESCALATION_MODEL,
} from './config.js';
import { ContainerOutput, runContainerAgent } from './container-runner.js';
import { getDb, logHeartbeatResult } from './db.js';
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
import { HEARTBEAT_CHECKS } from './heartbeat-checks.js';

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

// Re-export checks so Telegram /heartbeat_status and tests can import from one place
export { HEARTBEAT_CHECKS as DEFAULT_CHECKS };

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
      overdueRatio = minutesSince / check.cadence;
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
      logger.warn({ text: text.slice(-300) }, 'No TRIAGE_RESULT found in agent output');
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
    logger.warn({ after: after.slice(0, 200) }, 'Failed to parse TRIAGE_RESULT JSON');
    return null;
  }

  // Use whichever appears later in the text (last occurrence wins in case of retries)
  if (okIdx > alertIdx) {
    return { status: 'HEARTBEAT_OK', checkId };
  }

  // Parse HEARTBEAT_ALERT block
  const block = text.slice(alertIdx);
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);

  let actionNeeded: TriageResult['actionNeeded'];
  let summary: string | undefined;
  let priority: TriageResult['priority'];

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
      if (val === 'low' || val === 'medium' || val === 'high' || val === 'critical') {
        priority = val;
      }
    }
  }

  return {
    status: 'HEARTBEAT_ALERT',
    checkId,
    summary,
    priority,
    actionNeeded,
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
    closeTimer = setTimeout(() => deps.queue.closeStdin(jid), CLOSE_DELAY_MS);
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

async function runEscalation(
  check: HeartbeatCheck,
  triage: TriageResult,
  group: RegisteredGroup,
  jid: string,
  deps: HeartbeatDependencies,
): Promise<void> {
  const CLOSE_DELAY_MS = 10_000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const escalationPrompt = `[HEARTBEAT ESCALATION: ${check.name}]

Trigger: ${check.escalationTrigger}
Triage summary: ${triage.summary || 'No summary provided.'}
Priority: ${triage.priority || 'unknown'}

Investigate the issue described above and take appropriate action using available tools.
Report back what you found and what action you took.`;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: escalationPrompt,
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
        if (streamedOutput.result && !closeTimer) {
          closeTimer = setTimeout(
            () => deps.queue.closeStdin(jid),
            CLOSE_DELAY_MS,
          );
        }
      },
    );
    if (closeTimer) clearTimeout(closeTimer);
    // Forward escalation result to the user
    if (output.result) {
      await deps.sendMessage(jid, `[${check.name} escalation]\n${output.result}`).catch((err) =>
        logger.warn({ err }, 'Failed to send escalation result'),
      );
    }
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    logger.error({ err, checkId: check.id }, 'Escalation failed');
  }
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

  const check = pickNextCheck(HEARTBEAT_CHECKS, state, now, HEARTBEAT_TIMEZONE);

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

  const { triage, error } = await runSingleCheck(check, group, jid, deps);

  state.lastTick = now.toISOString();

  if (error) {
    logger.error({ checkId: check.id, error }, 'Heartbeat check error');
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

  const willEscalate =
    isAlert &&
    triage != null &&
    (triage.actionNeeded === 'escalate_to_agent' ||
      triage.actionNeeded === 'escalate_to_browser');

  // Log to heartbeat_result_log
  try {
    logHeartbeatResult(getDb(), {
      checkId: check.id,
      result: isAlert ? 'HEARTBEAT_ALERT' : 'HEARTBEAT_OK',
      summary,
      escalated: willEscalate,
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to log heartbeat result to DB');
  }

  if (isAlert) {
    logger.info({ checkId: check.id, summary }, 'Heartbeat ALERT');

    // Send notification
    const notifyText = `⚠️ [${check.name}]${summary ? ': ' + summary : ''}`;
    await deps
      .sendMessage(jid, notifyText)
      .catch((err) =>
        logger.warn(
          { err, jid },
          'Heartbeat: failed to send alert notification',
        ),
      );

    // Escalation
    if (willEscalate && triage) {
      await runEscalation(check, triage, group, jid, deps);
    }

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
