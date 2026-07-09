#!/usr/bin/env node

import * as fs from "fs";
import { bulkExport, type ExportSource, type ExportFormat } from "./export";

// ─── Argument parsing ─────────────────────────────────────────────────────────

export interface ExportArgs {
  source: ExportSource;
  from?: string;
  to?: string;
  repo?: string;
  minTurns: number;
  minTokens?: number;
  format: ExportFormat;
  output?: string;    // -o / --output file path; stdout when undefined
  includeTools: boolean;
  help: boolean;
}

export function parseExportArgs(argv: string[]): ExportArgs {
  const args: ExportArgs = {
    source: "all",
    format: "openai",
    minTurns: 1,
    includeTools: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];

    if (a === "--help" || a === "-h") { args.help = true; continue; }
    if ((a === "--source" || a === "-s") && next) {
      const validSources: ExportSource[] = ["all", "cli", "vscode", "claude-code"];
      args.source = validSources.includes(next as ExportSource) ? (next as ExportSource) : "all";
      i++;
    } else if (a === "--from" && next) {
      args.from = next; i++;
    } else if (a === "--to" && next) {
      args.to = next; i++;
    } else if (a === "--repo" && next) {
      args.repo = next; i++;
    } else if ((a === "--min-turns" || a === "--min_turns") && next) {
      const n = parseInt(next, 10);
      if (!isNaN(n) && n >= 0) args.minTurns = n;
      i++;
    } else if ((a === "--min-tokens" || a === "--min_tokens") && next) {
      const n = parseInt(next, 10);
      if (!isNaN(n) && n >= 0) args.minTokens = n;
      i++;
    } else if ((a === "--format" || a === "-f") && next) {
      const validFormats: ExportFormat[] = ["openai", "sharegpt"];
      args.format = validFormats.includes(next as ExportFormat) ? (next as ExportFormat) : "openai";
      i++;
    } else if ((a === "-o" || a === "--output") && next) {
      args.output = next; i++;
    } else if (a === "--include-tools") {
      args.includeTools = true;
    }
  }

  return args;
}

// ─── Help text ────────────────────────────────────────────────────────────────

const HELP = `
  Usage: copilot-lens export [options]

  Bulk-export sessions as NDJSON for fine-tuning (SFT datasets).

  Options:
    --source <s>        Filter by source: all (default) | cli | vscode | claude-code
    --from <date>       Include sessions updated on or after YYYY-MM-DD
    --to <date>         Include sessions updated on or before YYYY-MM-DD
    --repo <name>       Filter to sessions whose git root or cwd contains <name>
    --min-turns <n>     Minimum conversation turns / user messages (default: 1)
    --min-tokens <n>    Minimum approximate token count
    --format <f>        Output format: openai (default) | sharegpt
    --include-tools     Include tool-call events in output (stripped by default)
    -o, --output <file> Write to file instead of stdout
    -h, --help          Show this help

  Examples:
    copilot-lens export                                    # all → stdout
    copilot-lens export --from 2025-01-01 -o sft.jsonl    # since date → file
    copilot-lens export --repo copilot-lens --min-turns 3  # one repo, quality filter
    copilot-lens export --format sharegpt -o axolotl.jsonl # ShareGPT format
`;

// ─── Runner ───────────────────────────────────────────────────────────────────

export function runExportCLI(argv: string[]): void {
  const args = parseExportArgs(argv);

  if (args.help) {
    process.stdout.write(HELP + "\n");
    return;
  }

  const result = bulkExport({
    source: args.source,
    from: args.from,
    to: args.to,
    repo: args.repo,
    minTurns: args.minTurns,
    minTokens: args.minTokens,
    format: args.format,
    includeTools: args.includeTools,
  });

  const ndjson = result.lines.join("\n") + (result.lines.length ? "\n" : "");

  if (args.output) {
    fs.writeFileSync(args.output, ndjson, "utf-8");
    const statsLine =
      `Exported ${result.exportedSessions} session${result.exportedSessions !== 1 ? "s" : ""}` +
      ` (of ${result.totalSessions} total)` +
      (result.skippedTurns ? ` — ${result.skippedTurns} skipped (min-turns)` : "") +
      (result.skippedTokens ? ` — ${result.skippedTokens} skipped (min-tokens)` : "") +
      ` → ${args.output}`;
    process.stderr.write(statsLine + "\n");
  } else {
    process.stdout.write(ndjson);
    // Stats to stderr so they don't pollute piped JSONL output
    const statsLine =
      `# exported=${result.exportedSessions} total=${result.totalSessions}` +
      ` skipped_turns=${result.skippedTurns} skipped_tokens=${result.skippedTokens}\n`;
    process.stderr.write(statsLine);
  }
}
