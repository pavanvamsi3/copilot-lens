import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { cachedCall } from "./cache";

export interface TokenCall {
  timestamp: string;
  request_id: string;
  message_id?: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
}

export interface PeriodBucket {
  period: string;
  calls: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  top_model: string;
  models: Record<string, {
    prompt_tokens: number;
    cached_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }>;
}

export interface TokenUsageAnalytics {
  totals: {
    calls: number;
    prompt_tokens: number;
    cached_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_hit_rate: number;
    active_days: number;
    avg_per_day: number;
    top_model: string | null;
  };
  byModel: Record<string, {
    calls: number;
    prompt_tokens: number;
    cached_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }>;
  daily: PeriodBucket[];
  weekly: PeriodBucket[];
  monthly: PeriodBucket[];
  logsScanned: number;
  logsDir: string;
}

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /;
const RESPONSE_LINE_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z) \[DEBUG\] response \(Request-ID ([^)]+)\):\s*$/;
const DATA_LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z \[DEBUG\] data:\s*$/;
const JSON_OPEN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z \[DEBUG\] (\{)\s*$/;
const MODEL_LOOKBACK_RE = /"model"\s*:\s*"([^"]+)"/;

export function getLogsDir(): string {
  return path.join(os.homedir(), ".copilot", "logs");
}

/**
 * Strip Azure deployment / internal routing prefixes from model names.
 * Examples:
 *   capi:claude-opus-4.7:defaultReasoningEffort=medium  -> claude-opus-4.7
 *   capi-noe-ptuc-h200-ib-gpt-5-mini-2025-08-07         -> gpt-5-mini-2025-08-07
 */
export function normalizeModelName(raw: string): string {
  if (!raw) return raw;
  let m = raw.trim();

  if (m.startsWith("capi:")) {
    const parts = m.split(":");
    if (parts.length >= 2 && parts[1]) m = parts[1];
  }

  if (m.startsWith("capi-")) {
    const known = m.match(
      /(gpt-[\w.-]+|claude-[\w.-]+|gemini-[\w.-]+|grok-[\w.-]+|llama-[\w.-]+|mistral-[\w.-]+|o\d+[\w.-]*)$/i
    );
    if (known) m = known[1];
  }

  return m;
}

/**
 * Parse a single log file's contents and return the token-usage records found.
 */
export function parseLogContent(content: string): TokenCall[] {
  const lines = content.split(/\r?\n/);
  const calls: TokenCall[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(RESPONSE_LINE_RE);
    if (!m) continue;

    const ts = m[1];
    const requestId = m[2];

    // Expect "data:" on the next line and "{" on the line after.
    if (i + 2 >= lines.length) continue;
    if (!DATA_LINE_RE.test(lines[i + 1])) continue;
    const openMatch = lines[i + 2].match(JSON_OPEN_RE);
    if (!openMatch) continue;

    // Accumulate JSON: starts with "{" then continuation lines until next
    // timestamp-prefixed line.
    const jsonLines: string[] = ["{"];
    let j = i + 3;
    for (; j < lines.length; j++) {
      if (TIMESTAMP_RE.test(lines[j])) break;
      jsonLines.push(lines[j]);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonLines.join("\n"));
    } catch {
      i = j - 1;
      continue;
    }

    const usage = parsed?.usage;
    if (
      !usage ||
      typeof usage.prompt_tokens !== "number" ||
      typeof usage.completion_tokens !== "number"
    ) {
      i = j - 1;
      continue;
    }

    let model: string = parsed.model || "";
    if (!model) {
      // Lookback up to 30 lines for a "model": "..." mention from streaming chunks.
      const start = Math.max(0, i - 30);
      for (let k = i - 1; k >= start; k--) {
        const mm = lines[k].match(MODEL_LOOKBACK_RE);
        if (mm) {
          model = mm[1];
          break;
        }
      }
    }
    model = normalizeModelName(model || "unknown");

    const cached =
      usage.prompt_tokens_details && typeof usage.prompt_tokens_details.cached_tokens === "number"
        ? usage.prompt_tokens_details.cached_tokens
        : 0;

    const totalTokens =
      typeof usage.total_tokens === "number"
        ? usage.total_tokens
        : usage.prompt_tokens + usage.completion_tokens;

    calls.push({
      timestamp: ts,
      request_id: requestId,
      message_id: typeof parsed.id === "string" ? parsed.id : undefined,
      model,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      cached_tokens: cached,
      total_tokens: totalTokens,
    });

    i = j - 1;
  }

  return calls;
}

function listLogFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".log"))
    .map((f) => path.join(dir, f));
}

function isoDay(ts: string): string {
  return ts.slice(0, 10);
}

function isoWeek(ts: string): string {
  const d = new Date(ts);
  // ISO week: Thursday-anchored year/week (uses UTC).
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function isoMonth(ts: string): string {
  return ts.slice(0, 7);
}

function emptyBucket(period: string): PeriodBucket & { _models: Record<string, number> } {
  return {
    period,
    calls: 0,
    prompt_tokens: 0,
    cached_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    top_model: "",
    models: {},
    _models: {},
  };
}

function bucketize(calls: TokenCall[], keyFn: (c: TokenCall) => string): PeriodBucket[] {
  const map = new Map<string, ReturnType<typeof emptyBucket>>();
  for (const c of calls) {
    const k = keyFn(c);
    let b = map.get(k);
    if (!b) {
      b = emptyBucket(k);
      map.set(k, b);
    }
    b.calls += 1;
    b.prompt_tokens += c.prompt_tokens;
    b.cached_tokens += c.cached_tokens;
    b.completion_tokens += c.completion_tokens;
    b.total_tokens += c.total_tokens;
    b._models[c.model] = (b._models[c.model] || 0) + c.total_tokens;
    const mb = (b.models[c.model] = b.models[c.model] || {
      prompt_tokens: 0,
      cached_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
    mb.prompt_tokens += c.prompt_tokens;
    mb.cached_tokens += c.cached_tokens;
    mb.completion_tokens += c.completion_tokens;
    mb.total_tokens += c.total_tokens;
  }
  const out = Array.from(map.values()).map((b) => {
    const top = Object.entries(b._models).sort((a, b2) => b2[1] - a[1])[0];
    const { _models, ...rest } = b;
    return { ...rest, top_model: top ? top[0] : "" };
  });
  out.sort((a, b) => a.period.localeCompare(b.period));
  return out;
}

export function aggregate(calls: TokenCall[], logsScanned: number, logsDir: string): TokenUsageAnalytics {
  const byModel: TokenUsageAnalytics["byModel"] = {};
  let prompt = 0;
  let cached = 0;
  let completion = 0;
  let total = 0;

  for (const c of calls) {
    prompt += c.prompt_tokens;
    cached += c.cached_tokens;
    completion += c.completion_tokens;
    total += c.total_tokens;
    const m = (byModel[c.model] = byModel[c.model] || {
      calls: 0,
      prompt_tokens: 0,
      cached_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
    m.calls += 1;
    m.prompt_tokens += c.prompt_tokens;
    m.cached_tokens += c.cached_tokens;
    m.completion_tokens += c.completion_tokens;
    m.total_tokens += c.total_tokens;
  }

  const daily = bucketize(calls, (c) => isoDay(c.timestamp));
  const weekly = bucketize(calls, (c) => isoWeek(c.timestamp));
  const monthly = bucketize(calls, (c) => isoMonth(c.timestamp));

  const activeDays = daily.length;
  const avgPerDay = activeDays > 0 ? Math.round(total / activeDays) : 0;
  const cacheHitRate = prompt > 0 ? cached / prompt : 0;

  let topModel: string | null = null;
  let topModelTokens = -1;
  for (const [name, stats] of Object.entries(byModel)) {
    if (stats.total_tokens > topModelTokens) {
      topModelTokens = stats.total_tokens;
      topModel = name;
    }
  }

  return {
    totals: {
      calls: calls.length,
      prompt_tokens: prompt,
      cached_tokens: cached,
      completion_tokens: completion,
      total_tokens: total,
      cache_hit_rate: cacheHitRate,
      active_days: activeDays,
      avg_per_day: avgPerDay,
      top_model: topModel,
    },
    byModel,
    daily,
    weekly,
    monthly,
    logsScanned,
    logsDir,
  };
}

export function getTokenUsage(): TokenUsageAnalytics {
  return cachedCall("tokenUsage", 30_000, () => {
    const dir = getLogsDir();
    const files = listLogFiles(dir);
    const all: TokenCall[] = [];
    for (const f of files) {
      try {
        const content = fs.readFileSync(f, "utf-8");
        const calls = parseLogContent(content);
        for (const c of calls) all.push(c);
      } catch {
        // skip unreadable files
      }
    }
    all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return aggregate(all, files.length, dir);
  });
}
