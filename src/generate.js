#!/usr/bin/env node
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

// ── Config ────────────────────────────────────────────────────────────────────
const APIFY_TOKEN       = process.env.APIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const KEYWORDS          = (process.env.KEYWORDS || '').split(',').map(k => k.trim()).filter(Boolean);
const ARTICLE_STYLE     = (process.env.ARTICLE_STYLE || 'listicle').toLowerCase();
const TWEETS_PER_KW     = parseInt(process.env.TWEETS_PER_KEYWORD || '30', 10);
const OUTPUT_DIR        = path.resolve(ROOT_DIR, process.env.OUTPUT_DIR || 'output');

const APIFY_ACTOR_ID    = 'kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest';
const APIFY_RUN_URL     = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items`;

const DRY_RUN = process.argv.includes('--dry-run');

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function validateEnv() {
  const missing = [];
  if (!APIFY_TOKEN)       missing.push('APIFY_TOKEN');
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (KEYWORDS.length === 0) missing.push('KEYWORDS');
  if (!['listicle', 'explainer'].includes(ARTICLE_STYLE)) {
    console.error(`ARTICLE_STYLE must be "listicle" or "explainer", got: "${ARTICLE_STYLE}"`);
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ── Apify: fetch tweets ───────────────────────────────────────────────────────
async function fetchTweets(keyword) {
  console.log(`  Fetching ${TWEETS_PER_KW} tweets for: "${keyword}" …`);

  const url = `${APIFY_RUN_URL}?token=${APIFY_TOKEN}&timeout=120&memory=256`;

  const input = {
    searchTerms: [keyword],
    maxItems: TWEETS_PER_KW,
    queryType: 'Top',
    lang: 'en',
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Apify request failed [${res.status}]: ${body.slice(0, 300)}`);
  }

  const data = await res.json();

  if (!Array.isArray(data) || data.length === 0) {
    console.warn(`  No tweets returned for "${keyword}"`);
    return [];
  }

  console.log(`  Got ${data.length} tweets`);
  return data;
}

// ── Summarise tweets for Claude prompt ───────────────────────────────────────
function buildTweetSummaries(tweets) {
  return tweets
    .map((t, i) => {
      const text    = (t.text || t.full_text || t.tweet_text || '').replace(/\s+/g, ' ').trim();
      const author  = t.author?.userName || t.user?.screen_name || t.username || 'unknown';
      const likes   = t.likeCount   ?? t.favorite_count ?? 0;
      const rts     = t.retweetCount ?? t.retweet_count  ?? 0;
      const replies = t.replyCount  ?? t.reply_count     ?? 0;
      const engagement = likes + rts * 2 + replies;
      return { index: i + 1, author, text, engagement, likes, rts, replies };
    })
    .sort((a, b) => b.engagement - a.engagement)
    .map(t => `[${t.index}] @${t.author} (👍${t.likes} 🔁${t.rts} 💬${t.replies}): ${t.text}`)
    .join('\n');
}

// ── Claude: generate article ──────────────────────────────────────────────────
async function generateArticle(client, keyword, tweetSummaries) {
  const isListicle = ARTICLE_STYLE === 'listicle';

  const styleGuide = isListicle
    ? `Write a listicle-style article (600–900 words). Use a catchy H1 title, then 7–10 numbered sections each with a bold subheading. Be punchy and direct.`
    : `Write an explainer-style article (700–1000 words). Use a compelling H1 title followed by flowing paragraphs with H2 subheadings. Build a coherent argument or narrative.`;

  const systemPrompt = `You are a sharp, opinionated tech journalist who synthesises social media signals into insightful long-form articles. Your writing is clear, direct, and never dull. You never quote tweets verbatim — instead you paraphrase, synthesise, and interpret the underlying ideas and sentiment. You write in clean Markdown.`;

  const userPrompt = `KEYWORD: ${keyword}
STYLE: ${ARTICLE_STYLE}

Here are the top tweets by engagement on this topic:

${tweetSummaries}

---

${styleGuide}

Requirements:
- Synthesise the ideas and sentiment from the tweets above — do NOT quote any tweet verbatim
- Opinionated, confident voice; take positions, don't just describe
- Clean Markdown formatting (H1 title, H2/bold subheadings, short paragraphs)
- End the article with a final line formatted exactly as:
  **SEO keywords:** ${keyword}, [3–5 related keyword phrases separated by commas]

Write the complete article now.`;

  console.log(`  Calling Claude (${ARTICLE_STYLE}) …`);

  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1800,
    system: [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      { role: 'user', content: userPrompt },
    ],
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected response type from Claude');
  return content.text;
}

// ── Save article to disk ──────────────────────────────────────────────────────
async function saveArticle(keyword, articleMarkdown) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const filename = `${todayStamp()}-${slugify(keyword)}.md`;
  const filepath = path.join(OUTPUT_DIR, filename);
  await fs.writeFile(filepath, articleMarkdown, 'utf8');
  console.log(`  Saved → ${path.relative(ROOT_DIR, filepath)}`);
  return filename;
}

// ── Write run log ─────────────────────────────────────────────────────────────
async function writeRunLog(log) {
  const logPath = path.join(ROOT_DIR, 'run-log.json');
  let existing = [];
  try {
    const raw = await fs.readFile(logPath, 'utf8');
    existing = JSON.parse(raw);
    if (!Array.isArray(existing)) existing = [existing];
  } catch {
    // no prior log
  }
  existing.push(log);
  await fs.writeFile(logPath, JSON.stringify(existing, null, 2), 'utf8');
  console.log(`\nRun log updated → run-log.json`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== trend-writer ===');

  if (DRY_RUN) {
    console.log('\n[DRY RUN] — no API calls will be made\n');
    console.log(`Keywords  : ${KEYWORDS.join(', ') || '(none set)'}`);
    console.log(`Style     : ${ARTICLE_STYLE}`);
    console.log(`Tweets/kw : ${TWEETS_PER_KW}`);
    console.log(`Output dir: ${OUTPUT_DIR}`);
    console.log(`\nWould process ${KEYWORDS.length} keyword(s):`);
    for (const kw of KEYWORDS) {
      console.log(`  • "${kw}"`);
      console.log(`    1. POST ${APIFY_RUN_URL} → fetch ${TWEETS_PER_KW} tweets`);
      console.log(`    2. Claude claude-opus-4-5 → ${ARTICLE_STYLE} article`);
      console.log(`    3. Save → ${OUTPUT_DIR}/${todayStamp()}-${slugify(kw)}.md`);
    }
    console.log('\n[DRY RUN] Done.');
    return;
  }

  validateEnv();

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const runLog = {
    runAt: new Date().toISOString(),
    style: ARTICLE_STYLE,
    keywords: KEYWORDS,
    results: [],
  };

  for (let i = 0; i < KEYWORDS.length; i++) {
    const keyword = KEYWORDS[i];
    console.log(`\n[${i + 1}/${KEYWORDS.length}] Keyword: "${keyword}"`);

    const result = { keyword, status: 'error', file: null, error: null };

    try {
      const tweets = await fetchTweets(keyword);

      if (tweets.length === 0) {
        result.error = 'No tweets returned';
        runLog.results.push(result);
        continue;
      }

      const summaries = buildTweetSummaries(tweets);
      const article   = await generateArticle(client, keyword, summaries);
      const filename  = await saveArticle(keyword, article);

      result.status = 'ok';
      result.file   = filename;
      result.tweetCount = tweets.length;
    } catch (err) {
      console.error(`  Error processing "${keyword}": ${err.message}`);
      result.error = err.message;
    }

    runLog.results.push(result);

    // 2s delay between keywords (skip after last)
    if (i < KEYWORDS.length - 1) {
      console.log('  Waiting 2s before next keyword…');
      await sleep(2000);
    }
  }

  await writeRunLog(runLog);

  const ok    = runLog.results.filter(r => r.status === 'ok').length;
  const total = runLog.results.length;
  console.log(`\n=== Done: ${ok}/${total} articles generated ===`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
