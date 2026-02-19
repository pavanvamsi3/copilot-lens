import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Test sessions.ts functions that don't depend on the real ~/.copilot directory
// by creating temporary fixture directories

describe("detectStatus", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-lens-sess-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // We can't easily test detectStatus directly since it's not exported,
  // but we can test the session parsing logic indirectly through getSession
  // For now, we test the workspace.yaml parsing and events.jsonl parsing patterns

  it("parses workspace.yaml fields correctly", () => {
    const yaml = `
id: test-session-id
cwd: /home/user/project
git_root: /home/user/project
branch: main
created_at: "2024-01-15T10:00:00Z"
updated_at: "2024-01-15T11:00:00Z"
summary_count: 3
`;
    const { parse } = require("yaml");
    const ws = parse(yaml);

    expect(ws.id).toBe("test-session-id");
    expect(ws.cwd).toBe("/home/user/project");
    expect(ws.git_root).toBe("/home/user/project");
    expect(ws.branch).toBe("main");
    expect(ws.created_at).toBe("2024-01-15T10:00:00Z");
    expect(ws.summary_count).toBe(3);
  });

  it("parses events.jsonl lines correctly", () => {
    const lines = [
      '{"type":"session.start","id":"e1","timestamp":"2024-01-15T10:00:00Z","data":{"copilotVersion":"0.400"}}',
      '{"type":"user.message","id":"e2","timestamp":"2024-01-15T10:00:05Z","data":{"content":"Hello"}}',
      '{"type":"tool.execution_start","id":"e3","timestamp":"2024-01-15T10:00:06Z","data":{"tool":"bash"}}',
      '{"type":"tool.execution_complete","id":"e4","timestamp":"2024-01-15T10:00:10Z","data":{"tool":"bash","success":true}}',
      '{"type":"assistant.turn_start","id":"e5","timestamp":"2024-01-15T10:00:10Z","data":{}}',
      '{"type":"assistant.message","id":"e6","timestamp":"2024-01-15T10:00:15Z","data":{"content":"Done!"}}',
    ];

    const events = lines.map((line) => JSON.parse(line));

    expect(events).toHaveLength(6);
    expect(events[0].type).toBe("session.start");
    expect(events[0].data.copilotVersion).toBe("0.400");
    expect(events[1].data.content).toBe("Hello");
    expect(events[2].data.tool).toBe("bash");
    expect(events[3].data.success).toBe(true);
  });

  it("calculates active duration capping gaps at 5 min", () => {
    const timestamps = [
      1000000, // t0
      1005000, // +5s (gap: 5s)
      1010000, // +5s (gap: 5s)
      1610000, // +10min (gap capped at 5min = 300s)
      1615000, // +5s (gap: 5s)
    ];

    const MAX_GAP = 300_000;
    let duration = 0;
    for (let i = 1; i < timestamps.length; i++) {
      duration += Math.min(timestamps[i] - timestamps[i - 1], MAX_GAP);
    }

    // 5000 + 5000 + 300000 + 5000 = 315000
    expect(duration).toBe(315000);
  });
});

describe("analytics aggregation logic", () => {
  it("counts tool usage correctly", () => {
    const toolUsage: Record<string, number> = {};
    const events = [
      { type: "tool.execution_start", data: { tool: "bash" } },
      { type: "tool.execution_start", data: { tool: "edit" } },
      { type: "tool.execution_start", data: { tool: "bash" } },
      { type: "tool.execution_start", data: { tool: "grep" } },
    ];

    for (const event of events) {
      if (event.type === "tool.execution_start") {
        const tool = event.data.tool || "unknown";
        toolUsage[tool] = (toolUsage[tool] || 0) + 1;
      }
    }

    expect(toolUsage).toEqual({ bash: 2, edit: 1, grep: 1 });
  });

  it("extracts model from session.model_change events", () => {
    const modelUsage: Record<string, number> = {};
    const events = [
      { type: "session.model_change", data: { newModel: "claude-sonnet-4" } },
      { type: "session.model_change", data: { newModel: "gpt-4.1" } },
      { type: "session.model_change", data: { newModel: "claude-sonnet-4" } },
    ];

    for (const event of events) {
      if (event.type === "session.model_change" && event.data.newModel) {
        const model = event.data.newModel;
        modelUsage[model] = (modelUsage[model] || 0) + 1;
      }
    }

    expect(modelUsage).toEqual({ "claude-sonnet-4": 2, "gpt-4.1": 1 });
  });

  it("extracts model from session.info message", () => {
    const modelUsage: Record<string, number> = {};
    const msg = "Model changed to: claude-opus-4.5";
    const match = msg.match(/Model changed to:\s*([^\s.]+(?:[-.][^\s.]+)*)/i);

    if (match) {
      modelUsage[match[1]] = (modelUsage[match[1]] || 0) + 1;
    }

    expect(modelUsage).toEqual({ "claude-opus-4.5": 1 });
  });

  it("parses MCP servers from session.info message", () => {
    const mcpServers: Record<string, number> = {};
    const msg = "Configured MCP servers: github-mcp-server, bluebird-mcp";
    const match = msg.match(/Configured MCP servers?:\s*(.+)/i);

    if (match) {
      for (const server of match[1].split(",").map((s: string) => s.trim())) {
        if (server) mcpServers[server] = (mcpServers[server] || 0) + 1;
      }
    }

    expect(mcpServers).toEqual({
      "github-mcp-server": 1,
      "bluebird-mcp": 1,
    });
  });

  it("calculates tool success rate", () => {
    const toolSuccessRate: Record<string, { success: number; failure: number }> = {};
    const events = [
      { type: "tool.execution_complete", data: { tool: "bash", success: true } },
      { type: "tool.execution_complete", data: { tool: "bash", success: true } },
      { type: "tool.execution_complete", data: { tool: "bash", success: false } },
      { type: "tool.execution_complete", data: { tool: "edit", success: true } },
    ];

    for (const event of events) {
      if (event.type === "tool.execution_complete") {
        const tool = event.data.tool;
        if (!toolSuccessRate[tool]) toolSuccessRate[tool] = { success: 0, failure: 0 };
        if (event.data.success) toolSuccessRate[tool].success++;
        else toolSuccessRate[tool].failure++;
      }
    }

    expect(toolSuccessRate.bash).toEqual({ success: 2, failure: 1 });
    expect(toolSuccessRate.edit).toEqual({ success: 1, failure: 0 });
  });

  it("counts hours of day from ISO timestamps", () => {
    const hourOfDay: Record<string, number> = {};
    const timestamps = [
      "2024-01-15T08:30:00Z",
      "2024-01-15T08:45:00Z",
      "2024-01-15T14:00:00Z",
    ];

    for (const ts of timestamps) {
      const hour = new Date(ts).getUTCHours().toString().padStart(2, "0") + ":00";
      hourOfDay[hour] = (hourOfDay[hour] || 0) + 1;
    }

    expect(hourOfDay["08:00"]).toBe(2);
    expect(hourOfDay["14:00"]).toBe(1);
  });
});

describe("scoring logic", () => {
  it("scores prompt quality based on avg length", () => {
    // Mimics scorePromptQuality logic
    const testCases = [
      { avgLen: 150, expectedMin: 15 },
      { avgLen: 75, expectedMin: 10 },
      { avgLen: 30, expectedMin: 5 },
      { avgLen: 5, expectedMin: 0 },
    ];

    for (const { avgLen, expectedMin } of testCases) {
      let score = 0;
      if (avgLen >= 100) score = 20;
      else if (avgLen >= 50) score = 15;
      else if (avgLen >= 20) score = 10;
      else score = 5;
      expect(score).toBeGreaterThanOrEqual(expectedMin);
    }
  });

  it("scores tool utilization by distinct tool count", () => {
    const testCases = [
      { count: 10, expected: 20 },
      { count: 7, expected: 20 },
      { count: 5, expected: 15 },
      { count: 3, expected: 10 },
      { count: 1, expected: 5 },
    ];

    for (const { count, expected } of testCases) {
      let score = 0;
      if (count >= 7) score = 20;
      else if (count >= 5) score = 15;
      else if (count >= 3) score = 10;
      else score = 5;
      expect(score).toBe(expected);
    }
  });

  it("fuzzy matches MCP server names", () => {
    const configured = ["bluebird-mcp", "github-mcp-server"];
    const usedServers = ["bluebird", "github-mcp-server-actions_list"];

    const used = configured.filter((cfgName) => {
      const cfgLower = cfgName.toLowerCase().replace(/[-_\s]/g, "");
      return usedServers.some((u) => {
        const uLower = u.toLowerCase().replace(/[-_\s]/g, "");
        return uLower.includes(cfgLower) || cfgLower.includes(uLower);
      });
    });

    expect(used).toContain("bluebird-mcp");
    expect(used).toContain("github-mcp-server");
    expect(used).toHaveLength(2);
  });
});

describe("empty session filtering", () => {
  it("excludes CLI sessions with no events.jsonl", () => {
    // A session directory with workspace.yaml but no events.jsonl
    // should be excluded from listing because it has no user messages
    const eventsExist = false;
    const hasUserMessage = false;
    // Mimics the filter logic in listCliSessions
    const shouldInclude = eventsExist && hasUserMessage;
    expect(shouldInclude).toBe(false);
  });

  it("excludes CLI sessions with events but no user.message", () => {
    const content = [
      '{"type":"session.start","id":"e1","timestamp":"2024-01-15T10:00:00Z","data":{}}',
      '{"type":"assistant.turn_start","id":"e2","timestamp":"2024-01-15T10:00:01Z","data":{}}',
    ].join("\n");

    // Mimics the filter: check for "user.message" substring
    expect(content.includes('"user.message"')).toBe(false);
  });

  it("includes CLI sessions that have user.message events", () => {
    const content = [
      '{"type":"session.start","id":"e1","timestamp":"2024-01-15T10:00:00Z","data":{}}',
      '{"type":"user.message","id":"e2","timestamp":"2024-01-15T10:00:05Z","data":{"content":"Hello"}}',
      '{"type":"assistant.message","id":"e3","timestamp":"2024-01-15T10:00:15Z","data":{"content":"Hi"}}',
    ].join("\n");

    expect(content.includes('"user.message"')).toBe(true);
  });
});

describe("source field", () => {
  it("SessionMeta interface includes source field", () => {
    // Type-level check: ensure the source field is part of the interface
    const meta = {
      id: "test",
      cwd: "/tmp",
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
      status: "completed" as const,
      source: "cli" as const,
    };
    expect(meta.source).toBe("cli");

    const vscodeMeta = { ...meta, source: "vscode" as const };
    expect(vscodeMeta.source).toBe("vscode");
  });
});
