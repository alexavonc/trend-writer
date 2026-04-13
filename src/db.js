import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

const ARTICLES_FILE      = path.join(DATA_DIR, 'articles.json');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const VAPID_FILE         = path.join(DATA_DIR, 'vapid-keys.json');

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJSON(file, data) {
  await ensureDir();
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

// ── Articles ──────────────────────────────────────────────────────────────────

export async function readArticles() {
  return readJSON(ARTICLES_FILE, []);
}

export async function getArticle(id) {
  const articles = await readArticles();
  return articles.find(a => a.id === id) ?? null;
}

export async function addArticle(article) {
  const articles = await readArticles();
  articles.unshift(article);
  await writeJSON(ARTICLES_FILE, articles);
  return article;
}

export async function updateArticle(id, patch) {
  const articles = await readArticles();
  const idx = articles.findIndex(a => a.id === id);
  if (idx < 0) return null;
  articles[idx] = { ...articles[idx], ...patch };
  await writeJSON(ARTICLES_FILE, articles);
  return articles[idx];
}

// ── Push subscriptions ────────────────────────────────────────────────────────

export async function readSubscriptions() {
  return readJSON(SUBSCRIPTIONS_FILE, []);
}

export async function addSubscription(sub) {
  const subs = await readSubscriptions();
  const idx = subs.findIndex(s => s.endpoint === sub.endpoint);
  if (idx < 0) subs.push(sub);
  else subs[idx] = sub;
  await writeJSON(SUBSCRIPTIONS_FILE, subs);
}

export async function removeSubscription(endpoint) {
  const subs = await readSubscriptions();
  await writeJSON(SUBSCRIPTIONS_FILE, subs.filter(s => s.endpoint !== endpoint));
}

// ── VAPID keys ────────────────────────────────────────────────────────────────

export async function readVapidKeys() {
  return readJSON(VAPID_FILE, null);
}

export async function writeVapidKeys(keys) {
  await writeJSON(VAPID_FILE, keys);
}
