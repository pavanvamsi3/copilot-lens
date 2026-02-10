import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parse as parseYaml } from "yaml";

export type SessionStatus = "running" | "completed" | "error";

export interface SessionMeta {
  id: string;
  cwd: string;
  gitRoot?: string;
  branch?: string;
  createdAt: string;
  updatedAt: string;
  summaryCount?: number;
  status: SessionStatus;
}

export interface SessionEvent {
  type: string;
  id: string;
  timestamp: string;
  data: Record<string, any>;
}

export interface SessionDetail extends SessionMeta {
  events: SessionEvent[];
  planContent?: string;
  hasSnapshots: boolean;
  copilotVersion?: string;
  eventCounts: Record<string, number>;
  duration: number; // milliseconds
  status: SessionStatus;
}

export interface AnalyticsData {
  totalSessions: number;
  sessionsPerDay: Record<string, number>;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  totalDuration: number;
  toolUsage: Record<string, number>;
  topDirectories: Record<string, number>;
  branchActivity: Record<string, number>;
}

function getSessionDir(): string {
  return path.join(os.homedir(), ".copilot", "session-state");
}

function detectStatus(sessionDir: string, _updatedAt: string): SessionStatus {
  try {
    // session.db only exists for actively running sessions — strongest signal
    if (fs.existsSync(path.join(sessionDir, "session.db"))) return "running";

    const eventsPath = path.join(sessionDir, "events.jsonl");
    if (!fs.existsSync(eventsPath)) return "completed";

    // Only read the last 2KB to check for abort events (avoid reading huge files)
    const stat = fs.statSync(eventsPath);
    const readSize = Math.min(stat.size, 2048);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(eventsPath, "r");
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);

    const tail = buf.toString("utf-8");
    const lines = tail.trimEnd().split("\n").filter(Boolean);

    // Check last few lines for abort signals
    for (const line of lines.slice(-5)) {
      try {
        const event = JSON.parse(line);
        if (event.type === "abort") {
          return event.data?.reason === "user initiated" ? "completed" : "error";
        }
      } catch {}
    }

    // No abort — check if recently modified
    const age = Date.now() - stat.mtimeMs;
    if (age < 300_000) return "running";
  } catch {}

  return "completed";
}

export function listSessions(): SessionMeta[] {
  const dir = getSessionDir();
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const sessions: SessionMeta[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wsPath = path.join(dir, entry.name, "workspace.yaml");
    if (!fs.existsSync(wsPath)) continue;

    try {
      const raw = fs.readFileSync(wsPath, "utf-8");
      const ws = parseYaml(raw);
      const sessionPath = path.join(dir, entry.name);
      const updatedAt = ws.updated_at || "";
      sessions.push({
        id: ws.id || entry.name,
        cwd: ws.cwd || "",
        gitRoot: ws.git_root,
        branch: ws.branch,
        createdAt: ws.created_at || "",
        updatedAt,
        summaryCount: ws.summary_count,
        status: detectStatus(sessionPath, updatedAt),
      });
    } catch {
      // skip corrupted files
    }
  }

  sessions.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  return sessions;
}

export function getSession(sessionId: string): SessionDetail | null {
  const dir = path.join(getSessionDir(), sessionId);
  if (!fs.existsSync(dir)) return null;

  // Parse workspace.yaml
  const wsPath = path.join(dir, "workspace.yaml");
  if (!fs.existsSync(wsPath)) return null;

  let ws: any;
  try {
    ws = parseYaml(fs.readFileSync(wsPath, "utf-8"));
  } catch {
    return null;
  }

  // Parse events.jsonl
  const events: SessionEvent[] = [];
  const eventsPath = path.join(dir, "events.jsonl");
  try {
    if (fs.existsSync(eventsPath)) {
      const lines = fs.readFileSync(eventsPath, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          // skip malformed lines
        }
      }
    }
  } catch {
    // file may be locked by active session
  }

  // Read plan.md
  let planContent: string | undefined;
  const planPath = path.join(dir, "plan.md");
  if (fs.existsSync(planPath)) {
    planContent = fs.readFileSync(planPath, "utf-8");
  }

  // Check snapshots
  const hasSnapshots = fs.existsSync(
    path.join(dir, "rewind-snapshots", "index.json")
  );

  // Extract copilot version from session.start event
  const startEvent = events.find((e) => e.type === "session.start");
  const copilotVersion = startEvent?.data?.copilotVersion;

  // Count events by type
  const eventCounts: Record<string, number> = {};
  for (const e of events) {
    eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
  }

  // Calculate duration
  const created = new Date(ws.created_at).getTime();
  const updated = new Date(ws.updated_at).getTime();
  const duration = updated - created;

  return {
    id: ws.id || sessionId,
    cwd: ws.cwd || "",
    gitRoot: ws.git_root,
    branch: ws.branch,
    createdAt: ws.created_at || "",
    updatedAt: ws.updated_at || "",
    summaryCount: ws.summary_count,
    events,
    planContent,
    hasSnapshots,
    copilotVersion,
    eventCounts,
    duration,
    status: detectStatus(dir, ws.updated_at || ""),
  };
}

export function getAnalytics(): AnalyticsData {
  const sessions = listSessions();
  const sessionsPerDay: Record<string, number> = {};
  const toolUsage: Record<string, number> = {};
  const topDirectories: Record<string, number> = {};
  const branchActivity: Record<string, number> = {};
  const durations: number[] = [];
  const sessionDir = getSessionDir();

  for (const s of sessions) {
    // Sessions per day
    const day = s.createdAt.slice(0, 10);
    if (day) sessionsPerDay[day] = (sessionsPerDay[day] || 0) + 1;

    // Duration
    const dur =
      new Date(s.updatedAt).getTime() - new Date(s.createdAt).getTime();
    if (dur > 0) durations.push(dur);

    // Top directories
    const dirName = s.cwd || "unknown";
    topDirectories[dirName] = (topDirectories[dirName] || 0) + 1;

    // Branch activity
    const branch = s.branch || "unknown";
    branchActivity[branch] = (branchActivity[branch] || 0) + 1;

    // Tool usage — scan events.jsonl line by line without loading full detail
    try {
      const eventsPath = path.join(sessionDir, s.id, "events.jsonl");
      if (fs.existsSync(eventsPath)) {
        const content = fs.readFileSync(eventsPath, "utf-8");
        for (const line of content.split("\n")) {
          if (!line.includes("tool.execution_start")) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "tool.execution_start") {
              const tool = event.data?.tool || event.data?.toolName || "unknown";
              toolUsage[tool] = (toolUsage[tool] || 0) + 1;
            }
          } catch {}
        }
      }
    } catch {}
  }

  const totalDuration = durations.reduce((a, b) => a + b, 0);

  return {
    totalSessions: sessions.length,
    sessionsPerDay,
    avgDuration: durations.length ? totalDuration / durations.length : 0,
    minDuration: durations.length ? Math.min(...durations) : 0,
    maxDuration: durations.length ? Math.max(...durations) : 0,
    totalDuration,
    toolUsage,
    topDirectories,
    branchActivity,
  };
}
