# Copilot Lens 👓

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
copilot-lens tokens           # Token usage in the terminal (Ink TUI)
copilot-lens tokens --json    # Machine-readable output
```

## Features

- **Search**: full-text across every session, with source/date/directory filters
- **Sessions**: unified browser for Copilot CLI, VS Code Copilot Chat, and Claude Code conversations, including extended-thinking blocks where supported
- **Analytics**: eight charts covering daily activity, hour-of-day, tools, models, top directories, time per branch/repo, and MCP servers
- **Tokens**: real token usage parsed from local session data/logs, with daily/weekly/monthly views, model breakdown, Copilot premium requests, and an estimated upstream API cost reference for direct-API sources
- **Effectiveness Score**: 0 to 100 score per repo with improvement tips
- **Export**: single-session OpenAI-style chat JSONL, suitable as SFT data

### Sessions

![Unified session browser across Copilot CLI, VS Code Copilot Chat, and Claude Code](https://raw.githubusercontent.com/pavanvamsi3/copilot-lens/main/assets/copilot-lens-sessions-list.png?v=3)

### Analytics

![Eight charts showing how and when you use Copilot and Claude](https://raw.githubusercontent.com/pavanvamsi3/copilot-lens/main/assets/copilot-lens-demo.png)

### Tokens

![Real API-reported token usage with daily, weekly, and monthly views](https://raw.githubusercontent.com/pavanvamsi3/copilot-lens/main/assets/copilot-lens-tokens.png?v=2)

### Effectiveness Score

![0 to 100 score per repo with actionable improvement tips](https://raw.githubusercontent.com/pavanvamsi3/copilot-lens/main/assets/copilot-lens-score.png)

> **About pricing:** GitHub Copilot bills on **premium requests**, not raw token dollars. Copilot Lens now surfaces premium requests as the primary Copilot billing signal. Any API-cost figure is only a direct-provider reference for the underlying token usage, not your GitHub bill.

## Where the data comes from

| Source | Path |
|--------|------|
| Copilot CLI sessions and usage summaries | `~/.copilot/session-state/` |
| Copilot CLI legacy token logs | `~/.copilot/logs/process-*.log` |
| VS Code Copilot Chat | `~/Library/Application Support/Code/` (macOS), `%APPDATA%/Code/` (Win), `~/.config/Code/` (Linux) |
| Claude Code | `~/.claude/projects/` |

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
