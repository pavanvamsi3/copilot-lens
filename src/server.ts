import express from "express";
import cors from "cors";
import path from "path";
import { listSessions, getSession, getAnalytics, listReposWithScores, getRepoScore, getVSCodeScore, type AnalyticsSourceFilter } from "./sessions";
import { clearCache } from "./cache";
import { SearchIndex } from "./search";
import { getTokenUsage, type TokenSourceFilter } from "./token-usage";

export function createApp() {
  const app = express();
  app.use(cors());

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
