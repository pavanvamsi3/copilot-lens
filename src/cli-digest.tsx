#!/usr/bin/env node

import React, { useState, useEffect } from "react";
import { render, Text, Box, Newline } from "ink";
import * as fs from "fs";
import * as path from "path";
import { getDigest, DigestPeriod, DigestData } from "./digest";

// ── Helpers ──────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return "< 1m";
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}k`;
  return n.toString();
}

function changeBadge(current: number, prior: number | null): string | null {
  if (prior === null || prior === 0) return null;
  const pct = Math.round(((current - prior) / prior) * 100);
  const arrow = pct >= 0 ? "▲" : "▼";
  return `${arrow} ${Math.abs(pct)}% vs prior`;
}

// ── TUI Component ────────────────────────────────────────────────────

type Row = { icon: string; label: string; value: string; badge?: string };

function DigestApp({ period }: { period: DigestPeriod }) {
  const [data, setData] = useState<DigestData | null>(null);

  useEffect(() => {
    setData(getDigest(period));
  }, [period]);

  if (!data) return <Text dimColor>Computing digest…</Text>;

  if (data.sessions === 0 && data.totalTokens === 0) {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">{data.rangeLabel}</Text>
        <Text dimColor>No activity found for this period.</Text>
        <Text>{""}</Text>
      </Box>
    );
  }

  const SEP = "────────────────────────────────────";

  const rows: Row[] = [
    { icon: "📅", label: "Active days",     value: `${data.activeDays} / ${data.totalDays}` },
    {
      icon: "💬", label: "Sessions",
      value: String(data.sessions),
      badge: changeBadge(data.sessions, data.priorSessions) ?? undefined,
    },
    { icon: "⏱ ", label: "Total time",      value: fmtMs(data.totalDurationMs) },
    {
      icon: "🔤", label: "Tokens used",
      value: fmtTokens(data.totalTokens),
      badge: changeBadge(data.totalTokens, data.priorTokens) ?? undefined,
    },
    ...(data.mostActiveRepo ? [{ icon: "🏆", label: "Most active repo", value: data.mostActiveRepo }] : []),
    ...(data.peakHour       ? [{ icon: "🕐", label: "Peak hour",         value: data.peakHour }]       : []),
    ...(data.topTool        ? [{
      icon: "🔧", label: "Top tool",
      value: data.topToolCalls > 0 ? `${data.topTool} (${data.topToolCalls} calls)` : data.topTool,
    }] : []),
    ...(data.topModel ? [{ icon: "🤖", label: "Top model", value: data.topModel }] : []),
  ];

  const labelW = Math.max(...rows.map((r) => r.label.length));

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">{data.rangeLabel}</Text>
      <Text dimColor>{SEP}</Text>
      {rows.map((row) => (
        <Text key={row.label}>
          <Text>{"  "}{row.icon}{"  "}</Text>
          <Text dimColor>{row.label.padEnd(labelW)}</Text>
          <Text>{"  "}{row.value}</Text>
          {row.badge ? <Text dimColor>{"     "}{row.badge}</Text> : null}
        </Text>
      ))}
      {data.longestSession && (
        <Box marginTop={1}>
          <Text dimColor>
            {"  Longest session: "}
            {data.longestSession.title
              ? `"${data.longestSession.title.length > 40 ? data.longestSession.title.slice(0, 40) + "…" : data.longestSession.title}" — `
              : ""}
            {fmtMs(data.longestSession.durationMs)}
            {data.longestSession.turns > 0 ? `, ${data.longestSession.turns} turns` : ""}
          </Text>
        </Box>
      )}
      <Newline />
    </Box>
  );
}

// ── Markdown export ──────────────────────────────────────────────────

function toMarkdown(data: DigestData): string {
  function change(cur: number, prior: number | null) {
    const b = changeBadge(cur, prior);
    return b ? ` _(${b})_` : "";
  }

  const lines = [
    "# AI Usage Digest",
    "",
    `## ${data.rangeLabel}`,
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| Active days | ${data.activeDays} / ${data.totalDays} |`,
    `| Sessions | ${data.sessions}${change(data.sessions, data.priorSessions)} |`,
    `| Total time | ${fmtMs(data.totalDurationMs)} |`,
    `| Tokens used | ${fmtTokens(data.totalTokens)}${change(data.totalTokens, data.priorTokens)} |`,
  ];
  if (data.mostActiveRepo) lines.push(`| Most active repo | ${data.mostActiveRepo} |`);
  if (data.peakHour) lines.push(`| Peak hour | ${data.peakHour} |`);
  if (data.topTool) {
    const v = data.topToolCalls > 0 ? `${data.topTool} (${data.topToolCalls} calls)` : data.topTool;
    lines.push(`| Top tool | ${v} |`);
  }
  if (data.topModel) lines.push(`| Top model | ${data.topModel} |`);

  if (data.longestSession) {
    const title = data.longestSession.title ?? "Untitled";
    const dur = fmtMs(data.longestSession.durationMs);
    const turns = data.longestSession.turns > 0 ? `, ${data.longestSession.turns} turns` : "";
    lines.push("", "---", "", `**Longest session:** "${title}" — ${dur}${turns}`);
  }

  lines.push("", "---", "", "_Generated by copilot-lens_");
  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────

const HELP = `
  Usage: copilot-lens digest [options]

  Print a weekly usage summary to the terminal (Spotify Wrapped-style).

  Options:
    --last-week   Show last week instead of the current week
    --month       Show the current month's digest
    --save        Also write digest.md to the current directory
    --json        Output raw JSON (pipeline-friendly)
    -h, --help    Show this help
`.trimStart();

export function parseDigestArgs(argv: string[]): {
  period: DigestPeriod;
  save: boolean;
  json: boolean;
  help: boolean;
} {
  let period: DigestPeriod = "week";
  let save = false;
  let json = false;
  let help = false;

  for (const a of argv) {
    if (a === "--last-week") period = "last-week";
    else if (a === "--month") period = "month";
    else if (a === "--save") save = true;
    else if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") help = true;
  }

  return { period, save, json, help };
}

export function runDigestTUI(argv: string[]): void {
  const opts = parseDigestArgs(argv);

  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  if (opts.json) {
    const data = getDigest(opts.period);
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }

  if (opts.save) {
    const data = getDigest(opts.period);
    const md = toMarkdown(data);
    const outPath = path.join(process.cwd(), "digest.md");
    fs.writeFileSync(outPath, md, "utf-8");
    process.stderr.write(`Saved digest to ${outPath}\n`);
  }

  render(<DigestApp period={opts.period} />);
}
