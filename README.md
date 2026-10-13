# Copilot Lens 👓

[![CI](https://github.com/pavanvamsi3/copilot-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/pavanvamsi3/copilot-lens/actions/workflows/ci.yml)

**Your Copilot history has answers. Now you can actually find them.**

A local memory layer for AI coding assistants. Search and browse everything you've ever discussed with Copilot CLI, VS Code Copilot Chat, or Claude Code. All on your machine. No cloud, no sign-in.

![copilot-lens hero](https://raw.githubusercontent.com/pavanvamsi3/copilot-lens/main/assets/copilot-lens-hero.png)

## Install

```bash
npx copilot-lens --open
```

Or `npm install -g copilot-lens` for a permanent install.

## Usage

```bash
copilot-lens                  # Web dashboard at localhost:3000
copilot-lens --open           # Open browser automatically
copilot-lens --port 8080
copilot-lens --version        # Print the installed version (or use -v)
copilot-lens tokens           # Token usage in the terminal (Ink TUI)
copilot-lens tokens --json    # Machine-readable output
```

## Configuration

Set `COPILOT_LENS_CACHE_TTL_MS` before starting Copilot Lens to tune the session-list, analytics, and token-usage cache lifetime. It accepts a non-negative integer in milliseconds and defaults to `30000` (30 seconds). Unset, empty, or invalid values use that default; `0` disables caching.

For example, use a five-second cache lifetime:

```bash
COPILOT_LENS_CACHE_TTL_MS=5000 copilot-lens --open
```

In PowerShell:

```powershell
$env:COPILOT_LENS_CACHE_TTL_MS = "5000"
copilot-lens --open
```

## Search API

`GET /api/search?q=keyword&offset=20&limit=20` returns matches 21–40 as an array
of search results. Ranking and source filtering happen before pagination.

`limit` defaults to `20` and accepts integers from `1` to `100`; `offset` defaults
to `0` and accepts non-negative safe integers. Query values must be decimal
integers. Invalid or repeated pagination parameters return HTTP 400 with an
`error` message. Offsets beyond the last match return an empty array.

## Features

- **Search**: full-text across every session, with source/date/directory filters
- **Sessions**: unified browser for Copilot CLI, VS Code Copilot Chat, and Claude Code conversations, including extended-thinking blocks where supported
- **Analytics**: eight charts covering daily activity, hour-of-day, tools, models, top directories, time per branch/repo, and MCP servers
- **Tokens**: real API-reported token usage parsed from local logs, with daily/weekly/monthly views, model breakdown, and an estimated upstream API cost
- **Effectiveness Score**: 0 to 100 score per repo with improvement tips
- **Export**: single-session OpenAI-style chat JSONL, suitable as SFT data

For case-sensitive API queries, use `/api/search?q=HTTPServer&caseSensitive=true`.
This preserves case when matching query tokens against message content, titles,
and directories, and when choosing highlight snippets. Searches without this
option remain case-insensitive.

### Sessions

![Unified session browser across Copilot CLI, VS Code Copilot Chat, and Claude Code](https://raw.githubusercontent.com/pavanvamsi3/copilot-lens/main/assets/copilot-lens-sessions-list.png?v=3)

### Analytics

![Eight charts showing how and when you use Copilot and Claude](https://raw.githubusercontent.com/pavanvamsi3/copilot-lens/main/assets/copilot-lens-demo.png)

### Tokens

![Real API-reported token usage with daily, weekly, and monthly views](https://raw.githubusercontent.com/pavanvamsi3/copilot-lens/main/assets/copilot-lens-tokens.png?v=2)

### Effectiveness Score

![0 to 100 score per repo with actionable improvement tips](https://raw.githubusercontent.com/pavanvamsi3/copilot-lens/main/assets/copilot-lens-score.png)

> **About the cost number:** GitHub Copilot bills on **premium requests**, not tokens. The cost shown is what you'd pay calling Anthropic / OpenAI / Google directly with the same usage. Useful as a reference, not your GitHub bill.

### Estimated API cost

The JSON token-usage response includes `totals.estimatedCostUSD`, a lifetime
estimate for the selected source. It is `null` if any model is unpriced and `0`
when there are no calls. The API table supports `claude-sonnet-4` (including
`claude-sonnet-4-20250514`) and `gpt-4o` (including its `2024-08-06` and
`2024-11-20` snapshots). CAPI routing prefixes are normalized before lookup.

Approximate standard USD rates per million tokens, checked October 13, 2026:

| Model           | Input | Cached input | Output |
| --------------- | ----- | ------------ | ------ |
| Claude Sonnet 4 | $3.00 | $0.30        | $15.00 |
| GPT-4o          | $2.50 | $1.25        | $10.00 |

Rates come from [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
and [OpenAI GPT-4o pricing](https://developers.openai.com/api/docs/models/gpt-4o).
Cached input is charged separately from other prompt tokens. Cache-write
premiums, long-context surcharges, service tiers, and other fees are excluded,
so this is an approximate API reference cost, not a Copilot bill. The dashboard
has a separate, broader pricing table and can show a partially priced estimate.

### Token usage CSV export

Download `/api/token-usage?format=csv` to analyse individual calls in a spreadsheet.
Add `source=copilot-cli` or `source=claude-code` to filter the export. The CSV uses
the same cached snapshot as the JSON summary and lists calls chronologically with
columns `timestamp`, `model`, `source`, `prompt_tokens`, `completion_tokens`,
`cached_tokens`, and `total_tokens`. Text cells are quoted, and formula-prefixed
text is prefixed with an apostrophe for spreadsheet import. Empty sources return
the header row.

## Where the data comes from

| Source                 | Path                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| Copilot CLI sessions   | `~/.copilot/session-state/`                                                                       |
| Copilot CLI token logs | `~/.copilot/logs/process-*.log`                                                                   |
| VS Code Copilot Chat   | `~/Library/Application Support/Code/` (macOS), `%APPDATA%/Code/` (Win), `~/.config/Code/` (Linux) |
| Claude Code            | `~/.claude/projects/`                                                                             |

VS Code Insiders is supported. Pasted images are stripped; files over 200MB are skipped. Durations exclude gaps longer than 5 minutes so paused sessions aren't inflated.

## Development

```bash
git clone https://github.com/pavanvamsi3/copilot-lens.git
cd copilot-lens
npm install
npm run dev        # tsx, no build step
npm run build
npm test
```

Stack: Node + Express + TypeScript, vanilla frontend, Chart.js, Ink for the TUI, Vitest.

## License

MIT
