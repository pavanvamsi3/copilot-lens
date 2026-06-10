import { describe, it, expect, beforeEach } from "vitest";
import {
  _testing,
  SemanticIndex,
  buildCorpus,
  buildVector,
  blendResults,
} from "../semantic-search";
import type { SearchEntry } from "../search";

const { tokenizeForVector, textFromEntry, magnitude, cosineSimilarity } = _testing;

// ─── helpers ───────────────────────────────────────────────────────────────

function makeEntry(id: string, title: string, content: string[]): SearchEntry {
  return { id, source: "cli", title, cwd: "/project", date: "2024-01-01", content };
}

// ─── tokenizeForVector ──────────────────────────────────────────────────────

describe("tokenizeForVector", () => {
  it("lowercases and splits on non-alphanumeric", () => {
    expect(tokenizeForVector("Hello, World!")).toEqual(["hello", "world"]);
  });

  it("filters tokens shorter than 2 chars", () => {
    const tokens = tokenizeForVector("a ab abc");
    expect(tokens).not.toContain("a");
    expect(tokens).toContain("ab");
    expect(tokens).toContain("abc");
  });

  it("filters tokens longer than 40 chars", () => {
    const long = "a".repeat(41);
    const short = "normalword";
    expect(tokenizeForVector(`${long} ${short}`)).toEqual([short]);
  });

  it("returns empty array for empty string", () => {
    expect(tokenizeForVector("")).toEqual([]);
  });

  it("handles numeric tokens", () => {
    expect(tokenizeForVector("fix issue 123")).toContain("123");
  });
});

// ─── textFromEntry ──────────────────────────────────────────────────────────

describe("textFromEntry", () => {
  it("joins title, cwd, and content", () => {
    const entry = makeEntry("1", "My Title", ["hello world", "foo bar"]);
    const text = textFromEntry(entry);
    expect(text).toContain("My Title");
    expect(text).toContain("/project");
    expect(text).toContain("hello world");
    expect(text).toContain("foo bar");
  });
});

// ─── magnitude ─────────────────────────────────────────────────────────────

describe("magnitude", () => {
  it("computes Euclidean length", () => {
    const v = new Float32Array([3, 4]);
    expect(magnitude(v)).toBeCloseTo(5, 5);
  });

  it("returns 0 for zero vector", () => {
    expect(magnitude(new Float32Array([0, 0, 0]))).toBe(0);
  });

  it("returns 1 for unit vector", () => {
    const v = new Float32Array([1, 0, 0]);
    expect(magnitude(v)).toBeCloseTo(1, 5);
  });
});

// ─── cosineSimilarity ───────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical non-zero vectors", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("returns 0 when either vector is zero", () => {
    const a = new Float32Array([1, 2, 3]);
    const zero = new Float32Array([0, 0, 0]);
    expect(cosineSimilarity(a, zero)).toBe(0);
    expect(cosineSimilarity(zero, a)).toBe(0);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });
});

// ─── buildCorpus ────────────────────────────────────────────────────────────

describe("buildCorpus", () => {
  it("produces terms sorted alphabetically", () => {
    const entries = [makeEntry("1", "zebra apple", [])];
    const corpus = buildCorpus(entries);
    const sorted = [...corpus.terms].sort();
    expect(corpus.terms).toEqual(sorted);
  });

  it("termIndex maps every term to its position in terms array", () => {
    const entries = [makeEntry("1", "foo bar", [])];
    const corpus = buildCorpus(entries);
    for (const [term, idx] of corpus.termIndex) {
      expect(corpus.terms[idx]).toBe(term);
    }
  });

  it("idf length equals terms length", () => {
    const entries = [makeEntry("1", "hello world", [])];
    const corpus = buildCorpus(entries);
    expect(corpus.idf.length).toBe(corpus.terms.length);
  });

  it("all IDF values are positive", () => {
    const entries = [
      makeEntry("1", "shared unique1", []),
      makeEntry("2", "shared unique2", []),
    ];
    const corpus = buildCorpus(entries);
    for (const v of corpus.idf) {
      expect(v).toBeGreaterThan(0);
    }
  });

  it("rare term has higher IDF than common term", () => {
    const entries = [
      makeEntry("1", "common rare1", []),
      makeEntry("2", "common rare2", []),
      makeEntry("3", "common", []),
    ];
    const corpus = buildCorpus(entries);
    const commonIdx = corpus.termIndex.get("common")!;
    const rareIdx = corpus.termIndex.get("rare1")!;
    expect(rareIdx).toBeDefined();
    expect(corpus.idf[rareIdx]).toBeGreaterThan(corpus.idf[commonIdx]);
  });

  it("handles empty entries array without throwing", () => {
    const corpus = buildCorpus([]);
    expect(corpus.terms).toEqual([]);
    expect(corpus.docCount).toBe(1); // max(N,1)
  });
});

// ─── buildVector ────────────────────────────────────────────────────────────

describe("buildVector", () => {
  it("returns L2-normalized vector (magnitude ≈ 1)", () => {
    const entries = [makeEntry("1", "search query example", [])];
    const corpus = buildCorpus(entries);
    const vec = buildVector("search query", corpus);
    const mag = magnitude(vec);
    if (mag > 0) expect(mag).toBeCloseTo(1, 5);
  });

  it("returns zero vector for text with no corpus terms", () => {
    const entries = [makeEntry("1", "hello world", [])];
    const corpus = buildCorpus(entries);
    const vec = buildVector("zzz999", corpus);
    expect(magnitude(vec)).toBe(0);
  });

  it("similar texts produce higher similarity than dissimilar", () => {
    const entries = [
      makeEntry("1", "typescript compiler errors", []),
      makeEntry("2", "cooking recipes kitchen", []),
    ];
    const corpus = buildCorpus(entries);
    const queryVec = buildVector("typescript errors", corpus);
    const v1 = buildVector(textFromEntry(entries[0]), corpus);
    const v2 = buildVector(textFromEntry(entries[1]), corpus);
    expect(cosineSimilarity(queryVec, v1)).toBeGreaterThan(cosineSimilarity(queryVec, v2));
  });
});

// ─── SemanticIndex ──────────────────────────────────────────────────────────

describe("SemanticIndex", () => {
  let index: SemanticIndex;
  const entries: SearchEntry[] = [
    makeEntry("s1", "TypeScript compiler", ["fix type errors", "interface mismatch"]),
    makeEntry("s2", "React components", ["useState hook", "prop types"]),
    makeEntry("s3", "database queries", ["SQL join", "index optimization"]),
  ];

  beforeEach(() => {
    index = new SemanticIndex();
  });

  it("isBuilt returns false before build", () => {
    expect(index.isBuilt()).toBe(false);
  });

  it("isBuilt returns true after build", () => {
    index.build(entries);
    expect(index.isBuilt()).toBe(true);
  });

  it("build is idempotent (no-op on second call)", () => {
    index.build(entries);
    const firstResult = index.search("typescript");
    index.build(entries); // second call — should be no-op
    const secondResult = index.search("typescript");
    expect(firstResult).toEqual(secondResult);
  });

  it("search returns empty array before build", () => {
    expect(index.search("typescript")).toEqual([]);
  });

  it("search returns results with matchType=semantic", () => {
    index.build(entries);
    const results = index.search("typescript compiler");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.matchType).toBe("semantic");
    }
  });

  it("search returns empty highlights array", () => {
    index.build(entries);
    const results = index.search("typescript");
    for (const r of results) {
      expect(r.highlights).toEqual([]);
    }
  });

  it("search returns empty array for out-of-corpus query", () => {
    index.build(entries);
    const results = index.search("zzz999xyzunknown");
    expect(results).toEqual([]);
  });

  it("search respects limit option", () => {
    index.build(entries);
    const results = index.search("the", { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("search filters by source", () => {
    const mixed: SearchEntry[] = [
      { ...entries[0], source: "cli" },
      { ...entries[1], source: "vscode" },
    ];
    index.build(mixed);
    const results = index.search("typescript", { source: "vscode" });
    for (const r of results) {
      expect(r.entry.source).toBe("vscode");
    }
  });

  it("clear resets index so isBuilt returns false", () => {
    index.build(entries);
    index.clear();
    expect(index.isBuilt()).toBe(false);
  });

  it("can rebuild after clear", () => {
    index.build(entries);
    index.clear();
    index.build(entries);
    expect(index.isBuilt()).toBe(true);
    const results = index.search("typescript");
    expect(results.length).toBeGreaterThan(0);
  });
});

// ─── blendResults ───────────────────────────────────────────────────────────

describe("blendResults", () => {
  const e1 = makeEntry("s1", "TypeScript", []);
  const e2 = makeEntry("s2", "React", []);
  const e3 = makeEntry("s3", "database", []);

  it("result in both lists gets matchType=hybrid", () => {
    const kw = [{ entry: e1, score: 10, highlights: ["ts"], matchType: "keyword" as const }];
    const sem = [{ entry: e1, score: 0.8, highlights: [], matchType: "semantic" as const }];
    const out = blendResults(kw, sem, 10);
    const r = out.find((r) => r.entry.id === "s1");
    expect(r?.matchType).toBe("hybrid");
  });

  it("result only in keyword list keeps keyword matchType", () => {
    const kw = [{ entry: e1, score: 10, highlights: ["ts"], matchType: "keyword" as const }];
    const sem = [{ entry: e2, score: 0.8, highlights: [], matchType: "semantic" as const }];
    const out = blendResults(kw, sem, 10);
    const r = out.find((r) => r.entry.id === "s1");
    expect(r?.matchType).toBe("keyword");
  });

  it("result only in semantic list keeps semantic matchType", () => {
    const kw = [{ entry: e1, score: 10, highlights: [], matchType: "keyword" as const }];
    const sem = [{ entry: e2, score: 0.8, highlights: [], matchType: "semantic" as const }];
    const out = blendResults(kw, sem, 10);
    const r = out.find((r) => r.entry.id === "s2");
    expect(r?.matchType).toBe("semantic");
  });

  it("respects limit", () => {
    const kw = [e1, e2, e3].map((e, i) => ({ entry: e, score: 10 - i, highlights: [], matchType: "keyword" as const }));
    const sem: typeof kw = [];
    expect(blendResults(kw, sem, 2).length).toBe(2);
  });

  it("results are sorted descending by blended score", () => {
    const kw = [
      { entry: e1, score: 5, highlights: [], matchType: "keyword" as const },
      { entry: e2, score: 1, highlights: [], matchType: "keyword" as const },
    ];
    const sem = [
      { entry: e2, score: 0.9, highlights: [], matchType: "semantic" as const },
    ];
    const out = blendResults(kw, sem, 10);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
    }
  });

  it("handles empty keyword list", () => {
    const sem = [{ entry: e1, score: 0.8, highlights: [], matchType: "semantic" as const }];
    const out = blendResults([], sem, 10);
    expect(out.length).toBe(1);
    expect(out[0].matchType).toBe("semantic");
  });

  it("handles empty semantic list", () => {
    const kw = [{ entry: e1, score: 5, highlights: [], matchType: "keyword" as const }];
    const out = blendResults(kw, [], 10);
    expect(out.length).toBe(1);
    expect(out[0].matchType).toBe("keyword");
  });

  it("handles both lists empty", () => {
    expect(blendResults([], [], 10)).toEqual([]);
  });
});
