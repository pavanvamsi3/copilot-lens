#!/usr/bin/env node

import React, { useState, useEffect } from "react";
import { render, Text, Box, Newline } from "ink";
import { getTokenUsage, TokenUsageAnalytics, TokenSourceFilter } from "./token-usage";

// ── Formatting helpers ──────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function pct(n: number, total: number): string {
  if (total === 0) return "0.0%";
  return ((n / total) * 100).toFixed(1) + "%";
}

function pad(s: string, width: number): string {
  return s.padStart(width);
}

function bar(value: number, max: number, width: number): string {
  if (max === 0) return "";
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled);
}

function shortDate(iso: string): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const d = new Date(iso);
  return `${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")}`;
}

function sourceLabel(source: TokenSourceFilter): string {
  if (source === "all") return "copilot-cli + claude-code";
  return source;
}

// ── Components ──────────────────────────────────────────────────────

function Header({ source }: { source: TokenSourceFilter }) {
  return (
    <Box>
      <Text bold color="cyan">Token Usage</Text>
      <Text dimColor>{"  " + sourceLabel(source)}</Text>
    </Box>
  );
}

function Totals({ data }: { data: TokenUsageAnalytics }) {
  const t = data.totals;
  const w = fmt(t.total_tokens).length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text bold>{pad(fmt(t.total_tokens), w)}</Text>
        <Text dimColor>  total tokens</Text>
      </Text>
      <Text>
        <Text>{pad(fmt(t.prompt_tokens), w)}</Text>
        <Text dimColor>  prompt</Text>
      </Text>
      <Text>
        <Text>{pad(fmt(t.completion_tokens), w)}</Text>
        <Text dimColor>  completion</Text>
      </Text>
      <Text>
        <Text>{pad(fmt(t.cached_tokens), w)}</Text>
        <Text dimColor>  cached </Text>
        <Text dimColor>({(t.cache_hit_rate * 100).toFixed(1)}%)</Text>
      </Text>
      <Newline />
      <Text dimColor>
        {t.active_days} active day{t.active_days !== 1 ? "s" : ""}
        {" · "}
        {fmt(t.avg_per_day)} avg/day
        {t.top_model ? ` · ${t.top_model}` : ""}
      </Text>
    </Box>
  );
}

function Models({ data }: { data: TokenUsageAnalytics }) {
  const entries = Object.entries(data.byModel)
    .sort((a, b) => b[1].total_tokens - a[1].total_tokens)
    .slice(0, 8);

  if (entries.length === 0) return null;

  const total = data.totals.total_tokens;
  const maxName = Math.max(...entries.map(([name]) => name.length));
  const maxTokens = Math.max(...entries.map(([, s]) => fmt(s.total_tokens).length));

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Models</Text>
      {entries.map(([name, stats]) => (
        <Text key={name}>
          <Text>  {name.padEnd(maxName)}</Text>
          <Text dimColor>  </Text>
          <Text>{pad(fmt(stats.total_tokens), maxTokens)}</Text>
          <Text dimColor>  {pct(stats.total_tokens, total).padStart(6)}</Text>
        </Text>
      ))}
    </Box>
  );
}

function Daily({ data }: { data: TokenUsageAnalytics }) {
  const days = data.daily.slice(-7).reverse();
  if (days.length === 0) return null;

  const maxTokens = Math.max(...days.map((d) => d.total_tokens));
  const maxFmt = Math.max(...days.map((d) => fmt(d.total_tokens).length));
  const barWidth = 16;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Daily</Text>
      {days.map((d) => (
        <Text key={d.period}>
          <Text dimColor>  {shortDate(d.period)}  </Text>
          <Text color="cyan">{bar(d.total_tokens, maxTokens, barWidth).padEnd(barWidth)}</Text>
          <Text>  {pad(fmt(d.total_tokens), maxFmt)}</Text>
        </Text>
      ))}
    </Box>
  );
}

function EmptyState({ source }: { source: TokenSourceFilter }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>No token usage data found.</Text>
      <Text dimColor>
        {source === "copilot-cli"
          ? "Logs expected in ~/.copilot/logs/"
          : source === "claude-code"
            ? "Logs expected in ~/.claude/projects/"
            : "Logs expected in ~/.copilot/logs/ and ~/.claude/projects/"}
      </Text>
    </Box>
  );
}

function TokensApp({ source }: { source: TokenSourceFilter }) {
  const [data, setData] = useState<TokenUsageAnalytics | null>(null);

  useEffect(() => {
    setData(getTokenUsage(source));
  }, [source]);

  if (!data) {
    return <Text dimColor>Scanning logs…</Text>;
  }

  if (data.totals.calls === 0) {
    return (
      <Box flexDirection="column">
        <Header source={source} />
        <EmptyState source={source} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header source={source} />
      <Totals data={data} />
      <Models data={data} />
      <Daily data={data} />
      <Text>{""}</Text>
    </Box>
  );
}

// ── CLI ─────────────────────────────────────────────────────────────

const HELP = `
  Usage: copilot-lens tokens [options]

  Options:
    --source <all|copilot-cli|claude-code>   Filter by source (default: all)
    --json                                   Output raw JSON
    --help                                   Show this help
`.trimStart();

export function parseTokensArgs(argv: string[]): {
  source: TokenSourceFilter;
  json: boolean;
  help: boolean;
} {
  let source: TokenSourceFilter = "all";
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) {
      const v = argv[i + 1];
      if (v === "all" || v === "copilot-cli" || v === "claude-code") source = v;
      i++;
    }
    if (argv[i] === "--json") json = true;
    if (argv[i] === "--help" || argv[i] === "-h") help = true;
  }

  return { source, json, help };
}

export function runTokensTUI(argv: string[]): void {
  const opts = parseTokensArgs(argv);

  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  if (opts.json) {
    const data = getTokenUsage(opts.source);
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }

  render(<TokensApp source={opts.source} />);
}
