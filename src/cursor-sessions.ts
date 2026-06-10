import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import type { SessionMeta, SessionDetail, SessionEvent, SessionStatus } from "./sessions";
import { cachedCall } from "./cache";

// ============ Platform paths ============

export function getCursorDataDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [];

  const variants = ["Cursor", "Cursor Nightly"];
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

// ============ Data structures ============

interface CursorBubble {
  type: "user" | "ai";
  text?: string;
  richText?: string;
  modelType?: string;
  timingInfo?: {
    clientStartTime?: number;
    clientEndTime?: number;
    firstTokenTime?: number;
  };
}

interface CursorTab {
  tabId: string;
  chatTitle?: string;
  lastSendTime?: number;
  bubbles?: CursorBubble[];
}

// Keys tried in order — covers Cursor versions through mid-2025.
const CHAT_KEYS = [
  "workbench.panel.aichat.view.aichat.chatdata",
  "aiService.chats",
  "chat.ChatSessionStore.index",
];

// ============ Database reading ============

function getDbPath(dataDir: string): string {
  return path.join(dataDir, "User", "globalStorage", "state.vscdb");
}

export function readCursorTabs(dataDir: string): CursorTab[] {
  const dbPath = getDbPath(dataDir);
  if (!fs.existsSync(dbPath)) return [];

  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    for (const key of CHAT_KEYS) {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key) as
        | { value: unknown }
        | undefined;
      if (!row) continue;

      const rawValue = row.value;
      const str = Buffer.isBuffer(rawValue) ? rawValue.toString("utf8") : (rawValue as string);
      const data = JSON.parse(str);

      // Handle both {tabs: [...]} and direct array shapes
      const tabs: CursorTab[] = Array.isArray(data) ? data : (data.tabs ?? []);
      if (tabs.length > 0) return tabs;
    }
  } catch {
    // unreadable or locked DB — skip
  } finally {
    db?.close();
  }
  return [];
}

// ============ Helpers ============

function msToIso(ms: number | undefined): string {
  if (!ms) return "";
  return new Date(ms).toISOString();
}

function deriveStatus(lastSendTime: number | undefined): SessionStatus {
  if (!lastSendTime) return "completed";
  const age = Date.now() - lastSendTime;
  return age < 600_000 ? "running" : "completed";
}

function tabHasContent(tab: CursorTab): boolean {
  return (tab.bubbles ?? []).some(
    (b) => b.type === "user" && (b.text || b.richText || "").trim().length > 0
  );
}

// ============ Conversion: tab → SessionDetail events ============

export function tabToEvents(tab: CursorTab): SessionEvent[] {
  const events: SessionEvent[] = [];
  const bubbles = tab.bubbles ?? [];

  for (const bubble of bubbles) {
    const text = (bubble.text || bubble.richText || "").trim();
    const ts = msToIso(bubble.timingInfo?.clientStartTime);

    if (bubble.type === "user") {
      if (!text) continue;
      events.push({
        type: "user.message",
        id: randomUUID(),
        timestamp: ts,
        data: { content: text },
      });
    } else if (bubble.type === "ai") {
      if (text) {
        const respTs = msToIso(
          bubble.timingInfo?.clientEndTime || bubble.timingInfo?.firstTokenTime || bubble.timingInfo?.clientStartTime
        );
        events.push({
          type: "assistant.message",
          id: randomUUID(),
          timestamp: respTs || ts,
          data: {
            content: text,
            model: bubble.modelType,
          },
        });
      }
    }
  }

  return events;
}

// ============ Public API ============

export function listCursorSessions(): SessionMeta[] {
  const sessions: SessionMeta[] = [];

  for (const dataDir of getCursorDataDirs()) {
    const tabs = readCursorTabs(dataDir);
    for (const tab of tabs) {
      if (!tabHasContent(tab)) continue;

      const firstUserBubble = tab.bubbles?.find((b) => b.type === "user");
      const createdAt = msToIso(firstUserBubble?.timingInfo?.clientStartTime || tab.lastSendTime);
      const updatedAt = msToIso(tab.lastSendTime);

      sessions.push({
        id: tab.tabId,
        cwd: "",
        createdAt,
        updatedAt,
        status: deriveStatus(tab.lastSendTime),
        source: "cursor",
        title: tab.chatTitle || undefined,
      });
    }
  }

  return sessions;
}

export function getCursorSession(tabId: string): SessionDetail | null {
  for (const dataDir of getCursorDataDirs()) {
    const tabs = readCursorTabs(dataDir);
    const tab = tabs.find((t) => t.tabId === tabId);
    if (!tab || !tabHasContent(tab)) continue;

    const events = tabToEvents(tab);

    const eventCounts: Record<string, number> = {};
    for (const e of events) {
      eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
    }

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

    const firstUserBubble = tab.bubbles?.find((b) => b.type === "user");

    return {
      id: tabId,
      cwd: "",
      createdAt: msToIso(firstUserBubble?.timingInfo?.clientStartTime || tab.lastSendTime),
      updatedAt: msToIso(tab.lastSendTime),
      events,
      planContent: undefined,
      hasSnapshots: false,
      copilotVersion: undefined,
      eventCounts,
      duration,
      status: deriveStatus(tab.lastSendTime),
      source: "cursor",
      title: tab.chatTitle || undefined,
    };
  }

  return null;
}

export function isCursorSession(tabId: string): boolean {
  for (const dataDir of getCursorDataDirs()) {
    const tabs = readCursorTabs(dataDir);
    if (tabs.some((t) => t.tabId === tabId && tabHasContent(t))) return true;
  }
  return false;
}

// ============ Analytics ============

export interface CursorAnalyticsEntry {
  sessionId: string;
  title: string;
  createdAt: string;
  duration: number;
  modelUsage: Record<string, number>;
  turnCount: number;
  msgLengths: number[];
}

const CACHE_TTL = 30_000;

export function getCursorAnalytics(): CursorAnalyticsEntry[] {
  return cachedCall("getCursorAnalytics", CACHE_TTL, _computeCursorAnalytics);
}

function _computeCursorAnalytics(): CursorAnalyticsEntry[] {
  const results: CursorAnalyticsEntry[] = [];

  for (const dataDir of getCursorDataDirs()) {
    const tabs = readCursorTabs(dataDir);

    for (const tab of tabs) {
      if (!tabHasContent(tab)) continue;

      const modelUsage: Record<string, number> = {};
      const msgLengths: number[] = [];
      let turnCount = 0;
      const timestamps: number[] = [];

      for (const bubble of tab.bubbles ?? []) {
        if (bubble.timingInfo?.clientStartTime) {
          timestamps.push(bubble.timingInfo.clientStartTime);
        }
        if (bubble.type === "user") {
          const text = (bubble.text || bubble.richText || "").trim();
          if (text) msgLengths.push(text.length);
        } else if (bubble.type === "ai") {
          turnCount++;
          if (bubble.modelType) {
            modelUsage[bubble.modelType] = (modelUsage[bubble.modelType] || 0) + 1;
          }
        }
      }

      let duration = 0;
      timestamps.sort((a, b) => a - b);
      if (timestamps.length >= 2) {
        const MAX_GAP = 300_000;
        for (let i = 1; i < timestamps.length; i++) {
          duration += Math.min(timestamps[i] - timestamps[i - 1], MAX_GAP);
        }
      }

      const firstUserBubble = tab.bubbles?.find((b) => b.type === "user");
      const createdAt = msToIso(firstUserBubble?.timingInfo?.clientStartTime || tab.lastSendTime);

      results.push({
        sessionId: tab.tabId,
        title: tab.chatTitle || "",
        createdAt,
        duration,
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
  getCursorDataDirs,
  readCursorTabs,
  tabToEvents,
  tabHasContent,
  deriveStatus,
  msToIso,
  CHAT_KEYS,
};
