/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import Anthropic from '@anthropic-ai/sdk';
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { getDb } from './db.js';
import { logInvocation } from './cost-tracker.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  checkId?: string; // for heartbeat cost attribution
  source?: string; // override cost-log source (e.g. 'heartbeat_triage')
  modelOverride?: string; // model passed to query() in agent-runner
  maxTurns?: number; // max agentic turns passed to query()
  assistantName?: string;
  secrets?: Record<string, string>;
  imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
}

export interface ContainerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: ContainerUsage;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

async function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): Promise<VolumeMount[]> {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  await fs.promises.mkdir(groupSessionsDir, { recursive: true });

  // Settings merge (sequential — fast, and must complete before skills sync)
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  let settings: Record<string, unknown> = {
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    },
  };
  try {
    const raw = await fs.promises.readFile(settingsFile, 'utf-8');
    settings = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // keep defaults if file missing or malformed
  }
  if (settings.mcpServers && typeof settings.mcpServers === 'object') {
    delete (settings.mcpServers as Record<string, unknown>).google;
  }
  await fs.promises.writeFile(
    settingsFile,
    JSON.stringify(settings, null, 2) + '\n',
  );

  // Per-group IPC namespace
  const groupIpcDir = resolveGroupIpcPath(group.folder);

  // Parallelize: skills sync, agent-runner sync, and IPC dir creation are independent
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );

  await Promise.all([
    // Skills sync
    (async () => {
      try {
        const entries = await fs.promises.readdir(skillsSrc, {
          withFileTypes: true,
        });
        await Promise.all(
          entries
            .filter((e) => e.isDirectory())
            .map((e) =>
              fs.promises.cp(
                path.join(skillsSrc, e.name),
                path.join(skillsDst, e.name),
                {
                  recursive: true,
                },
              ),
            ),
        );
      } catch {
        // skillsSrc doesn't exist — skip
      }
    })(),
    // Agent-runner source sync
    (async () => {
      try {
        await fs.promises.mkdir(groupAgentRunnerDir, { recursive: true });
        const files = await fs.promises.readdir(agentRunnerSrc, {
          withFileTypes: true,
        });
        await Promise.all(
          files
            .filter((f) => f.isFile())
            .map(async (f) => {
              const srcFile = path.join(agentRunnerSrc, f.name);
              const dstFile = path.join(groupAgentRunnerDir, f.name);
              const srcStat = await fs.promises.stat(srcFile);
              let dstMtime = 0;
              try {
                dstMtime = (await fs.promises.stat(dstFile)).mtimeMs;
              } catch {
                // doesn't exist yet
              }
              if (srcStat.mtimeMs > dstMtime) {
                await fs.promises.copyFile(srcFile, dstFile);
                logger.debug(
                  { group: group.folder, file: f.name },
                  'Synced agent-runner source file',
                );
              }
            }),
        );
      } catch {
        // agentRunnerSrc doesn't exist — skip
      }
    })(),
    // IPC directories
    Promise.all([
      fs.promises.mkdir(path.join(groupIpcDir, 'messages'), {
        recursive: true,
      }),
      fs.promises.mkdir(path.join(groupIpcDir, 'tasks'), { recursive: true }),
      fs.promises.mkdir(path.join(groupIpcDir, 'input'), { recursive: true }),
    ]),
  ]);

  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Allow containers to reach host services (e.g. safe-google-mcp on 127.0.0.1:3100)
  args.push('--add-host=host.docker.internal:host-gateway');

  args.push(CONTAINER_IMAGE);

  return args;
}

/**
 * Build a context prefix to prepend to the agent prompt.
 * Reads groups/personal/CLAUDE.md, vault MEMORY.md, and today/yesterday's ledger
 * from the host before the container spawns.
 */
async function buildContextPrefix(group: RegisteredGroup): Promise<string> {
  const filesToRead: Array<{ path: string; label: string }> = [];

  // Always inject groups/personal/CLAUDE.md if it exists
  filesToRead.push({
    path: path.join(GROUPS_DIR, 'personal', 'CLAUDE.md'),
    label: 'groups/personal/CLAUDE.md',
  });

  // Find the /workspace/obsidian mount to resolve host paths for vault files
  const obsidianMount = group.containerConfig?.additionalMounts?.find(
    (m) => m.containerPath === '/workspace/obsidian',
  );

  if (obsidianMount) {
    const base = obsidianMount.hostPath;
    filesToRead.push({
      path: path.join(base, 'MEMORY.md'),
      label: 'MEMORY.md',
    });

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);

    for (const date of [today, yesterday]) {
      filesToRead.push({
        path: path.join(base, 'Ledger', `${date}.md`),
        label: `Ledger/${date}.md`,
      });
    }
  }

  const results = await Promise.all(
    filesToRead.map(async ({ path: filePath, label }) => {
      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        return `## ${label}\n\n${content.trim()}`;
      } catch {
        return null;
      }
    }),
  );

  const parts = results.filter((r): r is string => r !== null);
  if (parts.length === 0) return '';
  return `<injected_context>\n${parts.join('\n\n')}\n</injected_context>\n\n`;
}

/**
 * Append a structured log entry to the group's Obsidian Logs/ directory.
 * Called by the host after every container run, regardless of outcome.
 */
function writeObsidianLog(
  group: RegisteredGroup,
  prompt: string,
  results: string[],
  status: 'success' | 'error',
  durationMs: number,
  isScheduledTask: boolean,
): void {
  const obsidianMount = group.containerConfig?.additionalMounts?.find(
    (m) => m.containerPath === '/workspace/obsidian',
  );
  if (!obsidianMount) return;

  try {
    const logsDir = path.join(obsidianMount.hostPath, 'Logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr =
      String(now.getUTCHours()).padStart(2, '0') +
      ':' +
      String(now.getUTCMinutes()).padStart(2, '0') +
      'Z';

    // Strip injected context wrapper before logging the prompt
    const cleanPrompt = prompt
      .replace(/^<injected_context>[\s\S]*?<\/injected_context>\n\n/, '')
      .trim();

    // First line of prompt as entry title
    const firstLine = cleanPrompt
      .split('\n')[0]
      .replace(/[#*`]/g, '')
      .trim()
      .slice(0, 80);
    const taskTag = isScheduledTask ? ' `[scheduled]`' : '';
    const durationSec = (durationMs / 1000).toFixed(1);

    const promptSection =
      cleanPrompt.length > 2000
        ? cleanPrompt.slice(0, 2000) + '\n…*(truncated)*'
        : cleanPrompt;

    const responseSection =
      results.length > 0
        ? results.join('\n\n')
        : status === 'error'
          ? '*(error — no output)*'
          : '*(no output)*';

    const entry = [
      `## ${timeStr} — ${firstLine}${taskTag}`,
      ``,
      `**Group:** ${group.name} | **Duration:** ${durationSec}s | **Status:** ${status}`,
      ``,
      `### Request`,
      ``,
      promptSection,
      ``,
      `### Response`,
      ``,
      responseSection,
      ``,
      `---`,
      ``,
    ].join('\n');

    const logFile = path.join(logsDir, `${dateStr}.md`);
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, `# ${dateStr}\n\n`);
    }
    fs.appendFileSync(logFile, entry);
    logger.debug({ group: group.name, logFile }, 'Obsidian log appended');
  } catch (err) {
    logger.warn({ group: group.name, err }, 'Failed to write Obsidian log');
  }
}

/**
 * Summarize a request/response pair into a compact ledger one-liner using Haiku.
 * Falls back to first line of response (or prompt) if the API call fails.
 */
async function summarizeForLedger(
  prompt: string,
  results: string[],
  status: 'success' | 'error',
  source: string,
): Promise<string> {
  const cleanPrompt = prompt
    .replace(/^<injected_context>[\s\S]*?<\/injected_context>\n\n/, '')
    .trim();

  const response = results.length > 0 ? results.join('\n\n').trim() : '';

  // Truncate inputs to keep the summarization call small
  const maxInput = 2000;
  const truncPrompt =
    cleanPrompt.length > maxInput
      ? cleanPrompt.slice(0, maxInput) + '…'
      : cleanPrompt;
  const truncResponse =
    response.length > maxInput ? response.slice(0, maxInput) + '…' : response;

  const statusNote = status === 'error' ? ' (the task FAILED)' : '';
  const sourceNote =
    source === 'scheduled_task'
      ? ' This was a scheduled task.'
      : source === 'heartbeat_escalation'
        ? ' This was a heartbeat escalation.'
        : '';

  try {
    const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
    const apiKey = secrets.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('No API key');

    const anthropic = new Anthropic({ apiKey });
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [
        {
          role: 'user',
          content: `Summarize this agent interaction into a single compact ledger line (max 120 chars). Focus on what was accomplished or what the key outcome/result was. No markdown, no bullet points, no quotes — just a plain one-liner.${statusNote}${sourceNote}

REQUEST:
${truncPrompt}

RESPONSE:
${truncResponse || '(no output)'}`,
        },
      ],
    });

    const text =
      msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    if (text) {
      // Track the summarization cost
      logInvocation(getDb(), {
        source: 'ledger_summary',
        model: 'claude-haiku-4-5-20251001',
        usage: {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
          cacheReadTokens:
            (msg.usage as unknown as Record<string, number>)
              .cache_read_input_tokens ?? 0,
          cacheWriteTokens:
            (msg.usage as unknown as Record<string, number>)
              .cache_creation_input_tokens ?? 0,
        },
      });
      return text.slice(0, 120);
    }
  } catch (err) {
    logger.debug({ err }, 'Ledger summarization failed, using fallback');
  }

  // Fallback: first non-empty line of response, or prompt
  if (response) {
    const firstLine = response
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (firstLine) return firstLine.slice(0, 120);
  }
  return cleanPrompt.split('\n')[0].replace(/[#*`]/g, '').trim().slice(0, 120);
}

/**
 * Append a compact one-liner to the group's Obsidian Ledger/ file.
 * Skipped for heartbeat triage (noisy, cheap) and heartbeat summary.
 * Uses Haiku to produce a meaningful summary of the interaction.
 * Fire-and-forget: does not block the caller.
 */
function writeLedgerEntry(
  group: RegisteredGroup,
  prompt: string,
  results: string[],
  status: 'success' | 'error',
  durationMs: number,
  source: string,
): void {
  // Skip noisy/cheap sources — only log meaningful work
  if (source === 'heartbeat_triage' || source === 'heartbeat_summary') return;

  const obsidianMount = group.containerConfig?.additionalMounts?.find(
    (m) => m.containerPath === '/workspace/obsidian',
  );
  if (!obsidianMount) return;

  // Capture timestamp now (before async summarization)
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr =
    String(now.getUTCHours()).padStart(2, '0') +
    ':' +
    String(now.getUTCMinutes()).padStart(2, '0') +
    'Z';

  // Fire-and-forget: summarize then append
  summarizeForLedger(prompt, results, status, source)
    .then((summary) => {
      const ledgerDir = path.join(obsidianMount.hostPath, 'Ledger');
      fs.mkdirSync(ledgerDir, { recursive: true });

      let tag = '';
      if (source === 'scheduled_task') tag = '[scheduled] ';
      else if (source === 'heartbeat_escalation') tag = '[heartbeat] ';

      const statusTag = status === 'error' ? ' (FAILED)' : '';
      const line = `- ${timeStr} — ${tag}${summary}${statusTag}\n`;

      const ledgerFile = path.join(ledgerDir, `${dateStr}.md`);
      if (!fs.existsSync(ledgerFile)) {
        fs.writeFileSync(
          ledgerFile,
          [
            `---`,
            `date: ${dateStr}`,
            `type: ledger`,
            `---`,
            ``,
            `# ${dateStr}`,
            ``,
            `<!-- Compact one-liners. Injected into agent context for continuity. -->`,
            ``,
          ].join('\n'),
        );
      }
      fs.appendFileSync(ledgerFile, line);
      logger.debug({ group: group.name, ledgerFile }, 'Ledger entry appended');
    })
    .catch((err) => {
      logger.warn({ group: group.name, err }, 'Failed to write ledger entry');
    });
}

/**
 * Read token usage from the SDK JSONL transcript for a given session.
 * Only counts assistant messages with timestamp >= sinceMs (the container start time).
 */
function readTranscriptUsage(
  groupFolder: string,
  sessionId: string | undefined,
  sinceMs: number,
): ContainerUsage | undefined {
  if (!sessionId) return undefined;
  const transcriptPath = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );
  if (!fs.existsSync(transcriptPath)) return undefined;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let model = '';
  const sinceIso = new Date(sinceMs).toISOString();

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (entry.type !== 'assistant') continue;
      if (typeof entry.timestamp === 'string' && entry.timestamp < sinceIso)
        continue;

      const msg = entry.message as
        | { usage?: Record<string, number>; model?: string }
        | undefined;
      if (msg?.usage) {
        inputTokens += msg.usage.input_tokens ?? 0;
        outputTokens += msg.usage.output_tokens ?? 0;
        cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
        cacheWriteTokens += msg.usage.cache_creation_input_tokens ?? 0;
      }
      if (msg?.model && !model) model = msg.model;
    }
  } catch (err) {
    logger.debug(
      { err, groupFolder, sessionId },
      'Failed to parse transcript for usage',
    );
    return undefined;
  }

  if (inputTokens + outputTokens === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    model: model || 'unknown',
  };
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Build mounts and context prefix in parallel (both are independent I/O)
  const [mounts, contextPrefix] = await Promise.all([
    buildVolumeMounts(group, input.isMain),
    buildContextPrefix(group),
  ]);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Prepend injected context (vault memory, ledger) to the prompt
    if (contextPrefix) {
      input.prompt = contextPrefix + input.prompt;
    }

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets();
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    // Collect agent responses for Obsidian logging
    const streamedResults: string[] = [];
    // Accumulate token usage across all output markers
    let accumulatedUsage: ContainerUsage | undefined;

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            if (parsed.result) {
              streamedResults.push(parsed.result);
            }
            if (parsed.usage) {
              if (!accumulatedUsage) {
                accumulatedUsage = { ...parsed.usage };
              } else {
                accumulatedUsage.inputTokens += parsed.usage.inputTokens;
                accumulatedUsage.outputTokens += parsed.usage.outputTokens;
                accumulatedUsage.cacheReadTokens +=
                  parsed.usage.cacheReadTokens;
                accumulatedUsage.cacheWriteTokens +=
                  parsed.usage.cacheWriteTokens;
                if (parsed.usage.model)
                  accumulatedUsage.model = parsed.usage.model;
              }
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    const logCost = (duration: number) => {
      // Primary: parse the SDK JSONL transcript for reliable usage data.
      // Fallback: use usage emitted by agent runner in ContainerOutput.
      let usage = readTranscriptUsage(
        group.folder,
        newSessionId || input.sessionId,
        startTime,
      );
      if (
        !usage &&
        accumulatedUsage &&
        accumulatedUsage.inputTokens + accumulatedUsage.outputTokens > 0
      ) {
        usage = accumulatedUsage;
      }
      if (!usage) return;

      const source =
        input.source ??
        (input.isScheduledTask ? 'scheduled_task' : 'user_message');
      try {
        logInvocation(getDb(), {
          source,
          checkId: input.checkId,
          model: usage.model || 'unknown',
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
          },
          durationMs: duration,
          groupId: group.folder,
        });
      } catch (err) {
        logger.warn({ err }, 'Failed to log invocation cost');
      }
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      const ledgerSource =
        input.source ??
        (input.isScheduledTask ? 'scheduled_task' : 'user_message');

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            logCost(duration);
            writeObsidianLog(
              group,
              input.prompt,
              streamedResults,
              'success',
              duration,
              input.isScheduledTask ?? false,
            );
            writeLedgerEntry(
              group,
              input.prompt,
              streamedResults,
              'success',
              duration,
              ledgerSource,
            );
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        logCost(duration);
        writeObsidianLog(
          group,
          input.prompt,
          streamedResults,
          'error',
          duration,
          input.isScheduledTask ?? false,
        );
        writeLedgerEntry(
          group,
          input.prompt,
          streamedResults,
          'error',
          duration,
          ledgerSource,
        );
        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        logCost(duration);
        writeObsidianLog(
          group,
          input.prompt,
          streamedResults,
          'error',
          duration,
          input.isScheduledTask ?? false,
        );
        writeLedgerEntry(
          group,
          input.prompt,
          streamedResults,
          'error',
          duration,
          ledgerSource,
        );
        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logCost(duration);
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          writeObsidianLog(
            group,
            input.prompt,
            streamedResults,
            'success',
            duration,
            input.isScheduledTask ?? false,
          );
          writeLedgerEntry(
            group,
            input.prompt,
            streamedResults,
            'success',
            duration,
            ledgerSource,
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        logCost(duration);
        writeObsidianLog(
          group,
          input.prompt,
          output.result ? [output.result] : [],
          output.status,
          duration,
          input.isScheduledTask ?? false,
        );
        writeLedgerEntry(
          group,
          input.prompt,
          output.result ? [output.result] : [],
          output.status,
          duration,
          ledgerSource,
        );
        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
