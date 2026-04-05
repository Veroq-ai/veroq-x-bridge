#!/usr/bin/env node

/**
 * VeroQ × X Bridge — MCP server that combines X API social data
 * with VeroQ Shield verification and entity sentiment.
 *
 * Tools:
 *   x_verify_post      — verify claims in an X post
 *   x_topic_sentiment   — social sentiment for a topic from X + VeroQ
 *   x_verify_trending   — fact-check claims in trending X posts
 *   x_entity_pulse      — full entity intel: X social + VeroQ news sentiment + briefs
 *   x_search_verified   — search X posts with claim verification
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Config ──

const VEROQ_API_KEY = process.env.VEROQ_API_KEY;
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;

if (!VEROQ_API_KEY) {
  console.error("VEROQ_API_KEY required — get one at https://veroq.ai/settings");
  process.exit(1);
}
if (!X_BEARER_TOKEN) {
  console.error("X_BEARER_TOKEN required — get one at https://developer.x.com");
  process.exit(1);
}

const VEROQ_BASE = (process.env.VEROQ_BASE_URL || "https://api.veroq.ai").replace(/\/+$/, "");
const X_API_BASE = "https://api.x.com/2";

// ── API Helpers ──

async function veroqApi(
  method: "GET" | "POST",
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const url = new URL(path, VEROQ_BASE);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${VEROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`VeroQ API ${res.status}: ${data.error || data.message || res.statusText}`);
  }
  return data;
}

async function xApi(
  path: string,
  params?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(path, X_API_BASE);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X API ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

// ── Sentiment Analysis (lightweight, no LLM) ──

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
  score: number; // -1 to 1
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

function aggregateSentiment(results: SentimentResult[]): {
  avg_score: number;
  label: string;
  distribution: { positive: number; negative: number; neutral: number; mixed: number };
  top_signals: { positive: string[]; negative: string[] };
} {
  if (results.length === 0) {
    return {
      avg_score: 0,
      label: "neutral",
      distribution: { positive: 0, negative: 0, neutral: 0, mixed: 0 },
      top_signals: { positive: [], negative: [] },
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

// ── X Post Helpers ──

interface XPost {
  id: string;
  text: string;
  author_id?: string;
  author_username?: string;
  created_at?: string;
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
    impression_count: number;
  };
}

function extractPostId(input: string): string {
  // Accept post URL or raw ID
  const match = input.match(/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/);
  return match ? match[1] : input.replace(/\D/g, "");
}

async function searchXPosts(query: string, maxResults: number = 10): Promise<XPost[]> {
  const data = await xApi("/2/tweets/search/recent", {
    query,
    max_results: String(Math.min(Math.max(maxResults, 10), 100)),
    "tweet.fields": "created_at,public_metrics,author_id",
    expansions: "author_id",
    "user.fields": "username",
  });

  const tweets = (data.data || []) as Array<Record<string, unknown>>;
  const users = ((data.includes as Record<string, unknown>)?.users || []) as Array<Record<string, unknown>>;
  const userMap = new Map(users.map((u) => [u.id as string, u.username as string]));

  return tweets.map((t) => ({
    id: t.id as string,
    text: t.text as string,
    author_id: t.author_id as string,
    author_username: userMap.get(t.author_id as string),
    created_at: t.created_at as string,
    public_metrics: t.public_metrics as XPost["public_metrics"],
  }));
}

async function getXPost(postId: string): Promise<XPost | null> {
  try {
    const data = await xApi(`/2/tweets/${postId}`, {
      "tweet.fields": "created_at,public_metrics,author_id",
      expansions: "author_id",
      "user.fields": "username",
    });
    const tweet = data.data as Record<string, unknown> | undefined;
    if (!tweet) return null;
    const users = ((data.includes as Record<string, unknown>)?.users || []) as Array<Record<string, unknown>>;
    const author = users[0];
    return {
      id: tweet.id as string,
      text: tweet.text as string,
      author_id: tweet.author_id as string,
      author_username: author?.username as string,
      created_at: tweet.created_at as string,
      public_metrics: tweet.public_metrics as XPost["public_metrics"],
    };
  } catch {
    return null;
  }
}

// ── Text helper ──

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

// ── MCP Server ──

const server = new McpServer({
  name: "veroq-x-bridge",
  version: "1.0.0",
});

// ── Tool 1: Verify claims in an X post ──

server.tool(
  "x_verify_post",
  `Verify factual claims in an X (Twitter) post using VeroQ Shield.

WHEN TO USE: When an agent needs to fact-check a specific X post before acting on it.
RETURNS: Claim-level verdicts (supported/contradicted/unverifiable) with evidence.
COST: 1 X API call + 1 VeroQ Shield call.`,
  {
    post: z.string().describe("X post URL (e.g. https://x.com/user/status/123) or post ID"),
    max_claims: z.number().min(1).max(10).default(5).describe("Max claims to extract and verify"),
  },
  async ({ post, max_claims }) => {
    const postId = extractPostId(post);
    if (!postId) return text("Invalid post URL or ID.");

    const xPost = await getXPost(postId);
    if (!xPost) return text(`Post ${postId} not found or inaccessible.`);

    // Verify with Shield
    const shield = await veroqApi("POST", "/api/v1/verify/output", undefined, {
      text: xPost.text,
      source: `x.com/${xPost.author_username || xPost.author_id}`,
      max_claims,
    });

    const claims = (shield.claims || []) as Array<Record<string, unknown>>;
    const lines: string[] = [
      `## Post Verification`,
      `**Author:** @${xPost.author_username || xPost.author_id}`,
      `**Text:** ${xPost.text}`,
      `**Posted:** ${xPost.created_at || "unknown"}`,
      xPost.public_metrics
        ? `**Engagement:** ${xPost.public_metrics.like_count} likes, ${xPost.public_metrics.retweet_count} RTs, ${xPost.public_metrics.impression_count?.toLocaleString() || "?"} views`
        : "",
      "",
      `### Shield Results`,
      `**Trust Score:** ${shield.trust_score}/1.0`,
      `**Verdict:** ${shield.overall_verdict}`,
      `**Claims:** ${shield.claims_supported} supported, ${shield.claims_contradicted} contradicted, ${shield.claims_unverifiable} unverifiable`,
      "",
    ];

    for (const c of claims) {
      const icon = c.verdict === "supported" ? "+" : c.verdict === "contradicted" ? "x" : "?";
      lines.push(`[${icon}] ${c.text}`);
      lines.push(`    Verdict: ${c.verdict} (${Math.round((c.confidence as number) * 100)}%)`);
      if (c.correction) lines.push(`    Correction: ${c.correction}`);
      lines.push("");
    }

    if (shield.summary) lines.push(`**Summary:** ${shield.summary}`);

    return text(lines.filter(Boolean).join("\n"));
  },
);

// ── Tool 2: Topic sentiment from X ──

server.tool(
  "x_topic_sentiment",
  `Get real-time social sentiment for a topic from X posts, combined with VeroQ entity sentiment if available.

WHEN TO USE: When an agent needs to gauge public opinion on a topic, company, or event.
RETURNS: Sentiment breakdown (positive/negative/neutral), top signals, sample posts.
COST: 1 X API search + 1 optional VeroQ entity call.`,
  {
    topic: z.string().describe("Topic, company name, ticker, or hashtag to analyze"),
    max_posts: z.number().min(10).max(100).default(25).describe("Number of X posts to analyze"),
    include_veroq_sentiment: z.boolean().default(true).describe("Cross-reference with VeroQ entity sentiment from news"),
  },
  async ({ topic, max_posts, include_veroq_sentiment }) => {
    // Search X
    let posts: XPost[];
    try {
      posts = await searchXPosts(topic, max_posts);
    } catch (err: unknown) {
      return text(`X API error searching "${topic}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (posts.length === 0) return text(`No recent X posts found for "${topic}".`);

    // Analyze sentiment per post
    const postSentiments = posts.map((p) => ({
      post: p,
      sentiment: analyzeSentiment(p.text),
    }));

    const agg = aggregateSentiment(postSentiments.map((ps) => ps.sentiment));

    const lines: string[] = [
      `## X Social Sentiment: "${topic}"`,
      `**Posts analyzed:** ${posts.length}`,
      `**Overall sentiment:** ${agg.label} (score: ${agg.avg_score})`,
      `**Distribution:** ${agg.distribution.positive} positive, ${agg.distribution.negative} negative, ${agg.distribution.neutral} neutral, ${agg.distribution.mixed} mixed`,
      "",
    ];

    if (agg.top_signals.positive.length > 0) {
      lines.push(`**Bullish signals:** ${agg.top_signals.positive.join(", ")}`);
    }
    if (agg.top_signals.negative.length > 0) {
      lines.push(`**Bearish signals:** ${agg.top_signals.negative.join(", ")}`);
    }
    lines.push("");

    // Top posts by engagement
    const sorted = [...postSentiments]
      .sort((a, b) => (b.post.public_metrics?.like_count || 0) - (a.post.public_metrics?.like_count || 0))
      .slice(0, 5);

    lines.push("### Top Posts by Engagement");
    for (const ps of sorted) {
      const icon = ps.sentiment.label === "positive" ? "+" : ps.sentiment.label === "negative" ? "-" : "~";
      const likes = ps.post.public_metrics?.like_count || 0;
      lines.push(`[${icon}] @${ps.post.author_username || "?"}: ${ps.post.text.slice(0, 140)}${ps.post.text.length > 140 ? "..." : ""}`);
      lines.push(`    ${likes} likes | sentiment: ${ps.sentiment.label} (${ps.sentiment.score})`);
      lines.push("");
    }

    // Cross-reference with VeroQ entity sentiment
    if (include_veroq_sentiment) {
      try {
        const entity = await veroqApi("GET", `/api/v1/entities/${encodeURIComponent(topic)}/sentiment`, { period: "7d" });
        if (entity.status === "ok") {
          const overall = entity.overall as Record<string, number>;
          const trend = entity.sentiment_trend as string;
          lines.push("### VeroQ News Sentiment (7d)");
          lines.push(`**Trend:** ${trend}`);
          lines.push(`**From news:** ${overall?.positive || 0} positive, ${overall?.negative || 0} negative, ${overall?.neutral || 0} neutral`);

          // Compare
          const xLabel = agg.label;
          const newsLabel = trend === "improving" ? "positive" : trend === "declining" ? "negative" : "neutral";
          if (xLabel !== newsLabel) {
            lines.push(`**Divergence detected:** X social is ${xLabel}, news sentiment is ${newsLabel}`);
          } else {
            lines.push(`**Aligned:** Both X social and news sentiment are ${xLabel}`);
          }
        }
      } catch {
        // Entity not found — skip
      }
    }

    return text(lines.join("\n"));
  },
);

// ── Tool 3: Verify trending claims on X ──

server.tool(
  "x_verify_trending",
  `Find trending posts about a topic on X and fact-check the most-shared claims using VeroQ Shield.

WHEN TO USE: When an agent needs to know what people are saying about a topic AND whether those claims are true.
RETURNS: Top posts ranked by engagement, each with claim-level verification.
COST: 1 X API search + N VeroQ Shield calls (one per verified post).`,
  {
    topic: z.string().describe("Topic to search for on X"),
    verify_top: z.number().min(1).max(5).default(3).describe("Number of top posts to verify (by engagement)"),
  },
  async ({ topic, verify_top }) => {
    const posts = await searchXPosts(topic, 50);
    if (posts.length === 0) return text(`No recent X posts found for "${topic}".`);

    // Sort by engagement, take top N
    const topPosts = [...posts]
      .sort((a, b) => (b.public_metrics?.like_count || 0) - (a.public_metrics?.like_count || 0))
      .slice(0, verify_top);

    const lines: string[] = [
      `## Verified Trending: "${topic}"`,
      `**Searched:** ${posts.length} posts | **Verifying top:** ${topPosts.length}`,
      "",
    ];

    // Verify each top post in parallel
    const verifications = await Promise.all(
      topPosts.map(async (post) => {
        if (post.text.length < 20) return { post, shield: null };
        try {
          const shield = await veroqApi("POST", "/api/v1/verify/output", undefined, {
            text: post.text,
            source: `x.com/${post.author_username || post.author_id}`,
            max_claims: 3,
          });
          return { post, shield };
        } catch {
          return { post, shield: null };
        }
      }),
    );

    for (const { post, shield } of verifications) {
      const likes = post.public_metrics?.like_count || 0;
      const views = post.public_metrics?.impression_count || 0;
      lines.push(`### @${post.author_username || "?"} (${likes} likes, ${views.toLocaleString()} views)`);
      lines.push(`> ${post.text}`);
      lines.push("");

      if (!shield) {
        lines.push("*Could not verify (text too short or API error)*");
      } else {
        const claims = (shield.claims || []) as Array<Record<string, unknown>>;
        if (claims.length === 0) {
          lines.push("*No verifiable factual claims found*");
        } else {
          lines.push(`**Trust Score:** ${shield.trust_score} | **Verdict:** ${shield.overall_verdict}`);
          for (const c of claims) {
            const icon = c.verdict === "supported" ? "+" : c.verdict === "contradicted" ? "x" : "?";
            lines.push(`  [${icon}] ${c.text} — ${c.verdict} (${Math.round((c.confidence as number) * 100)}%)`);
            if (c.correction) lines.push(`      Correction: ${c.correction}`);
          }
        }
      }
      lines.push("");
    }

    // Quick sentiment of all posts
    const sentiments = posts.map((p) => analyzeSentiment(p.text));
    const agg = aggregateSentiment(sentiments);
    lines.push(`### Social Sentiment (${posts.length} posts)`);
    lines.push(`**Overall:** ${agg.label} (${agg.avg_score}) | ${agg.distribution.positive}+ ${agg.distribution.negative}- ${agg.distribution.neutral}~ ${agg.distribution.mixed}m`);

    return text(lines.join("\n"));
  },
);

// ── Tool 4: Entity pulse — full intel ──

server.tool(
  "x_entity_pulse",
  `Full intelligence on an entity: X social sentiment + VeroQ news sentiment + latest briefs + trending co-mentions.

WHEN TO USE: When an agent needs comprehensive real-time intelligence on a company, person, or topic.
RETURNS: Social sentiment, news sentiment, sentiment alignment/divergence, latest verified news, relationships.
COST: 1 X API search + 3 VeroQ API calls.`,
  {
    entity: z.string().describe("Entity name (e.g. 'NVIDIA', 'OpenAI', 'Bitcoin')"),
    period: z.enum(["7d", "30d", "90d"]).default("7d").describe("Sentiment lookback period"),
  },
  async ({ entity, period }) => {
    // Run all API calls in parallel
    const [xPosts, veroqSentiment, veroqBriefs, veroqRelationships] = await Promise.all([
      searchXPosts(entity, 50).catch(() => [] as XPost[]),
      veroqApi("GET", `/api/v1/entities/${encodeURIComponent(entity)}/sentiment`, { period }).catch(() => null),
      veroqApi("GET", `/api/v1/entities/${encodeURIComponent(entity)}/briefs`, { limit: 5 }).catch(() => null),
      veroqApi("GET", `/api/v1/entities/${encodeURIComponent(entity)}/relationships`).catch(() => null),
    ]);

    const lines: string[] = [`## Entity Pulse: ${entity}`, ""];

    // X Social Sentiment
    if (xPosts.length > 0) {
      const sentiments = xPosts.map((p) => analyzeSentiment(p.text));
      const agg = aggregateSentiment(sentiments);
      lines.push("### X Social Sentiment (real-time)");
      lines.push(`**Posts:** ${xPosts.length} | **Sentiment:** ${agg.label} (${agg.avg_score})`);
      lines.push(`**Distribution:** ${agg.distribution.positive}+ ${agg.distribution.negative}- ${agg.distribution.neutral}~ ${agg.distribution.mixed}m`);
      if (agg.top_signals.positive.length) lines.push(`**Bullish:** ${agg.top_signals.positive.join(", ")}`);
      if (agg.top_signals.negative.length) lines.push(`**Bearish:** ${agg.top_signals.negative.join(", ")}`);

      // Most-liked post
      const topPost = [...xPosts].sort((a, b) => (b.public_metrics?.like_count || 0) - (a.public_metrics?.like_count || 0))[0];
      if (topPost) {
        lines.push(`**Top post:** @${topPost.author_username}: "${topPost.text.slice(0, 120)}..." (${topPost.public_metrics?.like_count || 0} likes)`);
      }
      lines.push("");
    } else {
      lines.push("### X Social: No recent posts found\n");
    }

    // VeroQ News Sentiment
    if (veroqSentiment?.status === "ok") {
      const overall = veroqSentiment.overall as Record<string, number>;
      const trend = veroqSentiment.sentiment_trend as string;
      lines.push(`### News Sentiment (${period})`);
      lines.push(`**Trend:** ${trend}`);
      lines.push(`**Coverage:** ${overall?.total || 0} articles — ${overall?.positive || 0} positive, ${overall?.negative || 0} negative, ${overall?.neutral || 0} neutral`);

      // Alignment check
      if (xPosts.length > 0) {
        const xAgg = aggregateSentiment(xPosts.map((p) => analyzeSentiment(p.text)));
        const xLabel = xAgg.label;
        const newsLabel = trend === "improving" ? "positive" : trend === "declining" ? "negative" : "neutral";
        if (xLabel !== newsLabel) {
          lines.push(`**DIVERGENCE:** X social is ${xLabel}, news is ${newsLabel} — possible leading indicator`);
        } else {
          lines.push(`**Aligned:** Social and news sentiment both ${xLabel}`);
        }
      }
      lines.push("");
    }

    // Latest Briefs
    if (veroqBriefs?.status === "ok") {
      const briefs = (veroqBriefs.briefs || []) as Array<Record<string, unknown>>;
      if (briefs.length > 0) {
        lines.push("### Latest Verified News");
        for (const b of briefs.slice(0, 5)) {
          const conf = b.confidence_score ? ` (${Math.round((b.confidence_score as number) * 100)}% confidence)` : "";
          lines.push(`- ${b.headline}${conf}`);
        }
        lines.push("");
      }
    }

    // Relationships
    if (veroqRelationships?.status === "ok") {
      const rels = (veroqRelationships.relationships || []) as Array<Record<string, unknown>>;
      if (rels.length > 0) {
        lines.push("### Related Entities");
        for (const r of rels.slice(0, 8)) {
          const sent = r.avg_sentiment as number;
          const sentLabel = sent > 0.3 ? "positive" : sent < -0.3 ? "negative" : "neutral";
          lines.push(`- **${r.entity}** — ${r.co_occurrences} co-mentions, sentiment: ${sentLabel}`);
        }
        lines.push("");
      }
    }

    return text(lines.join("\n"));
  },
);

// ── Tool 5: Search X with verification ──

server.tool(
  "x_search_verified",
  `Search X posts matching a query and verify the most-engaged post's claims via VeroQ Shield.

WHEN TO USE: When an agent needs to find and validate information from X before using it.
RETURNS: Search results with the top post's claims verified.
COST: 1 X API search + 1 VeroQ Shield call.`,
  {
    query: z.string().describe("X search query (supports X search operators)"),
    max_results: z.number().min(10).max(100).default(20).describe("Number of posts to search"),
    verify_top: z.boolean().default(true).describe("Verify claims in the most-engaged post"),
  },
  async ({ query, max_results, verify_top }) => {
    const posts = await searchXPosts(query, max_results);
    if (posts.length === 0) return text(`No posts found for "${query}".`);

    const sorted = [...posts].sort(
      (a, b) => (b.public_metrics?.like_count || 0) - (a.public_metrics?.like_count || 0),
    );

    const lines: string[] = [
      `## X Search: "${query}"`,
      `**Results:** ${posts.length} posts`,
      "",
    ];

    // Show top 10
    for (const p of sorted.slice(0, 10)) {
      const likes = p.public_metrics?.like_count || 0;
      const sentiment = analyzeSentiment(p.text);
      const icon = sentiment.label === "positive" ? "+" : sentiment.label === "negative" ? "-" : "~";
      lines.push(`[${icon}] @${p.author_username || "?"} (${likes} likes): ${p.text.slice(0, 150)}${p.text.length > 150 ? "..." : ""}`);
    }
    lines.push("");

    // Verify top post
    if (verify_top && sorted[0] && sorted[0].text.length >= 20) {
      const topPost = sorted[0];
      try {
        const shield = await veroqApi("POST", "/api/v1/verify/output", undefined, {
          text: topPost.text,
          source: `x.com/${topPost.author_username || topPost.author_id}`,
          max_claims: 3,
        });
        lines.push(`### Verification: @${topPost.author_username}'s top post`);
        lines.push(`**Trust Score:** ${shield.trust_score} | **Verdict:** ${shield.overall_verdict}`);
        const claims = (shield.claims || []) as Array<Record<string, unknown>>;
        for (const c of claims) {
          const icon = c.verdict === "supported" ? "+" : c.verdict === "contradicted" ? "x" : "?";
          lines.push(`  [${icon}] ${c.text} — ${c.verdict}`);
          if (c.correction) lines.push(`      Correction: ${c.correction}`);
        }
      } catch {
        lines.push("*Verification failed*");
      }
    }

    // Quick sentiment
    const agg = aggregateSentiment(posts.map((p) => analyzeSentiment(p.text)));
    lines.push("");
    lines.push(`**Social Sentiment:** ${agg.label} (${agg.avg_score}) | ${agg.distribution.positive}+ ${agg.distribution.negative}- ${agg.distribution.neutral}~`);

    return text(lines.join("\n"));
  },
);

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("VeroQ × X Bridge MCP server running (stdio)");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
