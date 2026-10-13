import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openLinuxBrowser } from "../cli-browser";

const run = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execFile: run }));

const commands = ["xdg-open", "gnome-open", "kde-open", "wslview"];
const url = "http://[::1]:4200";

beforeEach(() => {
  run.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("Linux browser launch", () => {
  it.each(commands)("stops when %s succeeds", (workingCommand) => {
    run.mockImplementation((command, _args, callback) => {
      callback?.(command === workingCommand ? null : new Error("not found"));
    });

    openLinuxBrowser(url);

    expect(run.mock.calls.map(([command]) => command)).toEqual(
      commands.slice(0, commands.indexOf(workingCommand) + 1)
    );
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("prints the dashboard URL once when every command fails", () => {
    run.mockImplementation((_command, _args, callback) => {
      callback?.(Object.assign(new Error("not found"), { code: "ENOENT" }));
    });

    openLinuxBrowser(url);

    expect(run.mock.calls.map(([command]) => command)).toEqual(commands);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      `Could not open browser automatically. Visit ${url}`
    );
  });

  it("waits for an opener to fail before launching the next one", () => {
    const callbacks: Array<(error: Error | null) => void> = [];
    run.mockImplementation((_command, _args, callback) =>
      callbacks.push(callback)
    );

    openLinuxBrowser(url);
    expect(run).toHaveBeenCalledTimes(1);
    callbacks.shift()!(new Error("not found"));
    expect(run).toHaveBeenCalledTimes(2);
    callbacks.shift()!(null);
    expect(run).toHaveBeenCalledTimes(2);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("falls back when an installed opener exits unsuccessfully", () => {
    run.mockImplementation((command, _args, callback) => {
      callback?.(
        command === "xdg-open"
          ? Object.assign(new Error("no browser"), { code: 3 })
          : null
      );
    });

    openLinuxBrowser(url);

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      "xdg-open",
      "gnome-open",
    ]);
  });

  it("passes the URL as one argument without a shell", () => {
    const specialUrl = "http://localhost:4200/?a=1&b=$value";
    run.mockImplementation((_command, _args, callback) => callback?.(null));

    openLinuxBrowser(specialUrl);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0].slice(0, 2)).toEqual(["xdg-open", [specialUrl]]);
  });
});
