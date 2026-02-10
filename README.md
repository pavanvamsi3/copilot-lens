# Copilot Lens 👓

A local web dashboard to visualize, explore, and analyze your **GitHub Copilot CLI** terminal sessions. See your full conversation history, tool usage patterns, and usage analytics — all without leaving your machine.

## Why Copilot Lens?

GitHub Copilot CLI stores session data locally, but there's no built-in way to browse or analyze it. Copilot Lens gives you a clean, interactive dashboard to:

- **Review past sessions** — What did you ask? What did Copilot do?
- **Understand your usage patterns** — Which repos, branches, and tools do you use most?
- **Track your productivity** — How much active time are you spending with Copilot?

Everything runs locally. No data leaves your machine. No cloud. No sign-in.

## Install

```bash
npm install -g copilot-lens
```

## Usage

```bash
# Start the dashboard
copilot-lens

# Auto-open in browser
copilot-lens --open

# Custom port
copilot-lens --port 8080

# Or use npx (no install needed)
npx copilot-lens --open
```

### CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `3000` | Port number |
| `--host` | `localhost` | Host address |
| `--open` | off | Auto-open browser |

## Features

### 📋 Session Browser

- Browse all your Copilot CLI sessions in a searchable, filterable list
- **Color-coded by directory** — each project gets a unique accent color
- **Status detection** — see which sessions are Running, Completed, or Error
- **Three filter dimensions** — filter by time range, status, and directory
- Click any session to view full details

### 💬 Conversation View

- Chat-style layout with your prompts on the right and Copilot responses on the left
- View tool calls made during the session
- See any errors that occurred
- Read session plans (if created)

### 📊 Analytics Dashboard

Eight interactive charts powered by Chart.js, arranged in a 2-column grid:

| Chart | Type | What It Shows |
|-------|------|---------------|
| **Sessions Per Day** | Bar (compact) | Daily session activity over time |
| **Activity by Hour of Day** | Bar (compact) | When during the day you use Copilot most |
| **Tool Usage** | Doughnut | Most-used tools (grep, edit, powershell, etc.) |
| **Model Usage** | Doughnut | Which AI models you've used (Claude, GPT, etc.) |
| **Top Working Directories** | Horizontal bar (full-width) | Which project folders you use Copilot in most |
| **Time Per Branch** | Horizontal bar | Active Copilot time spent on each git branch |
| **Time Per Repo** | Horizontal bar | Active Copilot time per repository |
| **MCP Servers Used** | Doughnut | Which MCP servers are configured across sessions |

Doughnut chart legends are interactive — click a label to toggle that segment's visibility.

#### Glimpse of Analytics Dashboard

<img width="1184" height="1011" alt="image" src="https://github.com/user-attachments/assets/136205ca-f206-4fb1-88a7-71640314a9b5" />


### 🎨 UI Features

- **Dark & Light mode** — toggle with one click, preference is saved
- **Manual refresh** — refresh button to reload data on demand
- **Responsive layout** — works on any screen size
- **2-column grid layout** — compact charts with no wasted space

## How It Works

Copilot Lens reads session data from `~/.copilot/session-state/`, where GitHub Copilot CLI stores:

- **`workspace.yaml`** — Session metadata (directory, git branch, timestamps)
- **`events.jsonl`** — Full event log (messages, tool calls, errors)
- **`plan.md`** — Session plans (if created)

A local Express server parses these files and serves a static frontend dashboard.

### Duration Calculation

Session durations are calculated from **actual event activity**, not wall-clock time. Gaps longer than 5 minutes between events are excluded, so resumed sessions don't show inflated durations.

### Status Detection

| Status | How It's Detected |
|--------|-------------------|
| **Running** | `session.db` exists and was modified within 10 min, or `events.jsonl` modified within 5 min |
| **Completed** | Has an `abort` event with "user initiated" reason, or no recent activity |
| **Error** | Has an `abort` event with a non-user-initiated reason |

## Tech Stack

- **Backend**: Node.js + Express + TypeScript
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **Charts**: Chart.js
- **Data**: YAML + JSONL parsing (no database required)

## Development

```bash
git clone https://github.com/pavanvamsi3/copilot-lens.git
cd copilot-lens
npm install
npm run dev        # Start with tsx (no build needed)
npm run build      # Compile TypeScript
npm start          # Run compiled version
```

## License

MIT

## Optional: Custom Local Hostname

If you'd like a prettier URL like `http://copilot.lens:3000`, add this to your hosts file:

- **Windows** (run as Admin): `echo 127.0.0.1 copilot.lens >> C:\Windows\System32\drivers\etc\hosts`
- **macOS/Linux**: `echo "127.0.0.1 copilot.lens" | sudo tee -a /etc/hosts`

Then run: `copilot-lens --host copilot.lens`

