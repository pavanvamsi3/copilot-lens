import { listSessions, getSession, type SessionMeta } from "./sessions";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExportFormat = "openai" | "sharegpt";
export type ExportSource = "cli" | "vscode" | "claude-code" | "all";

export interface ExportOptions {
  source?: ExportSource;
  from?: string;       // ISO date, inclusive
  to?: string;         // ISO date, inclusive
  repo?: string;       // substring match on gitRoot or cwd
  minTurns?: number;   // minimum conversation turns (user messages)
  minTokens?: number;  // minimum token count (skipped when data unavailable)
  format?: ExportFormat;
  includeTools?: boolean; // include tool call events (default: false)
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAIRecord {
  session_id: string;
  source: string;
  created_at: string;
  repo?: string;
  session_quality: SessionQuality;
  messages: OpenAIMessage[];
}

export interface ShareGPTConversation {
  from: "human" | "gpt" | "system";
  value: string;
}

export interface ShareGPTRecord {
  session_id: string;
  source: string;
  created_at: string;
  repo?: string;
  session_quality: SessionQuality;
  conversations: ShareGPTConversation[];
}

export interface SessionQuality {
  score: number;          // 0–100
  turn_count: number;
  has_errors: boolean;
  duration_ms: number;
}

// ─── Quality heuristic ────────────────────────────────────────────────────────

export function computeQuality(
  turnCount: number,
  hasErrors: boolean,
  durationMs: number
): SessionQuality {
  // Scoring:
  //   turns:    up to 50 pts — log scale, caps at 20 turns
  //   duration: up to 30 pts — log scale, caps at 30 min
  //   no errors: 20 pts bonus
  const turnScore = Math.min(50, Math.round((Math.log1p(turnCount) / Math.log1p(20)) * 50));
  const durScore = Math.min(30, Math.round((Math.log1p(durationMs / 60_000) / Math.log1p(30)) * 30));
  const errPenalty = hasErrors ? 0 : 20;
  return {
    score: Math.min(100, turnScore + durScore + errPenalty),
    turn_count: turnCount,
    has_errors: hasErrors,
    duration_ms: durationMs,
  };
}

// ─── Filtering ────────────────────────────────────────────────────────────────

export function filterSessions(sessions: SessionMeta[], opts: ExportOptions): SessionMeta[] {
  let result = [...sessions];

  if (opts.source && opts.source !== "all") {
    result = result.filter((s) => s.source === opts.source);
  }

  if (opts.from) {
    const from = new Date(opts.from).getTime();
    result = result.filter((s) => new Date(s.updatedAt).getTime() >= from);
  }

  if (opts.to) {
    // "to" is end-of-day inclusive
    const to = new Date(opts.to);
    to.setHours(23, 59, 59, 999);
    result = result.filter((s) => new Date(s.updatedAt).getTime() <= to.getTime());
  }

  if (opts.repo) {
    const q = opts.repo.toLowerCase();
    result = result.filter(
      (s) =>
        (s.gitRoot || "").toLowerCase().includes(q) ||
        (s.cwd || "").toLowerCase().includes(q)
    );
  }

  return result;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function extractMessages(
  session: ReturnType<typeof getSession>,
  includeTools: boolean
): Array<{ role: "user" | "assistant"; content: string }> {
  if (!session) return [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const e of session.events) {
    if (!includeTools && e.type === "tool.execution_start") continue;
    if (e.type === "assistant.thinking") continue;
    const content = typeof e.data?.content === "string" ? e.data.content.trim() : "";
    if (!content) continue;
    if (e.type === "user.message") messages.push({ role: "user", content });
    else if (e.type === "assistant.message") messages.push({ role: "assistant", content });
  }
  return messages;
}

export function formatAsOpenAI(
  session: NonNullable<ReturnType<typeof getSession>>,
  opts: ExportOptions
): OpenAIRecord {
  const messages = extractMessages(session, !!opts.includeTools);
  const userTurns = messages.filter((m) => m.role === "user").length;
  const hasErrors = session.events.some((e) => e.type === "session.error");
  const quality = computeQuality(userTurns, hasErrors, session.duration);
  const repo = session.gitRoot || session.cwd || undefined;
  return {
    session_id: session.id,
    source: session.source,
    created_at: session.createdAt,
    ...(repo ? { repo } : {}),
    session_quality: quality,
    messages,
  };
}

export function formatAsShareGPT(
  session: NonNullable<ReturnType<typeof getSession>>,
  opts: ExportOptions
): ShareGPTRecord {
  const raw = extractMessages(session, !!opts.includeTools);
  const conversations: ShareGPTConversation[] = raw.map((m) => ({
    from: m.role === "user" ? "human" : "gpt",
    value: m.content,
  }));
  const userTurns = raw.filter((m) => m.role === "user").length;
  const hasErrors = session.events.some((e) => e.type === "session.error");
  const quality = computeQuality(userTurns, hasErrors, session.duration);
  const repo = session.gitRoot || session.cwd || undefined;
  return {
    session_id: session.id,
    source: session.source,
    created_at: session.createdAt,
    ...(repo ? { repo } : {}),
    session_quality: quality,
    conversations,
  };
}

// ─── Main bulk export ─────────────────────────────────────────────────────────

export interface ExportResult {
  lines: string[];
  totalSessions: number;
  exportedSessions: number;
  skippedTurns: number;
  skippedTokens: number;
}

export function bulkExport(opts: ExportOptions): ExportResult {
  const allSessions = listSessions();
  const filtered = filterSessions(allSessions, opts);

  const format = opts.format ?? "openai";
  const minTurns = opts.minTurns ?? 1;

  const lines: string[] = [];
  let skippedTurns = 0;
  let skippedTokens = 0;

  for (const meta of filtered) {
    const session = getSession(meta.id);
    if (!session) continue;

    const messages = extractMessages(session, !!opts.includeTools);
    const userTurns = messages.filter((m) => m.role === "user").length;

    if (userTurns < minTurns) {
      skippedTurns++;
      continue;
    }

    // minTokens: count characters as proxy when real token data unavailable
    if (opts.minTokens && opts.minTokens > 0) {
      const charCount = messages.reduce((s, m) => s + m.content.length, 0);
      const approxTokens = Math.ceil(charCount / 4);
      if (approxTokens < opts.minTokens) {
        skippedTokens++;
        continue;
      }
    }

    const record =
      format === "sharegpt"
        ? formatAsShareGPT(session, opts)
        : formatAsOpenAI(session, opts);

    lines.push(JSON.stringify(record));
  }

  return {
    lines,
    totalSessions: allSessions.length,
    exportedSessions: lines.length,
    skippedTurns,
    skippedTokens,
  };
}

// Exported for testing
export const _testing = { filterSessions, computeQuality, formatAsOpenAI, formatAsShareGPT };
