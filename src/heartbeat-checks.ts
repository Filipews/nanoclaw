/**
 * Heartbeat check definitions — prompts optimized for the triage model (Haiku).
 *
 * Each prompt must end with a TRIAGE_RESULT block. The triage model outputs ONLY:
 *
 *   HEARTBEAT_OK
 *
 * or:
 *
 *   HEARTBEAT_ALERT
 *   action: notify_only | escalate_to_agent | escalate_to_browser
 *   summary: <one paragraph max>
 *   priority: low | medium | high | critical
 *
 * Prompts must NOT instruct the model to wrap output in code blocks.
 */

import { HeartbeatCheck } from './heartbeat-types.js';

const TRIAGE_FOOTER = `
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

export const HEARTBEAT_CHECKS: HeartbeatCheck[] = [
  {
    id: 'gmail-inbox',
    name: 'Gmail Inbox',
    cadence: 30,
    activeWindow: { start: '08:00', end: '20:00' },
    priority: 10,
    enabled: true,
    escalationTrigger: 'urgent email found',
    prompt: `[HEARTBEAT CHECK: Gmail Inbox]

Use the Google MCP (mcp__google__*) to scan the Gmail inbox.

Steps:
1. Fetch unread emails from the last 2 hours.
2. Read the email-filtering skill if available at /home/node/.claude/skills/ to understand priority senders and rules.
3. Check for any emails from VIP senders, flagged urgent, or containing keywords like: "urgent", "ASAP", "action required", "deadline", "invoice", "payment".
4. If there are CSV allowlist/blocklist files in /workspace/group/, check sender domains against them.

Classify: does any email require immediate attention?
${TRIAGE_FOOTER}`,
  },
  {
    id: 'calendar',
    name: 'Calendar',
    cadence: 60,
    activeWindow: { start: '07:00', end: '22:00' },
    priority: 9,
    enabled: true,
    escalationTrigger: 'event conflict or imminent event',
    prompt: `[HEARTBEAT CHECK: Calendar]

Use the Google MCP (mcp__google__*) to check the calendar.

Steps:
1. Fetch all events for the next 14 days.
2. Flag any of the following:
   - Flights, trips, or travel (keywords: flight, trip, travel, hotel, departure)
   - Birthdays or anniversaries
   - Medical/dental appointments
   - Meetings or calls starting within the next 60 minutes
   - Double-booked time slots (conflicts)
   - Events without a preparation task created
3. Note events that are coming up within 24 hours.

Is there anything requiring immediate attention or a reminder?
${TRIAGE_FOOTER}`,
  },
  {
    id: 'needs-reply',
    name: 'Needs Reply',
    cadence: 240,
    activeWindow: { start: '10:00', end: '19:00' },
    priority: 8,
    enabled: true,
    escalationTrigger: 'reply overdue > 24h',
    prompt: `[HEARTBEAT CHECK: Needs Reply]

Use the Google MCP (mcp__google__*) to check for unanswered email threads.

Steps:
1. Search Gmail for threads where the last message was received (not sent) more than 24 hours ago.
2. Filter to threads from non-automated senders (exclude newsletters, noreply, notifications).
3. Identify threads where a reply is expected — look for direct questions, requests, or personal messages.
4. Check if a reply was already drafted or sent.

Are there important threads awaiting a reply for more than 24 hours?
${TRIAGE_FOOTER}`,
  },
  {
    id: 'tasks',
    name: 'Tasks',
    cadence: 60,
    activeWindow: { start: '08:00', end: '21:00' },
    priority: 7,
    enabled: true,
    escalationTrigger: 'overdue task found',
    prompt: `[HEARTBEAT CHECK: Tasks]

Check task files for overdue or urgent items.

Steps:
1. Read /workspace/obsidian/Eve/Tasks/inbox.md if it exists.
2. Read any other task files in /workspace/obsidian/Eve/Tasks/ directory.
3. Look for tasks with:
   - Past due dates (format: YYYY-MM-DD before today)
   - "urgent" or "ASAP" labels
   - Blocked status with no resolution
4. Count overdue items and identify the most critical one.

Today's date: ${new Date().toISOString().slice(0, 10)}.

Are there overdue or urgent tasks requiring attention?
${TRIAGE_FOOTER}`,
  },
  {
    id: 'prices',
    name: 'Prices',
    cadence: 1440,
    activeWindow: { start: '07:00', end: '10:00' },
    priority: 3,
    enabled: true,
    escalationTrigger: 'price target met',
    prompt: `[HEARTBEAT CHECK: Prices]

Check the Watch List for price targets.

Steps:
1. Look for the Price Research skill at /home/node/.claude/skills/ and read its Watch List section.
2. Check /workspace/group/ for any price watch files (watchlist.md, prices.csv, watch-list.md).
3. For each item on the watch list that has a price target due today or already met, note it.
4. If no watch list is found, respond with HEARTBEAT_OK.

Today's date: ${new Date().toISOString().slice(0, 10)}.

Have any price targets been met or are due for review today?
${TRIAGE_FOOTER}`,
  },
  {
    id: 'daily-files',
    name: 'Daily Files',
    cadence: 480,
    activeWindow: { start: '08:00', end: '22:00' },
    priority: 2,
    enabled: true,
    escalationTrigger: 'new unprocessed file or missing daily log',
    prompt: `[HEARTBEAT CHECK: Daily Files]

Verify today's daily log and ledger exist, and check for pending inbox items.

Steps:
1. Today's date: ${new Date().toISOString().slice(0, 10)}.
2. Check if /workspace/obsidian/Eve/Daily/${new Date().toISOString().slice(0, 10)}.md exists.
3. Check if /workspace/obsidian/Ledger/${new Date().toISOString().slice(0, 10)}.md exists.
4. Scan /workspace/obsidian/Eve/Inbox/ for files that have not been processed (no processed/done tag).
5. Check if any pending items from yesterday's daily note need to be carried forward.

Are today's logs missing or are there unprocessed inbox files?
${TRIAGE_FOOTER}`,
  },
  {
    id: 'vault-health',
    name: 'Vault Health',
    cadence: 10080,
    activeWindow: { start: '09:00', end: '10:00' },
    priority: 1,
    enabled: true,
    escalationTrigger: 'vault inconsistency found',
    prompt: `[HEARTBEAT CHECK: Vault Health]

Perform a weekly health check of the Obsidian vault.

Steps:
1. Count open tasks across all task files in /workspace/obsidian/Eve/Tasks/ — report total.
2. Check skill CSV files in /home/node/.claude/skills/ — find any files not modified in over 30 days.
3. Verify /workspace/obsidian/MEMORY.md exists and was updated this week.
4. Check /workspace/obsidian/Eve/Weekly/ — does this week's summary file exist?
5. Look for any broken internal links or missing referenced files (spot check 5 random notes).
6. Report a summary of findings.

Today's date: ${new Date().toISOString().slice(0, 10)}.

Are there any vault inconsistencies or health issues requiring attention?
${TRIAGE_FOOTER}`,
  },
];
