# Copilot Lens — Architecture

A local web dashboard for analyzing AI coding assistant sessions from Copilot CLI, VS Code Copilot Chat, and Claude Code.

## Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser (SPA)                             │
│  ┌──────────────────┐  ┌────────────┐  ┌──────────────────────┐ │
│  │     Sessions     │  │ Analytics  │  │      Insights        │ │
│  │  Full-text Search│  │  8 Charts  │  │ Effectiveness Score  │ │
│  │  Filters + List  │  │ Source     │  │ Per-repo + VS Code   │ │
│  │  Detail Modal    │  │  Filter    │  │                      │ │
│  └──────────────────┘  └────────────┘  └──────────────────────┘ │
└────────────────────────┬─────────────────────────────────────────┘
                         │ HTTP (localhost)
┌────────────────────────┴─────────────────────────────────────────┐
│                    Express Server (server.ts)                     │
│                                                                   │
│  GET /api/search            GET /api/analytics?source=           │
│  GET /api/sessions          GET /api/insights/repos               │
│  GET /api/sessions/:id      GET /api/insights/score?repo=...      │
│  POST /api/cache/clear                                            │
└──────┬────────────────────────────┬──────────────┬───────────────┘
       │                            │              │
┌──────┴───────┐  ┌─────────────────┴──┐  ┌───────┴──────────────┐
│ sessions.ts  │  │ vscode-sessions.ts  │  │claude-code-sessions.ts│
│              │  │                     │  │                       │
│ CLI Sessions │  │ VS Code Sessions    │  │ Claude Code Sessions  │
│ Analytics    │  │ Analytics           │  │ Analytics             │
│ Scoring      │  │ Tool Normalization  │  │                       │
└──────┬───────┘  └──────────┬──────────┘  └───────┬──────────────┘
       │                     │                      │
┌──────┴───────┐  ┌──────────┴──────────┐  ┌───────┴──────────────┐
│  Filesystem  │  │   SQLite + JSON      │  │     Filesystem        │
│              │  │                      │  │                       │
│ ~/.copilot/  │  │ ~/Library/App.../    │  │ ~/.claude/projects/   │
│ session-     │  │ Code/User/           │  │  {project}/           │
│ state/       │  │ globalStorage/       │  │   {uuid}.jsonl        │
│  ├─ workspace│  │  ├─ state.vscdb      │  │                       │
│  │  .yaml    │  │  └─ emptyWindow      │  │ (JSONL event stream)  │
│  ├─ events   │  │     ChatSessions/    │  │                       │
│  │  .jsonl   │  │     └─ {id}.json     │  │                       │
│  └─ plan.md  │  └─────────────────────┘  └───────────────────────┘
└──────────────┘
       │
┌──────┴───────┐
│  search.ts   │
│              │
│  SearchIndex │
│  Tokenize    │
│  Score+Rank  │
│  Highlights  │
└──────────────┘
```

## File Structure

```
copilot-lens/
├── src/
│   ├── cli.ts                       # Entry point — CLI arg parsing, server startup
│   ├── server.ts                    # Express app with API routes
│   ├── sessions.ts                  # Core: CLI sessions, analytics, scoring engine
│   ├── vscode-sessions.ts           # VS Code session reading and normalization
│   ├── claude-code-sessions.ts      # Claude Code session reading and analytics
│   ├── cache.ts                     # In-memory TTL cache utility
│   ├── search.ts                    # Full-text search index and ranking
│   └── __tests__/
│       ├── sessions.test.ts         # 16 tests
│       ├── vscode-sessions.test.ts  # 37 tests
│       ├── claude-code-sessions.test.ts  # 27 tests
│       ├── cache.test.ts            # 7 tests
│       └── search.test.ts          # 10 tests
├── public/
│   ├── index.html              # SPA shell (3 pages, nav, modal)
│   ├── app.js                  # Frontend logic (fetch, render, charts, search)
│   └── style.css               # Dark/light theme styles
├── package.json
├── vitest.config.ts
└── tsconfig.json
```

**Total**: ~5,000 lines across 15 source files (97 tests).

---

## Entry Point & Startup

**File**: `src/cli.ts` (39 lines)

```
#!/usr/bin/env node → createApp() → app.listen(port, host)
```

1. Registers global error handlers (`uncaughtException`, `unhandledRejection`)
2. Parses CLI args: `--port` (default 3000), `--host` (default localhost), `--open`
3. Calls `createApp()` from `server.ts` to build the Express app
4. Starts listening; optionally opens browser via platform-specific command (`open` / `start` / `xdg-open`)

---

## Backend Modules

### `server.ts` — API Layer (122 lines)

Creates an Express app with CORS, static file serving, and 7 API endpoints:

| Endpoint | Method | Handler | Description |
|----------|--------|---------|-------------|
| `/api/search` | GET | `searchIndex.search()` | Full-text search across session content; params: `q`, `source`, `limit` |
| `/api/sessions` | GET | `listSessions()` | All sessions (Copilot CLI + VS Code + Claude Code), sorted by date |
| `/api/sessions/:id` | GET | `getSession(id)` | Full session detail with events |
| `/api/analytics?source=` | GET | `getAnalytics(source)` | Aggregated usage statistics; `source`: `all`\|`cli`\|`vscode`\|`claude-code` |
| `/api/insights/repos` | GET | `listReposWithScores()` | All repos with effectiveness scores |
| `/api/insights/score?repo=` | GET | `getRepoScore(repo)` / `getVSCodeScore()` | Score for a specific repo (or "VS Code" for global) |
| `/api/cache/clear` | POST | `clearCache()` + `searchIndex.clear()` | Invalidate all cached data and search index |

Also serves `public/` as static files and has an SPA fallback that serves `index.html` for non-API routes.

A single `SearchIndex` instance is held for the lifetime of the server process. `buildIndex` is a no-op if entries are already populated, so the index is built once per cache cycle and invalidated together with the session cache when the user clicks Refresh.

---

### `sessions.ts` — Core Engine (873 lines)

The largest module. Handles CLI session reading, unified session listing, analytics aggregation, and the scoring system.

#### Data Types

| Type | Fields | Purpose |
|------|--------|---------|
| `SessionMeta` | id, cwd, gitRoot, branch, createdAt, updatedAt, status, source, title | Session list item |
| `SessionDetail` | extends SessionMeta + events[], planContent, hasSnapshots, duration, eventCounts | Full session view |
| `SessionEvent` | type, id, timestamp, data | Individual event in a session |
| `AnalyticsData` | sessionsPerDay, hourOfDay, toolUsage, modelUsage, branchTime, repoTime, topDirectories, mcpServers, totalSessions, totalDuration, longestSession, avgDuration, totalErrors | Dashboard analytics |
| `RepoScore` | repo, totalScore (0-100), sessionCount, categories (5), tips[] | Effectiveness score |
| `CategoryScore` | score, maxScore, label, detail | Individual scoring category |

#### Key Functions

**Session Management:**

- **`listSessions()`** — Merges `listCliSessions()` + `listVSCodeSessions()` + `listClaudeCodeSessions()`, sorted by `createdAt` descending. Cached with 30s TTL.
- **`getSession(id)`** — Routes to VS Code, Claude Code, or CLI reader in order. CLI: reads `workspace.yaml` + `events.jsonl` + `plan.md`. VS Code/Claude Code: delegates to respective module.
- **`listCliSessions()`** — Scans `~/.copilot/session-state/` directories. For each: reads `workspace.yaml` (YAML metadata), reads last 2KB of `events.jsonl` (for latest timestamp), detects status.

**Status Detection (CLI):**

| Status | Condition |
|--------|-----------|
| Running | `session.db` modified within 10 min, or `events.jsonl` modified within 5 min |
| Error | Has `abort` event with non-user reason |
| Completed | Everything else |

**Analytics (`getAnalytics(source)`):**

Cached with 30s TTL, keyed by source filter. Accepts `source: "all" | "cli" | "vscode" | "claude-code"` to return per-source breakdowns. Computes:
- Sessions per day (bar chart data)
- Activity by hour of day
- Tool usage counts (from `tool.execution_start` events)
- Model usage counts (from `model.change` events)
- Top working directories (VS Code sessions labeled as "VS Code")
- Time per branch and per repo (gap-capped durations)
- MCP servers used
- Summary stats (total sessions, duration, longest, average, errors)

CLI sessions are scanned from `events.jsonl`. VS Code and Claude Code sessions delegate to `getVSCodeAnalytics()` and `getClaudeCodeAnalytics()` respectively, then merge results.

**Duration Calculation:**

Both CLI and VS Code sessions use **gap-capped duration**: sum of time between consecutive events, with a 5-minute maximum per gap. This prevents inflated durations from sessions left idle overnight.

```
Event 1 ──2min──> Event 2 ──8hr──> Event 3 ──1min──> Event 4
Duration = 2min + 5min(capped) + 1min = 8min
```

**Scoring System (`getRepoScore()`, `getVSCodeScore()`):**

Five categories, each scored 0-20 (total 0-100):

| Category | Function | What It Measures |
|----------|----------|-----------------|
| Prompt Quality | `scorePromptQuality()` | Avg prompt length (5-20pts) minus clarification penalty |
| Tool Utilization | `scoreToolUtilization()` | Count of distinct tools used (5-20pts) |
| Efficiency | `scoreEfficiency()` | Tool success rate (4-15pts) + concise session bonus (+5) |
| MCP Utilization | `scoreMcpUtilization()` | Ratio of configured vs used MCP servers (5-20pts) |
| Engagement | `scoreEngagement()` | Duration sweet spot 5-30min (3-15pts) + consistency bonus (+5) |

**Data Collection:**

- **CLI** (`collectRepoData`): Filters sessions by `gitRoot || cwd === repoPath`, then scans each session's `events.jsonl` for user messages, tool executions, turn counts, and MCP server info.
- **VS Code** (`collectVSCodeData`): Uses `getVSCodeAnalytics()` output. Normalizes tool names via `normalizeVSCodeToolName()`. No per-repo filtering (global score).

**MCP Config Scanning:**

- CLI repos: checks `{repo}/.vscode/mcp.json` and `{repo}/.github/copilot/mcp.json`
- VS Code: checks `~/Library/Application Support/Code/User/mcp.json` and `~/.vscode/mcp.json`
- Handles JSONC (strips trailing commas before parsing)

**Tips Generation (`generateTips()`):**

Examines low-scoring categories and generates actionable advice:
- Short prompts → suggest adding context
- Few tools → suggest specific tools to try
- Low success rate → suggest clearer instructions
- Unused MCP servers → list which ones to leverage
- Brief/infrequent sessions → suggest more engagement

---

---

### `claude-code-sessions.ts` — Claude Code Reader (310 lines)

Reads Claude Code CLI sessions from `~/.claude/projects/`.

#### Data Sources

| Data | Location | Format |
|------|----------|--------|
| Sessions | `~/.claude/projects/{sanitized-path}/{uuid}.jsonl` | JSONL event stream |

Each project directory corresponds to one working directory (path encoded as `-Users-name-project`). Each top-level `.jsonl` file is one session; files inside `subagents/` subdirectories are skipped.

#### Event Types

| JSONL `type` | Mapped to | Key Fields |
|-------------|-----------|------------|
| `user` | `user.message` | `message.content` (string or content blocks), `cwd`, `gitBranch`, `slug`, `timestamp` |
| `assistant` | `assistant.message` + `tool.execution_start` (per tool_use block) | `message.content[]`, `message.model`, `timestamp` |
| `file-history-snapshot`, `progress`, `queue-operation`, `system` | skipped | — |

Events with `isSidechain: true` are filtered out (warmup/sidebar calls made by sub-agents).

#### Key Functions

- **`listClaudeCodeSessions()`** — Scans all project subdirectories for top-level `*.jsonl` files. Reads up to 5000 lines per file to extract metadata (`cwd`, `gitBranch`, `slug`, timestamps). Skips sessions with no non-sidechain `user` events. Returns `SessionMeta[]` with `source: "claude-code"` and `title: slug`.

- **`getClaudeCodeSession(sessionId)`** — Finds and parses the full JSONL. Converts events to `SessionEvent[]`, skipping sidechains. Emits one `tool.execution_start` per `tool_use` block in assistant messages. Computes gap-capped duration. Status is `"running"` if last event < 5 min ago.

- **`isClaudeCodeSession(id)`** — Scans projects dir for `{id}.jsonl`.

- **`getClaudeCodeAnalytics()`** — Cached with 30s TTL. Aggregates tool usage (from `tool_use` blocks), model usage (from `message.model`), turn counts, and message lengths per session.

#### Claude Code JSONL Structure

```
// user event
{
  type: "user",
  uuid: "...",
  sessionId: "uuid",
  isSidechain: false,
  cwd: "/Users/name/project",
  gitBranch: "main",
  slug: "happy-seeking-whistle",
  timestamp: "2026-02-19T10:00:00Z",
  message: { role: "user", content: "your prompt here" }
}

// assistant event
{
  type: "assistant",
  uuid: "...",
  sessionId: "uuid",
  isSidechain: false,
  timestamp: "2026-02-19T10:00:05Z",
  message: {
    model: "claude-sonnet-4-6",
    content: [
      { type: "thinking", thinking: "..." },
      { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
      { type: "text", text: "Here is the result..." }
    ]
  }
}
```

---

### `search.ts` — Full-Text Search Engine (170 lines)

Provides an in-process, dependency-free full-text search over all session content.

#### Exported Types

| Type | Fields | Purpose |
|------|--------|---------|
| `SearchEntry` | id, source, title, cwd, date, content[] | Indexed representation of one session |
| `SearchResult` | entry, score, highlights[] | Ranked search hit with extracted snippets |
| `SearchOptions` | limit (default 20), source ('cli'\|'vscode'\|'claude-code'\|'all') | Query parameters |

#### `SearchIndex` class

**`buildIndex(sessions: SessionMeta[]): void`**

- Stores the sessions list for lazy rebuilds after `clear()`
- No-op if entries are already populated (call `clear()` first to force rebuild)
- For each session: calls `getSession(id)`, extracts text from `user.message` and `assistant.message` events, strips code blocks (triple-backtick fences) before indexing

**`search(query: string, options?: SearchOptions): SearchResult[]`**

1. Returns `[]` for empty/blank queries immediately
2. Lazy-rebuilds from stored sessions if entries array is empty (supports the post-`clear()` pattern)
3. Tokenises query: lowercase, split on non-alphanumeric chars, drop tokens < 2 chars
4. For each entry, computes a relevance score:

   | Signal | Weight |
   |--------|--------|
   | Token occurrence count in content | `count / total_word_count` |
   | Token appears in `title` | +0.5 per token |
   | Token appears in `cwd` | +0.2 per token |

5. Filters to score > 0, applies `source` filter, sorts descending, slices to `limit`
6. For each result, calls `extractHighlights()` to produce up to 3 contextual snippets

**`extractHighlights(rawContent, tokens): string[]`**

- Finds match positions in lowercased content
- Extracts ±60 chars around each match start (max 120-char window)
- Trims to nearest word boundary
- Merges overlapping windows; returns up to 3 unique snippets

**`clear(): void`**

Resets the entries array. Stored sessions are kept so the next `search()` call can lazy-rebuild without requiring an explicit `buildIndex()` call first.

#### `tokenize(query): string[]` (exported)

Shared tokenizer: `query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2)`

---

### `vscode-sessions.ts` — VS Code Reader (494 lines)

Reads GitHub Copilot Chat sessions from VS Code's local storage.

#### Data Sources

| Data | Location | Format |
|------|----------|--------|
| Session Index | `{vscode-data}/User/globalStorage/state.vscdb` | SQLite, key `chat.ChatSessionStore.index` |
| Session Content | `{vscode-data}/User/globalStorage/emptyWindowChatSessions/{id}.json` | JSON (can be 1KB-450MB) |
| MCP Config | `{vscode-data}/User/mcp.json` | JSONC |

**Platform Paths** (`getVSCodeDataDirs()`):

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Code/` |
| Windows | `%APPDATA%/Code/` |
| Linux | `~/.config/Code/` |

Also checks "Code - Insiders" variant on all platforms.

#### Key Functions

- **`readSessionIndex(dataDir)`** — Opens `state.vscdb` with `better-sqlite3` (readonly), queries `ItemTable` for `chat.ChatSessionStore.index`. Handles Buffer return from BLOB columns. Returns array of `VSCodeSessionIndex` (sessionId, title, timing, isEmpty).

- **`readSessionContent(filePath)`** — Reads session JSON with protections:
  - Skips files > 200MB (`MAX_FILE_SIZE`)
  - Strips base64 image data via `JSON.parse` reviver (variables with `kind: "image"` and value > 1000 chars → `"[image data omitted]"`)
  - Truncates message text > 10KB (`MAX_TEXT_LENGTH`)

- **`requestsToEvents(requests)`** — Converts VS Code's request/response format into the unified `SessionEvent[]` format used by CLI sessions:
  - Each request → `assistant.turn_start` + `user.message` + tool events + `assistant.message`
  - Tool invocations → `tool.execution_start` events
  - Response parts filtered: `thinking` parts excluded, text parts concatenated
  - Timestamps derived from `request.timestamp` and `modelState.completedAt`

- **`listVSCodeSessions()`** — Uses index only (no JSON file reads). Maps each index entry to `SessionMeta` with `source: "vscode"`.

- **`getVSCodeSession(sessionId)`** — Reads the full JSON file, converts to `SessionDetail` with gap-capped duration.

- **`getVSCodeAnalytics()`** — Cached with 30s TTL. Parses all non-empty session files to extract tool usage, model usage, turn counts, durations, and message lengths.

- **`normalizeVSCodeToolName(raw)`** — Maps verbose VS Code tool descriptions to canonical short names:

  | Input Pattern | Output |
  |--------------|--------|
  | `"bluebird-mcp (MCP Server)"` | `{ tool: "bluebird-mcp", mcpServer: "bluebird-mcp" }` |
  | `"Running \`engineering_copilot\`"` | `{ tool: "engineering_copilot" }` |
  | `"Reading [](file:///...)"` | `{ tool: "read_file" }` |
  | `"Searching for regex ..."` | `{ tool: "search" }` |
  | `"Creating [](file:///...)"` | `{ tool: "create_file" }` |
  | `"Editing [](file:///...)"` | `{ tool: "edit_file" }` |

- **`scanVSCodeMcpConfig()`** — Reads MCP server names from VS Code's `mcp.json` config.

#### VS Code Session JSON Structure

```
{
  version: 3,
  sessionId: "uuid",
  creationDate: 1700000000000,
  lastMessageDate: 1700001000000,
  mode: { id: "agent", kind: "agent" },
  selectedModel: { identifier: "copilot/claude-sonnet-4.5", ... },
  customTitle: "My Chat Session",
  requests: [
    {
      requestId: "uuid",
      timestamp: 1700000000000,
      message: { text: "user prompt", parts: [...] },
      modelId: "copilot/claude-sonnet-4.5",
      response: [
        { kind: "toolInvocationSerialized", invocationMessage: {...}, originMessage: "..." },
        { kind: "thinking", value: "..." },
        { value: "response text" }
      ],
      result: { timings: { totalElapsed: 5000 } },
      variableData: { variables: [{ kind: "image", value: "base64..." }] }
    }
  ]
}
```

---

### `cache.ts` — TTL Cache (21 lines)

Simple in-memory cache using a `Map<string, { value, expiresAt }>`.

| Function | Signature | Purpose |
|----------|-----------|---------|
| `cachedCall` | `<T>(key: string, ttlMs: number, fn: () => T): T` | Return cached value if fresh, otherwise compute and cache |
| `clearCache` | `(): void` | Invalidate all entries (called by refresh button) |

**TTL**: 30 seconds (defined in consumers). Entries auto-expire — no background cleanup needed since stale entries are replaced on next call.

**What's cached:**

| Cache Key | TTL | Typical Cold Time | Purpose |
|-----------|-----|-------------------|---------|
| `listSessions` | 30s | ~7ms | Directory scanning + YAML parsing |
| `getAnalytics:all` | 30s | ~1.8s | Full analytics aggregation (all sources) |
| `getAnalytics:cli` | 30s | ~50ms | CLI-only analytics |
| `getAnalytics:vscode` | 30s | ~1.8s | VS Code-only analytics |
| `getAnalytics:claude-code` | 30s | ~100ms | Claude Code-only analytics |
| `getVSCodeAnalytics` | 30s | ~1.8s | VS Code JSON file parsing |
| `getClaudeCodeAnalytics` | 30s | ~100ms | Claude Code JSONL parsing |

---

## Frontend

### `index.html` — SPA Shell (118 lines)

Single HTML page with three mutually-exclusive sections:

```html
<header>  Logo | [Sessions] [Analytics] [Insights] | 🔄 Refresh | 🌗 Theme </header>
<main>
  <section id="sessionsPage">
    <div class="search-bar-wrap">  Full-text search input + clear button  </div>
    <div class="controls">         Time / Status / Directory filters       </div>
    <div id="sessionList">         Session cards or search results         </div>
  </section>
  <section id="analyticsPage">   Stats Cards, 8 Chart Canvases    </section>
  <section id="insightsPage">    Repo Selector, Score Display      </section>
</main>
<div id="detailModal">           Session Detail Drawer              </div>
```

External dependency: **Chart.js 4.x** via CDN.

### `app.js` — Frontend Logic (695 lines)

All rendering and interactivity in vanilla JavaScript (no framework).

**Page: Sessions**
- `loadSessions()` — Fetches `/api/sessions`, renders cards with source badges (CLI/VS Code), status indicators, color-coded directories
- **Full-text search** (`#searchInput`): 300ms debounced input → `runSearch(q)` → `GET /api/search` → `renderSearchResults(results)`
  - Shows up to 3 highlight snippets per card (`.search-highlights > .highlight-snippet`)
  - Clear button (`#searchClear`) resets to normal list view via `clearSearch()`
  - `isSearchActive` flag prevents filter-change events from overriding active search results
- Three filter dropdowns: time range (24h/7d/30d/all), status, directory (only active when `isSearchActive = false`)
- Click card → `openDetail(id)` fetches `/api/sessions/:id` → renders conversation view in modal

**Page: Analytics**
- `loadAnalytics()` — Fetches `/api/analytics?source={analyticsSource}`, renders 4 stat cards + 8 Chart.js charts
- Source filter toggle buttons (All / Copilot CLI / VS Code / Claude Code) re-fetch with matching `?source=` param
- Chart types: bar (sessions/day, hourly), doughnut (tools, models, MCP), horizontal bar (directories, branches, repos)
- Doughnut legends are interactive (click to toggle segments)
- Empty-state handling hides canvas and shows message in-place (preserves canvas element for re-render)

**Page: Insights**
- `loadInsights()` → Fetches `/api/insights/repos` → renders repo selector dropdown
- VS Code entry shows as "🟣 VS Code (all sessions)"
- `renderInsightsScore(data)` — SVG donut chart (score/100), 5 category bars with color coding, tips section

**Utilities:**
- `escapeHtml()` — XSS prevention for all user-controlled content
- `shortDir()` / `shortId()` — Truncate long paths/IDs for display
- `getScoreColor()` — Green (≥70%), yellow (≥40%), red (<40%)

**Theme:** Dark/light toggle, preference saved to `localStorage`.

**Refresh Button:** Calls `POST /api/cache/clear` then reloads active page data.

### `style.css` — Styling (678 lines)

CSS custom properties for theming:

```css
:root {
  --bg: #1a1a2e;        /* dark mode default */
  --surface: #16213e;
  --text: #e0e0e0;
  --accent: #0f9b8e;
  --accent2: #00d2ff;
  ...
}
[data-theme="light"] {
  --bg: #f5f5f5;
  --surface: #ffffff;
  --text: #333;
  ...
}
```

Key component styles:
- `.session-card` — Bordered cards with color-coded left border
- `.badge-cli` / `.badge-vscode` / `.badge-claude` — Source indicator badges (blue/purple/orange)
- `.badge-running` / `.badge-completed` / `.badge-error` — Status badges
- `.source-filter-btns` / `.source-btn` — Analytics source toggle buttons
- `.score-circle` — SVG-based circular progress indicator
- `.category-card` — Score breakdown cards with progress bars
- `.chart-container` — Responsive chart wrappers in 2-column grid

---

## Data Flow Examples

### Loading the Sessions Page

```
Browser                    Server                     Filesystem
   │                         │                            │
   ├─ GET /api/sessions ────►│                            │
   │                         ├─ cachedCall("listSessions")│
   │                         │   ├─ listCliSessions() ───►│ readdir ~/.copilot/session-state/
   │                         │   │                        │ readFile workspace.yaml (per session)
   │                         │   │                        │ read last 2KB of events.jsonl
   │                         │   │◄───────────────────────┤
   │                         │   ├─ listVSCodeSessions()─►│ SQLite: state.vscdb query
   │                         │   │◄───────────────────────┤
   │                         │   ├─ listClaudeCodeSessions►│ readdir ~/.claude/projects/
   │                         │   │                        │ scan top-level *.jsonl files
   │                         │   │◄───────────────────────┤
   │                         │   └─ merge + sort          │
   │◄── JSON [{sessions}] ──┤                            │
   │                         │                            │
   ├─ Click session card     │                            │
   ├─ GET /api/sessions/id ─►│                            │
   │                         ├─ isVSCodeSession(id)?      │
   │                         │   ├─ YES: getVSCodeSession()►│ readFile {id}.json (with image stripping)
   │                         │   └─ NO:                   │
   │                         ├─ isClaudeCodeSession(id)?  │
   │                         │   ├─ YES: getClaudeCodeSession()►│ readFile {id}.jsonl
   │                         │   └─ NO:  readFile events.jsonl, workspace.yaml, plan.md
   │◄── JSON {detail} ──────┤                            │
```

### Loading the Insights Page

```
Browser                    Server                     Filesystem
   │                         │                            │
   ├─ GET /api/insights/repos►│                           │
   │                         ├─ listReposWithScores()     │
   │                         │   ├─ listSessions() (cached)
   │                         │   ├─ per repo:             │
   │                         │   │   ├─ collectRepoData()─►│ readFile events.jsonl per matching session
   │                         │   │   ├─ scanMcpConfig() ──►│ readFile .vscode/mcp.json
   │                         │   │   └─ score 5 categories│
   │                         │   ├─ getVSCodeScore()      │
   │                         │   │   ├─ getVSCodeAnalytics() (cached)
   │                         │   │   ├─ scanVSCodeMcpConfig()►│ readFile Code/User/mcp.json
   │                         │   │   └─ score 5 categories│
   │                         │   └─ sort by totalScore    │
   │◄── JSON [{scores}] ────┤                            │
```

### Full-Text Search Query

```
Browser                    Server                     SearchIndex
   │                         │                            │
   │ (user types "typescript")│                           │
   │ 300ms debounce           │                           │
   ├─ GET /api/search?q=... ─►│                           │
   │                         ├─ listSessions() (cached)   │
   │                         ├─ searchIndex.buildIndex() ─►│ getSession(id) × N
   │                         │                            │ extract user/assistant msg content
   │                         │                            │ strip code blocks
   │                         │                            │ build entries[]
   │                         ├─ searchIndex.search(q) ───►│ tokenize("typescript") → ["typescript"]
   │                         │                            │ score each entry:
   │                         │                            │   content freq / word count
   │                         │                            │   + 0.5 if in title
   │                         │                            │   + 0.2 if in cwd
   │                         │                            │ sort desc, slice to limit
   │                         │                            │ extractHighlights (±60 chars)
   │◄── JSON [{entry,score,highlights}] ◄────────────────┤
   │                         │                            │
   │ renderSearchResults()    │                            │
   │  → session cards with    │                            │
   │    .search-highlights    │                            │
```

---

## Performance

### Caching Strategy

All expensive operations use a 30-second in-memory TTL cache. A single page load triggers one cold computation (~1.8s for VS Code file parsing), then all subsequent calls within 30s are instant.

| Scenario | Without Cache | With Cache |
|----------|--------------|------------|
| `listSessions()` | ~7ms | ~0ms |
| `getAnalytics()` | ~1.8s | ~0ms |
| `listReposWithScores()` | ~1.8s | ~6ms |
| `getVSCodeScore()` | ~1.7s | ~0ms |
| Full page load (all panels) | ~5.4s | ~1.8s |

### Large File Handling

VS Code session files can reach 450MB+ due to pasted images (base64 PNG in `variableData`).

| Protection | Threshold | Action |
|-----------|-----------|--------|
| File size cap | >200MB | Skip file entirely |
| Image stripping | `kind: "image"` + value > 1KB | Replace with `"[image data omitted]"` |
| Text truncation | Message text > 10KB | Truncate with `"...(truncated)"` |
| List views | N/A | Use SQLite index only (never read JSON) |

---

## Testing

**Framework**: Vitest

| Test File | Tests | What's Covered |
|-----------|-------|----------------|
| `cache.test.ts` | 7 | TTL expiry, cache hits, invalidation, separate keys, complex objects |
| `sessions.test.ts` | 16 | YAML parsing, JSONL parsing, duration calc, analytics aggregation, scoring, MCP matching, source field |
| `vscode-sessions.test.ts` | 37 | requestsToEvents (8), deriveStatus (4), msToIso (3), readSessionContent (7), normalizeVSCodeToolName (10), scanVSCodeMcpConfig (3), small image preservation (1) |
| `claude-code-sessions.test.ts` | 27 | extractTextContent (5), extractToolUseBlocks (3), deriveStatus (4), listClaudeCodeSessions (6), isClaudeCodeSession (2), getClaudeCodeSession (6), getClaudeCodeAnalytics (2) |
| `search.test.ts` | 10 | tokenize (punctuation, lowercase, min-length), empty/blank query, title scoring bonus, cwd scoring bonus, highlight length (≤121 chars), source filter cli/vscode, clear() + lazy rebuild, limit option |

**Total: 97 tests**

Run with:
```bash
npm test           # single run
npm run test:watch # watch mode
```

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| express | ^5.2.1 | HTTP server and routing |
| cors | ^2.8.6 | Cross-origin support |
| better-sqlite3 | ^12.6.2 | Read VS Code's state.vscdb (native SQLite) |
| yaml | ^2.8.2 | Parse CLI session workspace.yaml files |
| typescript | ^5.x | Build |
| vitest | ^4.0.x | Testing |
| tsx | ^4.x | Dev mode (run TS directly) |
