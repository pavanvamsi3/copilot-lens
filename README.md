# Copilot Lens 👓

**Your Copilot history has answers. Now you can actually find them.**

Copilot Lens is a local memory layer for AI coding assistants — search and browse everything you've ever discussed with Copilot or Claude, across Copilot CLI terminal sessions, VS Code Copilot Chat, and Claude Code. All on your machine. No cloud. No sign-in.

![copilot-lens hero](https://raw.githubusercontent.com/pavanvamsi3/copilot-lens/main/assets/copilot-lens-hero.png)

## Why

Copilot and Claude sessions are ephemeral by default. You solve a problem, close the terminal, and it's gone. Days later you need that same approach, that regex, that architecture decision — and you have nothing to reference.

These tools store all of this locally. Copilot Lens makes it accessible.

## Install

```bash
npm install -g copilot-lens
```

```bash
# Or without installing
npx copilot-lens --open
```

## Usage

```bash
copilot-lens          # Start the dashboard
copilot-lens --open   # Start and open in browser
copilot-lens --port 8080
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `3000` | Port number |
| `--host` | `localhost` | Host address |
| `--open` | off | Auto-open browser |

---

## Features

### 🔍 Search — Find anything in your Copilot history

Search across every conversation you've ever had with Copilot — CLI and VS Code — in one place.

- Full-text search over all session content
- Ranked results with inline highlights showing context around each match
- Filter results by source (Copilot CLI, VS Code, or Claude Code), date range, or working directory
- Results update as you type (debounced)
- Works offline, entirely on your machine

> **Example**: Search `"redis connection pool"` and instantly find the session from three weeks ago where you worked through that implementation.

### 📋 Session Browser — Review your conversations

Browse the full history of your Copilot sessions in a searchable, filterable list.

- **Unified view** — Copilot CLI, VS Code Copilot Chat, and Claude Code sessions side by side
- **Source badges** — see at a glance whether a session came from Copilot CLI, VS Code, or Claude Code
- **Color-coded by directory** — each project gets a distinct accent color
- **Status detection** — Running, Completed, or Error
- **Filter by** time range, status, and working directory
- Click any session to open the full conversation

**Conversation view:**
- Chat-style layout — your prompts on the right, Copilot responses on the left
- **Agent thinking** — collapsible reasoning blocks shown inline between messages (click "💭 View thinking" to expand)
- Tool calls made during the session
- Errors that occurred
- Session plans (if created)

> **Thinking support by source:** Claude Code and VS Code Copilot Chat sessions surface thinking blocks when the model was run with extended thinking enabled. Copilot CLI sessions do not include thinking — the CLI processes reasoning internally and does not persist it to disk.

![copilot-lens conversation view](https://raw.githubusercontent.com/pavanvamsi3/copilot-lens/main/assets/copilot-lens-sessions-list.png)

### 📊 Analytics — Understand your usage patterns

Eight interactive charts that show how and when you use Copilot and Claude. Filter by source (All / Copilot CLI / VS Code / Claude Code) to see per-tool breakdowns.

| Chart | What It Shows |
|-------|---------------|
| Sessions Per Day | Daily activity over time |
| Activity by Hour | When during the day you use Copilot most |
| Tool Usage | Most-used tools (grep, edit, glob, etc.) |
| Model Usage | Which AI models you've used |
| Top Working Directories | Which projects you use Copilot in most |
| Time Per Branch | Active Copilot time per git branch |
| Time Per Repo | Active Copilot time per repository |
| MCP Servers Used | Which MCP servers appear across sessions |

Dark and light mode. Interactive chart legends. Manual refresh.

![copilot-lens analytics](https://raw.githubusercontent.com/pavanvamsi3/copilot-lens/main/assets/copilot-lens-demo.png)

### 🪙 Token Usage — See exactly what you're spending

A dedicated **Tokens** tab that parses your Copilot CLI debug logs (`~/.copilot/logs/`) to show real, API-reported token consumption — no estimates.

- Summary cards: total tokens, prompt vs completion, cache hit rate, average per active day, top model, estimated upstream API cost (USD)
- Stacked bar chart over time — switch between **Daily / Weekly / Monthly** views
- Tokens by model (doughnut)
- Prompt-vs-completion ratio (doughnut)
- Per-period breakdown table

The parser uses an event-stream approach over real `[DEBUG] response (Request-ID …)` blocks, so request-config blocks (`max_prompt_tokens`) and model-catalog entries are not counted as usage. Model names are normalized — `capi:claude-opus-4.7:defaultReasoningEffort=medium` becomes `claude-opus-4.7`, and Azure deployment prefixes like `capi-noe-ptuc-h200-ib-gpt-5-mini-2025-08-07` become `gpt-5-mini-2025-08-07`.

> **About the cost number:** GitHub Copilot bills you on **premium requests** against your monthly allowance, not per token. The "Est. API Cost" card is what you would pay if you were calling Anthropic / OpenAI / Google directly with the same token counts — useful as a real-world reference, but not what GitHub charges you.

![copilot-lens tokens](https://raw.githubusercontent.com/pavanvamsi3/copilot-lens/main/assets/copilot-lens-tokens.png)

### 🏆 Effectiveness Score — See how well you're using Copilot

A 0–100 score per repository (CLI) and globally (VS Code) with actionable improvement tips.

| Category | What It Measures |
|----------|-----------------|
| Prompt Quality | Average prompt length, clarification rate |
| Tool Utilization | Diversity of tools used across sessions |
| Efficiency | Tool success rate, turns per session |
| MCP Utilization | Configured vs. actually used MCP servers |
| Engagement | Session duration and usage consistency |

![copilot-lens score](https://raw.githubusercontent.com/pavanvamsi3/copilot-lens/main/assets/copilot-lens-score.png)

---

## How It Works

Copilot Lens reads session data from three local sources — no network requests, no external APIs.

### Copilot CLI Sessions
- **Location**: `~/.copilot/session-state/`
- `workspace.yaml` — session metadata (directory, git branch, timestamps)
- `events.jsonl` — full event log (messages, tool calls, errors)
- `plan.md` — session plans, if created

### Copilot CLI Debug Logs (Token Usage)
- **Location**: `~/.copilot/logs/process-*.log`
- Each log contains the verbose API request/response stream from a CLI session
- Token usage is mined from `[DEBUG] response (Request-ID …)` blocks that contain real `usage.prompt_tokens` / `usage.completion_tokens` / `usage.prompt_tokens_details.cached_tokens`
- Model names come from the response JSON's `"model"` field, with a 30-line lookback into preceding streaming chunks when absent

### VS Code Copilot Chat Sessions
- **Index**: `state.vscdb` (SQLite) — session list with titles and timing
- **Content**: `emptyWindowChatSessions/{id}.json` — full conversation

Supported platforms and paths:
| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Code/` |
| Windows | `%APPDATA%/Code/` |
| Linux | `~/.config/Code/` |

VS Code Insiders is also supported. Sessions with pasted images (which can exceed 100MB) are automatically stripped of image data. Files over 200MB are skipped.

### Claude Code Sessions
- **Location**: `~/.claude/projects/{sanitized-project-path}/{sessionId}.jsonl`
- Each file is a JSONL stream of events with types `user`, `assistant`, `progress`, and others
- `user` events contain the prompt; `assistant` events contain model responses and tool calls
- `assistant` events may include `{ type: "thinking" }` content blocks (extended thinking) — these are surfaced as collapsible reasoning blocks in the conversation view
- Sidechain events (warmup/internal) are filtered out automatically
- Session title comes from the `slug` field (e.g. `happy-seeking-whistle`)

### Duration Calculation

Durations are calculated from actual event activity, not wall-clock time. Gaps longer than 5 minutes between events are excluded — so a session you paused and resumed doesn't show an inflated duration.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express + TypeScript |
| Frontend | Vanilla HTML/CSS/JavaScript |
| Charts | Chart.js |
| Data | YAML, JSONL, SQLite (`better-sqlite3`) |
| Testing | Vitest (97 tests) |

---

## Development

```bash
git clone https://github.com/pavanvamsi3/copilot-lens.git
cd copilot-lens
npm install
npm run dev        # Start with tsx (no build step)
npm run build      # Compile TypeScript
npm test           # Run tests
npm start          # Run compiled version
```

---

## Optional: Custom Local Hostname

For a cleaner URL like `http://copilot.lens:3000`:

**macOS/Linux:**
```bash
echo "127.0.0.1 copilot.lens" | sudo tee -a /etc/hosts
```

**Windows (run as Admin):**
```bash
echo 127.0.0.1 copilot.lens >> C:\Windows\System32\drivers\etc\hosts
```

Then: `copilot-lens --host copilot.lens`

---

## License

MIT
