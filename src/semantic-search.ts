import type { SearchEntry, SearchResult } from "./search";

// ============ Tokenization ============

export function tokenizeForVector(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && t.length <= 40);
}

export function textFromEntry(entry: SearchEntry): string {
  return [entry.title, entry.cwd, ...entry.content].join(" ");
}

// ============ Vector math ============

export function magnitude(v: Float32Array): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const mag = magnitude(a) * magnitude(b);
  if (mag === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / mag;
}

// ============ TF-IDF corpus ============

export interface TfIdfCorpus {
  terms: string[];
  idf: Float32Array;
  termIndex: Map<string, number>;
  docCount: number;
}

export function buildCorpus(entries: SearchEntry[]): TfIdfCorpus {
  const df = new Map<string, number>();

  for (const entry of entries) {
    const seen = new Set(tokenizeForVector(textFromEntry(entry)));
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }

  const N = entries.length || 1;
  const terms = Array.from(df.keys()).sort();
  const idf = new Float32Array(terms.length);
  const termIndex = new Map<string, number>();

  for (let i = 0; i < terms.length; i++) {
    termIndex.set(terms[i], i);
    // Smoothed IDF: log((N+1)/(df+1)) + 1  — keeps single-doc terms from
    // dominating while still rewarding rare terms over common ones.
    idf[i] = Math.log((N + 1) / ((df.get(terms[i]) || 0) + 1)) + 1;
  }

  return { terms, idf, termIndex, docCount: N };
}

export function buildVector(text: string, corpus: TfIdfCorpus): Float32Array {
  const tokens = tokenizeForVector(text);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  const total = tokens.length || 1;

  const vec = new Float32Array(corpus.terms.length);
  for (const [term, count] of tf) {
    const idx = corpus.termIndex.get(term);
    if (idx === undefined) continue;
    vec[idx] = (count / total) * corpus.idf[idx];
  }

  // L2-normalize so cosine similarity is just the dot product
  const mag = magnitude(vec);
  if (mag > 0) for (let i = 0; i < vec.length; i++) vec[i] /= mag;

  return vec;
}

// ============ SemanticIndex ============

export type SemanticSourceFilter = "cli" | "vscode" | "claude-code" | "cursor" | "all";

export interface SemanticSearchOptions {
  limit?: number;
  source?: SemanticSourceFilter;
}

export class SemanticIndex {
  private corpus: TfIdfCorpus | null = null;
  private docVectors: Map<string, Float32Array> = new Map();
  private entries: SearchEntry[] = [];

  /** Build the corpus and document vectors from already-indexed search entries. */
  build(entries: SearchEntry[]): void {
    if (this.corpus !== null) return; // no-op if already built
    if (entries.length === 0) return;
    this.entries = entries;
    this.corpus = buildCorpus(entries);
    for (const entry of entries) {
      this.docVectors.set(entry.id, buildVector(textFromEntry(entry), this.corpus));
    }
  }

  isBuilt(): boolean {
    return this.corpus !== null;
  }

  search(query: string, options?: SemanticSearchOptions): SearchResult[] {
    if (!this.corpus || this.docVectors.size === 0) return [];

    const source = options?.source ?? "all";
    const limit = options?.limit ?? 20;

    const queryVec = buildVector(query, this.corpus);
    // If no query terms appear in the corpus at all, similarity will be 0 for everyone
    if (magnitude(queryVec) === 0) return [];

    const results: SearchResult[] = [];

    for (const entry of this.entries) {
      if (source !== "all" && entry.source !== source) continue;
      const docVec = this.docVectors.get(entry.id);
      if (!docVec) continue;
      const score = cosineSimilarity(queryVec, docVec);
      if (score < 0.01) continue;
      // Semantic results carry no keyword-style highlight snippets
      results.push({ entry, score, highlights: [], matchType: "semantic" });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  clear(): void {
    this.corpus = null;
    this.docVectors.clear();
    this.entries = [];
  }
}

// ============ Hybrid blending ============

/**
 * Merge keyword and semantic results into a single ranked list.
 *
 * Keyword scores are normalized to [0,1] by max, then weighted 60%.
 * Semantic cosine scores are already in [0,1] and weighted 40%.
 * A result that appears in only one list still contributes its share.
 */
export function blendResults(
  keyword: SearchResult[],
  semantic: SearchResult[],
  limit: number
): SearchResult[] {
  const maxKw = keyword.reduce((m, r) => Math.max(m, r.score), 1e-9);

  const merged = new Map<string, SearchResult>();

  for (const r of keyword) {
    merged.set(r.entry.id, {
      ...r,
      score: 0.6 * (r.score / maxKw),
      matchType: "keyword",
    });
  }

  for (const r of semantic) {
    const existing = merged.get(r.entry.id);
    if (existing) {
      existing.score += 0.4 * r.score;
      existing.matchType = "hybrid";
    } else {
      merged.set(r.entry.id, {
        ...r,
        score: 0.4 * r.score,
        matchType: "semantic",
      });
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Exported for testing
export const _testing = {
  tokenizeForVector,
  textFromEntry,
  magnitude,
  cosineSimilarity,
  buildCorpus,
  buildVector,
  blendResults,
};
