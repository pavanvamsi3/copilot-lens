import { SessionMeta, getSession } from "./sessions";

export interface SearchEntry {
  id: string;
  source: "cli" | "vscode" | "claude-code";
  title: string;
  cwd: string;
  date: string; // ISO string — updatedAt from SessionMeta
  content: string[]; // array of extracted message strings
}

export interface SearchResult {
  entry: SearchEntry;
  score: number;
  highlights: string[]; // up to 3 snippets, ±60 chars around match, trimmed to word boundaries
}

export interface SearchPage {
  results: SearchResult[];
  totalMatches: number;
}

export interface SearchOptions {
  limit?: number; // default 20
  offset?: number; // default 0, applied after ranking and source filtering
  source?: "cli" | "vscode" | "claude-code" | "all"; // default 'all'
  caseSensitive?: boolean; // default false
}

function stripCodeBlocks(text: string): string {
  // Markdown fences may close with an equal or longer run of the same
  // delimiter. Inline spans require an exact run; do not pair with a
  // substring of a longer delimiter and accidentally swallow surrounding prose.
  return text
    .replace(
      /(?<!`)(`{3,})(?!`)[\s\S]*?(?<!`)\1`*(?!`)|(?<!~)(~{3,})(?!~)[\s\S]*?(?<!~)\2~*(?!~)/g,
      " "
    )
    .replace(/(?<!`)(`{1,2})(?!`)[\s\S]*?(?<!`)\1(?!`)/g, " ");
}

export function tokenize(query: string, caseSensitive = false): string[] {
  const normalized = caseSensitive ? query : query.toLowerCase();
  // Keep complete Unicode words in exact-case queries, including decomposed
  // accents. Default queries retain the existing ASCII tokenization rules.
  const delimiter = caseSensitive ? /[^\p{L}\p{N}\p{M}]+/u : /[^a-z0-9]+/;
  return normalized.split(delimiter).filter((t) => t.length >= 2);
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
  private skippedWarning = "";

  // Include each session's identity, update time, and searchable metadata.
  // Sorting avoids rebuilding when only the session enumeration order changes.
  private computeSignature(sessions: SessionMeta[]): string {
    return JSON.stringify(
      sessions
        .map((meta) =>
          JSON.stringify([
            meta.source,
            meta.id,
            meta.updatedAt,
            meta.title || meta.id,
            meta.cwd || "",
          ])
        )
        .sort()
    );
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
    let skippedCount = 0;
    for (const meta of sessions) {
      try {
        const detail = getSession(meta.id);
        if (!detail) {
          skippedCount++;
          continue;
        }

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
        skippedCount++;
      }
    }
    // An entirely unreadable session set is retried by search(). Avoid repeating
    // the same diagnostic on every query while allowing those retries to recover.
    const warning = skippedCount
      ? JSON.stringify([
          skippedCount,
          sessions
            .map((meta) =>
              JSON.stringify([meta.source, meta.id, meta.updatedAt])
            )
            .sort(),
        ])
      : "";
    if (warning && warning !== this.skippedWarning) {
      console.warn(
        `[copilot-lens] search: skipped ${skippedCount} session${skippedCount === 1 ? "" : "s"} that could not be loaded or parsed`
      );
    }
    this.skippedWarning = warning;
  }

  search(query: string, options?: SearchOptions): SearchResult[] {
    return this.searchPage(query, options).results;
  }

  searchPage(query: string, options?: SearchOptions): SearchPage {
    if (!query || !query.trim()) return { results: [], totalMatches: 0 };

    // Lazy build: only build if entries is empty
    if (this.entries.length === 0) {
      if (this.storedSessions) {
        this.buildIndex(this.storedSessions);
      } else {
        return { results: [], totalMatches: 0 };
      }
    }

    const caseSensitive = options?.caseSensitive ?? false;
    const tokens = tokenize(query, caseSensitive);
    if (tokens.length === 0) return { results: [], totalMatches: 0 };

    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const sourceFilter = options?.source ?? "all";

    const results: SearchResult[] = [];

    for (const entry of this.entries) {
      if (sourceFilter !== "all" && entry.source !== sourceFilter) continue;

      const rawContent = entry.content.join(" ");
      const joinedContent = caseSensitive
        ? rawContent
        : rawContent.toLowerCase();
      const title = caseSensitive ? entry.title : entry.title.toLowerCase();
      const cwd = caseSensitive ? entry.cwd : entry.cwd.toLowerCase();
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
        if (title.includes(token)) {
          score += 0.5;
        }

        // cwd bonus
        if (cwd.includes(token)) {
          score += 0.2;
        }
      }

      if (score <= 0) continue;

      const highlights = this.extractHighlights(
        rawContent,
        tokens,
        caseSensitive
      );

      results.push({ entry, score, highlights });
    }

    results.sort((a, b) => b.score - a.score);
    return {
      results: results.slice(offset, offset + limit),
      totalMatches: results.length,
    };
  }

  private extractHighlights(
    rawContent: string,
    tokens: string[],
    caseSensitive: boolean
  ): string[] {
    const searchable = caseSensitive ? rawContent : rawContent.toLowerCase();
    const windows: Array<[number, number]> = [];

    for (const token of tokens) {
      let idx = 0;
      while ((idx = searchable.indexOf(token, idx)) !== -1) {
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
    this.skippedWarning = "";
    // storedSessions kept so search() can lazy-rebuild after clear()
  }
}
