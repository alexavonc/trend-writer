# trend-writer

A Node.js CLI that turns trending tweets into polished long-form articles — automatically.

**Flow:** keywords → top tweets (Apify) → Claude article generation → dated Markdown files

---

## Quick start

```bash
cp .env.example .env
# Fill in APIFY_TOKEN, ANTHROPIC_API_KEY, KEYWORDS, etc.

npm install
npm start
```

### Dry-run (no API calls)

```bash
node src/generate.js --dry-run
# or
npm run dry-run
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `APIFY_TOKEN` | Yes | — | Apify API token |
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `KEYWORDS` | Yes | — | Comma-separated topics, e.g. `AI agents,open source LLMs` |
| `ARTICLE_STYLE` | No | `listicle` | `listicle` (600–900 words) or `explainer` (700–1000 words) |
| `TWEETS_PER_KEYWORD` | No | `30` | Tweets to fetch per keyword |
| `OUTPUT_DIR` | No | `output` | Directory for generated `.md` files |

---

## Output

Articles are saved as `./output/YYYY-MM-DD-{slug}.md`.

A `run-log.json` is updated after each run with status, file names, and error details.

---

## Article style

| Style | Format | Word count |
|---|---|---|
| `listicle` | H1 + 7–10 numbered sections with bold subheadings | 600–900 words |
| `explainer` | H1 + flowing paragraphs with H2 subheadings | 700–1000 words |

Both styles:
- Synthesise/paraphrase tweets — no verbatim quotes
- Opinionated, confident voice
- SEO keywords line at the bottom

---

## Scheduled runs (Railway)

`railway.toml` is configured for **Wednesday 9 AM SGT** (`0 1 * * 3` UTC).

1. Create a new Railway project and link this repo
2. Set all env vars in Railway's variable panel
3. Deploy — Railway will run on schedule automatically

---

## Apify actor

Uses [`kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest`](https://apify.com/kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest) via the run-sync API. Tweets are sorted by engagement (likes + 2×retweets + replies) before being fed to Claude.
