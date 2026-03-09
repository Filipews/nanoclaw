import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  HEARTBEAT_INTERVAL_MINUTES,
  HEARTBEAT_TIMEZONE,
} from './config.js';
import { ContainerOutput, runContainerAgent } from './container-runner.js';
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

export const DEFAULT_CHECKS: HeartbeatCheck[] = [
  {
    id: 'gmail-inbox',
    name: 'Gmail Inbox',
    cadence: 30,
    activeWindow: { start: '08:00', end: '20:00' },
    priority: 10,
    enabled: true,
    prompt: `Check Gmail inbox for urgent or important emails that need attention.
Scan for anything flagged urgent, from important senders, or time-sensitive.
Summarize any action items briefly.
When done, output on a new line exactly:
TRIAGE_RESULT:
{"status":"HEARTBEAT_OK","checkId":"gmail-inbox","summary":"..."}
If there is something urgent requiring attention, use HEARTBEAT_ALERT and set actionNeeded accordingly.
Do not wrap the JSON in a code block.`,
    escalationTrigger: 'urgent email found',
  },
  {
    id: 'calendar',
    name: 'Calendar',
    cadence: 60,
    activeWindow: { start: '07:00', end: '22:00' },
    priority: 9,
    enabled: true,
    prompt: `Check upcoming calendar events in the next 48 hours.
Look for conflicts, imminent events (within 1 hour), and preparation needed.
When done, output on a new line exactly:
TRIAGE_RESULT:
{"status":"HEARTBEAT_OK","checkId":"calendar","summary":"..."}
If there is a conflict or imminent event, use HEARTBEAT_ALERT and set actionNeeded accordingly.
Do not wrap the JSON in a code block.`,
    escalationTrigger: 'event conflict or imminent event',
  },
  {
    id: 'needs-reply',
    name: 'Needs Reply',
    cadence: 240,
    activeWindow: { start: '10:00', end: '19:00' },
    priority: 8,
    enabled: true,
    prompt: `Check for emails or messages awaiting a reply for more than 4 hours.
Look through Gmail sent/inbox for threads where a reply is expected but not yet sent.
When done, output on a new line exactly:
TRIAGE_RESULT:
{"status":"HEARTBEAT_OK","checkId":"needs-reply","summary":"..."}
If there are replies overdue more than 8 hours, use HEARTBEAT_ALERT and set actionNeeded accordingly.
Do not wrap the JSON in a code block.`,
    escalationTrigger: 'reply overdue > 8h',
  },
  {
    id: 'tasks',
    name: 'Tasks',
    cadence: 60,
    activeWindow: { start: '08:00', end: '21:00' },
    priority: 7,
    enabled: true,
    prompt: `Scan /workspace/obsidian/Eve/Inbox/ and tasks for overdue items.
Check Tasks inbox.md and any active task lists for overdue or blocked tasks.
When done, output on a new line exactly:
TRIAGE_RESULT:
{"status":"HEARTBEAT_OK","checkId":"tasks","summary":"..."}
If there are overdue tasks, use HEARTBEAT_ALERT and set actionNeeded accordingly.
Do not wrap the JSON in a code block.`,
    escalationTrigger: 'overdue task found',
  },
  {
    id: 'prices',
    name: 'Prices',
    cadence: 1440,
    activeWindow: { start: '07:00', end: '08:00' },
    priority: 3,
    enabled: true,
    prompt: `Run the Watch List price check per the Price Research skill (if available).
Check current prices against any tracked targets in /workspace/group/ or /workspace/obsidian/.
When done, output on a new line exactly:
TRIAGE_RESULT:
{"status":"HEARTBEAT_OK","checkId":"prices","summary":"..."}
If any price target is met, use HEARTBEAT_ALERT and set actionNeeded accordingly.
Do not wrap the JSON in a code block.`,
    escalationTrigger: 'price target met',
  },
  {
    id: 'daily-files',
    name: 'Daily Files',
    cadence: 480,
    activeWindow: { start: '08:00', end: '22:00' },
    priority: 2,
    enabled: true,
    prompt: `Check /workspace/obsidian/Eve/Inbox/ for new unprocessed files.
List any new documents, PDFs, or files that have not been processed yet.
When done, output on a new line exactly:
TRIAGE_RESULT:
{"status":"HEARTBEAT_OK","checkId":"daily-files","summary":"..."}
If new unprocessed files are found, use HEARTBEAT_ALERT and set actionNeeded accordingly.
Do not wrap the JSON in a code block.`,
    escalationTrigger: 'new unprocessed file found',
  },
  {
    id: 'vault-health',
    name: 'Vault Health',
    cadence: 10080,
    activeWindow: { start: '09:00', end: '10:00' },
    priority: 1,
    enabled: true,
    prompt: `Verify Obsidian vault structure and ledger continuity.
Check that daily notes are present, ledger entries are consistent, and no broken links in key files.
When done, output on a new line exactly:
TRIAGE_RESULT:
{"status":"HEARTBEAT_OK","checkId":"vault-health","summary":"..."}
If there is a vault inconsistency, use HEARTBEAT_ALERT and set actionNeeded accordingly.
Do not wrap the JSON in a code block.`,
    escalationTrigger: 'vault inconsistency found',
  },
];

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

function parseTriageResult(text: string): TriageResult | null {
  const marker = 'TRIAGE_RESULT:';
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  const after = text.slice(idx + marker.length).trim();
  const firstLine = after.split('\n')[0].trim();
  try {
    return JSON.parse(firstLine) as TriageResult;
  } catch {
    // Try the second line in case there's a blank line between marker and JSON
    const lines = after.split('\n').filter((l) => l.trim());
    if (lines.length > 0) {
      try {
        return JSON.parse(lines[0]) as TriageResult;
      } catch {
        // ignore
      }
    }
    logger.warn({ after: after.slice(0, 200) }, 'Failed to parse TRIAGE_RESULT JSON');
    return null;
  }
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
    return { triage: parseTriageResult(text), text };
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

  const escalationPrompt = `${check.escalationTrigger.toUpperCase()} — take appropriate action.
Context: ${triage.summary || 'No summary provided.'}
Check: ${check.name}
Please investigate and handle this escalation. Use available tools to take action if needed.`;

  try {
    await runContainerAgent(
      group,
      {
        prompt: escalationPrompt,
        sessionId: undefined,
        groupFolder: group.folder,
        chatJid: jid,
        isMain: false,
        isScheduledTask: true,
        checkId: check.id,
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
    logger.debug('Heartbeat: no personal/telegram_eve group found, skipping tick');
    return { checkId: null, checkName: null, status: 'skipped' };
  }

  const [jid, group] = groupEntry;
  const now = new Date();
  const state = readState();

  const check = pickNextCheck(DEFAULT_CHECKS, state, now, HEARTBEAT_TIMEZONE);

  if (!check) {
    logger.debug('Heartbeat: no check due this tick');
    state.lastTick = now.toISOString();
    writeState(state);
    return { checkId: null, checkName: null, status: 'skipped' };
  }

  logger.info({ checkId: check.id, checkName: check.name }, 'Heartbeat: running check');

  const { triage, error } = await runSingleCheck(check, group, jid, deps);

  state.lastTick = now.toISOString();

  if (error) {
    logger.error({ checkId: check.id, error }, 'Heartbeat check error');
    writeState(state);
    return { checkId: check.id, checkName: check.name, status: 'error', summary: error };
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

  if (isAlert) {
    logger.info({ checkId: check.id, summary }, 'Heartbeat ALERT');

    // Send notification
    const notifyText = `⚠️ [${check.name}]${summary ? ': ' + summary : ''}`;
    await deps.sendMessage(jid, notifyText).catch((err) =>
      logger.warn({ err, jid }, 'Heartbeat: failed to send alert notification'),
    );

    // Escalation
    if (
      triage &&
      (triage.actionNeeded === 'escalate_to_agent' ||
        triage.actionNeeded === 'escalate_to_browser')
    ) {
      await runEscalation(check, triage, group, jid, deps);
    }

    return { checkId: check.id, checkName: check.name, status: 'alert', summary };
  }

  logger.info({ checkId: check.id }, 'Heartbeat OK');
  return { checkId: check.id, checkName: check.name, status: 'ok', summary };
}

let running = false;

export function startHeartbeatRunner(deps: HeartbeatDependencies): HeartbeatRunner {
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
