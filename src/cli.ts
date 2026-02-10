#!/usr/bin/env node

import { createApp } from "./server";

process.on("uncaughtException", (err) => {
  console.error("Uncaught error:", err.message);
});
process.on("unhandledRejection", (err: any) => {
  console.error("Unhandled rejection:", err?.message || err);
});

const args = process.argv.slice(2);

function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const port = parseInt(getArg("--port", "3000"), 10);
const host = getArg("--host", "localhost");
const shouldOpen = args.includes("--open");

const app = createApp();

app.listen(port, host, async () => {
  const url = `http://${host}:${port}`;
  console.log(`\n  👓 Copilot Lens is running at ${url}\n`);

  if (shouldOpen) {
    const { exec } = await import("child_process");
    const cmd =
      process.platform === "win32"
        ? `start "" "${url}"`
        : process.platform === "darwin"
          ? `open ${url}`
          : `xdg-open ${url}`;
    exec(cmd);
  }
});
