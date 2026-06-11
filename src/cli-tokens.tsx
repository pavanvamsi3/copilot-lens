#!/usr/bin/env node

import React, { useState, useEffect } from "react";
import { render, Text, Box, Newline } from "ink";
import { getTokenUsage, TokenUsageAnalytics, TokenSourceFilter, ContextUtilization } from "./token-usage";

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

function ContextEfficiency({ data }: { data: TokenUsageAnalytics }) {
  const ctx = data.contextUtilization;
  if (!ctx || ctx.totalSessionsAnalyzed === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Context Efficiency</Text>
        <Text dimColor>  No context utilization data (model or prompt tokens unknown)</Text>
      </Box>
    );
  }

  const utilPct = ctx.avgUtilizationPct.toFixed(1);
  const gaugeWidth = 20;
  const filled = Math.round((ctx.avgUtilizationPct / 100) * gaugeWidth);
  const gauge = "█".repeat(Math.min(filled, gaugeWidth)) + "░".repeat(Math.max(0, gaugeWidth - filled));
  const gaugeColor = ctx.avgUtilizationPct > 80 ? "red" : ctx.avgUtilizationPct > 50 ? "yellow" : "green";

  const effPct = (ctx.contextEfficiencyScore * 100).toFixed(1);

  const models = Object.entries(ctx.perModel)
    .sort((a, b) => b[1].totalCalls - a[1].totalCalls)
    .slice(0, 5);
  const maxName = models.length > 0 ? Math.max(...models.map(([n]) => n.length)) : 0;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Context Efficiency</Text>
      <Text>
        <Text dimColor>  Avg utilization  </Text>
        <Text color={gaugeColor}>{gauge}</Text>
        <Text>  {utilPct}%</Text>
      </Text>
      <Text>
        <Text dimColor>  Near limit (&gt;80%)  </Text>
        <Text>{ctx.sessionsNearLimit} call{ctx.sessionsNearLimit !== 1 ? "s" : ""}</Text>
        <Text dimColor>  ({ctx.sessionsNearLimitPct.toFixed(1)}%)</Text>
      </Text>
      <Text>
        <Text dimColor>  Efficiency score  </Text>
        <Text>{effPct}%</Text>
        <Text dimColor>  (output / input ratio)</Text>
      </Text>
      <Text dimColor>  {ctx.totalSessionsAnalyzed} analyzed · {ctx.totalSessionsSkipped} skipped (unknown model)</Text>
      {models.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>  Per-Model Context</Text>
          {models.map(([name, m]) => (
            <Text key={name}>
              <Text>    {name.padEnd(maxName)}</Text>
              <Text dimColor>  avg </Text>
              <Text>{m.avgUtilizationPct.toFixed(1).padStart(5)}%</Text>
              <Text dimColor>  max </Text>
              <Text>{m.maxUtilizationPct.toFixed(1).padStart(5)}%</Text>
              <Text dimColor>  near-limit </Text>
              <Text>{String(m.callsNearLimit).padStart(3)}/{m.totalCalls}</Text>
            </Text>
          ))}
        </Box>
      )}
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

function TokensApp({ source, showContext }: { source: TokenSourceFilter; showContext: boolean }) {
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
      {showContext && <ContextEfficiency data={data} />}
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
    --context                                Show context window utilization stats
    --json                                   Output raw JSON
    --help                                   Show this help
`.trimStart();

export function parseTokensArgs(argv: string[]): {
  source: TokenSourceFilter;
  json: boolean;
  help: boolean;
  context: boolean;
} {
  let source: TokenSourceFilter = "all";
  let json = false;
  let help = false;
  let context = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) {
      const v = argv[i + 1];
      if (v === "all" || v === "copilot-cli" || v === "claude-code") source = v;
      i++;
    }
    if (argv[i] === "--json") json = true;
    if (argv[i] === "--help" || argv[i] === "-h") help = true;
    if (argv[i] === "--context") context = true;
  }

  return { source, json, help, context };
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

  render(<TokensApp source={opts.source} showContext={opts.context} />);
}
