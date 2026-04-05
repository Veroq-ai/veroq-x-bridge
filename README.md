# @veroq/x-bridge

MCP server that bridges X (Twitter) real-time social data with VeroQ Shield verification and entity sentiment.

**Your AI agent can now fact-check X posts and gauge social sentiment — in one tool call.**

## Tools

| Tool | What it does | Cost |
|------|-------------|------|
| `x_verify_post` | Verify claims in a specific X post via Shield | 1 X + 1 VeroQ |
| `x_topic_sentiment` | Social sentiment from X + VeroQ news sentiment | 1 X + 1 VeroQ |
| `x_verify_trending` | Fact-check the most-shared posts on any topic | 1 X + N VeroQ |
| `x_entity_pulse` | Full intel: X social + news + briefs + relationships | 1 X + 3 VeroQ |
| `x_search_verified` | Search X with auto-verification of top result | 1 X + 1 VeroQ |

## Quick Start

```bash
npm install @veroq/x-bridge
```

```bash
export VEROQ_API_KEY=your_key     # https://veroq.ai/settings
export X_BEARER_TOKEN=your_token  # https://developer.x.com
npx veroq-x-bridge
```

## Use with Claude Desktop

```json
{
  "mcpServers": {
    "veroq-x-bridge": {
      "command": "npx",
      "args": ["@veroq/x-bridge"],
      "env": {
        "VEROQ_API_KEY": "your_key",
        "X_BEARER_TOKEN": "your_token"
      }
    }
  }
}
```

## Examples

### Verify a post

> "Verify this post: https://x.com/elonmusk/status/123456789"

Returns claim-level verdicts: which statements are supported, contradicted, or unverifiable — with evidence.

### Social sentiment

> "What's the social sentiment around NVIDIA right now?"

Returns X social sentiment (positive/negative/neutral distribution, bullish/bearish signals) cross-referenced with VeroQ news sentiment. Flags divergence between social and news.

### Fact-check trending posts

> "What are people saying about the Fed rate decision? Are they right?"

Searches X, ranks by engagement, verifies the top posts' claims via Shield. Separates fact from noise.

### Full entity pulse

> "Give me the full picture on Bitcoin"

Combines: X social sentiment + VeroQ news sentiment trend + latest verified briefs + entity relationships. Flags social/news divergence as a potential leading indicator.

## How Sentiment Works

**X Social Sentiment** — lightweight keyword-based analysis (zero API cost). Runs on every post, aggregates into distribution + top bullish/bearish signals.

**VeroQ News Sentiment** — entity-level sentiment extracted from verified news briefs. 7d/30d/90d lookback with trend direction.

**Divergence Detection** — when X social says "bullish" but news says "declining", the bridge flags it. Social often leads news by 12-48 hours.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VEROQ_API_KEY` | Yes | VeroQ API key |
| `X_BEARER_TOKEN` | Yes | X API bearer token |
| `VEROQ_BASE_URL` | No | Override VeroQ API URL (default: `https://api.veroq.ai`) |

## License

MIT
