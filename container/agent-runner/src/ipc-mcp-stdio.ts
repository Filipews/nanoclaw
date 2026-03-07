/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { chromium, Browser, BrowserContext, Page } from 'playwright';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  `Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.

To postpone a single occurrence of a recurring task without changing the recurring schedule, use next_run with a local timestamp (same format as 'once' schedule_value: no Z suffix). The cron expression is preserved and the task resumes its normal schedule after the postponed run.`,
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
    next_run: z.string().optional().describe('Override the next run time only (local timestamp, no Z suffix, e.g. "2026-03-12T08:00:00"). Use this to postpone one occurrence of a recurring task without changing the cron expression.'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }
    if (args.next_run !== undefined) {
      if (/[Zz]$/.test(args.next_run) || /[+-]\d{2}:\d{2}$/.test(args.next_run)) {
        return {
          content: [{ type: 'text' as const, text: `next_run must be local time without timezone suffix. Got "${args.next_run}" — use format like "2026-03-12T08:00:00".` }],
          isError: true,
        };
      }
      if (isNaN(new Date(args.next_run).getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid next_run timestamp: "${args.next_run}". Use local time format like "2026-03-12T08:00:00".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;
    if (args.next_run !== undefined) data.next_run = args.next_run;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// === Playwright Browser Tools ===

let _browser: Browser | null = null;
let _context: BrowserContext | null = null;
let _page: Page | null = null;

function randomDelay(minMs = 1000, maxMs = 3000): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs) + minMs);
  return new Promise((r) => setTimeout(r, ms));
}

async function getBrowserPage(): Promise<Page> {
  if (_browser === null || !_browser.isConnected()) {
    _browser = await chromium.launch({
      headless: false,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1920,1080',
      ],
    });
    _context = await _browser.newContext({
      viewport: { width: 1920, height: 1080 },
      locale: 'pt-BR',
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    await _context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    _page = await _context.newPage();
  }
  if (_page === null || _page.isClosed()) {
    _page = await _context!.newPage();
  }
  return _page;
}

process.on('exit', () => {
  _browser?.close().catch(() => {});
});

server.tool(
  'browser_navigate',
  'Navigate to a URL and wait for the page to load. Adds a random human-like delay (1–3 s) after load to reduce bot-detection risk. Returns the page title and final URL.',
  {
    url: z.string().describe('URL to navigate to'),
    wait_until: z
      .enum(['load', 'domcontentloaded', 'networkidle'])
      .default('networkidle')
      .describe('When to consider navigation complete (default: networkidle)'),
  },
  async (args) => {
    try {
      const page = await getBrowserPage();
      await page.goto(args.url, {
        waitUntil: args.wait_until as 'load' | 'domcontentloaded' | 'networkidle',
        timeout: 30000,
      });
      await randomDelay();
      const title = await page.title();
      const url = page.url();
      return {
        content: [{ type: 'text' as const, text: `Navigated to: ${url}\nTitle: ${title}` }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Navigation error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'browser_query',
  'Extract text or attribute values from elements matching a CSS selector. Returns up to 20 matches.',
  {
    selector: z.string().describe('CSS selector'),
    attribute: z
      .string()
      .optional()
      .describe('Attribute to extract (e.g. "href", "src"). Omit to get innerText.'),
    limit: z.number().int().min(1).max(50).default(20).describe('Max results to return'),
  },
  async (args) => {
    try {
      const page = await getBrowserPage();
      const results = await page.evaluate(
        ({ selector, attribute, limit }) => {
          const els = Array.from(document.querySelectorAll(selector)).slice(0, limit);
          return els.map((el) =>
            attribute
              ? (el as HTMLElement).getAttribute(attribute) || ''
              : (el as HTMLElement).innerText?.trim() || '',
          );
        },
        { selector: args.selector, attribute: args.attribute ?? null, limit: args.limit },
      );
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: `No elements matched "${args.selector}"` }] };
      }
      const text = results.map((r, i) => `[${i + 1}] ${r}`).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Query error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'browser_click',
  'Click an element matching a CSS selector. Waits up to 5 s for the element to be visible.',
  {
    selector: z.string().describe('CSS selector of the element to click'),
    timeout: z.number().int().default(5000).describe('Wait timeout in ms'),
  },
  async (args) => {
    try {
      const page = await getBrowserPage();
      await page.click(args.selector, { timeout: args.timeout });
      await randomDelay(500, 1500);
      return { content: [{ type: 'text' as const, text: `Clicked: ${args.selector}` }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Click error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'browser_screenshot',
  'Take a screenshot of the current page and save it to /workspace/data/price-research/screenshots/YYYY-MM-DD-{slug}.png. Returns the saved file path.',
  {
    slug: z
      .string()
      .describe('Short identifier for the file, e.g. "mercadolivre-iphone15". Alphanumeric and hyphens only.'),
    full_page: z.boolean().default(false).describe('Capture full scrollable page (default: viewport only)'),
  },
  async (args) => {
    try {
      const page = await getBrowserPage();
      const date = new Date().toISOString().slice(0, 10);
      const slug = args.slug.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
      const dir = '/workspace/data/price-research/screenshots';
      fs.mkdirSync(dir, { recursive: true });
      const filepath = path.join(dir, `${date}-${slug}.png`);
      await page.screenshot({ path: filepath, fullPage: args.full_page });
      return { content: [{ type: 'text' as const, text: `Screenshot saved: ${filepath}` }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Screenshot error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'browser_scroll',
  'Scroll the current page.',
  {
    direction: z
      .enum(['up', 'down', 'top', 'bottom'])
      .describe('up/down scroll by pixels; top/bottom jump to page edge'),
    amount: z
      .number()
      .int()
      .optional()
      .describe('Pixels to scroll for up/down (default: 600)'),
  },
  async (args) => {
    try {
      const page = await getBrowserPage();
      const px = args.amount ?? 600;
      switch (args.direction) {
        case 'down':
          await page.evaluate((n) => window.scrollBy(0, n), px);
          break;
        case 'up':
          await page.evaluate((n) => window.scrollBy(0, -n), px);
          break;
        case 'top':
          await page.evaluate(() => window.scrollTo(0, 0));
          break;
        case 'bottom':
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          break;
      }
      await randomDelay(300, 800);
      return { content: [{ type: 'text' as const, text: `Scrolled ${args.direction}` }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Scroll error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'browser_close',
  'Close the browser and release all resources. Call this when browsing is done.',
  {},
  async () => {
    try {
      if (_browser) {
        await _browser.close();
        _browser = null;
        _context = null;
        _page = null;
      }
      return { content: [{ type: 'text' as const, text: 'Browser closed.' }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Close error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
