export interface HeartbeatCheck {
  id: string;
  name: string;
  cadence: number; // minutes
  activeWindow?: { start: string; end: string }; // "HH:MM" local time
  priority: number;
  prompt: string;
  escalationTrigger: string;
  enabled: boolean;
}

export interface CheckState {
  lastRun: string;
  lastResult: 'ok' | 'alert';
  lastSummary?: string;
  consecutiveOks: number;
}

export interface HeartbeatState {
  checks: Record<string, CheckState>;
  lastTick: string;
}

export interface TriageResult {
  status: 'HEARTBEAT_OK' | 'HEARTBEAT_ALERT';
  checkId: string;
  summary?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  actionNeeded?: 'notify_only' | 'escalate_to_agent' | 'escalate_to_browser';
  details?: Record<string, unknown>;
}

export interface HeartbeatTickResult {
  checkId: string | null;
  checkName: string | null;
  status: 'ok' | 'alert' | 'skipped' | 'error';
  summary?: string;
}
