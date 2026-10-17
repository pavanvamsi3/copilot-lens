import { readFileSync } from "fs";
import { join } from "path";
import { runInNewContext } from "vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the actual dashboard functions; no copied transcript formatter.
const source = ts.createSourceFile(
  "app.js",
  readFileSync(join(__dirname, "../../public/app.js"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS
);
const names = new Set([
  "formatDuration",
  "escapeMarkdownInline",
  "buildSessionMarkdown",
  "downloadSessionMarkdown",
  "renderDetail",
  "escapeHtml",
  "shortDir",
]);
const code = source.statements
  .filter(
    (node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text || "")
  )
  .map((node) => node.getText(source))
  .join("\n");

function setup(click = vi.fn()) {
  const link = { href: "", download: "", click, remove: vi.fn() };
  const status = { textContent: "", hidden: true };
  const button = { addEventListener: vi.fn(), disabled: false };
  const detailContent = {
    innerHTML: "",
    querySelectorAll: vi.fn(() => []),
    querySelector: vi.fn((selector: string) =>
      selector === "#exportMarkdownBtn" ? button : status
    ),
  };
  const createObjectURL = vi.fn(() => "blob:test-transcript");
  const revokeObjectURL = vi.fn();
  const appendChild = vi.fn();
  const setTimeout = vi.fn();
  const exportedSession = session([
    { type: "user.message", data: { content: "full export content" } },
  ]);
  const fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => exportedSession,
  }));
  const context = {
    Blob,
    URL: { createObjectURL, revokeObjectURL },
    setTimeout,
    fetch,
    document: { createElement: vi.fn(() => link), body: { appendChild } },
    detailContent,
  };
  const functions = runInNewContext(
    `${code}\n({buildSessionMarkdown, downloadSessionMarkdown, renderDetail})`,
    context
  );
  return {
    ...functions,
    link,
    status,
    button,
    detailContent,
    createObjectURL,
    revokeObjectURL,
    appendChild,
    setTimeout,
    fetch,
    exportedSession,
  };
}

function session(events: unknown[] = []) {
  return {
    id: "test-session",
    source: "cli",
    title: "Sample",
    cwd: "/demo",
    createdAt: "2026-10-13T13:00:00Z",
    duration: 125000,
    status: "completed",
    events,
    eventCounts: {},
    hasSnapshots: false,
  };
}

describe("session Markdown export", () => {
  it("includes session identity, date, model and duration", () => {
    const markdown = setup().buildSessionMarkdown(
      session([{ type: "session.start", data: { model: "gpt-4.1" } }])
    );
    expect(markdown).toContain("# Session: test-session\n");
    expect(markdown).toContain("**Date:** 2026-10-13T13:00:00.000Z");
    expect(markdown).toContain("**Model:** gpt-4.1");
    expect(markdown).toContain("**Duration:** 2m 5s");
  });

  it.each(["cli", "vscode", "claude-code"])(
    "keeps full messages in event order for %s",
    (source) => {
      const text = "café 日本語\n" + "complete message ".repeat(100) + "END";
      const markdown = setup().buildSessionMarkdown({
        ...session([
          { type: "user.message", data: { content: "First\n\nSecond line" } },
          { type: "assistant.message", data: { content: text } },
          { type: "user.message", data: { content: "Follow-up" } },
        ]),
        source,
      });
      expect(markdown).toContain("> **User:** First\n> \n> Second line");
      expect(markdown).toContain(`**Assistant:**\n\n${text}`);
      expect(markdown.indexOf(text)).toBeLessThan(
        markdown.indexOf("Follow-up")
      );
      expect(markdown.endsWith("\n")).toBe(true);
    }
  );

  it("preserves assistant Markdown and fenced code verbatim", () => {
    const content = "## Result\n\n```js\nconst x = '<tag>';\n```\n\n- café";
    expect(
      setup().buildSessionMarkdown(
        session([{ type: "assistant.message", data: { content } }])
      )
    ).toContain(content);
  });

  it("excludes thinking, tool calls, errors and blank messages", () => {
    const markdown = setup().buildSessionMarkdown(
      session([
        { type: "assistant.thinking", data: { content: "THINKING" } },
        { type: "tool.execution_start", data: { content: "TOOL" } },
        { type: "session.error", data: { content: "ERROR" } },
        { type: "user.message", data: { content: " \n " } },
        { type: "assistant.message", data: {} },
      ])
    );
    expect(markdown).not.toMatch(
      /THINKING|TOOL|ERROR|\*\*User:|\*\*Assistant:/
    );
    expect(markdown).toContain("No messages in this session.");
  });

  it("reports recorded model changes and Claude response models without duplicates", () => {
    const markdown = setup().buildSessionMarkdown(
      session([
        { type: "session.start", data: { model: "initial" } },
        { type: "session.model_change", data: { newModel: "next" } },
        {
          type: "session.info",
          data: {
            infoType: "model",
            message: "Model changed to: claude-sonnet-4.5.",
          },
        },
        {
          type: "assistant.message",
          data: { content: "Result", model: "next" },
        },
      ])
    );
    expect(markdown).toContain("**Model:** initial, next, claude-sonnet-4.5");
  });

  it("reports a model recorded on a response-less assistant turn", () => {
    const markdown = setup().buildSessionMarkdown(
      session([
        {
          type: "assistant.turn_start",
          data: { model: "claude-sonnet-4.5" },
        },
      ])
    );
    expect(markdown).toContain("**Model:** claude-sonnet-4.5");
  });

  it("handles missing date/model/duration without invalid metadata", () => {
    const markdown = setup().buildSessionMarkdown({
      ...session(),
      createdAt: "bad",
      duration: undefined,
    });
    expect(markdown).toContain("**Date:** — | **Model:** — | **Duration:** —");
    expect(markdown).not.toMatch(/Invalid Date|NaN|undefined/);
  });

  it("keeps metadata on one line and escapes Markdown metacharacters", () => {
    const markdown = setup().buildSessionMarkdown({
      ...session(),
      id: "a*\n# injected",
      events: [{ type: "session.start", data: { model: "model|<tag>" } }],
    });
    expect(markdown).toContain("# Session: a\\* # injected\n");
    expect(markdown).toContain("**Model:** model\\|\\<tag\\>");
    expect(markdown).not.toContain("\n# injected");
  });

  it("downloads a UTF-8 Markdown blob and releases the temporary link and URL", async () => {
    const result = setup();
    result.downloadSessionMarkdown(
      session([{ type: "user.message", data: { content: "日本語" } }])
    );
    const blob = result.createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/markdown;charset=utf-8");
    expect(await blob.text()).toContain("日本語");
    expect(result.link.download).toBe("session-test-session.md");
    expect(result.link.href).toBe("blob:test-transcript");
    expect(result.appendChild).toHaveBeenCalledWith(result.link);
    expect(result.link.click).toHaveBeenCalledOnce();
    expect(result.link.remove).toHaveBeenCalledOnce();
    expect(result.setTimeout).toHaveBeenCalledWith(expect.any(Function), 0);
    result.setTimeout.mock.calls[0][0]();
    expect(result.revokeObjectURL).toHaveBeenCalledWith("blob:test-transcript");
  });

  it("sanitizes filename separators", () => {
    const result = setup();
    result.downloadSessionMarkdown({
      ...session(),
      id: "../folder\\session:1",
    });
    expect(result.link.download).toBe("session-___folder_session_1.md");
  });

  it("cleans up when the browser rejects the download", () => {
    const result = setup(
      vi.fn(() => {
        throw new Error("Download blocked");
      })
    );
    expect(() => result.downloadSessionMarkdown(session())).toThrow(
      "Download blocked"
    );
    expect(result.link.remove).toHaveBeenCalledOnce();
    result.setTimeout.mock.calls[0][0]();
    expect(result.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("reloads the untruncated session before downloading Markdown", async () => {
    const result = setup();
    result.renderDetail({ ...session(), source: "vscode" });
    expect(result.detailContent.innerHTML).toContain("Export as Markdown");
    expect(result.detailContent.innerHTML).toContain(
      "/api/sessions/test-session/export"
    );
    const handler = result.button.addEventListener.mock.calls[0][1];
    await handler({ currentTarget: result.button });
    expect(result.fetch).toHaveBeenCalledWith(
      "/api/sessions/test-session/export-source"
    );
    const blob = result.createObjectURL.mock.calls[0][0] as Blob;
    expect(await blob.text()).toContain("full export content");
    expect(result.button.disabled).toBe(false);
  });

  it("exports an already loaded non-VS Code session without another request", async () => {
    const result = setup();
    result.renderDetail(
      session([{ type: "user.message", data: { content: "loaded content" } }])
    );
    const handler = result.button.addEventListener.mock.calls[0][1];
    await handler({ currentTarget: result.button });
    expect(result.fetch).not.toHaveBeenCalled();
    const blob = result.createObjectURL.mock.calls[0][0] as Blob;
    expect(await blob.text()).toContain("loaded content");
  });

  it("falls back to the loaded VS Code transcript when the reload is offline", async () => {
    const result = setup();
    result.fetch.mockRejectedValueOnce(new Error("Failed to fetch"));
    result.renderDetail({
      ...session([
        { type: "user.message", data: { content: "loaded fallback" } },
      ]),
      source: "vscode",
    });
    const handler = result.button.addEventListener.mock.calls[0][1];
    await handler({ currentTarget: result.button });
    expect(result.status.hidden).toBe(false);
    expect(result.status.textContent).toContain(
      "Exported the loaded transcript; full VS Code text could not be reloaded"
    );
    expect(result.status.textContent).toContain(
      "Long prompts may be truncated"
    );
    const blob = result.createObjectURL.mock.calls[0][0] as Blob;
    expect(await blob.text()).toContain("loaded fallback");
    expect(result.button.disabled).toBe(false);
  });
});
