import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { listSessions } from "./sessions";
import { getTokenUsage } from "./token-usage";

export type DigestPeriod = "week" | "last-week" | "month";

export interface DigestData {
  rangeLabel: string;
  startDate: string;
  endDate: string;
  activeDays: number;
  totalDays: number;
  sessions: number;
  totalDurationMs: number;
  totalTokens: number;
  mostActiveRepo: string | null;
  peakHour: string | null;
  topTool: string | null;
  topToolCalls: number;
  topModel: string | null;
  longestSession: {
    title: string | null;
    durationMs: number;
    turns: number;
  } | null;
  priorSessions: number;
  priorTokens: number | null;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function weekBounds(offset = 0): { start: Date; end: Date; label: string } {
  const now = new Date();
  const dow = now.getUTCDay(); // 0=Sun
  const toMonday = dow === 0 ? 6 : dow - 1;
  const mon = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - toMonday - offset * 7)
  );
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  const end = new Date(sun);
  end.setUTCHours(23, 59, 59, 999);

  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const label = `Week of ${M[mon.getUTCMonth()]} ${mon.getUTCDate()} – ${M[sun.getUTCMonth()]} ${sun.getUTCDate()}, ${sun.getUTCFullYear()}`;
  return { start: mon, end, label };
}

function monthBounds(offset = 0): { start: Date; end: Date; label: string } {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  const M = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return { start, end, label: `${M[d.getUTCMonth()]} ${d.getUTCFullYear()}` };
}

function getBounds(period: DigestPeriod) {
  if (period === "week")      return { cur: weekBounds(0),  prior: weekBounds(1) };
  if (period === "last-week") return { cur: weekBounds(1),  prior: weekBounds(2) };
  return                             { cur: monthBounds(0), prior: monthBounds(1) };
}

function fmtHour(h: number): string {
  if (h === 0)  return "12 – 1 AM";
  if (h < 12)   return `${h} – ${h + 1} AM`;
  if (h === 12) return "12 – 1 PM";
  return `${h - 12} – ${h - 11} PM`;
}

function getSessionDir(): string {
  return path.join(os.homedir(), ".copilot", "session-state");
}

export function getDigest(period: DigestPeriod = "week"): DigestData {
  const { cur, prior } = getBounds(period);
  const allSessions = listSessions();

  const inRange = allSessions.filter((s) => {
    const t = new Date(s.createdAt).getTime();
    return t >= cur.start.getTime() && t <= cur.end.getTime();
  });
  const inPrior = allSessions.filter((s) => {
    const t = new Date(s.createdAt).getTime();
    return t >= prior.start.getTime() && t <= prior.end.getTime();
  });

  const activeDays = new Set(inRange.map((s) => s.createdAt.slice(0, 10)).filter(Boolean)).size;
  const totalDays = Math.round((cur.end.getTime() - cur.start.getTime()) / 86400000) + 1;

  const repoCount: Record<string, number> = {};
  const hourCount: Record<number, number> = {};
  const toolCount: Record<string, number> = {};
  let totalDurationMs = 0;
  let longestSession: DigestData["longestSession"] = null;

  const sDir = getSessionDir();

  for (const s of inRange) {
    const hour = new Date(s.createdAt).getHours();
    hourCount[hour] = (hourCount[hour] || 0) + 1;

    const repo = s.gitRoot || s.cwd;
    if (repo) repoCount[repo] = (repoCount[repo] || 0) + 1;

    const created = new Date(s.createdAt).getTime();
    const updatedRaw = new Date(s.updatedAt).getTime();
    const updated = isNaN(updatedRaw) ? created : updatedRaw;
    let dur = Math.min(Math.max(updated - created, 0), 4 * 3600_000);
    let turns = 0;

    if (s.source === "cli") {
      const evPath = path.join(sDir, s.id, "events.jsonl");
      try {
        if (fs.existsSync(evPath)) {
          const stat = fs.statSync(evPath);
          const readSize = Math.min(stat.size, 1024 * 1024);
          const buf = Buffer.alloc(readSize);
          const fd = fs.openSync(evPath, "r");
          fs.readSync(fd, buf, 0, readSize, 0);
          fs.closeSync(fd);
          const tsList: number[] = [];

          for (const line of buf.toString("utf-8").split("\n")) {
            if (!line.trim()) continue;
            try {
              const ev = JSON.parse(line);
              if (ev.timestamp) {
                const t = new Date(ev.timestamp).getTime();
                if (t > 0) tsList.push(t);
              }
              if (ev.type === "tool.execution_start") {
                const tool: string = ev.data?.tool || ev.data?.toolName || "";
                if (tool) toolCount[tool] = (toolCount[tool] || 0) + 1;
              }
              if (ev.type === "assistant.turn_start") turns++;
            } catch { /* skip malformed lines */ }
          }

          if (tsList.length >= 2) {
            tsList.sort((a, b) => a - b);
            let evDur = 0;
            for (let i = 1; i < tsList.length; i++) {
              evDur += Math.min(tsList[i] - tsList[i - 1], 300_000);
            }
            if (evDur > 0) dur = evDur;
          }
        }
      } catch { /* skip unreadable sessions */ }
    }

    totalDurationMs += dur;

    const title = s.title ?? (repo ? path.basename(repo) : null);
    if (!longestSession || dur > longestSession.durationMs) {
      longestSession = { title, durationMs: dur, turns };
    }
  }

  // Token data: filter daily buckets by date range
  const tokenData = getTokenUsage("all");
  let totalTokens = 0;
  let priorTokens = 0;
  const modelTokens: Record<string, number> = {};

  for (const day of tokenData.daily) {
    const t = new Date(day.period + "T00:00:00Z").getTime();
    if (t >= cur.start.getTime() && t <= cur.end.getTime()) {
      totalTokens += day.total_tokens;
      for (const [m, stats] of Object.entries(day.models)) {
        modelTokens[m] = (modelTokens[m] || 0) + stats.total_tokens;
      }
    }
    if (t >= prior.start.getTime() && t <= prior.end.getTime()) {
      priorTokens += day.total_tokens;
    }
  }

  const mostActiveRepo =
    Object.keys(repoCount).length > 0
      ? path.basename(Object.entries(repoCount).sort((a, b) => b[1] - a[1])[0][0])
      : null;

  const peakHour =
    Object.keys(hourCount).length > 0
      ? fmtHour(parseInt(Object.entries(hourCount).sort((a, b) => b[1] - a[1])[0][0]))
      : null;

  let topTool: string | null = null;
  let topToolCalls = 0;
  if (Object.keys(toolCount).length > 0) {
    const [name, count] = Object.entries(toolCount).sort((a, b) => b[1] - a[1])[0];
    topTool = name.charAt(0).toUpperCase() + name.slice(1);
    topToolCalls = count;
  }

  let topModel: string | null = null;
  if (Object.keys(modelTokens).length > 0) {
    topModel = Object.entries(modelTokens).sort((a, b) => b[1] - a[1])[0][0];
  } else if (tokenData.totals.top_model) {
    topModel = tokenData.totals.top_model;
  }

  return {
    rangeLabel: cur.label,
    startDate: isoDay(cur.start),
    endDate: isoDay(cur.end),
    activeDays,
    totalDays,
    sessions: inRange.length,
    totalDurationMs,
    totalTokens,
    mostActiveRepo,
    peakHour,
    topTool,
    topToolCalls,
    topModel,
    longestSession: longestSession && longestSession.durationMs > 0 ? longestSession : null,
    priorSessions: inPrior.length,
    priorTokens: priorTokens > 0 ? priorTokens : null,
  };
}
