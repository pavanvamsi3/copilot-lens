import express from "express";
import path from "path";
import { listSessions, getSession, getAnalytics, listReposWithScores, getRepoScore, getVSCodeScore, type AnalyticsSourceFilter } from "./sessions";
import { clearCache } from "./cache";
import { SearchIndex } from "./search";
import { getTokenUsage, type TokenSourceFilter } from "./token-usage";
import { bulkExport, type ExportSource, type ExportFormat } from "./export";

export interface AppOptions {
  // The host the server binds to. Used to build the allowed-Host list so a
  // concrete LAN binding still works while loopback stays rebinding-protected.
  host?: string;
}

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

// Guards against DNS-rebinding: a malicious page that points its own domain at
// 127.0.0.1 sends a Host header for that domain, which we reject. The dashboard
// is same-origin so no CORS is needed; cross-origin reads stay blocked entirely.
function hostGuard(configuredHost?: string): express.RequestHandler {
  const host = (configuredHost || "").toLowerCase();

  // When bound to a wildcard interface the user has explicitly opted into
  // network exposure and we can't enumerate the reachable IPs, so skip the
  // guard rather than break legitimate access (a startup warning is printed).
  if (WILDCARD_HOSTS.has(host)) {
    return (_req, _res, next) => next();
  }

  const allowed = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (host) allowed.add(host);

  return (req, res, next) => {
    const header = (req.headers.host || "").toLowerCase();
    const hostname = header.replace(/:\d+$/, ""); // strip port (keeps [::1])
    if (!allowed.has(hostname)) {
      res.status(403).json({ error: "Forbidden: invalid Host header" });
      return;
    }
    next();
  };
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  app.use(hostGuard(options.host));

  const searchIndex = new SearchIndex();

  // Serve static frontend files
  app.use(express.static(path.join(__dirname, "..", "public")));

  // API: Full-text search
  app.get("/api/search", async (req, res) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const source = typeof req.query.source === "string" ? req.query.source : "all";
      const limit = parseInt(req.query.limit as string) || 20;

      if (!q) return res.json([]);

      const sessions = listSessions();
      searchIndex.buildIndex(sessions);

      const results = searchIndex.search(q, {
        limit,
        source: source as "cli" | "vscode" | "all",
      });

      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: List all sessions
  app.get("/api/sessions", (_req, res) => {
    try {
      const sessions = listSessions();
      res.json(sessions);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Get session detail
  app.get("/api/sessions/:id", (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      res.json(session);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Export a session as OpenAI-style chat JSONL (one line per conversation).
  // Suitable as SFT training data.
  app.get("/api/sessions/:id/export", (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
      for (const e of session.events) {
        const content = typeof e.data?.content === "string" ? e.data.content.trim() : "";
        if (!content) continue;
        if (e.type === "user.message") messages.push({ role: "user", content });
        else if (e.type === "assistant.message") messages.push({ role: "assistant", content });
      }
      const line = JSON.stringify({
        session_id: session.id,
        source: session.source,
        created_at: session.createdAt,
        messages,
      });
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="session-${session.id}.jsonl"`
      );
      res.send(line + "\n");
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Analytics
  app.get("/api/analytics", (req, res) => {
    try {
      const validSources: AnalyticsSourceFilter[] = ["all", "cli", "vscode", "claude-code"];
      const raw = typeof req.query.source === "string" ? req.query.source : "all";
      const source: AnalyticsSourceFilter = validSources.includes(raw as AnalyticsSourceFilter) ? (raw as AnalyticsSourceFilter) : "all";
      const analytics = getAnalytics(source);
      res.json(analytics);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: List repos with scores
  app.get("/api/insights/repos", (_req, res) => {
    try {
      const repos = listReposWithScores();
      res.json(repos);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Get score for specific repo
  app.get("/api/insights/score", (req, res) => {
    try {
      const repo = req.query.repo as string;
      if (!repo) {
        res.status(400).json({ error: "repo query parameter required" });
        return;
      }
      // Route "VS Code" to the global VS Code score
      const score = repo === "VS Code" ? getVSCodeScore() : getRepoScore(repo);
      res.json(score);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Token usage (parsed from ~/.copilot/logs and ~/.claude/projects)
  app.get("/api/token-usage", (req, res) => {
    try {
      const validSources: TokenSourceFilter[] = ["all", "copilot-cli", "claude-code"];
      const raw = typeof req.query.source === "string" ? req.query.source : "all";
      const source: TokenSourceFilter = validSources.includes(raw as TokenSourceFilter) ? (raw as TokenSourceFilter) : "all";
      res.json(getTokenUsage(source));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Bulk export — NDJSON stream, one record per session
  // ?source=all|cli|vscode|claude-code
  // ?from=YYYY-MM-DD  ?to=YYYY-MM-DD
  // ?repo=<substring>
  // ?min_turns=N  ?min_tokens=N
  // ?format=openai|sharegpt
  // ?include_tools=1
  app.get("/api/export", (req, res) => {
    try {
      const validSources: ExportSource[] = ["all", "cli", "vscode", "claude-code"];
      const rawSource = typeof req.query.source === "string" ? req.query.source : "all";
      const source: ExportSource = validSources.includes(rawSource as ExportSource)
        ? (rawSource as ExportSource)
        : "all";

      const validFormats: ExportFormat[] = ["openai", "sharegpt"];
      const rawFormat = typeof req.query.format === "string" ? req.query.format : "openai";
      const format: ExportFormat = validFormats.includes(rawFormat as ExportFormat)
        ? (rawFormat as ExportFormat)
        : "openai";

      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      const repo = typeof req.query.repo === "string" ? req.query.repo : undefined;
      const minTurns = req.query.min_turns ? parseInt(req.query.min_turns as string) : 1;
      const minTokens = req.query.min_tokens ? parseInt(req.query.min_tokens as string) : undefined;
      const includeTools = req.query.include_tools === "1" || req.query.include_tools === "true";

      const result = bulkExport({ source, from, to, repo, minTurns, minTokens, format, includeTools });

      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="copilot-lens-export-${format}.jsonl"`
      );
      // Emit summary as first comment line, then data lines
      res.write(
        `// exported=${result.exportedSessions} total=${result.totalSessions} skipped_turns=${result.skippedTurns} skipped_tokens=${result.skippedTokens}\n`
      );
      for (const line of result.lines) {
        res.write(line + "\n");
      }
      res.end();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Clear cache (for manual refresh)
  app.post("/api/cache/clear", (_req, res) => {
    clearCache();
    searchIndex.clear();
    res.json({ ok: true });
  });

  // SPA fallback — only for non-API routes
  app.use((_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  // Global error handler
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error("Server error:", err.message);
    res.status(500).json({ error: err.message });
  });

  return app;
}
