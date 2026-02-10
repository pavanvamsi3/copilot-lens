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
  branchTime: Record<string, number>; // total active time in ms per branch
  repoTime: Record<string, number>; // total active time in ms per repo
  modelUsage: Record<string, number>;
  mcpServers: Record<string, number>;
  toolSuccessRate: Record<string, { success: number; failure: number }>;
  turnsPerSession: number[];
  hourOfDay: Record<string, number>;
  errorTypes: Record<string, number>;
}

function getSessionDir(): string {
  return path.join(os.homedir(), ".copilot", "session-state");
}

function detectStatus(sessionDir: string, _updatedAt: string): SessionStatus {
  try {
    const eventsPath = path.join(sessionDir, "events.jsonl");

    // Check session.db + recent activity (session.db can be stale if not cleaned up)
    const dbPath = path.join(sessionDir, "session.db");
    if (fs.existsSync(dbPath)) {
      const dbAge = Date.now() - fs.statSync(dbPath).mtimeMs;
      if (dbAge < 600_000) return "running"; // session.db modified within 10 min
    }

    if (!fs.existsSync(eventsPath)) {
      // No events yet — only "running" if session.db exists (checked above)
      // A workspace.yaml alone with no events means the session was never active
      return "completed";
    }

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

    // No abort — check if events.jsonl recently modified
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

  // Calculate active duration from event timestamps (cap gaps at 5 min)
  let duration = 0;
  const timestamps = events
    .map((e) => new Date(e.timestamp).getTime())
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  if (timestamps.length >= 2) {
    const MAX_GAP = 300_000;
    for (let i = 1; i < timestamps.length; i++) {
      duration += Math.min(timestamps[i] - timestamps[i - 1], MAX_GAP);
    }
  }

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
  const branchTime: Record<string, number> = {};
  const repoTime: Record<string, number> = {};
  const modelUsage: Record<string, number> = {};
  const mcpServers: Record<string, number> = {};
  const toolSuccessRate: Record<string, { success: number; failure: number }> = {};
  const turnsPerSession: number[] = [];
  const hourOfDay: Record<string, number> = {};
  const errorTypes: Record<string, number> = {};
  const durations: number[] = [];
  const sessionDir = getSessionDir();

  for (const s of sessions) {
    // Sessions per day
    const day = s.createdAt.slice(0, 10);
    if (day) sessionsPerDay[day] = (sessionsPerDay[day] || 0) + 1;

    // Hour of day
    try {
      const hour = new Date(s.createdAt).getHours().toString().padStart(2, "0") + ":00";
      hourOfDay[hour] = (hourOfDay[hour] || 0) + 1;
    } catch {}

    // Duration — calculated from actual event activity, not updated_at - created_at
    // (sessions can be resumed days later, inflating the duration)
    // Computed below after scanning events.jsonl

    // Top directories
    const dirName = s.cwd || "unknown";
    topDirectories[dirName] = (topDirectories[dirName] || 0) + 1;

    // Branch activity
    const branch = s.branch || "unknown";

    // Scan events.jsonl for all metrics
    try {
      const eventsPath = path.join(sessionDir, s.id, "events.jsonl");
      if (fs.existsSync(eventsPath)) {
        const content = fs.readFileSync(eventsPath, "utf-8");
        let turnCount = 0;
        const timestamps: number[] = [];
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            // Collect timestamps for active duration
            if (event.timestamp) {
              const t = new Date(event.timestamp).getTime();
              if (t > 0) timestamps.push(t);
            }

            // Tool usage
            if (event.type === "tool.execution_start") {
              const tool = event.data?.tool || event.data?.toolName || "unknown";
              toolUsage[tool] = (toolUsage[tool] || 0) + 1;
            }

            // Tool success rate
            if (event.type === "tool.execution_complete") {
              const tool = event.data?.tool || event.data?.toolName || "unknown";
              if (!toolSuccessRate[tool]) toolSuccessRate[tool] = { success: 0, failure: 0 };
              if (event.data?.success) toolSuccessRate[tool].success++;
              else toolSuccessRate[tool].failure++;
            }

            // MCP servers
            if (event.type === "session.info" && event.data?.infoType === "mcp") {
              const msg = event.data?.message || "";
              const match = msg.match(/Configured MCP servers?:\s*(.+)/i);
              if (match) {
                for (const server of match[1].split(",").map((s: string) => s.trim())) {
                  if (server) mcpServers[server] = (mcpServers[server] || 0) + 1;
                }
              }
            }

            // Model usage
            if (event.type === "session.info" && event.data?.infoType === "model") {
              const msg = event.data?.message || "";
              const match = msg.match(/Model changed to:\s*([^\s.]+(?:[-.][^\s.]+)*)/i);
              if (match) modelUsage[match[1]] = (modelUsage[match[1]] || 0) + 1;
            }
            if (event.type === "session.start" && event.data?.model) {
              const model = event.data.model;
              modelUsage[model] = (modelUsage[model] || 0) + 1;
            }

            // Turn counting
            if (event.type === "assistant.turn_start") turnCount++;

            // Errors
            if (event.type === "session.error") {
              const errType = event.data?.errorType || "unknown";
              errorTypes[errType] = (errorTypes[errType] || 0) + 1;
            }
          } catch {}
        }
        if (turnCount > 0) turnsPerSession.push(turnCount);

        // Calculate active duration: sum gaps between events, cap each gap at 5 min
        if (timestamps.length >= 2) {
          timestamps.sort((a, b) => a - b);
          let activeDur = 0;
          const MAX_GAP = 300_000; // 5 minutes
          for (let i = 1; i < timestamps.length; i++) {
            const gap = timestamps[i] - timestamps[i - 1];
            activeDur += Math.min(gap, MAX_GAP);
          }
          if (activeDur > 0) {
            durations.push(activeDur);
            branchTime[branch] = (branchTime[branch] || 0) + activeDur;
            const repo = s.gitRoot || s.cwd || "unknown";
            repoTime[repo] = (repoTime[repo] || 0) + activeDur;
          }
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
    branchTime,
    repoTime,
    modelUsage,
    mcpServers,
    toolSuccessRate,
    turnsPerSession,
    hourOfDay,
    errorTypes,
  };
}
