/**
 * Tests for VeroQ × X Bridge MCP server.
 *
 * Tests sentiment analysis, URL extraction, aggregation, and edge cases.
 * Does NOT call real APIs — tests pure logic functions only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Import pure functions by re-implementing them (server.ts is an executable) ──
// We duplicate the pure logic here to test it in isolation.

// --- Sentiment words ---

const POSITIVE_WORDS = new Set([
  "bullish", "up", "gain", "surge", "soar", "rally", "beat", "strong",
  "growth", "profit", "record", "high", "buy", "moon", "rocket", "amazing",
  "great", "excellent", "love", "best", "win", "winning", "outperform",
  "breakout", "boom", "upgrade", "positive", "confident", "optimistic",
]);
const NEGATIVE_WORDS = new Set([
  "bearish", "down", "loss", "crash", "dump", "drop", "miss", "weak",
  "decline", "sell", "tank", "plunge", "fear", "worst", "fail", "bad",
  "terrible", "hate", "short", "underperform", "breakdown", "bust",
  "downgrade", "negative", "worried", "pessimistic", "scam", "fraud",
]);

interface SentimentResult {
  score: number;
  label: "positive" | "negative" | "neutral" | "mixed";
  positive_signals: string[];
  negative_signals: string[];
}

function analyzeSentiment(text: string): SentimentResult {
  const words = text.toLowerCase().split(/\s+/);
  const pos: string[] = [];
  const neg: string[] = [];
  for (const w of words) {
    const clean = w.replace(/[^a-z]/g, "");
    if (POSITIVE_WORDS.has(clean)) pos.push(clean);
    if (NEGATIVE_WORDS.has(clean)) neg.push(clean);
  }
  const total = pos.length + neg.length;
  if (total === 0) return { score: 0, label: "neutral", positive_signals: [], negative_signals: [] };
  const score = (pos.length - neg.length) / total;
  const label =
    pos.length >= 2 && neg.length >= 2 ? "mixed" :
    score > 0.2 ? "positive" :
    score < -0.2 ? "negative" : "neutral";
  return { score: Math.round(score * 100) / 100, label, positive_signals: pos, negative_signals: neg };
}

function aggregateSentiment(results: SentimentResult[]) {
  if (results.length === 0) {
    return {
      avg_score: 0,
      label: "neutral",
      distribution: { positive: 0, negative: 0, neutral: 0, mixed: 0 },
      top_signals: { positive: [] as string[], negative: [] as string[] },
    };
  }
  const dist = { positive: 0, negative: 0, neutral: 0, mixed: 0 };
  const allPos: Record<string, number> = {};
  const allNeg: Record<string, number> = {};
  let totalScore = 0;

  for (const r of results) {
    dist[r.label]++;
    totalScore += r.score;
    for (const w of r.positive_signals) allPos[w] = (allPos[w] || 0) + 1;
    for (const w of r.negative_signals) allNeg[w] = (allNeg[w] || 0) + 1;
  }

  const avg = Math.round((totalScore / results.length) * 100) / 100;
  const label =
    avg > 0.15 ? "positive" :
    avg < -0.15 ? "negative" :
    dist.mixed > results.length / 3 ? "mixed" : "neutral";

  const topPos = Object.entries(allPos).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
  const topNeg = Object.entries(allNeg).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);

  return { avg_score: avg, label, distribution: dist, top_signals: { positive: topPos, negative: topNeg } };
}

function extractPostId(input: string): string {
  const match = input.match(/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/);
  return match ? match[1] : input.replace(/\D/g, "");
}

// ── Tests ──

describe("extractPostId", () => {
  it("extracts ID from x.com URL", () => {
    assert.equal(extractPostId("https://x.com/elonmusk/status/1234567890"), "1234567890");
  });

  it("extracts ID from twitter.com URL", () => {
    assert.equal(extractPostId("https://twitter.com/user/status/9876543210"), "9876543210");
  });

  it("handles raw numeric ID", () => {
    assert.equal(extractPostId("1234567890"), "1234567890");
  });

  it("handles URL with query params", () => {
    assert.equal(extractPostId("https://x.com/user/status/111222333?s=20"), "111222333");
  });

  it("returns empty for non-URL non-numeric input", () => {
    assert.equal(extractPostId("hello world"), "");
  });

  it("handles mobile URL with trailing slash", () => {
    assert.equal(extractPostId("https://x.com/user/status/555666777/"), "555666777");
  });
});

describe("analyzeSentiment", () => {
  it("detects positive sentiment", () => {
    const r = analyzeSentiment("NVIDIA had amazing growth and record profit this quarter");
    assert.equal(r.label, "positive");
    assert.ok(r.score > 0);
    assert.ok(r.positive_signals.includes("amazing"));
    assert.ok(r.positive_signals.includes("growth"));
    assert.ok(r.positive_signals.includes("record"));
    assert.ok(r.positive_signals.includes("profit"));
  });

  it("detects negative sentiment", () => {
    const r = analyzeSentiment("The stock crash was terrible, worst decline in years");
    assert.equal(r.label, "negative");
    assert.ok(r.score < 0);
    assert.ok(r.negative_signals.includes("crash"));
    assert.ok(r.negative_signals.includes("terrible"));
    assert.ok(r.negative_signals.includes("worst"));
    assert.ok(r.negative_signals.includes("decline"));
  });

  it("detects neutral sentiment (no signal words)", () => {
    const r = analyzeSentiment("The company reported quarterly earnings today");
    assert.equal(r.label, "neutral");
    assert.equal(r.score, 0);
    assert.equal(r.positive_signals.length, 0);
    assert.equal(r.negative_signals.length, 0);
  });

  it("detects mixed sentiment only with 2+ signals each side", () => {
    const r = analyzeSentiment("great surge but crash and terrible dump incoming");
    assert.equal(r.label, "mixed");
    assert.ok(r.positive_signals.length >= 2);
    assert.ok(r.negative_signals.length >= 2);
  });

  it("does NOT mark as mixed with only 1 signal per side", () => {
    const r = analyzeSentiment("the gain was followed by a small drop");
    // Only 1 pos (gain) and 1 neg (drop) — should not be mixed
    assert.notEqual(r.label, "mixed");
  });

  it("handles empty text", () => {
    const r = analyzeSentiment("");
    assert.equal(r.label, "neutral");
    assert.equal(r.score, 0);
  });

  it("strips punctuation before matching", () => {
    const r = analyzeSentiment("Bullish! Amazing! Record-breaking growth!!!");
    assert.ok(r.positive_signals.includes("bullish"));
    assert.ok(r.positive_signals.includes("amazing"));
    assert.ok(r.positive_signals.includes("growth"));
  });

  it("handles crypto slang", () => {
    const r = analyzeSentiment("BTC to the moon rocket buy buy buy");
    assert.equal(r.label, "positive");
    assert.ok(r.positive_signals.includes("moon"));
    assert.ok(r.positive_signals.includes("rocket"));
    assert.ok(r.positive_signals.includes("buy"));
  });

  it("handles scam/fraud signals", () => {
    const r = analyzeSentiment("This is a total scam and fraud, avoid at all costs");
    assert.equal(r.label, "negative");
    assert.ok(r.negative_signals.includes("scam"));
    assert.ok(r.negative_signals.includes("fraud"));
  });

  it("score is bounded between -1 and 1", () => {
    const pos = analyzeSentiment("bullish surge soar rally beat strong growth profit record high");
    assert.ok(pos.score >= -1 && pos.score <= 1);
    const neg = analyzeSentiment("bearish crash dump drop miss weak decline sell tank plunge");
    assert.ok(neg.score >= -1 && neg.score <= 1);
  });
});

describe("aggregateSentiment", () => {
  it("returns neutral for empty array", () => {
    const r = aggregateSentiment([]);
    assert.equal(r.label, "neutral");
    assert.equal(r.avg_score, 0);
    assert.equal(r.distribution.positive, 0);
  });

  it("aggregates all positive posts", () => {
    const posts = [
      analyzeSentiment("Amazing growth and record profit"),
      analyzeSentiment("Strong rally and bullish surge"),
      analyzeSentiment("Great winning streak continues"),
    ];
    const r = aggregateSentiment(posts);
    assert.equal(r.label, "positive");
    assert.ok(r.avg_score > 0);
    assert.equal(r.distribution.positive, 3);
  });

  it("aggregates mixed set", () => {
    const posts = [
      analyzeSentiment("Amazing growth this quarter"),
      analyzeSentiment("Terrible crash and huge loss"),
      analyzeSentiment("The company reported earnings today"),
    ];
    const r = aggregateSentiment(posts);
    assert.ok(r.distribution.positive >= 1);
    assert.ok(r.distribution.negative >= 1);
  });

  it("ranks top signals by frequency", () => {
    const posts = [
      analyzeSentiment("bullish bullish surge"),
      analyzeSentiment("bullish growth"),
      analyzeSentiment("surge profit"),
    ];
    const r = aggregateSentiment(posts);
    // "bullish" should be first (appears in 3 posts)
    assert.equal(r.top_signals.positive[0], "bullish");
  });

  it("limits top signals to 5", () => {
    const posts = Array(20).fill(null).map(() =>
      analyzeSentiment("bullish surge soar rally beat strong growth profit record high buy moon rocket amazing")
    );
    const r = aggregateSentiment(posts);
    assert.ok(r.top_signals.positive.length <= 5);
  });
});

describe("URL construction", () => {
  it("X API search URL is correct", () => {
    const X_API_BASE = "https://api.x.com/2";
    const url = new URL("/2/tweets/search/recent", X_API_BASE);
    assert.equal(url.toString(), "https://api.x.com/2/tweets/search/recent");
  });

  it("X API tweet lookup URL is correct", () => {
    const X_API_BASE = "https://api.x.com/2";
    const url = new URL("/2/tweets/123456", X_API_BASE);
    assert.equal(url.toString(), "https://api.x.com/2/tweets/123456");
  });

  it("VeroQ API Shield URL is correct", () => {
    const VEROQ_BASE = "https://api.veroq.ai";
    const url = new URL("/api/v1/shield", VEROQ_BASE);
    assert.equal(url.toString(), "https://api.veroq.ai/api/v1/shield");
  });

  it("VeroQ entity sentiment URL encodes properly", () => {
    const VEROQ_BASE = "https://api.veroq.ai";
    const entity = "OpenAI";
    const url = new URL(`/api/v1/entities/${encodeURIComponent(entity)}/sentiment`, VEROQ_BASE);
    assert.equal(url.toString(), "https://api.veroq.ai/api/v1/entities/OpenAI/sentiment");
  });

  it("VeroQ entity with special chars encodes safely", () => {
    const VEROQ_BASE = "https://api.veroq.ai";
    const entity = "S&P 500";
    const url = new URL(`/api/v1/entities/${encodeURIComponent(entity)}/sentiment`, VEROQ_BASE);
    assert.ok(url.toString().includes("S%26P%20500"));
  });
});

describe("edge cases", () => {
  it("extractPostId handles URL with photo suffix", () => {
    assert.equal(extractPostId("https://x.com/user/status/123/photo/1"), "123");
  });

  it("sentiment handles repeated words", () => {
    const r = analyzeSentiment("buy buy buy buy sell");
    assert.equal(r.label, "positive"); // 4 buy vs 1 sell = score 0.6
    assert.ok(r.score > 0.5);
  });

  it("sentiment handles unicode/emoji text gracefully", () => {
    const r = analyzeSentiment("Great news for Bitcoin 🚀🚀🚀 to the moon");
    assert.equal(r.label, "positive");
    assert.ok(r.positive_signals.includes("great"));
    assert.ok(r.positive_signals.includes("moon"));
  });

  it("aggregation handles single post", () => {
    const r = aggregateSentiment([analyzeSentiment("Amazing surge")]);
    assert.equal(r.distribution.positive, 1);
    assert.ok(r.avg_score > 0);
  });
});
