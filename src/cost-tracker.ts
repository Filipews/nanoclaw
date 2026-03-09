import Database from 'better-sqlite3';

import { logger } from './logger.js';

interface ModelRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const MODEL_RATES: Record<string, ModelRate> = {
  'claude-haiku-4-5-20251001': {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  },
  'claude-sonnet-4-6': {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  'claude-opus-4-6': {
    input: 5.0,
    output: 25.0,
    cacheRead: 0.5,
    cacheWrite: 6.25,
  },
};

const DEFAULT_RATE = MODEL_RATES['claude-sonnet-4-5-20250929'];

function getRate(model: string): ModelRate {
  if (MODEL_RATES[model]) return MODEL_RATES[model];
  if (model.includes('haiku')) return MODEL_RATES['claude-haiku-4-5-20251001'];
  if (model.includes('opus')) return MODEL_RATES['claude-opus-4-6'];
  if (model.includes('sonnet'))
    return MODEL_RATES['claude-sonnet-4-5-20250929'];
  return DEFAULT_RATE;
}

export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  const rate = getRate(model);
  return (
    (inputTokens * rate.input +
      outputTokens * rate.output +
      cacheRead * rate.cacheRead +
      cacheWrite * rate.cacheWrite) /
    1_000_000
  );
}

export interface InvocationData {
  source: string;
  checkId?: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  durationMs?: number;
  groupId?: string;
}

export function logInvocation(
  db: Database.Database,
  data: InvocationData,
): void {
  const cost = computeCost(
    data.model,
    data.usage.inputTokens,
    data.usage.outputTokens,
    data.usage.cacheReadTokens,
    data.usage.cacheWriteTokens,
  );
  try {
    db.prepare(
      `
      INSERT INTO cost_log
        (source, check_id, model, tokens_input, tokens_output,
         tokens_cache_read, tokens_cache_write, cost_usd, duration_ms, group_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      data.source,
      data.checkId ?? null,
      data.model,
      data.usage.inputTokens,
      data.usage.outputTokens,
      data.usage.cacheReadTokens,
      data.usage.cacheWriteTokens,
      cost,
      data.durationMs ?? null,
      data.groupId ?? 'personal',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to log invocation cost');
  }
}

// --- Query helpers ---

export function getMonthSummary(db: Database.Database): {
  totalCost: number;
  dailyAvg: number;
  month: string;
  bySource: Array<{ source: string; cost: number; count: number }>;
  byModel: Array<{ model: string; cost: number; count: number }>;
} {
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const start = `${month}-01T00:00:00`;
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    .toISOString()
    .slice(0, 16);

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_log WHERE timestamp >= ? AND timestamp < ?`,
    )
    .get(start, end) as { total: number };

  const bySource = db
    .prepare(
      `SELECT source, SUM(cost_usd) as cost, COUNT(*) as count
     FROM cost_log WHERE timestamp >= ? AND timestamp < ?
     GROUP BY source ORDER BY cost DESC`,
    )
    .all(start, end) as Array<{ source: string; cost: number; count: number }>;

  const byModel = db
    .prepare(
      `SELECT model, SUM(cost_usd) as cost, COUNT(*) as count
     FROM cost_log WHERE timestamp >= ? AND timestamp < ?
     GROUP BY model ORDER BY cost DESC`,
    )
    .all(start, end) as Array<{ model: string; cost: number; count: number }>;

  const total = totals.total ?? 0;
  const dayOfMonth = now.getDate();
  return {
    totalCost: total,
    dailyAvg: dayOfMonth > 0 ? total / dayOfMonth : 0,
    month,
    bySource,
    byModel,
  };
}

export function getTodayDetail(db: Database.Database): Array<{
  timestamp: string;
  source: string;
  model: string;
  cost: number;
  tokensInput: number;
  tokensOutput: number;
  durationMs: number | null;
}> {
  const today = new Date().toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT timestamp, source, model,
            cost_usd as cost, tokens_input as tokensInput,
            tokens_output as tokensOutput, duration_ms as durationMs
     FROM cost_log WHERE timestamp >= ? AND timestamp < ?
     ORDER BY timestamp DESC LIMIT 100`,
    )
    .all(`${today}T00:00:00`, `${today}T23:59:59`) as ReturnType<
    typeof getTodayDetail
  >;
}

export function getWeekSummary(
  db: Database.Database,
): Array<{ date: string; cost: number; count: number }> {
  const days: Array<{ date: string; cost: number; count: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const date = d.toISOString().slice(0, 10);
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) as cost, COUNT(*) as count
       FROM cost_log WHERE timestamp >= ? AND timestamp < ?`,
      )
      .get(`${date}T00:00:00`, `${date}T23:59:59`) as {
      cost: number;
      count: number;
    };
    days.push({ date, cost: row.cost ?? 0, count: row.count });
  }
  return days;
}

export function getHeartbeatSummary(db: Database.Database): Array<{
  checkId: string | null;
  cost: number;
  count: number;
}> {
  return db
    .prepare(
      `SELECT check_id as checkId, SUM(cost_usd) as cost, COUNT(*) as count
     FROM cost_log WHERE source LIKE 'heartbeat%'
     GROUP BY check_id ORDER BY cost DESC`,
    )
    .all() as ReturnType<typeof getHeartbeatSummary>;
}

// --- Telegram formatting ---

function bar(value: number, max: number, width = 8): string {
  if (max === 0) return '░'.repeat(width);
  const filled = Math.min(width, Math.round((value / max) * width));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function formatMonthlySummary(
  s: ReturnType<typeof getMonthSummary>,
): string {
  const lines = [
    `📊 Cost summary — ${s.month}`,
    `Total: $${s.totalCost.toFixed(4)}   Daily avg: $${s.dailyAvg.toFixed(4)}`,
    '',
  ];
  if (s.bySource.length > 0) {
    lines.push('By source:');
    const maxSrc = Math.max(...s.bySource.map((x) => x.cost));
    for (const row of s.bySource) {
      lines.push(
        `  ${bar(row.cost, maxSrc)} ${row.source} $${row.cost.toFixed(4)} (${row.count}x)`,
      );
    }
    lines.push('');
  }
  if (s.byModel.length > 0) {
    lines.push('By model:');
    const maxMod = Math.max(...s.byModel.map((x) => x.cost));
    for (const row of s.byModel) {
      const short = row.model.replace('claude-', '').slice(0, 30);
      lines.push(
        `  ${bar(row.cost, maxMod)} ${short} $${row.cost.toFixed(4)} (${row.count}x)`,
      );
    }
  }
  if (s.bySource.length === 0 && s.byModel.length === 0) {
    lines.push('No invocations recorded this month.');
  }
  return lines.join('\n');
}

export function formatTodayDetail(
  rows: ReturnType<typeof getTodayDetail>,
): string {
  if (rows.length === 0) return '📊 No invocations today.';
  const lines = ["📊 Today's invocations:"];
  for (const row of rows) {
    const time = row.timestamp.slice(11, 16) + 'Z';
    const dur =
      row.durationMs != null ? ` ${(row.durationMs / 1000).toFixed(1)}s` : '';
    const short = row.model.replace('claude-', '').slice(0, 20);
    lines.push(
      `  ${time} ${row.source} ${short} $${row.cost.toFixed(5)}${dur}`,
    );
  }
  const total = rows.reduce((s, r) => s + r.cost, 0);
  lines.push(`Total: $${total.toFixed(4)}`);
  return lines.join('\n');
}

export function formatWeekSummary(
  days: ReturnType<typeof getWeekSummary>,
): string {
  const lines = ['📊 Last 7 days:'];
  const maxCost = Math.max(...days.map((d) => d.cost), 0.0001);
  for (const day of days) {
    lines.push(
      `  ${day.date} ${bar(day.cost, maxCost)} $${day.cost.toFixed(4)} (${day.count}x)`,
    );
  }
  const total = days.reduce((s, d) => s + d.cost, 0);
  lines.push(`Total: $${total.toFixed(4)}`);
  return lines.join('\n');
}

export function formatHeartbeatSummary(
  rows: ReturnType<typeof getHeartbeatSummary>,
): string {
  if (rows.length === 0) return '📊 No heartbeat invocations recorded.';
  const lines = ['📊 Heartbeat costs by check_id:'];
  const maxCost = Math.max(...rows.map((r) => r.cost), 0.0001);
  for (const row of rows) {
    const id = row.checkId ?? '(none)';
    lines.push(
      `  ${bar(row.cost, maxCost)} ${id} $${row.cost.toFixed(4)} (${row.count}x)`,
    );
  }
  const total = rows.reduce((s, r) => s + r.cost, 0);
  lines.push(`Total: $${total.toFixed(4)}`);
  return lines.join('\n');
}
