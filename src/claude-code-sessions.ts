import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import type { SessionMeta, SessionDetail, SessionEvent, SessionStatus } from "./sessions";
import { cachedCall } from "./cache";

// ============ Platform paths ============

export function getClaudeCodeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

// ============ JSONL parsing helpers ============

interface ClaudeCodeEvent {
  type: string;
  uuid?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  slug?: string;
  version?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    model?: string;
  };
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** Read up to maxLines lines from a file */
function readFirstLines(filePath: string, maxLines: number): string[] {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.split("\n").filter(Boolean).slice(0, maxLines);
  } catch {
    return [];
  }
}

/** Parse all lines from a JSONL file */
function readAllLines(filePath: string): ClaudeCodeEvent[] {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 200 * 1024 * 1024) return []; // 200MB cap

    const content = fs.readFileSync(filePath, "utf-8");
    const events: ClaudeCodeEvent[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    return events;
  } catch {
    return [];
  }
}

function extractTextContent(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("");
}

function extractToolUseBlocks(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (!content || typeof content === "string") return [];
  return content.filter((b) => b.type === "tool_use");
}

function deriveStatus(lastTimestamp: string | undefined): SessionStatus {
  if (!lastTimestamp) return "completed";
  const age = Date.now() - new Date(lastTimestamp).getTime();
  return age < 300_000 ? "running" : "completed";
}

// ============ List sessions ============

export function listClaudeCodeSessions(): SessionMeta[] {
  const projectsDir = getClaudeCodeProjectsDir();
  if (!fs.existsSync(projectsDir)) return [];

  const sessions: SessionMeta[] = [];

  let subdirs: fs.Dirent[];
  try {
    subdirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const subdir of subdirs) {
    if (!subdir.isDirectory()) continue;
    const subdirPath = path.join(projectsDir, subdir.name);

    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(subdirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    // Only top-level JSONL files (not inside subagents/ or other subdirs)
    const jsonlFiles = files.filter(
      (f) => f.isFile() && f.name.endsWith(".jsonl")
    );

    for (const file of jsonlFiles) {
      const filePath = path.join(subdirPath, file.name);
      const sessionId = file.name.replace(/\.jsonl$/, "");

      try {
        // Read first 100 lines to extract metadata efficiently
        const lines = readFirstLines(filePath, 100);
        if (lines.length === 0) continue;

        let cwd = "";
        let gitBranch = "";
        let slug = "";
        let firstTimestamp = "";
        let lastTimestamp = "";
        let hasUserEvent = false;

        // We need to scan all lines to find last timestamp
        // but limit to metadata extraction from events
        const allLines = readFirstLines(filePath, 5000);

        for (const line of allLines) {
          try {
            const event: ClaudeCodeEvent = JSON.parse(line);
            if (!event.type) continue;

            // Extract metadata from any event
            if (!cwd && event.cwd) cwd = event.cwd;
            if (!gitBranch && event.gitBranch) gitBranch = event.gitBranch;
            if (!slug && event.slug) slug = event.slug;
            if (event.timestamp) {
              if (!firstTimestamp) firstTimestamp = event.timestamp;
              lastTimestamp = event.timestamp;
            }

            if (event.type === "user" && event.isSidechain !== true) {
              hasUserEvent = true;
            }
          } catch {
            // skip
          }
        }

        if (!hasUserEvent) continue;

        sessions.push({
          id: sessionId,
          cwd,
          branch: gitBranch || undefined,
          createdAt: firstTimestamp,
          updatedAt: lastTimestamp,
          status: deriveStatus(lastTimestamp),
          source: "claude-code",
          title: slug || undefined,
        });
      } catch {
        // skip corrupted files
      }
    }
  }

  return sessions;
}

// ============ Get session detail ============

/** Find the JSONL file for a given session ID by scanning projects dir */
function findSessionFile(sessionId: string): string | null {
  const projectsDir = getClaudeCodeProjectsDir();
  if (!fs.existsSync(projectsDir)) return null;

  try {
    for (const subdir of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!subdir.isDirectory()) continue;
      const candidate = path.join(projectsDir, subdir.name, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

export function getClaudeCodeSession(sessionId: string): SessionDetail | null {
  const filePath = findSessionFile(sessionId);
  if (!filePath) return null;

  const rawEvents = readAllLines(filePath);
  if (rawEvents.length === 0) return null;

  // Extract metadata
  let cwd = "";
  let gitBranch = "";
  let slug = "";
  let firstTimestamp = "";
  let lastTimestamp = "";

  for (const event of rawEvents) {
    if (!cwd && event.cwd) cwd = event.cwd;
    if (!gitBranch && event.gitBranch) gitBranch = event.gitBranch;
    if (!slug && event.slug) slug = event.slug;
    if (event.timestamp) {
      if (!firstTimestamp) firstTimestamp = event.timestamp;
      lastTimestamp = event.timestamp;
    }
  }

  // Convert to SessionEvents
  const events: SessionEvent[] = [];

  for (const event of rawEvents) {
    if (event.isSidechain === true) continue;
    if (!event.type) continue;

    const ts = event.timestamp || "";
    const id = event.uuid || randomUUID();

    if (event.type === "user") {
      const content = extractTextContent(event.message?.content);
      if (content) {
        events.push({
          type: "user.message",
          id,
          timestamp: ts,
          data: { content },
        });
      }
    } else if (event.type === "assistant") {
      const msgContent = event.message?.content;

      // Emit tool_use blocks as tool.execution_start events
      for (const block of extractToolUseBlocks(msgContent)) {
        events.push({
          type: "tool.execution_start",
          id: block.id || randomUUID(),
          timestamp: ts,
          data: { tool: block.name || "unknown", input: block.input },
        });
      }

      // Emit text content as assistant.message
      const textContent = extractTextContent(msgContent);
      if (textContent) {
        events.push({
          type: "assistant.message",
          id,
          timestamp: ts,
          data: {
            content: textContent,
            model: event.message?.model,
          },
        });
      }
    }
  }

  // Compute gap-capped duration
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

  // Count events by type
  const eventCounts: Record<string, number> = {};
  for (const e of events) {
    eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
  }

  return {
    id: sessionId,
    cwd,
    branch: gitBranch || undefined,
    createdAt: firstTimestamp,
    updatedAt: lastTimestamp,
    events,
    planContent: undefined,
    hasSnapshots: false,
    copilotVersion: undefined,
    eventCounts,
    duration,
    status: deriveStatus(lastTimestamp),
    source: "claude-code",
    title: slug || undefined,
  };
}

// ============ Check if session belongs to Claude Code ============

export function isClaudeCodeSession(sessionId: string): boolean {
  return findSessionFile(sessionId) !== null;
}

// ============ Analytics ============

export interface ClaudeCodeAnalyticsEntry {
  sessionId: string;
  title: string;
  createdAt: string;
  duration: number;
  toolUsage: Record<string, number>;
  modelUsage: Record<string, number>;
  turnCount: number;
  msgLengths: number[];
}

const CACHE_TTL = 30_000;

export function getClaudeCodeAnalytics(): ClaudeCodeAnalyticsEntry[] {
  return cachedCall("getClaudeCodeAnalytics", CACHE_TTL, _computeClaudeCodeAnalytics);
}

function _computeClaudeCodeAnalytics(): ClaudeCodeAnalyticsEntry[] {
  const projectsDir = getClaudeCodeProjectsDir();
  if (!fs.existsSync(projectsDir)) return [];

  const results: ClaudeCodeAnalyticsEntry[] = [];

  let subdirs: fs.Dirent[];
  try {
    subdirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const subdir of subdirs) {
    if (!subdir.isDirectory()) continue;
    const subdirPath = path.join(projectsDir, subdir.name);

    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(subdirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    const jsonlFiles = files.filter(
      (f) => f.isFile() && f.name.endsWith(".jsonl")
    );

    for (const file of jsonlFiles) {
      const filePath = path.join(subdirPath, file.name);
      const sessionId = file.name.replace(/\.jsonl$/, "");

      const rawEvents = readAllLines(filePath);
      if (rawEvents.length === 0) continue;

      const toolUsage: Record<string, number> = {};
      const modelUsage: Record<string, number> = {};
      const msgLengths: number[] = [];
      let turnCount = 0;
      let slug = "";
      let firstTimestamp = "";
      let hasUserEvent = false;
      const timestamps: number[] = [];

      for (const event of rawEvents) {
        if (event.isSidechain === true) continue;
        if (!event.type) continue;

        if (!slug && event.slug) slug = event.slug;
        if (event.timestamp) {
          if (!firstTimestamp) firstTimestamp = event.timestamp;
          const t = new Date(event.timestamp).getTime();
          if (t > 0) timestamps.push(t);
        }

        if (event.type === "user") {
          hasUserEvent = true;
          const content = extractTextContent(event.message?.content);
          if (content) msgLengths.push(content.length);
        } else if (event.type === "assistant") {
          turnCount++;
          const model = event.message?.model;
          if (model) {
            modelUsage[model] = (modelUsage[model] || 0) + 1;
          }
          for (const block of extractToolUseBlocks(event.message?.content)) {
            const tool = block.name || "unknown";
            toolUsage[tool] = (toolUsage[tool] || 0) + 1;
          }
        }
      }

      if (!hasUserEvent) continue;

      // Gap-capped duration
      let duration = 0;
      timestamps.sort((a, b) => a - b);
      if (timestamps.length >= 2) {
        const MAX_GAP = 300_000;
        for (let i = 1; i < timestamps.length; i++) {
          duration += Math.min(timestamps[i] - timestamps[i - 1], MAX_GAP);
        }
      }

      results.push({
        sessionId,
        title: slug,
        createdAt: firstTimestamp,
        duration,
        toolUsage,
        modelUsage,
        turnCount,
        msgLengths,
      });
    }
  }

  return results;
}

// Exported for testing
export const _testing = {
  getClaudeCodeProjectsDir,
  findSessionFile,
  extractTextContent,
  extractToolUseBlocks,
  deriveStatus,
  readAllLines,
};
