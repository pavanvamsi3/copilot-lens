import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";

export interface Bookmark {
  sessionId: string;
  tags: string[];   // stored as JSON in the DB
  note: string;
  createdAt: string;
}

function getDbPath(): string {
  // COPILOT_LENS_DB_DIR lets tests redirect to a temp directory
  const base = process.env.COPILOT_LENS_DB_DIR || path.join(os.homedir(), ".config", "copilot-lens");
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, "bookmarks.db");
}

function openDb(): Database.Database {
  const db = new Database(getDbPath());
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      session_id TEXT PRIMARY KEY,
      tags       TEXT NOT NULL DEFAULT '[]',
      note       TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);
  return db;
}

export function listBookmarks(): Bookmark[] {
  const db = openDb();
  try {
    const rows = db.prepare("SELECT * FROM bookmarks ORDER BY created_at DESC").all() as Array<{
      session_id: string;
      tags: string;
      note: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      tags: JSON.parse(r.tags),
      note: r.note,
      createdAt: r.created_at,
    }));
  } finally {
    db.close();
  }
}

export function getBookmark(sessionId: string): Bookmark | null {
  const db = openDb();
  try {
    const row = db
      .prepare("SELECT * FROM bookmarks WHERE session_id = ?")
      .get(sessionId) as { session_id: string; tags: string; note: string; created_at: string } | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      tags: JSON.parse(row.tags),
      note: row.note,
      createdAt: row.created_at,
    };
  } finally {
    db.close();
  }
}

export function upsertBookmark(sessionId: string, tags: string[], note: string): Bookmark {
  const db = openDb();
  try {
    const existing = db.prepare("SELECT created_at FROM bookmarks WHERE session_id = ?").get(sessionId) as { created_at: string } | undefined;
    const createdAt = existing?.created_at ?? new Date().toISOString();
    const safeTags = tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
    db.prepare(`
      INSERT INTO bookmarks (session_id, tags, note, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET tags = excluded.tags, note = excluded.note
    `).run(sessionId, JSON.stringify(safeTags), note, createdAt);
    return { sessionId, tags: safeTags, note, createdAt };
  } finally {
    db.close();
  }
}

export function deleteBookmark(sessionId: string): boolean {
  const db = openDb();
  try {
    const result = db.prepare("DELETE FROM bookmarks WHERE session_id = ?").run(sessionId);
    return result.changes > 0;
  } finally {
    db.close();
  }
}

export function getBookmarkMap(): Map<string, Bookmark> {
  const all = listBookmarks();
  return new Map(all.map((b) => [b.sessionId, b]));
}

export function listAllTags(): string[] {
  const bookmarks = listBookmarks();
  const seen = new Set<string>();
  for (const b of bookmarks) {
    for (const t of b.tags) seen.add(t);
  }
  return Array.from(seen).sort();
}
