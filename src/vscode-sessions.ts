import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";
import type { SessionMeta, SessionDetail, SessionEvent, SessionStatus } from "./sessions";

// ============ Platform paths ============

function getVSCodeDataDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [];

  const variants = ["Code", "Code - Insiders"];
  for (const variant of variants) {
    if (process.platform === "darwin") {
      dirs.push(path.join(home, "Library", "Application Support", variant));
    } else if (process.platform === "win32") {
      const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      dirs.push(path.join(appData, variant));
    } else {
      dirs.push(path.join(home, ".config", variant));
    }
  }

  return dirs.filter((d) => fs.existsSync(d));
}

// ============ Index reading (from state.vscdb) ============

interface VSCodeSessionIndex {
  sessionId: string;
  title: string;
  lastMessageDate: number;
  timing?: { startTime: number; endTime?: number };
  isEmpty: boolean;
  initialLocation?: string;
}

function readSessionIndex(dataDir: string): VSCodeSessionIndex[] {
  const dbPath = path.join(dataDir, "User", "globalStorage", "state.vscdb");
  if (!fs.existsSync(dbPath)) return [];

  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("chat.ChatSessionStore.index") as { value: string } | undefined;
    db.close();

    if (!row) return [];
    const data = JSON.parse(row.value);
    const entries: Record<string, VSCodeSessionIndex> = data.entries || {};
    return Object.values(entries);
  } catch {
    return [];
  }
}

// ============ Session content reading ============

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB cap
const MAX_TEXT_LENGTH = 10_000; // truncate huge pasted text

function findSessionFile(dataDir: string, sessionId: string): string | null {
  const paths = [
    path.join(dataDir, "User", "globalStorage", "emptyWindowChatSessions", `${sessionId}.json`),
  ];

  // Also check workspaceStorage directories
  const wsDir = path.join(dataDir, "User", "workspaceStorage");
  if (fs.existsSync(wsDir)) {
    try {
      for (const entry of fs.readdirSync(wsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          paths.push(path.join(wsDir, entry.name, "chatSessions", `${sessionId}.json`));
        }
      }
    } catch {}
  }

  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readSessionContent(filePath: string): any | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return null;

    const raw = fs.readFileSync(filePath, "utf-8");

    // Use a reviver to strip image data inline during parsing
    const data = JSON.parse(raw, (_key, value) => {
      // Strip base64 image values from variableData variables
      if (
        value &&
        typeof value === "object" &&
        value.kind === "image" &&
        typeof value.value === "string" &&
        value.value.length > 1000
      ) {
        return { ...value, value: "[image data omitted]" };
      }
      return value;
    });

    // Truncate huge message text
    if (data.requests) {
      for (const req of data.requests) {
        const msg = req.message;
        if (msg && typeof msg.text === "string" && msg.text.length > MAX_TEXT_LENGTH) {
          msg.text = msg.text.slice(0, MAX_TEXT_LENGTH) + "\n...(truncated)";
        }
        if (msg?.parts) {
          for (const part of msg.parts) {
            if (part && typeof part.text === "string" && part.text.length > MAX_TEXT_LENGTH) {
              part.text = part.text.slice(0, MAX_TEXT_LENGTH) + "\n...(truncated)";
            }
          }
        }
      }
    }

    return data;
  } catch {
    return null;
  }
}

// ============ Data normalization ============

function deriveStatus(index: VSCodeSessionIndex): SessionStatus {
  if (index.timing?.endTime) return "completed";
  if (!index.timing?.startTime) return "completed";
  // No endTime — check if recently active
  const age = Date.now() - (index.lastMessageDate || index.timing.startTime);
  return age < 600_000 ? "running" : "completed";
}

function msToIso(ms: number | undefined): string {
  if (!ms) return "";
  return new Date(ms).toISOString();
}

function requestsToEvents(requests: any[]): SessionEvent[] {
  const events: SessionEvent[] = [];

  for (const req of requests) {
    const ts = req.timestamp ? new Date(req.timestamp).toISOString() : "";

    // User message
    const userText = req.message?.text || "";
    if (userText) {
      events.push({
        type: "user.message",
        id: req.requestId || "",
        timestamp: ts,
        data: { content: userText },
      });
    }

    // Assistant turn start
    events.push({
      type: "assistant.turn_start",
      id: `turn-${req.requestId || ""}`,
      timestamp: ts,
      data: {},
    });

    // Tool invocations from response parts
    const response = Array.isArray(req.response) ? req.response : [];
    for (const part of response) {
      if (!part || typeof part !== "object") continue;

      if (part.kind === "toolInvocationSerialized") {
        const toolName = part.originMessage || part.invocationMessage?.value || "unknown";
        events.push({
          type: "tool.execution_start",
          id: part.toolCallId || "",
          timestamp: ts,
          data: { tool: toolName, toolName },
        });
        events.push({
          type: "tool.execution_complete",
          id: part.toolCallId || "",
          timestamp: ts,
          data: { tool: toolName, toolName, success: true },
        });
      }
    }

    // Assistant response — collect text parts
    const textParts: string[] = [];
    for (const part of response) {
      if (!part || typeof part !== "object") continue;
      if (part.kind === "thinking" && part.value) continue; // skip thinking
      if (!part.kind && typeof part.value === "string") {
        textParts.push(part.value);
      }
    }
    // Also include result text
    const resultText = req.result?.value;
    if (resultText) textParts.push(resultText);

    const fullResponse = textParts.join("\n").trim();
    if (fullResponse) {
      // Estimate response timestamp as slightly after user message
      const respTs = req.modelState?.completedAt
        ? new Date(req.modelState.completedAt).toISOString()
        : ts;
      events.push({
        type: "assistant.message",
        id: req.responseId || `resp-${req.requestId || ""}`,
        timestamp: respTs,
        data: { content: fullResponse },
      });
    }
  }

  return events;
}

// ============ Public API ============

export function listVSCodeSessions(): SessionMeta[] {
  const sessions: SessionMeta[] = [];

  for (const dataDir of getVSCodeDataDirs()) {
    const entries = readSessionIndex(dataDir);
    for (const entry of entries) {
      if (entry.isEmpty) continue;

      sessions.push({
        id: entry.sessionId,
        cwd: "",
        createdAt: msToIso(entry.timing?.startTime || entry.lastMessageDate),
        updatedAt: msToIso(entry.timing?.endTime || entry.lastMessageDate),
        status: deriveStatus(entry),
        source: "vscode",
        title: entry.title || undefined,
      });
    }
  }

  return sessions;
}

export function getVSCodeSession(sessionId: string): SessionDetail | null {
  for (const dataDir of getVSCodeDataDirs()) {
    const filePath = findSessionFile(dataDir, sessionId);
    if (!filePath) continue;

    const content = readSessionContent(filePath);
    if (!content) continue;

    const requests = content.requests || [];
    const events = requestsToEvents(requests);

    // Event counts
    const eventCounts: Record<string, number> = {};
    for (const e of events) {
      eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
    }

    // Duration from timing or request timestamps
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

    // Extract model from first request or selectedModel
    const modelId = requests[0]?.modelId || content.selectedModel?.metadata?.name;

    // Derive status from index
    const entries = readSessionIndex(dataDir);
    const indexEntry = entries.find((e) => e.sessionId === sessionId);
    const status = indexEntry ? deriveStatus(indexEntry) : "completed";

    return {
      id: content.sessionId || sessionId,
      cwd: "",
      createdAt: msToIso(content.creationDate || content.timing?.startTime),
      updatedAt: msToIso(content.lastMessageDate),
      events,
      planContent: undefined,
      hasSnapshots: false,
      copilotVersion: undefined,
      eventCounts,
      duration,
      status,
      source: "vscode",
      title: content.customTitle || indexEntry?.title || undefined,
    };
  }

  return null;
}

/** Check if a session ID belongs to a VS Code session */
export function isVSCodeSession(sessionId: string): boolean {
  for (const dataDir of getVSCodeDataDirs()) {
    const entries = readSessionIndex(dataDir);
    if (entries.some((e) => e.sessionId === sessionId)) return true;
  }
  return false;
}

/** Extract analytics-relevant data from VS Code sessions without full parse */
export interface VSCodeAnalyticsEntry {
  sessionId: string;
  title: string;
  createdAt: string;
  duration: number;
  toolUsage: Record<string, number>;
  modelUsage: Record<string, number>;
  turnCount: number;
  requestCount: number;
}

export function getVSCodeAnalytics(): VSCodeAnalyticsEntry[] {
  const results: VSCodeAnalyticsEntry[] = [];

  for (const dataDir of getVSCodeDataDirs()) {
    const entries = readSessionIndex(dataDir);

    for (const entry of entries) {
      if (entry.isEmpty) continue;

      const filePath = findSessionFile(dataDir, entry.sessionId);
      if (!filePath) continue;

      const content = readSessionContent(filePath);
      if (!content?.requests) continue;

      const toolUsage: Record<string, number> = {};
      const modelUsage: Record<string, number> = {};
      let turnCount = 0;

      for (const req of content.requests) {
        turnCount++;

        // Model usage
        const model = req.modelId || "";
        if (model) {
          // Normalize model id: "copilot/claude-sonnet-4.5" → "claude-sonnet-4.5"
          const shortModel = model.includes("/") ? model.split("/").pop()! : model;
          modelUsage[shortModel] = (modelUsage[shortModel] || 0) + 1;
        }

        // Tool usage from response parts
        const response = Array.isArray(req.response) ? req.response : [];
        for (const part of response) {
          if (part?.kind === "toolInvocationSerialized") {
            const tool = part.originMessage || part.invocationMessage?.value || "unknown";
            toolUsage[tool] = (toolUsage[tool] || 0) + 1;
          }
        }
      }

      // Duration
      let duration = 0;
      if (entry.timing?.startTime && entry.timing?.endTime) {
        duration = entry.timing.endTime - entry.timing.startTime;
      }

      results.push({
        sessionId: entry.sessionId,
        title: entry.title || "",
        createdAt: msToIso(entry.timing?.startTime || entry.lastMessageDate),
        duration,
        toolUsage,
        modelUsage,
        turnCount,
        requestCount: content.requests.length,
      });
    }
  }

  return results;
}

// Exported for testing
export const _testing = {
  getVSCodeDataDirs,
  readSessionIndex,
  readSessionContent,
  requestsToEvents,
  deriveStatus,
  msToIso,
  findSessionFile,
};
