# PRD: Claude Code Session Support for Copilot Lens

**Status:** Draft
**Author:** copilot-lens team
**Date:** 2025-02-20

---

## 1. Summary

Extend Copilot Lens to read, index, and display **Claude Code** sessions alongside the existing GitHub Copilot CLI and VS Code Copilot Chat data sources. Claude Code stores sessions locally in `~/.claude/projects/` as JSONL files, making them a natural fit for the existing offline-first architecture.

---

## 2. Background & Motivation

Copilot Lens currently supports two data sources:

| Source | Storage | Reader Module |
|--------|---------|---------------|
| **GitHub Copilot CLI** | `~/.copilot/session-state/` (YAML + JSONL + SQLite) | `sessions.ts` |
| **VS Code Copilot Chat** | Platform-specific `Code/User/globalStorage/` (SQLite index + JSON files) | `vscode-sessions.ts` |

Claude Code is a widely-used AI coding assistant that stores its full session history locally in `~/.claude/projects/`. Users who work with both Copilot and Claude Code have no unified view of their AI-assisted coding history. Adding Claude Code support means:

- **One dashboard** for all AI coding assistant sessions
- **Unified search** across Copilot CLI, VS Code Copilot Chat, and Claude Code
- **Combined analytics** showing total tool usage, model usage, and productivity metrics across all AI assistants
- **Effectiveness scoring** that includes Claude Code engagement patterns

---

## 3. Claude Code Session Data Format

### 3.1 Storage Location

```
~/.claude/projects/
  {encoded-project-path}/        # e.g., "-home-user-myproject"
    {session-uuid}.jsonl         # One file per session
    subagents/                   # Optional: sub-agent logs
      {agent-uuid}.jsonl
```

**Project path encoding:** Each `/` (or `\` on Windows) in the absolute project path is replaced with `-`.
- `/home/user/myproject` → `-home-user-myproject`
- `C:\Users\Name\dev\proj` → `C--Users-Name-dev-proj`

### 3.2 JSONL Entry Types

Each `.jsonl` file contains one JSON object per line. The `type` field classifies entries:

| Type | Purpose | Include in Timeline? |
|------|---------|---------------------|
| `summary` | Session metadata (title, leafUuid) | No — metadata only |
| `user` | User messages and tool results | Yes |
| `assistant` | Claude responses (text, tool invocations) | Yes |
| `file-history-snapshot` | Filesystem state records | No — skip |

### 3.3 Entry Schema

#### Common Fields (all entry types)

```typescript
interface ClaudeCodeEntry {
  type: "summary" | "user" | "assistant" | "file-history-snapshot";
  uuid: string;                   // Unique message ID
  parentUuid: string | null;      // Parent in conversation tree (null = root)
  sessionId: string;              // Session UUID
  timestamp: string;              // ISO 8601
  cwd?: string;                   // Working directory at time of message
  version?: string;               // Claude Code client version
}
```

#### Summary Entry

```json
{
  "type": "summary",
  "summary": "Optimize Local Dev Servers for Instant Startup",
  "leafUuid": "uuid-of-latest-message"
}
```

#### User Entry

```json
{
  "type": "user",
  "uuid": "msg-uuid",
  "parentUuid": null,
  "sessionId": "session-uuid",
  "timestamp": "2025-01-01T10:00:00.000Z",
  "message": {
    "role": "user",
    "content": "How do I mock HTTP requests in JS?"
  },
  "cwd": "/home/user/myproject"
}
```

Tool results are delivered as user messages with structured content:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "tool_result", "tool_use_id": "call-id", "content": "..." }
    ]
  }
}
```

#### Assistant Entry

```json
{
  "type": "assistant",
  "uuid": "msg-uuid-2",
  "parentUuid": "msg-uuid",
  "sessionId": "session-uuid",
  "timestamp": "2025-01-01T10:00:04.000Z",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "You can use jest.mock..." },
      { "type": "tool_use", "id": "call-id", "name": "Edit", "input": { "file_path": "..." } }
    ]
  },
  "costUSD": 0.003,
  "model": "claude-sonnet-4-20250514"
}
```

### 3.4 Content Block Types

The `message.content` field can be a plain string or an array of content blocks:

| Block Type | Fields | Maps To |
|-----------|--------|---------|
| `text` | `text` | `assistant.message` event |
| `tool_use` | `id`, `name`, `input` | `tool.execution_start` event |
| `tool_result` | `tool_use_id`, `content` | `tool.execution_complete` event |

### 3.5 Additional Fields of Interest

| Field | Type | Description |
|-------|------|-------------|
| `costUSD` | number | API cost for this message |
| `model` | string | Model identifier (e.g., `claude-sonnet-4-20250514`) |
| `cwd` | string | Working directory |
| `version` | string | Claude Code client version |
| `isSidechain` | boolean | Conversation branch indicator |
| `isCompactSummary` | boolean | Multi-part summary marker |
| `inputTokens` | number | Input token count |
| `outputTokens` | number | Output token count |
| `cacheCreationInputTokens` | number | Tokens saved to prompt cache |
| `cacheReadInputTokens` | number | Tokens read from prompt cache |

---

## 4. Mapping to Copilot Lens Abstractions

### 4.1 SessionMeta Mapping

| SessionMeta Field | Claude Code Source |
|-------------------|--------------------|
| `id` | Session UUID (from filename or `sessionId` field) |
| `cwd` | Decoded project path from directory name, or `cwd` field from first entry |
| `gitRoot` | Not directly available; derive from `cwd` (optional) |
| `branch` | Not directly available; derive via `git` inspection (optional) |
| `createdAt` | Timestamp of first `user` or `assistant` entry |
| `updatedAt` | Timestamp of last `user` or `assistant` entry |
| `status` | Derive from file mtime (recent = "running") and entry content |
| `source` | `"claude-code"` (new source type) |
| `title` | From `summary` entry's `summary` field, or first user message truncated |

### 4.2 SessionEvent Mapping

| Claude Code Entry | Copilot Lens Event Type |
|-------------------|------------------------|
| `user` message (string content) | `user.message` |
| `user` message (tool_result content) | `tool.execution_complete` |
| `assistant` message (text blocks) | `assistant.message` |
| `assistant` message (tool_use blocks) | `tool.execution_start` |

### 4.3 SessionDetail Mapping

| SessionDetail Field | Claude Code Source |
|--------------------|--------------------|
| `events` | Converted from JSONL entries via mapping above |
| `planContent` | Not available (no plan.md equivalent) |
| `hasSnapshots` | `false` (no rewind-snapshots equivalent) |
| `copilotVersion` | `version` field from entries (Claude Code version) |
| `eventCounts` | Aggregated from converted events |
| `duration` | Gap-capped calculation from entry timestamps (reuse existing 5-min cap logic) |

### 4.4 Source Type Extension

The `SessionSource` type must be extended:

```typescript
// Before
export type SessionSource = "cli" | "vscode";

// After
export type SessionSource = "cli" | "vscode" | "claude-code";
```

This affects:
- `SessionMeta.source` / `SessionDetail.source`
- `SearchEntry.source`
- `SearchOptions.source` filter
- Frontend source filter dropdown
- Frontend badge rendering
- API `source` query parameter values

---

## 5. Required Changes

### 5.1 New Module: `src/claude-code-sessions.ts`

Create a new reader module (following the pattern of `vscode-sessions.ts`) that implements:

| Function | Purpose |
|----------|---------|
| `getClaudeCodeDataDir()` | Returns `~/.claude/projects/` path |
| `listClaudeCodeSessions()` | Scan project directories, read JSONL files, return `SessionMeta[]` |
| `getClaudeCodeSession(id)` | Read full session JSONL, convert to `SessionDetail` |
| `isClaudeCodeSession(id)` | Check if a session ID belongs to Claude Code |
| `getClaudeCodeAnalytics()` | Aggregate analytics data from all Claude Code sessions |
| `claudeCodeEntriesToEvents(entries)` | Convert JSONL entries to unified `SessionEvent[]` |
| `normalizeClaudeCodeToolName(name)` | Normalize tool names (e.g., `Edit` → `edit_file`, `Bash` → `bash`) |
| `scanClaudeCodeMcpConfig()` | Read MCP server configuration from Claude Code settings |

**Key implementation considerations:**

- **Performance:** For list view, only read the first line (summary) and last few lines (for timestamps) of each JSONL file — avoid reading entire files
- **Large files:** Apply the same protections as VS Code (skip >200MB, truncate long content)
- **Sidechains:** Filter out entries where `isSidechain === true` for the main timeline view
- **Compact summaries:** Skip entries where `isCompactSummary === true` in conversation display
- **Caching:** Use the existing `cachedCall()` with 30s TTL, consistent with CLI and VS Code

### 5.2 Core Module Changes: `src/sessions.ts`

| Change | Details |
|--------|---------|
| **Type update** | `SessionSource` → add `"claude-code"` |
| **`listSessions()`** | Merge Claude Code sessions alongside CLI and VS Code |
| **`getSession()`** | Route to Claude Code reader when `isClaudeCodeSession(id)` |
| **`getAnalytics()`** | Merge Claude Code analytics (sessions per day, tool usage, model usage, etc.) |
| **`listReposWithScores()`** | Include Claude Code projects as scoreable repos |
| **`getRepoScore()`** | Support Claude Code repos (use `cwd` as repo path) |
| **Scoring functions** | Adapt to work with Claude Code data (tool names, MCP config, etc.) |
| **MCP config scanning** | Add Claude Code's `~/.claude/settings.json` as an MCP config source |

### 5.3 Search Module Changes: `src/search.ts`

| Change | Details |
|--------|---------|
| **`SearchEntry.source`** | Add `"claude-code"` to source type |
| **`SearchOptions.source`** | Add `"claude-code"` to filter options |
| **Source filter logic** | Update `search()` to handle the new source value |

### 5.4 Server Changes: `src/server.ts`

| Change | Details |
|--------|---------|
| **Search endpoint** | Accept `source=claude-code` as filter value |
| **Insights endpoint** | Route `"Claude Code"` to a dedicated Claude Code scoring function |
| **No new endpoints needed** | All existing endpoints work with the unified session model |

### 5.5 Frontend Changes: `public/app.js` and `public/style.css`

| Change | Details |
|--------|---------|
| **Source badge** | Add `.badge-claude-code` with orange/amber accent (distinct from blue CLI and purple VS Code) |
| **Source filter** | Add "Claude Code" option to source dropdown (search and session list) |
| **Session detail modal** | Handle Claude Code sessions (display cost info if available, show model used) |
| **Analytics charts** | Claude Code sessions appear in all charts (sessions per day, tool usage, model usage, etc.) |
| **Insights page** | Show "🟠 Claude Code (all sessions)" in repo selector dropdown |
| **Session card rendering** | Display Claude Code-specific metadata (cost, token counts) where available |

### 5.6 Architecture Documentation

Update `architecture.md` and `architecture_mermaid.md` to reflect the new data source.

---

## 6. Analytics Integration

### 6.1 Data Points from Claude Code Sessions

| Metric | Source |
|--------|--------|
| **Sessions per day** | Group by date from `createdAt` |
| **Hour of day** | From entry timestamps |
| **Tool usage** | From `tool_use` content blocks in assistant messages |
| **Model usage** | From `model` field on assistant entries |
| **Top directories** | From decoded project paths |
| **Duration** | Gap-capped from entry timestamps (same 5-min cap algorithm) |
| **Turns per session** | Count user entries per session |
| **Error types** | Entries with error indicators |
| **Cost data** | `costUSD` field (new metric, Claude Code only) |
| **Token usage** | `inputTokens`, `outputTokens`, cache tokens (new metric) |

### 6.2 New Analytics Fields (Optional Enhancement)

Consider adding to `AnalyticsData`:

```typescript
interface AnalyticsData {
  // ... existing fields ...
  totalCostUSD?: number;              // Sum of costUSD across Claude Code sessions
  costPerDay?: Record<string, number>; // Daily cost breakdown
  tokenUsage?: {
    totalInput: number;
    totalOutput: number;
    totalCacheRead: number;
    totalCacheCreation: number;
  };
}
```

---

## 7. Scoring Integration

### 7.1 Claude Code Scoring

The existing 5-category scoring system (Prompt Quality, Tool Utilization, Efficiency, MCP Utilization, Engagement) maps directly to Claude Code data:

| Category | Claude Code Data Source |
|----------|----------------------|
| **Prompt Quality** | Average user message length from `user` entries |
| **Tool Utilization** | Distinct tool names from `tool_use` blocks |
| **Efficiency** | Tool result analysis from `tool_result` blocks |
| **MCP Utilization** | MCP servers from `~/.claude/settings.json` vs. tools used |
| **Engagement** | Session duration and frequency |

### 7.2 Tool Name Normalization

Claude Code uses tool names that need normalization:

| Claude Code Name | Normalized Name |
|-----------------|-----------------|
| `Edit` | `edit_file` |
| `Read` | `read_file` |
| `Write` | `write_file` |
| `Bash` | `bash` |
| `Search` | `search` |
| `Glob` | `glob` |
| `Grep` | `grep` |
| `WebSearch` | `web_search` |
| `WebFetch` | `web_fetch` |
| `TodoRead` / `TodoWrite` | `todo` |
| MCP tool calls | `{server_name}.{tool_name}` |

---

## 8. Testing Requirements

### 8.1 Unit Tests: `src/__tests__/claude-code-sessions.test.ts`

Follow the pattern established in `vscode-sessions.test.ts`:

| Test Group | Tests |
|-----------|-------|
| **JSONL parsing** | Parse valid entries, skip malformed lines, handle empty files |
| **`claudeCodeEntriesToEvents()`** | Map user messages, assistant messages, tool_use blocks, tool_result blocks, mixed content |
| **`normalizeClaudeCodeToolName()`** | All tool name mappings, unknown tools passthrough |
| **`listClaudeCodeSessions()`** | Directory scanning, project path decoding, empty directories |
| **`getClaudeCodeSession()`** | Full session loading, large file handling, sidechain filtering |
| **Status detection** | Running (recent mtime), completed, error detection |
| **Analytics** | Duration calculation, tool counts, model counts |
| **MCP config scanning** | Parse Claude Code settings.json for MCP servers |

### 8.2 Integration Tests

| Test | Details |
|------|---------|
| **`listSessions()` merging** | Verify Claude Code sessions appear alongside CLI and VS Code |
| **Search across sources** | Search returns results from all three sources |
| **Source filtering** | `source=claude-code` filter works correctly |
| **Analytics merging** | `getAnalytics()` includes Claude Code data |

### 8.3 Existing Test Updates

| File | Changes |
|------|---------|
| `sessions.test.ts` | Update `SessionSource` type tests to include `"claude-code"` |
| `search.test.ts` | Add `"claude-code"` source filter tests |

---

## 9. Implementation Plan

### Phase 1: Core Data Reading (Foundation)

**Tasks:**

- [ ] **T1.1** — Extend `SessionSource` type to include `"claude-code"` in `sessions.ts`
- [ ] **T1.2** — Create `src/claude-code-sessions.ts` with:
  - [ ] `getClaudeCodeDataDir()` — return `~/.claude/projects/`
  - [ ] `decodeProjectPath(dirName)` — decode `-home-user-project` → `/home/user/project`
  - [ ] `parseClaudeCodeJsonl(filePath)` — read and parse JSONL file with protections
  - [ ] `claudeCodeEntriesToEvents(entries)` — convert to unified `SessionEvent[]`
  - [ ] `listClaudeCodeSessions()` — scan directories, return `SessionMeta[]`
  - [ ] `getClaudeCodeSession(id)` — load full session detail
  - [ ] `isClaudeCodeSession(id)` — check if ID belongs to Claude Code
- [ ] **T1.3** — Write unit tests for all functions in T1.2
- [ ] **T1.4** — Integrate into `listSessions()` and `getSession()` in `sessions.ts`

### Phase 2: Search Integration

**Tasks:**

- [ ] **T2.1** — Update `SearchEntry.source` and `SearchOptions.source` types in `search.ts`
- [ ] **T2.2** — Update search source filter logic
- [ ] **T2.3** — Update server search endpoint to accept `source=claude-code`
- [ ] **T2.4** — Add search tests for Claude Code source filtering

### Phase 3: Analytics Integration

**Tasks:**

- [ ] **T3.1** — Implement `getClaudeCodeAnalytics()` in `claude-code-sessions.ts`
- [ ] **T3.2** — Implement `normalizeClaudeCodeToolName()` for tool name canonicalization
- [ ] **T3.3** — Merge Claude Code analytics in `getAnalytics()` in `sessions.ts`
- [ ] **T3.4** — (Optional) Add cost and token usage fields to `AnalyticsData`
- [ ] **T3.5** — Write analytics tests

### Phase 4: Scoring Integration

**Tasks:**

- [ ] **T4.1** — Implement Claude Code data collection for scoring (`collectClaudeCodeData()`)
- [ ] **T4.2** — Implement `scanClaudeCodeMcpConfig()` for MCP utilization scoring
- [ ] **T4.3** — Add Claude Code to `listReposWithScores()` and routing in insights endpoint
- [ ] **T4.4** — Write scoring tests

### Phase 5: Frontend Updates

**Tasks:**

- [ ] **T5.1** — Add `.badge-claude-code` CSS class with orange accent color
- [ ] **T5.2** — Add "Claude Code" to source filter dropdown
- [ ] **T5.3** — Update session card rendering to show Claude Code badge
- [ ] **T5.4** — Update analytics charts to include Claude Code data
- [ ] **T5.5** — Add "🟠 Claude Code (all sessions)" to insights repo selector
- [ ] **T5.6** — (Optional) Display cost/token info in session detail modal

### Phase 6: Documentation & Polish

**Tasks:**

- [ ] **T6.1** — Update `README.md` to mention Claude Code support
- [ ] **T6.2** — Update `architecture.md` with Claude Code data flow diagram
- [ ] **T6.3** — Update `architecture_mermaid.md` with Claude Code module
- [ ] **T6.4** — End-to-end manual testing with real Claude Code session data

---

## 10. Non-Goals (Out of Scope)

- **Writing Claude Code sessions** — Copilot Lens is read-only
- **Claude.ai web sessions** — Only local Claude Code CLI sessions are in scope
- **Sub-agent deep linking** — Sub-agent JSONL files in `subagents/` are not indexed in v1 (can be added later)
- **Conversation branching UI** — Sidechains are filtered out; branch visualization is a future enhancement
- **Real-time streaming** — No live-tailing of active Claude Code sessions (file mtime detection is sufficient)
- **Token cost analytics dashboard** — Optional enhancement, not required for v1

---

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Claude Code JSONL format changes in future versions | Session parsing breaks | Use defensive parsing with try/catch; version-check fields when available |
| Large number of Claude Code sessions (100s) | Slow `listSessions()` | Read only summary line + file stats for list view; leverage existing 30s cache |
| Very large JSONL files (tool output, images) | Memory pressure | Apply existing size limits (200MB cap, content truncation) |
| Overlap in session IDs between sources | Wrong session loaded | Prefix-based or directory-based ID disambiguation (e.g., `claude:{uuid}` vs `{uuid}`) |
| MCP config location changes | MCP scoring inaccurate | Fallback to "no config" gracefully; scan multiple known locations |

---

## 12. Success Criteria

- [ ] Claude Code sessions appear in the sessions list with a distinct badge
- [ ] Full-text search returns results from Claude Code sessions
- [ ] Analytics charts include Claude Code session data
- [ ] Effectiveness scoring works for Claude Code projects
- [ ] All existing tests continue to pass
- [ ] New tests cover the Claude Code reader module with ≥80% coverage
- [ ] No regression in performance for users without Claude Code installed (empty `~/.claude/` handled gracefully)

---

## 13. Open Questions

1. **Session ID format:** Should Claude Code session IDs be prefixed (e.g., `claude:{uuid}`) to avoid potential collisions with Copilot CLI session directory names? The current `isVSCodeSession()` check uses the SQLite index to verify — a similar approach with directory existence could work for Claude Code.

2. **Cost analytics:** Should cost data be displayed in the main analytics dashboard, or kept in a separate "Claude Code" section? Cost data is unique to Claude Code and doesn't apply to Copilot sessions.

3. **Sub-agent sessions:** Should sub-agent JSONL files in `subagents/` be indexed as separate sessions, or folded into the parent session? Initial recommendation: skip in v1, add as enhancement later.

4. **Project path as repo identifier:** Claude Code uses the project path as the primary grouping. Should this map to the existing `gitRoot`/`cwd` fields, or should a new `projectPath` field be added to `SessionMeta`?
