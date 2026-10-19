import { readFileSync } from "fs";
import { join } from "path";
import { runInNewContext } from "vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { getDashboardUrl } from "../cli-url";
import { parseDashboardArgs } from "../cli-args";

// Execute the real entry point with its external effects isolated. CI need not
// build dist/ first, and these tests never bind a port or launch a browser.
const code = ts.transpileModule(
  readFileSync(join(__dirname, "..", "cli.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }
).outputText;

async function start(args: string[], platform: string) {
  const execFile = vi.fn();
  const openLinuxBrowser = vi.fn();
  const log = vi.fn();
  const write = vi.fn();
  let startup: Promise<void> | undefined;
  const listen = vi.fn(
    (port: number, host: string, callback: () => Promise<void>) => {
      startup = callback();
    }
  );
  const createApp = vi.fn(() => ({ listen }));
  const modules: Record<string, unknown> = {
    "./cli-url": { getDashboardUrl },
    "./cli-args": { parseDashboardArgs },
    "./server": { createApp },
    child_process: { execFile },
    "./cli-browser": { openLinuxBrowser },
  };
  runInNewContext(code, {
    exports: {},
    require: (name: string) => {
      if (!(name in modules))
        throw new Error(`Unexpected CLI dependency: ${name}`);
      return modules[name];
    },
    console: { log, warn: vi.fn(), error: vi.fn() },
    process: {
      versions: { node: "20.11.0" },
      platform,
      env: { VITEST: "false" },
      argv: ["node", "cli.js", ...args],
      on: vi.fn(),
      stdout: { write },
    },
  });
  await startup;
  return { execFile, openLinuxBrowser, log, write, listen, createApp };
}

describe.each(["win32", "darwin", "linux"])(
  "CLI browser flags on %s",
  (platform) => {
    it.each([["--no-open"], ["--open", "--no-open"], ["--no-open", "--open"]])(
      "suppresses browser launch with flags %j",
      async (...flags) => {
        const result = await start(
          ["serve", "--port", "8123", "--host", "127.0.0.1", ...flags],
          platform
        );
        expect(result.createApp).toHaveBeenCalledWith({ host: "127.0.0.1" });
        expect(result.listen).toHaveBeenCalledWith(
          8123,
          "127.0.0.1",
          expect.any(Function)
        );
        expect(result.log.mock.calls.flat().join("")).toContain(
          "http://127.0.0.1:8123"
        );
        expect(result.execFile).not.toHaveBeenCalled();
        expect(result.openLinuxBrowser).not.toHaveBeenCalled();
      }
    );

    it("keeps default startup from opening a browser", async () => {
      const result = await start([], platform);
      expect(result.listen).toHaveBeenCalledWith(
        3000,
        "localhost",
        expect.any(Function)
      );
      expect(result.execFile).not.toHaveBeenCalled();
      expect(result.openLinuxBrowser).not.toHaveBeenCalled();
    });

    it("keeps explicit --open working without an override", async () => {
      const result = await start(["--open"], platform);
      expect(
        platform === "linux" ? result.openLinuxBrowser : result.execFile
      ).toHaveBeenCalledTimes(1);
      expect(result.log.mock.calls.flat().join("")).toContain(
        "http://localhost:3000"
      );
    });
  }
);

it("lists the override in CLI help without starting the server", async () => {
  const result = await start(["--help"], "linux");
  expect(result.write.mock.calls.flat().join("")).toContain("--no-open");
  expect(result.createApp).not.toHaveBeenCalled();
});
