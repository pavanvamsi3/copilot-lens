# Issue: Add Claude Code Session Support

## Description

Extend Copilot Lens to read, index, search, and display Claude Code sessions alongside the existing GitHub Copilot CLI and VS Code Copilot Chat data sources.

Claude Code stores its full conversation history locally as JSONL files in `~/.claude/projects/`, making it a natural fit for the existing offline-first, local-only architecture. This enhancement would give users a single dashboard to search and analyze their entire AI-assisted coding history across all three assistants.

## Motivation

Users who work with both GitHub Copilot and Claude Code currently have no unified way to:
- Search across all their AI coding conversations
- See combined analytics (tool usage, model usage, productivity metrics)
- Score their effectiveness across AI assistants
- Browse all sessions in a single timeline

## Claude Code Session Format

Sessions are stored in `~/.claude/projects/{encoded-project-path}/{session-uuid}.jsonl` as JSON Lines files. Each line is a JSON object with a `type` field (`summary`, `user`, `assistant`, or `file-history-snapshot`).

Key data available:
- **User/assistant messages** — Full conversation history
- **Tool invocations** — `tool_use` blocks (Edit, Read, Bash, Search, etc.)
- **Tool results** — `tool_result` blocks
- **Model info** — Model name per response
- **Cost data** — `costUSD`, token counts per message
- **Working directory** — `cwd` field per entry
- **Session metadata** — Summary/title from first line

**Full PRD:** [`docs/prd-claude-code-sessions.md`](docs/prd-claude-code-sessions.md)

## Tasks

### Phase 1: Core Data Reading (Foundation)
- [ ] Extend `SessionSource` type to include `"claude-code"` in `sessions.ts`
- [ ] Create `src/claude-code-sessions.ts` module with:
  - [ ] `getClaudeCodeDataDir()` — return `~/.claude/projects/` path
  - [ ] `decodeProjectPath(dirName)` — decode `-home-user-project` → `/home/user/project`
  - [ ] `parseClaudeCodeJsonl(filePath)` — read and parse JSONL with size protections
  - [ ] `claudeCodeEntriesToEvents(entries)` — convert to unified `SessionEvent[]`
  - [ ] `listClaudeCodeSessions()` — scan directories, return `SessionMeta[]`
  - [ ] `getClaudeCodeSession(id)` — load full session detail
  - [ ] `isClaudeCodeSession(id)` — check if ID belongs to Claude Code
- [ ] Write unit tests for all functions above
- [ ] Integrate into `listSessions()` and `getSession()` in `sessions.ts`

### Phase 2: Search Integration
- [ ] Update `SearchEntry.source` and `SearchOptions.source` types in `search.ts`
- [ ] Update search source filter logic to handle `"claude-code"`
- [ ] Update server search endpoint to accept `source=claude-code`
- [ ] Add search tests for Claude Code source filtering

### Phase 3: Analytics Integration
- [ ] Implement `getClaudeCodeAnalytics()` in `claude-code-sessions.ts`
- [ ] Implement `normalizeClaudeCodeToolName()` for tool name canonicalization
- [ ] Merge Claude Code analytics into `getAnalytics()` in `sessions.ts`
- [ ] (Optional) Add cost/token usage fields to `AnalyticsData`
- [ ] Write analytics tests

### Phase 4: Scoring Integration
- [ ] Implement Claude Code data collection for scoring
- [ ] Implement `scanClaudeCodeMcpConfig()` for MCP utilization scoring
- [ ] Add Claude Code projects to `listReposWithScores()` and insights routing
- [ ] Write scoring tests

### Phase 5: Frontend Updates
- [ ] Add `.badge-claude-code` CSS class with orange/amber accent color
- [ ] Add "Claude Code" to source filter dropdown in sessions page
- [ ] Update session card rendering to show Claude Code badge
- [ ] Update analytics charts to include Claude Code data
- [ ] Add "🟠 Claude Code (all sessions)" to insights repo selector
- [ ] (Optional) Display cost/token info in session detail modal

### Phase 6: Documentation & Polish
- [ ] Update `README.md` to mention Claude Code support
- [ ] Update `architecture.md` with Claude Code data flow diagram
- [ ] Update `architecture_mermaid.md` with Claude Code module
- [ ] End-to-end testing with real Claude Code session data

## Acceptance Criteria

- [ ] Claude Code sessions appear in the sessions list with a distinct badge
- [ ] Full-text search returns results from Claude Code sessions
- [ ] Source filter (`claude-code`) works in search and session list
- [ ] Analytics charts include Claude Code session data
- [ ] Effectiveness scoring works for Claude Code projects
- [ ] All existing tests continue to pass
- [ ] New tests cover the Claude Code reader module
- [ ] No regression for users without Claude Code installed (`~/.claude/` not found handled gracefully)

## Technical Notes

- **New source type:** `"claude-code"` added to `SessionSource` union type
- **New module:** `src/claude-code-sessions.ts` (follows `vscode-sessions.ts` pattern)
- **ID disambiguation:** Consider prefixing Claude Code session IDs to avoid collisions
- **Performance:** Read only summary line + file stats for list view; full JSONL only for detail view
- **Large file handling:** Apply existing protections (200MB file size cap, content truncation)
- **Caching:** Use existing `cachedCall()` with 30s TTL

## Labels

`enhancement`, `feature`, `claude-code`
