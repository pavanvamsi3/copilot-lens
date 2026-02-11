import express from "express";
import cors from "cors";
import path from "path";
import { listSessions, getSession, getAnalytics, listReposWithScores, getRepoScore } from "./sessions";

export function createApp() {
  const app = express();
  app.use(cors());

  // Serve static frontend files
  app.use(express.static(path.join(__dirname, "..", "public")));

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

  // API: Analytics
  app.get("/api/analytics", (_req, res) => {
    try {
      const analytics = getAnalytics();
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
      const score = getRepoScore(repo);
      res.json(score);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
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
