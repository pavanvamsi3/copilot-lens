import { SessionMeta, getSession } from "./sessions";

export interface SearchEntry {
  id: string;
  source: "cli" | "vscode" | "claude-code";
  title: string;
  cwd: string;
  date: string;      // ISO string — updatedAt from SessionMeta
  content: string[]; // array of extracted message strings
}

export interface SearchResult {
  entry: SearchEntry;
  score: number;
  highlights: string[]; // up to 3 snippets, ±60 chars around match, trimmed to word boundaries
}

export interface SearchOptions {
  limit?: number;                        // default 20
  source?: "cli" | "vscode" | "claude-code" | "all";    // default 'all'
}

function stripCodeBlocks(text: string): string {
  // Matches markdown code blocks starting with ``` and ending with ```,
  // including all content in between (using [\s\S]*? for non-greedy multi-line match),
  // and replaces them with a single space.
  return text.replace(/```[\s\S]*?```/g, " ");
}

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    // Splits the search query on one or more non-alphanumeric characters,
    // converting the string into an array of lowercase tokens.
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function trimToWordBoundary(text: string, start: number, end: number): string {
  let s = start;
  let e = end;

  // Trim start to nearest word boundary (move right until whitespace)
  if (s > 0 && !/\s/.test(text[s - 1])) {
    while (s < e && !/\s/.test(text[s])) s++;
  }

  // Trim end to nearest word boundary (move left until whitespace)
  if (e < text.length && !/\s/.test(text[e])) {
    while (e > s && !/\s/.test(text[e - 1])) e--;
  }

  return text.slice(s, e).trim();
}

export class SearchIndex {
  private entries: SearchEntry[] = [];
  private storedSessions: SessionMeta[] | null = null;
  private signature = "";

  // A cheap fingerprint of the session set. Changes when sessions are added,
  // removed, or updated, so the index can detect when it has gone stale.
  private computeSignature(sessions: SessionMeta[]): string {
    let latest = "";
    for (const s of sessions) {
      if (s.updatedAt > latest) latest = s.updatedAt;
    }
    return `${sessions.length}:${latest}`;
  }

  buildIndex(sessions: SessionMeta[]): void {
    // Store sessions for lazy rebuild after clear()
    this.storedSessions = sessions;
    // No-op only if already built AND the session set is unchanged
    const sig = this.computeSignature(sessions);
    if (this.entries.length > 0 && sig === this.signature) return;
    this.signature = sig;
    this._doBuild(sessions);
  }

  private _doBuild(sessions: SessionMeta[]): void {
    this.entries = [];
    for (const meta of sessions) {
      try {
        const detail = getSession(meta.id);
        if (!detail) continue;

        const content: string[] = [];
        for (const event of detail.events) {
          if (
            event.type === "user.message" ||
            event.type === "assistant.message"
          ) {
            const raw: string = event.data?.content ?? "";
            if (raw.trim()) {
              content.push(stripCodeBlocks(raw));
            }
          }
        }

        this.entries.push({
          id: meta.id,
          source: meta.source,
          title: meta.title || meta.id,
          cwd: meta.cwd || "",
          date: meta.updatedAt,
          content,
        });
      } catch {
        // skip silently
      }
    }
  }

  search(query: string, options?: SearchOptions): SearchResult[] {
    if (!query || !query.trim()) return [];

    // Lazy build: only build if entries is empty
    if (this.entries.length === 0) {
      if (this.storedSessions) {
        this.buildIndex(this.storedSessions);
      } else {
        return [];
      }
    }

    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    const limit = options?.limit ?? 20;
    const sourceFilter = options?.source ?? "all";

    const results: SearchResult[] = [];

    for (const entry of this.entries) {
      if (sourceFilter !== "all" && entry.source !== sourceFilter) continue;

      const joinedContent = entry.content.join(" ").toLowerCase();
      const wordCount = joinedContent.split(/\s+/).filter(Boolean).length || 1;

      let score = 0;
      for (const token of tokens) {
        // Count occurrences in content
        let count = 0;
        let idx = 0;
        while ((idx = joinedContent.indexOf(token, idx)) !== -1) {
          count++;
          idx += token.length;
        }

        if (count > 0) {
          score += count / wordCount;
        }

        // Title bonus
        if (entry.title.toLowerCase().includes(token)) {
          score += 0.5;
        }

        // cwd bonus
        if (entry.cwd.toLowerCase().includes(token)) {
          score += 0.2;
        }
      }

      if (score <= 0) continue;

      const rawContent = entry.content.join(" ");
      const highlights = this.extractHighlights(rawContent, tokens);

      results.push({ entry, score, highlights });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private extractHighlights(rawContent: string, tokens: string[]): string[] {
    const lower = rawContent.toLowerCase();
    const windows: Array<[number, number]> = [];

    for (const token of tokens) {
      let idx = 0;
      while ((idx = lower.indexOf(token, idx)) !== -1) {
        const start = Math.max(0, idx - 60);
        const end = Math.min(rawContent.length, idx + 60);
        windows.push([start, end]);
        idx += token.length;
        if (windows.length >= 10) break; // cap search early
      }
    }

    // Sort windows by position
    windows.sort((a, b) => a[0] - b[0]);

    // Deduplicate overlapping windows, keep up to 3
    const merged: Array<[number, number]> = [];
    for (const [s, e] of windows) {
      if (merged.length === 0) {
        merged.push([s, e]);
      } else {
        const last = merged[merged.length - 1];
        if (s <= last[1]) {
          // Overlapping — extend
          last[1] = Math.max(last[1], e);
        } else {
          merged.push([s, e]);
        }
      }
      if (merged.length >= 3) break;
    }

    const highlights: string[] = [];
    for (const [s, e] of merged.slice(0, 3)) {
      const snippet = trimToWordBoundary(rawContent, s, e);
      if (snippet) highlights.push(snippet);
    }

    return highlights;
  }

  clear(): void {
    this.entries = [];
    this.signature = "";
    // storedSessions kept so search() can lazy-rebuild after clear()
  }
}
