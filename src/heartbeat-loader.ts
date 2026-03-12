/**
 * Loads heartbeat check definitions from markdown files on disk.
 *
 * Each file in the checks directory is a `.md` file with YAML frontmatter
 * (config) and a markdown body split into `# Triage` and `# Escalation`
 * sections. Files are re-read every call — no caching — so edits take
 * effect on the next tick without restarting.
 */

import fs from 'fs';
import path from 'path';

import yaml from 'yaml';

import { logger } from './logger.js';
import { HeartbeatCheck } from './heartbeat-types.js';

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

function parseWindow(
  raw: unknown,
): { start: string; end: string } | undefined {
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
    logger.warn({ filePath }, 'Heartbeat check file missing YAML frontmatter, skipping');
    return null;
  }

  let fm: CheckFrontmatter;
  try {
    fm = yaml.parse(fmMatch[1]) as CheckFrontmatter;
  } catch (err) {
    logger.warn({ filePath, err }, 'Heartbeat check file has invalid YAML frontmatter, skipping');
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
    logger.warn({ filePath }, 'Heartbeat check missing required `cadence` field, skipping');
    return null;
  }

  const rawBody = fmMatch[2] ?? '';
  const today = new Date().toISOString().slice(0, 10);
  const bodyWithDate = rawBody.replace(/\{\{today\}\}/g, today);
  const { triageBody, escalationBody } = splitBody(bodyWithDate);

  // Build the full triage prompt: [HEARTBEAT CHECK: Name] prefix + body + footer
  const prompt = `[HEARTBEAT CHECK: ${name}]\n\n${triageBody}${TRIAGE_FOOTER}`;

  // Escalation prompt keeps {{details}} as-is (replaced at escalation time)
  const escalationPrompt = escalationBody !== undefined
    ? replaceToday(escalationBody)
    : undefined;

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
    logger.warn({ dir }, 'Heartbeat checks directory not found, returning empty list');
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
      logger.warn({ filePath, err }, 'Failed to read heartbeat check file, skipping');
      continue;
    }

    const check = parseCheckFile(filePath, content);
    if (check) {
      checks.push(check);
    }
  }

  return checks;
}
