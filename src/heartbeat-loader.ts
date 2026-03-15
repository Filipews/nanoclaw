/**
 * Loads heartbeat check definitions from markdown files on disk.
 *
 * Each file in the checks directory is a `.md` file with YAML frontmatter
 * (config) and a markdown body split into `# Triage` and `# Escalation`
 * sections. Files are re-read every call — no caching — so edits take
 * effect on the next tick without restarting.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import yaml from 'yaml';

import { META_ALERT_COST_THRESHOLD } from './config.js';
import { getTodayCost } from './cost-tracker.js';
import { getDb, getRecentHeartbeatAlerts } from './db.js';
import { CheckState, HeartbeatCheck, HeartbeatState } from './heartbeat-types.js';
import { logger } from './logger.js';

export const TRIAGE_FOOTER = `
---
Respond with ONLY one of the following formats, nothing else before or after:

If everything is fine:
HEARTBEAT_OK

If action is needed:
HEARTBEAT_ALERT
action: notify_only | escalate_to_agent | escalate_to_browser
summary: <one paragraph max describing what was found>
priority: low | medium | high | critical

Do not add any explanation. Do not use code blocks. Output only the result block.`;

interface CheckFrontmatter {
  name?: unknown;
  cadence?: unknown;
  window?: unknown;
  priority?: unknown;
  enabled?: unknown;
  escalationTrigger?: unknown;
}

function parseWindow(raw: unknown): { start: string; end: string } | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = raw.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!match) return undefined;
  return { start: match[1], end: match[2] };
}

function replaceToday(text: string): string {
  return text.replace(/\{\{today\}\}/g, new Date().toISOString().slice(0, 10));
}

/**
 * Split a markdown body into triage and escalation sections.
 *
 * If neither `# Triage` nor `# Escalation` headers are present, the entire
 * body is treated as the triage prompt.
 */
function splitBody(body: string): {
  triageBody: string;
  escalationBody: string | undefined;
} {
  // Normalise line endings
  const text = body.replace(/\r\n/g, '\n');

  // Find section headers (case-insensitive, level-1 only)
  const triageMatch = text.match(/^# Triage\s*$/im);
  const escalationMatch = text.match(/^# Escalation\s*$/im);

  if (!triageMatch && !escalationMatch) {
    return { triageBody: text.trim(), escalationBody: undefined };
  }

  let triageBody = '';
  let escalationBody: string | undefined;

  if (triageMatch && triageMatch.index !== undefined) {
    const start = triageMatch.index + triageMatch[0].length;
    const end =
      escalationMatch && escalationMatch.index !== undefined
        ? escalationMatch.index
        : text.length;
    triageBody = text.slice(start, end).trim();
  }

  if (escalationMatch && escalationMatch.index !== undefined) {
    const start = escalationMatch.index + escalationMatch[0].length;
    escalationBody = text.slice(start).trim();
  }

  return { triageBody, escalationBody };
}

function readHeartbeatState(checksDir: string): HeartbeatState | null {
  const statePath = path.join(path.dirname(checksDir), 'heartbeat-state.json');
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as HeartbeatState;
    }
  } catch {
    // ignore
  }
  return null;
}

function loadCheckCadences(
  checksDir: string,
): Record<string, { name: string; cadence: number }> {
  const result: Record<string, { name: string; cadence: number }> = {};
  try {
    const files = fs.readdirSync(checksDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const id = path.basename(file, '.md');
      const raw = fs.readFileSync(path.join(checksDir, file), 'utf-8');
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      try {
        const fm = yaml.parse(fmMatch[1]) as Record<string, unknown>;
        if (typeof fm.cadence === 'number') {
          result[id] = {
            name: (typeof fm.name === 'string' ? fm.name : id),
            cadence: fm.cadence,
          };
        }
      } catch {
        // skip invalid
      }
    }
  } catch {
    // skip if dir unreadable
  }
  return result;
}

function replaceSystemHealth(
  text: string,
  checksDir: string,
): string {
  if (!text.includes('{{system_health}}')) return text;

  let db: Database.Database;
  try {
    db = getDb();
  } catch {
    return text.replace(/\{\{system_health\}\}/g, '(system health data unavailable)');
  }

  const state = readHeartbeatState(checksDir);
  const todayCost = getTodayCost(db);
  const cadences = loadCheckCadences(checksDir);

  const lines: string[] = ['## System Health Report', ''];

  // Per-check status table
  lines.push('### Check Status');
  lines.push('| Check | Last Run | Result | Consecutive OKs | Stalled? |');
  lines.push('|-------|----------|--------|-----------------|----------|');

  const nowMs = Date.now();
  const checkIds = Object.keys(cadences).filter((id) => id !== 'meta-alerts');

  for (const id of checkIds) {
    const cs: CheckState | undefined = state?.checks[id];
    const info = cadences[id];
    if (!cs) {
      lines.push(`| ${info.name} | never | — | — | ⚠️ never run |`);
      continue;
    }
    const lastRunMs = new Date(cs.lastRun).getTime();
    const minutesSince = (nowMs - lastRunMs) / 60_000;
    const stalledThreshold = info.cadence * 2;
    const isStalled = minutesSince > stalledThreshold;
    const ago = minutesSince < 60
      ? `${Math.round(minutesSince)}m ago`
      : `${(minutesSince / 60).toFixed(1)}h ago`;
    lines.push(
      `| ${info.name} | ${ago} | ${cs.lastResult} | ${cs.consecutiveOks} | ${isStalled ? `⚠️ stalled (${Math.round(minutesSince)}m, cadence ${info.cadence}m)` : 'no'} |`,
    );
  }

  // Cost threshold
  lines.push('');
  lines.push('### Cost');
  lines.push(`- Today's total: $${todayCost.toFixed(4)}`);
  lines.push(`- Threshold: $${META_ALERT_COST_THRESHOLD.toFixed(2)}/day`);
  if (todayCost >= META_ALERT_COST_THRESHOLD) {
    lines.push(`- ⚠️ OVER THRESHOLD by $${(todayCost - META_ALERT_COST_THRESHOLD).toFixed(4)}`);
  }

  // Flagged issues summary
  const issues: string[] = [];
  for (const id of checkIds) {
    const cs = state?.checks[id];
    if (!cs) {
      issues.push(`${cadences[id].name}: never run`);
      continue;
    }
    if (cs.lastResult === 'error') {
      issues.push(`${cadences[id].name}: last result was error — "${cs.lastSummary?.slice(0, 80) ?? 'unknown'}"`);
    }
    const minutesSince = (nowMs - new Date(cs.lastRun).getTime()) / 60_000;
    if (minutesSince > cadences[id].cadence * 2) {
      issues.push(`${cadences[id].name}: stalled (${Math.round(minutesSince)}m since last run, cadence ${cadences[id].cadence}m)`);
    }
  }
  if (todayCost >= META_ALERT_COST_THRESHOLD) {
    issues.push(`Daily cost $${todayCost.toFixed(4)} exceeds threshold $${META_ALERT_COST_THRESHOLD.toFixed(2)}`);
  }

  if (issues.length > 0) {
    lines.push('');
    lines.push('### Flagged Issues');
    for (const issue of issues) {
      lines.push(`- ${issue}`);
    }
  } else {
    lines.push('');
    lines.push('### No issues detected.');
  }

  return text.replace(/\{\{system_health\}\}/g, lines.join('\n'));
}

function replaceCrossSignalState(
  text: string,
  checksDir: string,
): string {
  if (!text.includes('{{cross_signal_state}}')) return text;

  let db: Database.Database;
  try {
    db = getDb();
  } catch {
    return text.replace(/\{\{cross_signal_state\}\}/g, '(cross-signal data unavailable)');
  }

  const state = readHeartbeatState(checksDir);
  const alerts = getRecentHeartbeatAlerts(db, 24);
  const cadences = loadCheckCadences(checksDir);

  const lines: string[] = [
    '## Cross-Signal State',
    `Current time: ${new Date().toISOString()}`,
    '',
  ];

  // Recent state table (exclude cross-signal itself)
  lines.push('### Recent Check Results');
  lines.push('| Check | Last Result | Last Run | Summary |');
  lines.push('|-------|-------------|----------|---------|');

  const checkIds = Object.keys(cadences).filter((id) => id !== 'cross-signal');
  let totalChars = 0;
  const MAX_CHARS = 3000;

  for (const id of checkIds) {
    if (totalChars > MAX_CHARS) break;
    const cs = state?.checks[id];
    if (!cs) {
      lines.push(`| ${cadences[id].name} | — | never | — |`);
      continue;
    }
    const summary = cs.lastSummary
      ? cs.lastSummary.slice(0, 120) + (cs.lastSummary.length > 120 ? '…' : '')
      : '—';
    const ago = (() => {
      const mins = (Date.now() - new Date(cs.lastRun).getTime()) / 60_000;
      return mins < 60 ? `${Math.round(mins)}m ago` : `${(mins / 60).toFixed(1)}h ago`;
    })();
    const line = `| ${cadences[id].name} | ${cs.lastResult} | ${ago} | ${summary} |`;
    totalChars += line.length;
    lines.push(line);
  }

  // Recent alerts
  if (alerts.length > 0 && totalChars < MAX_CHARS) {
    lines.push('');
    lines.push('### Recent Alerts (last 24h)');
    for (const alert of alerts) {
      if (totalChars > MAX_CHARS) break;
      const summary = alert.summary
        ? alert.summary.slice(0, 100) + (alert.summary.length > 100 ? '…' : '')
        : '—';
      const line = `- **${alert.check_id}** (${alert.timestamp}): ${summary}`;
      totalChars += line.length;
      lines.push(line);
    }
  }

  return text.replace(/\{\{cross_signal_state\}\}/g, lines.join('\n'));
}

/**
 * Parse a single `.md` file and return a HeartbeatCheck, or null if the
 * frontmatter is invalid/missing.
 */
function parseCheckFile(
  filePath: string,
  content: string,
): HeartbeatCheck | null {
  const id = path.basename(filePath, '.md');

  // Split frontmatter from body
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    logger.warn(
      { filePath },
      'Heartbeat check file missing YAML frontmatter, skipping',
    );
    return null;
  }

  let fm: CheckFrontmatter;
  try {
    fm = yaml.parse(fmMatch[1]) as CheckFrontmatter;
  } catch (err) {
    logger.warn(
      { filePath, err },
      'Heartbeat check file has invalid YAML frontmatter, skipping',
    );
    return null;
  }

  if (!fm || typeof fm !== 'object') {
    logger.warn({ filePath }, 'Heartbeat check frontmatter is empty, skipping');
    return null;
  }

  const name = typeof fm.name === 'string' ? fm.name : id;
  const cadence = typeof fm.cadence === 'number' ? fm.cadence : undefined;
  const priority = typeof fm.priority === 'number' ? fm.priority : 5;
  const enabled = fm.enabled === false ? false : true;
  const escalationTrigger =
    typeof fm.escalationTrigger === 'string' ? fm.escalationTrigger : '';
  const activeWindow = parseWindow(fm.window);

  if (cadence === undefined) {
    logger.warn(
      { filePath },
      'Heartbeat check missing required `cadence` field, skipping',
    );
    return null;
  }

  const rawBody = fmMatch[2] ?? '';
  const today = new Date().toISOString().slice(0, 10);
  let bodyWithDate = rawBody.replace(/\{\{today\}\}/g, today);
  // Inject system health and cross-signal data when template vars are present
  const checksDir = path.dirname(filePath);
  bodyWithDate = replaceSystemHealth(bodyWithDate, checksDir);
  bodyWithDate = replaceCrossSignalState(bodyWithDate, checksDir);
  const { triageBody, escalationBody } = splitBody(bodyWithDate);

  // Build the full triage prompt: [HEARTBEAT CHECK: Name] prefix + body + footer
  const prompt = `[HEARTBEAT CHECK: ${name}]\n\n${triageBody}${TRIAGE_FOOTER}`;

  // Escalation prompt keeps {{details}} as-is (replaced at escalation time)
  const escalationPrompt =
    escalationBody !== undefined ? replaceToday(escalationBody) : undefined;

  return {
    id,
    name,
    cadence,
    activeWindow,
    priority,
    enabled,
    escalationTrigger,
    prompt,
    escalationPrompt,
  };
}

/**
 * Load all heartbeat checks from `.md` files in `dir`.
 *
 * Files are sorted alphabetically. Invalid files are skipped with a warning.
 * Returns an empty array if the directory does not exist.
 */
export function loadHeartbeatChecks(dir: string): HeartbeatCheck[] {
  if (!fs.existsSync(dir)) {
    logger.warn(
      { dir },
      'Heartbeat checks directory not found, returning empty list',
    );
    return [];
  }

  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort();
  } catch (err) {
    logger.warn({ dir, err }, 'Failed to read heartbeat checks directory');
    return [];
  }

  const checks: HeartbeatCheck[] = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      logger.warn(
        { filePath, err },
        'Failed to read heartbeat check file, skipping',
      );
      continue;
    }

    const check = parseCheckFile(filePath, content);
    if (check) {
      checks.push(check);
    }
  }

  return checks;
}
