import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parse as parseYaml } from "yaml";
import { listVSCodeSessions, getVSCodeSession, isVSCodeSession, getVSCodeAnalytics, normalizeVSCodeToolName, scanVSCodeMcpConfig } from "./vscode-sessions";

export type SessionStatus = "running" | "completed" | "error";
export type SessionSource = "cli" | "vscode";

export interface SessionMeta {
  id: string;
  cwd: string;
  gitRoot?: string;
  branch?: string;
  createdAt: string;
  updatedAt: string;
  summaryCount?: number;
  status: SessionStatus;
  source: SessionSource;
  title?: string;
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
  source: SessionSource;
  title?: string;
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

function listCliSessions(): SessionMeta[] {
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
        source: "cli",
      });
    } catch {
      // skip corrupted files
    }
  }

  return sessions;
}

export function listSessions(): SessionMeta[] {
  const cli = listCliSessions();
  let vscode: SessionMeta[] = [];
  try {
    vscode = listVSCodeSessions();
  } catch {
    // VS Code data may not exist
  }

  const sessions = [...cli, ...vscode];
  sessions.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  return sessions;
}

export function getSession(sessionId: string): SessionDetail | null {
  // Check VS Code sessions first (avoids filesystem miss for CLI)
  try {
    if (isVSCodeSession(sessionId)) {
      return getVSCodeSession(sessionId);
    }
  } catch {}

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
    source: "cli",
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

    // Top directories
    const dirName = s.source === "vscode" ? "VS Code" : (s.cwd || "unknown");
    topDirectories[dirName] = (topDirectories[dirName] || 0) + 1;

    // Branch activity
    const branch = s.branch || "unknown";

    // Skip VS Code sessions here — handled separately below
    if (s.source === "vscode") continue;

    // Scan events.jsonl for all metrics (CLI only)
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
            if (event.type === "session.model_change" && event.data?.newModel) {
              const model = event.data.newModel;
              modelUsage[model] = (modelUsage[model] || 0) + 1;
            }
            if (event.type === "session.info" && event.data?.infoType === "model") {
              const msg = event.data?.message || "";
              const match = msg.match(/Model changed to:\s*([^\s.]+(?:[-.][^\s.]+)*)/i);
              if (match) modelUsage[match[1]] = (modelUsage[match[1]] || 0) + 1;
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

  // Integrate VS Code session analytics
  try {
    const vscodeEntries = getVSCodeAnalytics();
    for (const entry of vscodeEntries) {
      // Tool usage
      for (const [tool, count] of Object.entries(entry.toolUsage)) {
        toolUsage[tool] = (toolUsage[tool] || 0) + count;
      }
      // Model usage
      for (const [model, count] of Object.entries(entry.modelUsage)) {
        modelUsage[model] = (modelUsage[model] || 0) + count;
      }
      // Turns
      if (entry.turnCount > 0) turnsPerSession.push(entry.turnCount);
      // Duration
      if (entry.duration > 0) durations.push(entry.duration);
    }
  } catch {}

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

// ============ Insights / Scoring ============

export interface RepoScore {
  repo: string;
  totalScore: number;
  sessionCount: number;
  categories: {
    promptQuality: CategoryScore;
    toolUtilization: CategoryScore;
    efficiency: CategoryScore;
    mcpUtilization: CategoryScore;
    engagement: CategoryScore;
  };
  tips: string[];
}

export interface CategoryScore {
  score: number;
  maxScore: number;
  label: string;
  detail: string;
}

function scanMcpConfig(repoPath: string): string[] {
  const configPaths = [
    path.join(repoPath, ".vscode", "mcp.json"),
    path.join(repoPath, ".github", "copilot", "mcp.json"),
  ];
  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        let raw = fs.readFileSync(configPath, "utf-8");
        // Strip trailing commas (JSONC / VS Code style)
        raw = raw.replace(/,\s*([\]}])/g, "$1");
        const config = JSON.parse(raw);
        const servers = config.servers || config.mcpServers || {};
        return Object.keys(servers);
      }
    } catch {}
  }
  return [];
}

interface RepoSessionData {
  msgLengths: number[];
  askUserCount: number;
  totalUserMsgs: number;
  toolsUsed: Set<string>;
  toolSuccess: number;
  toolTotal: number;
  turns: number[];
  durations: number[];
  mcpServersUsed: Set<string>;
  sessionDays: Set<string>;
  sessionCount: number;
}

function collectRepoData(repoPath: string): RepoSessionData {
  const sessions = listSessions();
  const repoSessions = sessions.filter(
    (s) => (s.gitRoot || s.cwd) === repoPath
  );

  const data: RepoSessionData = {
    msgLengths: [],
    askUserCount: 0,
    totalUserMsgs: 0,
    toolsUsed: new Set(),
    toolSuccess: 0,
    toolTotal: 0,
    turns: [],
    durations: [],
    mcpServersUsed: new Set(),
    sessionDays: new Set(),
    sessionCount: repoSessions.length,
  };

  const sessionDir = getSessionDir();

  for (const s of repoSessions) {
    const day = s.createdAt.slice(0, 10);
    if (day) data.sessionDays.add(day);

    try {
      const eventsPath = path.join(sessionDir, s.id, "events.jsonl");
      if (!fs.existsSync(eventsPath)) continue;
      const content = fs.readFileSync(eventsPath, "utf-8");
      let turnCount = 0;
      const timestamps: number[] = [];

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.timestamp) {
            const t = new Date(event.timestamp).getTime();
            if (t > 0) timestamps.push(t);
          }

          if (event.type === "user.message") {
            const msg = event.data?.content || event.data?.transformedContent || "";
            data.msgLengths.push(msg.length);
            data.totalUserMsgs++;
          }

          if (event.type === "tool.execution_start") {
            const tool = event.data?.tool || event.data?.toolName || "";
            if (tool) data.toolsUsed.add(tool);
            if (tool === "ask_user") data.askUserCount++;
          }

          if (event.type === "tool.execution_complete") {
            data.toolTotal++;
            if (event.data?.success) data.toolSuccess++;
          }

          if (event.type === "assistant.turn_start") turnCount++;

          if (event.type === "session.info" && event.data?.infoType === "mcp") {
            const msg = event.data?.message || "";
            const match = msg.match(/Configured MCP servers?:\s*(.+)/i);
            if (match) {
              for (const server of match[1].split(",").map((s: string) => s.trim())) {
                if (server) data.mcpServersUsed.add(server);
              }
            }
          }
        } catch {}
      }

      if (turnCount > 0) data.turns.push(turnCount);

      if (timestamps.length >= 2) {
        timestamps.sort((a, b) => a - b);
        let dur = 0;
        for (let i = 1; i < timestamps.length; i++) {
          dur += Math.min(timestamps[i] - timestamps[i - 1], 300_000);
        }
        if (dur > 0) data.durations.push(dur);
      }
    } catch {}
  }

  return data;
}

function scorePromptQuality(data: RepoSessionData): CategoryScore {
  const avgLen = data.msgLengths.length
    ? data.msgLengths.reduce((a, b) => a + b, 0) / data.msgLengths.length
    : 0;
  const askRatio = data.totalUserMsgs > 0 ? data.askUserCount / data.totalUserMsgs : 0;

  let score = 0;
  let detail = "";

  if (avgLen >= 100) { score = 20; detail = `Avg prompt length: ${Math.round(avgLen)} chars (excellent)`; }
  else if (avgLen >= 50) { score = 15; detail = `Avg prompt length: ${Math.round(avgLen)} chars (good)`; }
  else if (avgLen >= 20) { score = 10; detail = `Avg prompt length: ${Math.round(avgLen)} chars (fair)`; }
  else { score = 5; detail = `Avg prompt length: ${Math.round(avgLen)} chars (short)`; }

  // Penalty for high ask_user ratio (copilot needing clarification)
  const penalty = Math.floor(askRatio * 30);
  score = Math.max(0, score - penalty);
  if (penalty > 0) detail += ` | ${Math.round(askRatio * 100)}% needed clarification`;

  return { score, maxScore: 20, label: "Prompt Quality", detail };
}

function scoreToolUtilization(data: RepoSessionData): CategoryScore {
  const count = data.toolsUsed.size;
  let score = 0;
  let detail = `${count} distinct tools used`;

  if (count >= 7) { score = 20; detail += " (excellent diversity)"; }
  else if (count >= 5) { score = 15; detail += " (good diversity)"; }
  else if (count >= 3) { score = 10; detail += " (moderate)"; }
  else { score = 5; detail += " (limited)"; }

  return { score, maxScore: 20, label: "Tool Utilization", detail };
}

function scoreEfficiency(data: RepoSessionData): CategoryScore {
  const successRate = data.toolTotal > 0 ? data.toolSuccess / data.toolTotal : 1;
  const avgTurns = data.turns.length
    ? data.turns.reduce((a, b) => a + b, 0) / data.turns.length
    : 0;

  let score = 0;
  let detail = "";

  if (successRate >= 0.9) { score = 15; detail = `${Math.round(successRate * 100)}% tool success rate`; }
  else if (successRate >= 0.8) { score = 10; detail = `${Math.round(successRate * 100)}% tool success rate`; }
  else if (successRate >= 0.7) { score = 7; detail = `${Math.round(successRate * 100)}% tool success rate`; }
  else { score = 4; detail = `${Math.round(successRate * 100)}% tool success rate`; }

  // Bonus for concise sessions
  if (avgTurns > 0 && avgTurns < 15) {
    score = Math.min(20, score + 5);
    detail += ` | Avg ${Math.round(avgTurns)} turns/session (concise)`;
  } else if (avgTurns >= 15) {
    detail += ` | Avg ${Math.round(avgTurns)} turns/session`;
  }

  return { score, maxScore: 20, label: "Efficiency", detail };
}

function scoreMcpUtilization(data: RepoSessionData, configuredServers: string[]): CategoryScore {
  let score = 0;
  let detail = "";

  if (configuredServers.length === 0) {
    score = 10;
    detail = "No MCP servers configured (neutral)";
  } else {
    // Fuzzy match: config name "bluebird-mcp" matches usage "bluebird" or tool "bluebird-engineering_copilot"
    const usedServers = [...data.mcpServersUsed, ...data.toolsUsed];
    const used = configuredServers.filter((configured) => {
      const cfgLower = configured.toLowerCase().replace(/[-_\s]/g, "");
      return usedServers.some((u) => {
        const uLower = u.toLowerCase().replace(/[-_\s]/g, "");
        return uLower.includes(cfgLower) || cfgLower.includes(uLower);
      });
    });
    const ratio = used.length / configuredServers.length;
    if (ratio >= 0.8) { score = 20; detail = `Using ${used.length}/${configuredServers.length} configured MCP servers`; }
    else if (ratio >= 0.5) { score = 15; detail = `Using ${used.length}/${configuredServers.length} configured MCP servers`; }
    else if (ratio > 0) { score = 10; detail = `Using ${used.length}/${configuredServers.length} configured MCP servers`; }
    else { score = 5; detail = `${configuredServers.length} MCP servers configured but none used`; }
  }

  return { score, maxScore: 20, label: "MCP Utilization", detail };
}

function scoreEngagement(data: RepoSessionData): CategoryScore {
  const avgDur = data.durations.length
    ? data.durations.reduce((a, b) => a + b, 0) / data.durations.length
    : 0;
  const avgMin = avgDur / 60000;

  let score = 0;
  let detail = "";

  if (avgMin >= 5 && avgMin <= 30) { score = 15; detail = `Avg session: ${Math.round(avgMin)}min (ideal)`; }
  else if (avgMin > 30) { score = 10; detail = `Avg session: ${Math.round(avgMin)}min (long)`; }
  else if (avgMin > 0) { score = 7; detail = `Avg session: ${Math.round(avgMin)}min (brief)`; }
  else { score = 3; detail = "No session duration data"; }

  // Bonus for consistency
  const days = data.sessionDays.size;
  if (days >= 7) {
    score = Math.min(20, score + 5);
    detail += ` | Active on ${days} days (consistent)`;
  } else if (days >= 3) {
    score = Math.min(20, score + 3);
    detail += ` | Active on ${days} days`;
  } else {
    detail += ` | Active on ${days} day(s)`;
  }

  return { score, maxScore: 20, label: "Engagement", detail };
}

function generateTips(categories: RepoScore["categories"], data: RepoSessionData, configuredServers: string[]): string[] {
  const tips: string[] = [];

  if (categories.promptQuality.score < 15) {
    const avgLen = data.msgLengths.length
      ? Math.round(data.msgLengths.reduce((a, b) => a + b, 0) / data.msgLengths.length)
      : 0;
    tips.push(`Your prompts average ${avgLen} chars — try adding more context, expected behavior, and constraints to reduce back-and-forth.`);
  }

  if (categories.toolUtilization.score < 15) {
    const used = [...data.toolsUsed];
    const suggestions = ["grep", "glob", "edit", "task", "view"].filter((t) => !used.includes(t));
    if (suggestions.length > 0) {
      tips.push(`Try using ${suggestions.slice(0, 3).join(", ")} — these tools can speed up your workflow.`);
    }
  }

  if (categories.efficiency.score < 15) {
    const successRate = data.toolTotal > 0 ? Math.round((data.toolSuccess / data.toolTotal) * 100) : 100;
    if (successRate < 85) {
      tips.push(`Your tool success rate is ${successRate}% — review failing commands and provide clearer instructions.`);
    }
  }

  if (categories.mcpUtilization.score < 15 && configuredServers.length > 0) {
    const usedServers = [...data.mcpServersUsed, ...data.toolsUsed];
    const unused = configuredServers.filter((configured) => {
      const cfgLower = configured.toLowerCase().replace(/[-_\s]/g, "");
      return !usedServers.some((u) => {
        const uLower = u.toLowerCase().replace(/[-_\s]/g, "");
        return uLower.includes(cfgLower) || cfgLower.includes(uLower);
      });
    });
    if (unused.length > 0) {
      tips.push(`You have unused MCP servers: ${unused.join(", ")}. Try leveraging them in your prompts.`);
    }
  } else if (configuredServers.length === 0) {
    tips.push("Consider adding MCP servers to your project for enhanced capabilities (e.g., database access, API integrations).");
  }

  if (categories.engagement.score < 15) {
    const avgDur = data.durations.length
      ? data.durations.reduce((a, b) => a + b, 0) / data.durations.length / 60000
      : 0;
    if (avgDur < 5) {
      tips.push("Your sessions are very brief — try tackling larger tasks with Copilot for more impactful results.");
    }
    if (data.sessionDays.size < 3) {
      tips.push("Use Copilot more regularly to build momentum and improve your workflow.");
    }
  }

  if (tips.length === 0) {
    tips.push("Great job! You're using Copilot CLI effectively. Keep it up! 🎉");
  }

  return tips;
}

export function getRepoScore(repoPath: string): RepoScore {
  const data = collectRepoData(repoPath);
  const configuredServers = scanMcpConfig(repoPath);

  const categories = {
    promptQuality: scorePromptQuality(data),
    toolUtilization: scoreToolUtilization(data),
    efficiency: scoreEfficiency(data),
    mcpUtilization: scoreMcpUtilization(data, configuredServers),
    engagement: scoreEngagement(data),
  };

  const totalScore = Object.values(categories).reduce((sum, c) => sum + c.score, 0);
  const tips = generateTips(categories, data, configuredServers);

  return {
    repo: repoPath,
    totalScore,
    sessionCount: data.sessionCount,
    categories,
    tips,
  };
}

export function listReposWithScores(): RepoScore[] {
  const sessions = listSessions();
  const repos = new Set<string>();
  for (const s of sessions) {
    const repo = s.gitRoot || s.cwd;
    if (repo) repos.add(repo);
  }

  const results = [...repos]
    .map((repo) => getRepoScore(repo))
    .filter((r) => r.sessionCount >= 3) // minimum 3 sessions
    .sort((a, b) => b.totalScore - a.totalScore);

  // Append VS Code global score if there are enough sessions
  try {
    const vsScore = getVSCodeScore();
    if (vsScore.sessionCount >= 2) {
      results.push(vsScore);
      results.sort((a, b) => b.totalScore - a.totalScore);
    }
  } catch {}

  return results;
}

// ============ VS Code Global Scoring ============

function collectVSCodeData(): RepoSessionData {
  const analytics = getVSCodeAnalytics();

  const data: RepoSessionData = {
    msgLengths: [],
    askUserCount: 0,
    totalUserMsgs: 0,
    toolsUsed: new Set(),
    toolSuccess: 0,
    toolTotal: 0,
    turns: [],
    durations: [],
    mcpServersUsed: new Set(),
    sessionDays: new Set(),
    sessionCount: analytics.length,
  };

  for (const entry of analytics) {
    // Session days
    const day = entry.createdAt.slice(0, 10);
    if (day) data.sessionDays.add(day);

    // Turns
    if (entry.turnCount > 0) data.turns.push(entry.turnCount);

    // Duration
    if (entry.duration > 0) data.durations.push(entry.duration);

    // Tool usage — normalize names and extract MCP servers
    for (const [rawTool, count] of Object.entries(entry.toolUsage)) {
      const { tool, mcpServer } = normalizeVSCodeToolName(rawTool);
      data.toolsUsed.add(tool);
      data.toolTotal += count;
      data.toolSuccess += count; // VS Code doesn't track tool failures; assume success
      if (mcpServer) data.mcpServersUsed.add(mcpServer);
    }
  }

  // Collect message lengths by reading session content
  // (analytics already parsed the files — re-read from analytics entries' request data)
  // Instead, do a separate lightweight pass using getVSCodeAnalytics data
  // We need the actual message text, which analytics doesn't store.
  // Reuse the session reading infrastructure:
  for (const entry of analytics) {
    try {
      const session = getVSCodeSession(entry.sessionId);
      if (!session) continue;
      for (const event of session.events) {
        if (event.type === "user.message") {
          const msg = event.data?.content || "";
          if (msg) {
            data.msgLengths.push(msg.length);
            data.totalUserMsgs++;
          }
        }
      }
    } catch {}
  }

  return data;
}

export function getVSCodeScore(): RepoScore {
  const data = collectVSCodeData();
  const configuredServers = scanVSCodeMcpConfig();

  const categories = {
    promptQuality: scorePromptQuality(data),
    toolUtilization: scoreToolUtilization(data),
    efficiency: scoreEfficiency(data),
    mcpUtilization: scoreMcpUtilization(data, configuredServers),
    engagement: scoreEngagement(data),
  };

  const totalScore = Object.values(categories).reduce((sum, c) => sum + c.score, 0);
  const tips = generateTips(categories, data, configuredServers);

  return {
    repo: "VS Code",
    totalScore,
    sessionCount: data.sessionCount,
    categories,
    tips,
  };
}
