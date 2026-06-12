#!/usr/bin/env node

process.on("uncaughtException", (err) => {
  console.error("Uncaught error:", err.message);
});
process.on("unhandledRejection", (err: any) => {
  console.error("Unhandled rejection:", err?.message || err);
});

const args = process.argv.slice(2);

if (args[0] === "tokens") {
  const { runTokensTUI } = require("./cli-tokens");
  runTokensTUI(args.slice(1));
} else if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
  process.stdout.write(`
  Usage: copilot-lens [command] [options]

  Commands:
    (default)   Start the web dashboard
    tokens      Show token usage in the terminal (Ink TUI)

  Options:
    --port <n>  Port for the web dashboard (default: 3000)
    --host <h>  Host for the web dashboard (default: localhost)
    --open      Open the dashboard in your browser

  Run "copilot-lens tokens --help" for tokens command options.
`);
} else {
  const { createApp } = require("./server");

  function getArg(name: string, fallback: string): string {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  }

  const port = parseInt(getArg("--port", "3000"), 10);
  const host = getArg("--host", "localhost");
  const shouldOpen = args.includes("--open");

  const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!LOOPBACK_HOSTS.has(host)) {
    console.warn(
      `\n  ⚠️  Binding to ${host} exposes your AI session data to the network with no authentication.\n`
    );
  }

  const app = createApp({ host });

  app.listen(port, host, async () => {
    const url = `http://${host}:${port}`;
    console.log(`\n  👓 Copilot Lens is running at ${url}\n`);

    if (shouldOpen) {
      // Use execFile with an argument array (no shell) so the URL/host cannot
      // be interpreted as shell syntax.
      const { execFile } = await import("child_process");
      if (process.platform === "win32") {
        execFile("cmd", ["/c", "start", "", url]);
      } else if (process.platform === "darwin") {
        execFile("open", [url]);
      } else {
        execFile("xdg-open", [url]);
      }
    }
  });
}
