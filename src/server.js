import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import webpush from 'web-push';
import * as db from './db.js';
import { generateArticleForKeyword, sleep } from './generate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = path.resolve(__dirname, '..');

const PORT     = process.env.PORT || 3000;
const KEYWORDS = (process.env.KEYWORDS || 'Claude,AI,Product Design')
  .split(',').map(k => k.trim()).filter(Boolean);

// ── In-memory job store ───────────────────────────────────────────────────────
const jobs = new Map(); // jobId → JobState

function makeJob() {
  const id = crypto.randomUUID();
  jobs.set(id, {
    id,
    status: 'running',
    progress: { current: 0, total: KEYWORDS.length, currentKeyword: null },
    results: [],
    startedAt: new Date().toISOString(),
  });
  return id;
}

// ── VAPID init ────────────────────────────────────────────────────────────────
async function initVapid() {
  let keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    keys = await db.readVapidKeys();
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      await db.writeVapidKeys(keys);
      console.log('\nVAPID keys generated → data/vapid-keys.json');
      console.log('Add these to env vars to persist across redeploys:');
      console.log(`  VAPID_PUBLIC_KEY=${keys.publicKey}`);
      console.log(`  VAPID_PRIVATE_KEY=${keys.privateKey}\n`);
    }
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:hello@adora.so',
    keys.publicKey,
    keys.privateKey,
  );
  return keys;
}

// ── Unsplash image fetch ──────────────────────────────────────────────────────
async function fetchUnsplashImage(keyword, title) {
  if (!process.env.UNSPLASH_ACCESS_KEY) return {};
  try {
    const query = encodeURIComponent(`${title || keyword} technology`);
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${query}&per_page=1&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` } },
    );
    if (!res.ok) return {};
    const data = await res.json();
    if (!data.results?.length) return {};
    const p = data.results[0];
    return {
      imageUrl:             p.urls.regular,
      imageFullUrl:         p.urls.full,
      imageAlt:             p.alt_description || keyword,
      imageUnsplashId:      p.id,
      imageDownloadLocation: p.links.download_location,
      imagePhotographer:    p.user.name,
      imagePhotographerUrl: p.user.links.html,
    };
  } catch {
    return {};
  }
}

// ── Push notifications ────────────────────────────────────────────────────────
async function sendPushNotifications(results) {
  const subs = await db.readSubscriptions();
  if (!subs.length) return;

  const ok = results.filter(r => r.articleId);
  if (!ok.length) return;

  const body = ok.map(r => r.title).join(', ');
  const payload = JSON.stringify({
    title: `${ok.length} new article${ok.length > 1 ? 's' : ''} ready`,
    body,
    url: '/',
  });

  await Promise.allSettled(
    subs.map(async sub => {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await db.removeSubscription(sub.endpoint);
        }
      }
    }),
  );
}

// ── Generation job ────────────────────────────────────────────────────────────
async function runGeneration(jobId) {
  const job = jobs.get(jobId);
  try {
    for (let i = 0; i < KEYWORDS.length; i++) {
      const keyword = KEYWORDS[i];
      job.progress = { current: i + 1, total: KEYWORDS.length, currentKeyword: keyword };

      try {
        console.log(`  [${i + 1}/${KEYWORDS.length}] Generating "${keyword}"…`);
        const { markdown, title, seoKeywords, tweetCount } = await generateArticleForKeyword(keyword);
        const imageData = await fetchUnsplashImage(keyword, title);

        const article = await db.addArticle({
          id:          crypto.randomUUID(),
          keyword,
          title,
          markdown,
          seoKeywords,
          tweetCount,
          ...imageData,
          isPosted:    false,
          generatedAt: new Date().toISOString(),
        });

        job.results.push({ keyword, articleId: article.id, title });
        console.log(`  ✓ "${keyword}" → ${title}`);
      } catch (err) {
        console.error(`  ✗ "${keyword}": ${err.message}`);
        job.results.push({ keyword, error: err.message });
      }

      if (i < KEYWORDS.length - 1) await sleep(2000);
    }
  } finally {
    job.status = 'done';
    await sendPushNotifications(job.results);
    // Clean up job state after 5 minutes
    setTimeout(() => jobs.delete(jobId), 5 * 60 * 1000);
    console.log(`Generation job ${jobId} complete.\n`);
  }
}

// ── Preview helper ────────────────────────────────────────────────────────────
function getPreview(markdown) {
  return markdown
    .replace(/^#+\s+.+$/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 160);
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, 'public')));

// Articles list (no full markdown)
app.get('/api/articles', async (req, res) => {
  const articles = await db.readArticles();
  res.json(articles.map(a => ({
    id:          a.id,
    keyword:     a.keyword,
    title:       a.title,
    preview:     getPreview(a.markdown || ''),
    imageUrl:    a.imageUrl || null,
    imageAlt:    a.imageAlt || null,
    isPosted:    a.isPosted,
    generatedAt: a.generatedAt,
  })));
});

// Single article (full markdown)
app.get('/api/articles/:id', async (req, res) => {
  const article = await db.getArticle(req.params.id);
  if (!article) return res.status(404).json({ error: 'Not found' });
  res.json(article);
});

// Toggle posted status
app.patch('/api/articles/:id/posted', async (req, res) => {
  const { isPosted } = req.body;
  const article = await db.updateArticle(req.params.id, { isPosted });
  if (!article) return res.status(404).json({ error: 'Not found' });
  res.json(article);
});

// Trigger generation
app.post('/api/generate', (req, res) => {
  const running = [...jobs.values()].find(j => j.status === 'running');
  if (running) {
    return res.status(409).json({ error: 'Generation already in progress', jobId: running.id });
  }
  const jobId = makeJob();
  res.status(202).json({ jobId });
  runGeneration(jobId).catch(err => {
    const job = jobs.get(jobId);
    if (job) { job.status = 'error'; job.error = err.message; }
    console.error('Generation failed:', err.message);
  });
});

// Job status (for polling)
app.get('/api/generate/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// Image download (pings Unsplash ToS endpoint then redirects)
app.get('/api/articles/:id/download-image', async (req, res) => {
  const article = await db.getArticle(req.params.id);
  if (!article?.imageUrl) return res.status(404).json({ error: 'No image' });
  if (article.imageDownloadLocation && process.env.UNSPLASH_ACCESS_KEY) {
    fetch(`${article.imageDownloadLocation}?client_id=${process.env.UNSPLASH_ACCESS_KEY}`)
      .catch(() => {});
  }
  res.redirect(article.imageFullUrl || article.imageUrl);
});

// Push: VAPID public key
app.get('/api/push/vapid-public-key', async (req, res) => {
  const keys = await db.readVapidKeys();
  const publicKey = process.env.VAPID_PUBLIC_KEY || keys?.publicKey;
  res.json({ publicKey });
});

// Push: subscribe
app.post('/api/push/subscribe', async (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  await db.addSubscription(sub);
  res.status(201).json({ ok: true });
});

// Push: unsubscribe
app.delete('/api/push/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) await db.removeSubscription(endpoint);
  res.json({ ok: true });
});

// SPA catch-all
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await initVapid();

  // Cron: Wednesday 01:00 UTC = Wednesday 09:00 SGT
  cron.schedule('0 1 * * 3', () => {
    console.log(`\n[cron] Starting weekly generation — ${new Date().toISOString()}`);
    const jobId = makeJob();
    runGeneration(jobId).catch(console.error);
  });
  console.log('Cron scheduled: Wed 01:00 UTC (09:00 SGT)');

  app.listen(PORT, () => {
    console.log(`trend-writer → http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
