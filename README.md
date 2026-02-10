# Copilot Lens 👓

A local dashboard to visualize and analyze your GitHub Copilot CLI sessions.

## Install

```bash
npm install -g copilot-lens
```

## Usage

```bash
# Start the dashboard
copilot-lens

# With options
copilot-lens --port 8080 --open

# Or use npx (no install needed)
npx copilot-lens
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `3000` | Port number |
| `--host` | `localhost` | Host address |
| `--open` | off | Auto-open browser |

## Features

- **Session list** — Browse all your Copilot CLI sessions with search and filtering
- **Session details** — View full conversation history, tool calls, errors, and plans
- **Analytics dashboard** — Charts showing session activity, tool usage, top directories, and branch activity
- **Auto-refresh** — Dashboard updates every 5 seconds
- **Local only** — All data stays on your machine

## Data Source

Reads session data from `~/.copilot/session-state/` (the default GitHub Copilot CLI session directory).

## License

MIT

## Optional: Custom Local Hostname

If you'd like a prettier URL like `http://copilot.lens:3000`, add this to your hosts file:

- **Windows** (run as Admin): `echo 127.0.0.1 copilot.lens >> C:\Windows\System32\drivers\etc\hosts`
- **macOS/Linux**: `echo "127.0.0.1 copilot.lens" | sudo tee -a /etc/hosts`

Then run: `copilot-lens --host copilot.lens`
