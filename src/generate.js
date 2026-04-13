#!/usr/bin/env node
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT_DIR   = path.resolve(__dirname, '..');

// ── Config (read once at module load) ─────────────────────────────────────────
const APIFY_TOKEN       = process.env.APIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TWEETS_PER_KW     = parseInt(process.env.TWEETS_PER_KEYWORD || '30', 10);
const ARTICLE_STYLE     = (process.env.ARTICLE_STYLE || 'listicle').toLowerCase();
const OUTPUT_DIR        = path.resolve(ROOT_DIR, process.env.OUTPUT_DIR || 'output');

const APIFY_ACTOR_ID = 'kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest';
const APIFY_RUN_URL  = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items`;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function extractTitle(markdown) {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : 'Untitled';
}

function extractSeoKeywords(markdown) {
  const m = markdown.match(/\*\*SEO keywords:\*\*\s*(.+)$/im);
  if (!m) return [];
  return m[1].split(',').map(k => k.trim()).filter(Boolean);
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

// ── Apify: fetch tweets ───────────────────────────────────────────────────────

export async function fetchTweets(keyword) {
  const url = `${APIFY_RUN_URL}?token=${APIFY_TOKEN}&timeout=120&memory=256`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      searchTerms: [keyword],
      maxItems: TWEETS_PER_KW,
      queryType: 'Top',
      lang: 'en',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Apify [${res.status}]: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ── Tweet summariser ──────────────────────────────────────────────────────────

export function buildTweetSummaries(tweets) {
  return tweets
    .map((t, i) => {
      const text    = (t.text || t.full_text || t.tweet_text || '').replace(/\s+/g, ' ').trim();
      const author  = t.author?.userName || t.user?.screen_name || t.username || 'unknown';
      const likes   = t.likeCount   ?? t.favorite_count ?? 0;
      const rts     = t.retweetCount ?? t.retweet_count  ?? 0;
      const replies = t.replyCount  ?? t.reply_count     ?? 0;
      return { i: i + 1, author, text, score: likes + rts * 2 + replies, likes, rts, replies };
    })
    .sort((a, b) => b.score - a.score)
    .map(t => `[${t.i}] @${t.author} (👍${t.likes} 🔁${t.rts} 💬${t.replies}): ${t.text}`)
    .join('\n');
}

// ── Claude: generate article content ─────────────────────────────────────────

export async function generateArticleContent(keyword, tweetSummaries, style = ARTICLE_STYLE) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const isListicle = style === 'listicle';

  const styleGuide = isListicle
    ? `Write a listicle (600–900 words). H1 title + 7–10 numbered points each with a bold subheading. Punchy, scannable, direct.`
    : `Write an explainer (700–1000 words). H1 title + flowing paragraphs with H2 subheadings. Build a clear, coherent narrative.`;

  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1800,
    system: [
      {
        type: 'text',
        text: `You are a sharp writer for designers and product people who want to stay on top of AI without wading through hype. Your tone is knowledgeable but casual — like a senior product designer explaining complex AI updates to a smart friend who isn't deep in tech. You never quote tweets verbatim; you paraphrase, synthesise, and draw your own conclusions. You write clean Markdown only.`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `KEYWORD: ${keyword}
STYLE: ${style}

Top tweets by engagement:

${tweetSummaries}

---

${styleGuide}

Requirements:
- Synthesise ideas from the tweets — no verbatim quotes
- Casual but confident voice; take positions, explain jargon plainly
- Clean Markdown (H1 title, H2/bold subheadings, short paragraphs)
- End with exactly: **SEO keywords:** ${keyword}, [3–5 related keyword phrases]

Write the complete article now.`,
      },
    ],
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');
  return content.text;
}

// ── Core export: generate one article for a keyword ───────────────────────────

export async function generateArticleForKeyword(keyword) {
  console.log(`  Fetching tweets for "${keyword}"…`);
  const tweets = await fetchTweets(keyword);
  if (!tweets.length) throw new Error(`No tweets returned for "${keyword}"`);

  const summaries = buildTweetSummaries(tweets);

  console.log(`  Generating article with Claude…`);
  const markdown    = await generateArticleContent(keyword, summaries);
  const title       = extractTitle(markdown);
  const seoKeywords = extractSeoKeywords(markdown);
  const tweetCount  = tweets.length;

  return { keyword, markdown, title, seoKeywords, tweetCount };
}

// ── CLI (only runs when executed directly) ────────────────────────────────────

if (process.argv[1] === __filename) {
  const DRY_RUN  = process.argv.includes('--dry-run');
  const KEYWORDS = (process.env.KEYWORDS || '').split(',').map(k => k.trim()).filter(Boolean);

  if (DRY_RUN) {
    console.log('=== trend-writer (dry-run) ===\n');
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
    process.exit(0);
  }

  if (!APIFY_TOKEN || !ANTHROPIC_API_KEY || !KEYWORDS.length) {
    console.error('Missing required env vars: APIFY_TOKEN, ANTHROPIC_API_KEY, KEYWORDS');
    process.exit(1);
  }

  (async () => {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const runLog = { runAt: new Date().toISOString(), style: ARTICLE_STYLE, keywords: KEYWORDS, results: [] };

    for (let i = 0; i < KEYWORDS.length; i++) {
      const kw = KEYWORDS[i];
      console.log(`\n[${i + 1}/${KEYWORDS.length}] Keyword: "${kw}"`);
      try {
        const { markdown } = await generateArticleForKeyword(kw);
        const filename = `${todayStamp()}-${slugify(kw)}.md`;
        await fs.writeFile(path.join(OUTPUT_DIR, filename), markdown, 'utf8');
        console.log(`  Saved → output/${filename}`);
        runLog.results.push({ keyword: kw, status: 'ok', file: filename });
      } catch (err) {
        console.error(`  Error: ${err.message}`);
        runLog.results.push({ keyword: kw, status: 'error', error: err.message });
      }
      if (i < KEYWORDS.length - 1) {
        console.log('  Waiting 2s…');
        await sleep(2000);
      }
    }

    // Update run-log.json
    const logPath = path.join(ROOT_DIR, 'run-log.json');
    let existing = [];
    try { existing = JSON.parse(await fs.readFile(logPath, 'utf8')); } catch {}
    if (!Array.isArray(existing)) existing = [existing];
    existing.push(runLog);
    await fs.writeFile(logPath, JSON.stringify(existing, null, 2), 'utf8');
    console.log('\nRun log → run-log.json');
    console.log(`\n=== Done: ${runLog.results.filter(r => r.status === 'ok').length}/${KEYWORDS.length} articles generated ===`);
  })().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
