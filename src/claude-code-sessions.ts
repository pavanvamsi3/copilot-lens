import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { SessionMeta, SessionDetail, SessionEvent, SessionStatus } from "./sessions";
import { cachedCall } from "./cache";

// ============ Storage location ============

export function getClaudeCodeDataDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

// ============ Project path decoding ============

/**
 * Decode a Claude Code project directory name back to an approximate absolute path.
 * Encoding: each `/` (or `\` on Windows) is replaced with `-`.
 * NOTE: This encoding is lossy — directory names that contain dashes will be
 * decoded as path separators. Use the `cwd` field from JSONL entries for the
 * authoritative working directory; this decode is for display/grouping only.
 *
 * e.g. "-home-user-myproject" → "/home/user/myproject"
 */
export function decodeProjectPath(dirName: string): string {
  if (!dirName) return dirName;
  // Replace all `-` with `/` then fix the leading `/`
  const decoded = dirName.replace(/-/g, "/");
  // On Windows the encoding starts with "C/" etc. — leave as-is
  // On Unix the encoding starts with "/" which after replacement is "/"
  return decoded;
}

// ============ JSONL parsing ============

export interface ClaudeCodeEntry {
  type: "summary" | "user" | "assistant" | "file-history-snapshot" | string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  // summary-specific
  summary?: string;
  leafUuid?: string;
  // user/assistant message
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  // assistant-specific
  costUSD?: number;
  model?: string;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | string;
  // text
  text?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: Record<string, any>;
  // tool_result
  tool_use_id?: string;
  content?: string | ContentBlock[];
}

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB cap
const MAX_TEXT_LENGTH = 10_000;

function isValidTimestamp(t: number): boolean {
  return !isNaN(t) && t > 0;
}

export function parseClaudeCodeJsonl(filePath: string): ClaudeCodeEntry[] {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return [];

    const raw = fs.readFileSync(filePath, "utf-8");
    const entries: ClaudeCodeEntry[] = [];

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ============ Tool name normalization ============

export function normalizeClaudeCodeToolName(name: string): string {
  switch (name) {
    case "Edit":      return "edit_file";
    case "MultiEdit": return "edit_file";
    case "Read":      return "read_file";
    case "Write":     return "write_file";
    case "Bash":      return "bash";
    case "Search":    return "search";
    case "Glob":      return "glob";
    case "Grep":      return "grep";
    case "WebSearch": return "web_search";
    case "WebFetch":  return "web_fetch";
    case "TodoRead":
    case "TodoWrite": return "todo";
    default:
      // MCP tool calls often look like "mcp__server_name__tool_name"
      if (name.startsWith("mcp__")) {
        const parts = name.split("__");
        // parts[1] = server name, parts[2] = tool name
        return parts.length >= 3 ? `${parts[1]}.${parts.slice(2).join(".")}` : name;
      }
      return name;
  }
}

// ============ Entry → Event conversion ============

export function claudeCodeEntriesToEvents(entries: ClaudeCodeEntry[]): SessionEvent[] {
  const events: SessionEvent[] = [];

  for (const entry of entries) {
    // Skip sidechains and compact summaries in main timeline
    if (entry.isSidechain) continue;
    if (entry.isCompactSummary) continue;

    const ts = entry.timestamp || "";
    const id = entry.uuid || "";

    if (entry.type === "user") {
      const content = entry.message?.content;
      if (typeof content === "string") {
        if (content.trim()) {
          events.push({ type: "user.message", id, timestamp: ts, data: { content } });
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result") {
            const resultContent = typeof block.content === "string"
              ? block.content
              : (block.content && (block.content as ContentBlock[]).map((b) => (b as any).text || "").join("\n")) || "";
            const truncated = resultContent.length > MAX_TEXT_LENGTH
              ? resultContent.slice(0, MAX_TEXT_LENGTH) + "\n...(truncated)"
              : resultContent;
            events.push({
              type: "tool.execution_complete",
              id: block.tool_use_id || id,
              timestamp: ts,
              data: { tool: "unknown", result: truncated, success: true },
            });
          }
        }
      }
    } else if (entry.type === "assistant") {
      const content = entry.message?.content;
      const model = entry.model;
      const costUSD = entry.costUSD;

      if (typeof content === "string") {
        if (content.trim()) {
          events.push({
            type: "assistant.message", id, timestamp: ts,
            data: { content, model, costUSD },
          });
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text?.trim()) {
            const text = block.text.length > MAX_TEXT_LENGTH
              ? block.text.slice(0, MAX_TEXT_LENGTH) + "\n...(truncated)"
              : block.text;
            events.push({
              type: "assistant.message", id, timestamp: ts,
              data: { content: text, model, costUSD },
            });
          } else if (block.type === "tool_use") {
            const toolName = normalizeClaudeCodeToolName(block.name || "unknown");
            events.push({
              type: "tool.execution_start",
              id: block.id || id,
              timestamp: ts,
              data: { tool: toolName, toolName, rawName: block.name, input: block.input },
            });
          }
        }
      }
    }
  }

  return events;
}

// ============ Status detection ============

function detectClaudeCodeStatus(filePath: string): SessionStatus {
  try {
    const stat = fs.statSync(filePath);
    const age = Date.now() - stat.mtimeMs;
    if (age < 300_000) return "running"; // modified within 5 minutes
  } catch {}
  return "completed";
}

// ============ Session ID registry ============

// In-memory set of known Claude Code session IDs (populated during listClaudeCodeSessions)
const _knownClaudeIds = new Set<string>();

export function isClaudeCodeSession(sessionId: string): boolean {
  if (_knownClaudeIds.has(sessionId)) return true;

  // Fallback: scan the filesystem
  const projectsDir = getClaudeCodeDataDir();
  if (!fs.existsSync(projectsDir)) return false;

  try {
    for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue;
      const projectDir = path.join(projectsDir, projectEntry.name);
      const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
      if (fs.existsSync(jsonlPath)) return true;
    }
  } catch {}
  return false;
}

// ============ List sessions ============

const CACHE_TTL = 30_000;

export function listClaudeCodeSessions(): SessionMeta[] {
  return cachedCall("listClaudeCodeSessions", CACHE_TTL, _scanClaudeCodeSessions);
}

function _scanClaudeCodeSessions(): SessionMeta[] {
  const projectsDir = getClaudeCodeDataDir();
  if (!fs.existsSync(projectsDir)) return [];

  const sessions: SessionMeta[] = [];

  try {
    for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue;

      const projectDir = path.join(projectsDir, projectEntry.name);
      const cwd = decodeProjectPath(projectEntry.name);

      let projectFiles: fs.Dirent[];
      try {
        projectFiles = fs.readdirSync(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const fileEntry of projectFiles) {
        if (!fileEntry.isFile()) continue;
        if (!fileEntry.name.endsWith(".jsonl")) continue;

        const sessionId = fileEntry.name.slice(0, -".jsonl".length);
        const jsonlPath = path.join(projectDir, fileEntry.name);

        try {
          const entries = parseClaudeCodeJsonl(jsonlPath);
          if (entries.length === 0) continue;

          // Extract summary title
          let title: string | undefined;
          const summaryEntry = entries.find((e) => e.type === "summary" && e.summary);
          if (summaryEntry) title = summaryEntry.summary;

          // Find timestamps from user/assistant entries
          const timedEntries = entries.filter(
            (e) => (e.type === "user" || e.type === "assistant") && e.timestamp
          );
          if (timedEntries.length === 0) continue;

          // Check for at least one user message
          const hasUserMessage = entries.some(
            (e) => e.type === "user" && e.message?.content
          );
          if (!hasUserMessage) continue;

          // Use first/last timestamps
          const timestamps = timedEntries
            .map((e) => new Date(e.timestamp!).getTime())
            .filter(isValidTimestamp);
          if (timestamps.length === 0) continue;

          timestamps.sort((a, b) => a - b);
          const createdAt = new Date(timestamps[0]).toISOString();
          const updatedAt = new Date(timestamps[timestamps.length - 1]).toISOString();

          // Fallback title: first user message truncated
          if (!title) {
            const firstUser = timedEntries.find((e) => e.type === "user");
            const content = firstUser?.message?.content;
            if (typeof content === "string" && content.trim()) {
              title = content.trim().slice(0, 80);
            }
          }

          _knownClaudeIds.add(sessionId);

          sessions.push({
            id: sessionId,
            cwd,
            createdAt,
            updatedAt,
            status: detectClaudeCodeStatus(jsonlPath),
            source: "claude-code",
            title,
          });
        } catch {
          // skip corrupted files
        }
      }
    }
  } catch {}

  return sessions;
}

// ============ Get session detail ============

export function getClaudeCodeSession(sessionId: string): SessionDetail | null {
  const projectsDir = getClaudeCodeDataDir();
  if (!fs.existsSync(projectsDir)) return null;

  try {
    for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!projectEntry.isDirectory()) continue;

      const projectDir = path.join(projectsDir, projectEntry.name);
      const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);

      if (!fs.existsSync(jsonlPath)) continue;

      const entries = parseClaudeCodeJsonl(jsonlPath);
      if (entries.length === 0) return null;

      const cwd = decodeProjectPath(projectEntry.name);

      // Extract summary/title
      let title: string | undefined;
      const summaryEntry = entries.find((e) => e.type === "summary" && e.summary);
      if (summaryEntry) title = summaryEntry.summary;

      // Extract version from any entry
      const versionEntry = entries.find((e) => e.version);
      const copilotVersion = versionEntry?.version;

      // Find timestamps
      const timedEntries = entries.filter(
        (e) => (e.type === "user" || e.type === "assistant") && e.timestamp
      );
      const timestamps = timedEntries
        .map((e) => new Date(e.timestamp!).getTime())
        .filter(isValidTimestamp);
      timestamps.sort((a, b) => a - b);

      const createdAt = timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : "";
      const updatedAt = timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]).toISOString() : "";

      if (!title) {
        const firstUser = timedEntries.find((e) => e.type === "user");
        const content = firstUser?.message?.content;
        if (typeof content === "string" && content.trim()) {
          title = content.trim().slice(0, 80);
        }
      }

      const events = claudeCodeEntriesToEvents(entries);

      // Event counts
      const eventCounts: Record<string, number> = {};
      for (const e of events) {
        eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
      }

      // Duration (gap-capped at 5 min)
      let duration = 0;
      const eventTimestamps = events
        .map((e) => new Date(e.timestamp).getTime())
        .filter(isValidTimestamp)
        .sort((a, b) => a - b);
      if (eventTimestamps.length >= 2) {
        const MAX_GAP = 300_000;
        for (let i = 1; i < eventTimestamps.length; i++) {
          duration += Math.min(eventTimestamps[i] - eventTimestamps[i - 1], MAX_GAP);
        }
      }

      return {
        id: sessionId,
        cwd,
        createdAt,
        updatedAt,
        events,
        planContent: undefined,
        hasSnapshots: false,
        copilotVersion,
        eventCounts,
        duration,
        status: detectClaudeCodeStatus(jsonlPath),
        source: "claude-code",
        title,
      };
    }
  } catch {}

  return null;
}

// ============ Analytics ============

export interface ClaudeCodeAnalyticsEntry {
  sessionId: string;
  createdAt: string;
  duration: number;
  toolUsage: Record<string, number>;
  modelUsage: Record<string, number>;
  turnCount: number;
  msgLengths: number[];
  totalCostUSD: number;
}

export function getClaudeCodeAnalytics(): ClaudeCodeAnalyticsEntry[] {
  return cachedCall("getClaudeCodeAnalytics", CACHE_TTL, _computeClaudeCodeAnalytics);
}

function _computeClaudeCodeAnalytics(): ClaudeCodeAnalyticsEntry[] {
  const sessions = listClaudeCodeSessions();
  const results: ClaudeCodeAnalyticsEntry[] = [];
  const projectsDir = getClaudeCodeDataDir();
  if (!fs.existsSync(projectsDir)) return results;

  for (const session of sessions) {
    try {
      // Find the JSONL file for this session
      let jsonlPath: string | null = null;
      for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
        if (!projectEntry.isDirectory()) continue;
        const candidate = path.join(projectsDir, projectEntry.name, `${session.id}.jsonl`);
        if (fs.existsSync(candidate)) {
          jsonlPath = candidate;
          break;
        }
      }
      if (!jsonlPath) continue;

      const entries = parseClaudeCodeJsonl(jsonlPath);
      const toolUsage: Record<string, number> = {};
      const modelUsage: Record<string, number> = {};
      const msgLengths: number[] = [];
      let turnCount = 0;
      let totalCostUSD = 0;
      const timestamps: number[] = [];

      for (const entry of entries) {
        if (entry.isSidechain) continue;

        if (entry.timestamp) {
          const t = new Date(entry.timestamp).getTime();
          if (isValidTimestamp(t)) timestamps.push(t);
        }

        if (entry.type === "user") {
          const content = entry.message?.content;
          if (typeof content === "string" && content.trim()) {
            msgLengths.push(content.length);
          }
          turnCount++;
        } else if (entry.type === "assistant") {
          if (entry.model) {
            modelUsage[entry.model] = (modelUsage[entry.model] || 0) + 1;
          }
          if (entry.costUSD) {
            totalCostUSD += entry.costUSD;
          }

          const content = entry.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_use" && block.name) {
                const normalized = normalizeClaudeCodeToolName(block.name);
                toolUsage[normalized] = (toolUsage[normalized] || 0) + 1;
              }
            }
          }
        }
      }

      // Duration (gap-capped)
      let duration = 0;
      if (timestamps.length >= 2) {
        timestamps.sort((a, b) => a - b);
        const MAX_GAP = 300_000;
        for (let i = 1; i < timestamps.length; i++) {
          duration += Math.min(timestamps[i] - timestamps[i - 1], MAX_GAP);
        }
      }

      results.push({
        sessionId: session.id,
        createdAt: session.createdAt,
        duration,
        toolUsage,
        modelUsage,
        turnCount,
        msgLengths,
        totalCostUSD,
      });
    } catch {}
  }

  return results;
}

// ============ MCP config scanning ============

export function scanClaudeCodeMcpConfig(): string[] {
  const configPaths = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(os.homedir(), ".claude", "settings.local.json"),
  ];

  for (const configPath of configPaths) {
    try {
      if (!fs.existsSync(configPath)) continue;
      let raw = fs.readFileSync(configPath, "utf-8");
      // Strip trailing commas (JSONC)
      raw = raw.replace(/,\s*([\]}])/g, "$1");
      const config = JSON.parse(raw);
      const mcpServers = config.mcpServers || config.mcp_servers || {};
      const names = Object.keys(mcpServers);
      if (names.length > 0) return names;
    } catch {}
  }
  return [];
}

// Exported for testing
export const _testing = {
  decodeProjectPath,
  parseClaudeCodeJsonl,
  claudeCodeEntriesToEvents,
  normalizeClaudeCodeToolName,
  detectClaudeCodeStatus,
  getClaudeCodeDataDir,
  scanClaudeCodeMcpConfig,
  _scanClaudeCodeSessions,
};
