/* trend-writer frontend */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    articles:     [],
    selectedId:   null,
    selectedFull: null,
    pollingJobId: null,
    pollTimer:    null,
  };

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const app          = $('app');
  const articleList  = $('article-list');
  const emptyState   = $('empty-state');
  const articleView  = $('article-view');
  const articleHero  = $('article-hero');
  const articleMeta  = $('article-meta');
  const articleBody  = $('article-body');
  const generateBtn  = $('generate-btn');
  const generateLbl  = $('generate-label');
  const genBanner    = $('generating-banner');
  const genText      = $('generating-text');
  const copyBtn      = $('copy-btn');
  const postedBtn    = $('posted-btn');
  const notifBtn     = $('notif-btn');
  const backBtn      = $('back-btn');

  // ── Keyword colours ────────────────────────────────────────────────────────
  const KW_COLORS = {
    'claude':          { bg: '#EEEAFF', text: '#5B47F5' },
    'ai':              { bg: '#E0F2FE', text: '#0369A1' },
    'product design':  { bg: '#FFF3E0', text: '#C2410C' },
  };

  function kwStyle(keyword) {
    return KW_COLORS[(keyword || '').toLowerCase()] || { bg: '#F3F4F6', text: '#4B5563' };
  }

  // ── Formatters ─────────────────────────────────────────────────────────────
  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString('en-SG', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  }

  // ── Article list ───────────────────────────────────────────────────────────
  async function loadArticles() {
    try {
      const res = await fetch('/api/articles');
      state.articles = await res.json();
      renderList();
    } catch (e) {
      console.error('Failed to load articles:', e);
    }
  }

  function renderList() {
    if (!state.articles.length) {
      articleList.innerHTML = '<div class="empty-list">No articles yet.<br>Click <strong>Generate</strong> to create your first ones.</div>';
      return;
    }
    articleList.innerHTML = state.articles.map(a => {
      const c = kwStyle(a.keyword);
      return `
        <div class="article-card${a.id === state.selectedId ? ' active' : ''}"
             data-id="${a.id}"
             role="button"
             tabindex="0"
             aria-label="${a.title}">
          <div class="card-top">
            <span class="kw-badge" style="background:${c.bg};color:${c.text}">${a.keyword}</span>
            ${a.isPosted ? '<span class="posted-check">✓ Posted</span>' : ''}
          </div>
          <div class="card-title">${escapeHtml(a.title)}</div>
          <div class="card-preview">${escapeHtml(a.preview)}</div>
          <div class="card-footer">${fmtDate(a.generatedAt)}</div>
        </div>`;
    }).join('');
    // No per-card listeners — event delegation handles clicks (see bottom of file)
  }

  // ── Article detail ─────────────────────────────────────────────────────────
  async function selectArticle(id) {
    state.selectedId = id;

    // Update active class directly — no full re-render
    articleList.querySelectorAll('.article-card').forEach(el => {
      el.classList.toggle('active', el.dataset.id === id);
    });

    // Mobile: slide to detail
    app.classList.add('article-open');

    // Show loading placeholder
    emptyState.hidden = true;
    articleView.hidden = false;
    articleHero.hidden = true;
    articleMeta.innerHTML = '<span style="color:var(--text-faint)">Loading…</span>';
    articleBody.innerHTML = '';

    // Fetch full article
    try {
      const res = await fetch(`/api/articles/${id}`);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const article = await res.json();
      state.selectedFull = article;
      renderDetail(article);
    } catch (e) {
      articleMeta.innerHTML = `<span style="color:red">Failed to load article: ${e.message}</span>`;
      console.error('selectArticle error:', e);
    }
  }

  function renderDetail(article) {
    // Hero image
    if (article.imageUrl) {
      articleHero.hidden = false;
      const photographer = article.imagePhotographer
        ? `<a href="${article.imagePhotographerUrl || '#'}" class="image-credit" target="_blank" rel="noopener">📷 ${article.imagePhotographer} / Unsplash</a>`
        : '';
      articleHero.innerHTML = `
        <img src="${article.imageUrl}" alt="${escapeHtml(article.imageAlt || article.keyword)}" loading="lazy">
        <a href="/api/articles/${article.id}/download-image" class="image-download" download title="Download image">
          ↓ Download
        </a>
        ${photographer}`;
    } else {
      articleHero.hidden = true;
    }

    // Meta row
    const c = kwStyle(article.keyword);
    articleMeta.innerHTML = `
      <span class="kw-badge" style="background:${c.bg};color:${c.text}">${article.keyword}</span>
      <span class="meta-sep">·</span>
      <span>${fmtDate(article.generatedAt)}</span>
      ${article.isPosted ? '<span class="posted-pill">Posted ✓</span>' : ''}`;

    // Rendered markdown
    articleBody.innerHTML = marked.parse(article.markdown || '');

    // Action buttons
    updatePostedBtn(article.isPosted);
    postedBtn.onclick = () => togglePosted(article);
    copyBtn.onclick   = () => copyArticle(article.markdown || '');
  }

  function updatePostedBtn(isPosted) {
    postedBtn.textContent = isPosted ? '✓ Posted' : 'Mark as posted';
    postedBtn.className   = `btn ${isPosted ? 'btn-success' : 'btn-outline'}`;
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function togglePosted(article) {
    const next = !article.isPosted;
    try {
      await fetch(`/api/articles/${article.id}/posted`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPosted: next }),
      });
      article.isPosted = next;
      // Update list item
      const listItem = state.articles.find(a => a.id === article.id);
      if (listItem) listItem.isPosted = next;
      renderList();
      updatePostedBtn(next);
      // Refresh meta row
      if (state.selectedFull?.id === article.id) renderDetail(article);
    } catch (e) {
      console.error('Failed to update posted status:', e);
    }
  }

  async function copyArticle(markdown) {
    try {
      const html = marked.parse(markdown);
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html':  new Blob([html],     { type: 'text/html' }),
          'text/plain': new Blob([markdown], { type: 'text/plain' }),
        }),
      ]);
    } catch {
      // Fallback for browsers without ClipboardItem
      try {
        await navigator.clipboard.writeText(markdown);
      } catch {
        // Final fallback
        const ta = document.createElement('textarea');
        ta.value = markdown;
        ta.style.position = 'fixed';
        ta.style.opacity  = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
    }
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy article'; }, 2000);
  }

  // ── Generation ─────────────────────────────────────────────────────────────
  async function triggerGenerate() {
    if (generateBtn.disabled) return;

    generateBtn.disabled = true;
    generateLbl.textContent = 'Starting…';

    let res;
    try {
      res = await fetch('/api/generate', { method: 'POST' });
    } catch {
      generateBtn.disabled = false;
      generateLbl.textContent = 'Generate';
      return;
    }

    const data = await res.json();

    if (res.status === 409) {
      // Already running — attach to existing job
      startPolling(data.jobId);
      return;
    }

    startPolling(data.jobId);
  }

  function startPolling(jobId) {
    state.pollingJobId = jobId;
    genBanner.hidden   = false;
    generateBtn.disabled = true;
    generateLbl.textContent = 'Generating…';

    let delay = 3000;

    const poll = async () => {
      try {
        const res  = await fetch(`/api/generate/status/${jobId}`);
        const job  = await res.json();

        if (job.progress?.currentKeyword) {
          genText.textContent = `Generating ${job.progress.current}/${job.progress.total}: "${job.progress.currentKeyword}"…`;
        }

        if (job.status === 'done' || job.status === 'error') {
          stopPolling();
          await loadArticles();
          return;
        }

        // Back-off: 3s → 3s → 5s → 5s → 10s cap
        if (delay < 10000) delay = Math.min(delay + 2000, 10000);
        state.pollTimer = setTimeout(poll, delay);
      } catch {
        state.pollTimer = setTimeout(poll, delay);
      }
    };

    state.pollTimer = setTimeout(poll, delay);

    // Safety timeout: 10 minutes
    setTimeout(stopPolling, 10 * 60 * 1000);
  }

  function stopPolling() {
    clearTimeout(state.pollTimer);
    state.pollingJobId    = null;
    genBanner.hidden      = true;
    genText.textContent   = 'Generating articles…';
    generateBtn.disabled  = false;
    generateLbl.textContent = 'Generate';
  }

  // ── Mobile navigation ──────────────────────────────────────────────────────
  function goBack() {
    app.classList.remove('article-open');
    state.selectedId   = null;
    state.selectedFull = null;
    renderList();
    emptyState.hidden  = false;
    articleView.hidden = true;
  }

  // ── Push notifications ─────────────────────────────────────────────────────
  async function setupPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      alert('Push notifications are not supported in this browser.\nTry Safari or Chrome on iOS 16.4+.');
      return;
    }
    if (Notification.permission === 'denied') {
      alert('Notifications are blocked. Please allow them in your browser settings.');
      return;
    }

    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        alert('Push notifications are already enabled!');
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;

      const keyRes = await fetch('/api/push/vapid-public-key');
      const { publicKey } = await keyRes.json();

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub),
      });

      notifBtn.style.color = '#5B47F5';
      alert('Push notifications enabled! 🔔\n\nOn iOS: add this site to your Home Screen for the best experience.');
    } catch (e) {
      console.error('Push setup failed:', e);
    }
  }

  function urlBase64ToUint8Array(b64) {
    const padding = '='.repeat((4 - b64.length % 4) % 4);
    const base64  = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw     = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  // ── Refresh on tab focus ───────────────────────────────────────────────────
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadArticles();
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Event listeners ────────────────────────────────────────────────────────
  generateBtn.addEventListener('click', triggerGenerate);
  backBtn.addEventListener('click', goBack);
  notifBtn.addEventListener('click', setupPush);

  // Single delegated listener on the list container — survives innerHTML rebuilds
  articleList.addEventListener('click', e => {
    const card = e.target.closest('.article-card');
    if (card) selectArticle(card.dataset.id);
  });
  articleList.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const card = e.target.closest('.article-card');
      if (card) selectArticle(card.dataset.id);
    }
  });

  // ── Init ───────────────────────────────────────────────────────────────────
  marked.setOptions({ breaks: true, gfm: true });

  // Register service worker silently
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    // Auto-resubscribe if permission already granted
    if (Notification.permission === 'granted') {
      navigator.serviceWorker.ready.then(async reg => {
        const existing = await reg.pushManager.getSubscription();
        if (!existing) return;
        // Re-POST to ensure server has it (handles page reloads)
        fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(existing),
        }).catch(() => {});
      });
    }
  }

  // Deep-link from push notification
  const params = new URLSearchParams(window.location.search);
  const targetId = params.get('article');

  loadArticles().then(() => {
    if (targetId) selectArticle(targetId);
  });

})();
