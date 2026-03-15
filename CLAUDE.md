# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/container-runtime.ts` | Docker abstraction: mount args, stop, orphan cleanup |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/cost-tracker.ts` | Tracks API costs per invocation (tokens, model, source, group) |
| `src/heartbeat-runner.ts` | Heartbeat orchestration: tick loop, triage, escalation routing |
| `src/heartbeat-loader.ts` | Loads check definitions from `groups/personal/heartbeat-checks/*.md` each tick |
| `src/heartbeat-types.ts` | Types: HeartbeatCheck, CheckState, TriageResult, HeartbeatTickResult |
| `src/group-queue.ts` | Per-group task queue with global concurrency limit and backoff |
| `src/group-folder.ts` | Group folder path validation (safe names, no traversal) |
| `src/logger.ts` | Pino-based structured logger with color output in dev |
| `src/mount-security.ts` | Validates container mounts against allowlist (tamper-proof) |
| `src/sender-allowlist.ts` | Per-chat sender authorization (trigger/drop modes) |
| `src/timezone.ts` | UTC → local time formatting via Intl API |
| `src/env.ts` | Reads .env keys without polluting process.env |
| `src/image.ts` | Image processing: resize, save to attachments, parse references |
| `src/transcription.ts` | Audio transcription via OpenAI Whisper API |
| `src/types.ts` | Central types: Channel, RegisteredGroup, NewMessage, ScheduledTask, AdditionalMount |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |
| `container/agent-runner/src/index.ts` | Container main process: stdin input + IPC polling for follow-up messages |

## Heartbeat System

Runs periodic proactive checks on a rotation algorithm (overdue ratio × priority scoring). Each check has a cadence (minutes), active time window, and escalation routing:

- **`notify_only`**: Send alert to Telegram
- **`escalate_to_agent`**: Spawn Sonnet container with full task context
- **`escalate_to_browser`**: Same as agent with browser automation hint

Triage uses Haiku (cheap); escalation uses Sonnet. State persisted at `groups/personal/heartbeat-state.json`. Failing checks back off 5 minutes instead of full cadence. End-of-day summary appended to Obsidian daily log.

Check definitions live in `groups/personal/heartbeat-checks/*.md` (8 files: gmail-inbox, calendar, needs-reply, tasks, drive-inbox, prices, daily-files, vault-health). Edits to these files take effect on the next tick — no rebuild needed.

## Security Model

- **Mount allowlist**: `~/.config/nanoclaw/mount-allowlist.json` — stored outside project to prevent agent tampering. Blocks `.ssh`, `.gnupg`, `.aws`, credential files by default. Container paths must be under `/workspace/` or `/mnt/`.
- **Sender allowlist**: `~/.config/nanoclaw/sender-allowlist.json` — per-chat authorization. Modes: `trigger` (only listed senders activate agent) or `drop` (unlisted silently dropped). Supports per-chat overrides and `*` wildcard.

## Cost Tracking

`cost-tracker.ts` logs every Claude invocation to the `cost_log` SQLite table (input/output/cache tokens, model, source, duration, group_id). Query helpers: `getMonthSummary()`, `getTodayDetail()`, `getWeekSummary()`, `getHeartbeatSummary()`. Telegram-formatted output with visual progress bars.

## Group Queue

`group-queue.ts` enforces `MAX_CONCURRENT_CONTAINERS` globally with per-group queuing. Tasks are prioritized over messages in drain order. Exponential backoff on failure (5s base, max 5 retries). Graceful shutdown detaches containers rather than killing them (preserves WhatsApp connections). Task deduplication prevents double-queueing.

## IPC Protocol

- **Initial**: stdin JSON (full config + message)
- **Follow-up**: File-based IPC with stdin close sentinel
- Enables multi-turn conversations within a single container session

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
