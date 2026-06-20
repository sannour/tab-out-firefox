/* ================================================================
   Tab Out — Dashboard App (Firefox Edition)

   This file is the brain of the dashboard. Since the dashboard
   IS the extension's new tab page, it can call browser.tabs and
   browser.storage directly — no postMessage bridge needed.

   Uses the Firefox-native `browser.*` API throughout.

   What this file does:
   1. Reads open browser tabs directly via browser.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in browser.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   THEME — dark/light toggle, persisted in browser.storage.local
   ---------------------------------------------------------------- */

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const label = document.getElementById('themeLabel');
  if (label) label.textContent = theme === 'dark' ? 'Light' : 'Dark';
  // Toggle which icon is visible
  document.querySelectorAll('.theme-icon').forEach(el => el.style.display = 'none');
  const showIcon = document.querySelector(`.theme-icon-${theme === 'dark' ? 'light' : 'dark'}`);
  if (showIcon) showIcon.style.display = '';
}

async function loadTheme() {
  try {
    const { theme } = await browser.storage.local.get('theme');
    applyTheme(theme || 'dark');
  } catch {
    applyTheme('dark');
  }
}

async function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { await browser.storage.local.set({ theme: next }); } catch {}
}

// Load persisted theme (async — updates after first render)
loadTheme();

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('themeToggle');
  if (btn) btn.addEventListener('click', toggleTheme);
});


/* ----------------------------------------------------------------
   BROWSER TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to browser.tabs and browser.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Firefox.
 * Uses browser.runtime.getURL() to detect Tab Out's own pages
 * (which will be moz-extension://... URLs in Firefox).
 */
async function fetchOpenTabs() {
  try {
    const newtabUrl = browser.runtime.getURL('index.html');

    const tabs = await browser.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'about:newtab',
    }));
  } catch {
    // browser.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await browser.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await browser.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await browser.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await browser.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Firefox to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await browser.tabs.query({});
  const currentWindow = await browser.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await browser.tabs.update(match.id, { active: true });
  await browser.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await browser.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await browser.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const newtabUrl = browser.runtime.getURL('index.html');

  const allTabs = await browser.tabs.query({});
  const currentWindow = await browser.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'about:newtab'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await browser.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — browser.storage.local

   Uses Firefox's built-in key-value storage. Data persists across
   browser sessions and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in browser.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await browser.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await browser.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from browser.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await browser.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await browser.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await browser.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await browser.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await browser.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 *
 * Note: The first call creates and primes the AudioContext (Firefox
 * autoplay policy), so the very first close may be silent. All
 * subsequent closes play sound normally.
 */
let swooshCtx = null;

function playCloseSound() {
  try {
    if (!swooshCtx) {
      swooshCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (swooshCtx.state === 'suspended') {
      swooshCtx.resume();
    }

    const ctx = swooshCtx;
    const t = ctx.currentTime + 0.02;
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
/* ----------------------------------------------------------------
   CONFETTI ELEMENT POOL

   Pre-allocates confetti DOM elements so bursts don't pay the cost
   of createElement + appendChild. Idle elements sit in a hidden
   container with display: none. On burst, they're pulled out,
   positioned, and animated. After animation, they're reset and
   returned to the pool.
   ---------------------------------------------------------------- */

const CONFETTI_COLORS = [
  '#c8713a', // amber
  '#e8a070', // amber light
  '#5a7a62', // sage
  '#8aaa92', // sage light
  '#5a6b7a', // slate
  '#8a9baa', // slate light
  '#d4b896', // warm paper
  '#b35a5a', // rose
];

const CONFETTI_PARTICLE_COUNT = 8;
const CONFETTI_POOL_SIZE = 128;

// Pool of pre-created confetti DOM elements
let confettiPool = null;

// Hidden container that holds pool elements when not in use
let confettiPoolContainer = null;

/**
 * ensureConfettiPool()
 *
 * Lazy-initializes the confetti element pool. Called on first burst.
 * Creates all elements once and stores them in a hidden container.
 */
function ensureConfettiPool() {
  if (confettiPool) return;

  confettiPool = [];

  // Hidden container — keeps pooled elements out of layout
  confettiPoolContainer = document.createElement('div');
  confettiPoolContainer.style.cssText = 'display:none;position:fixed;left:-9999px;top:-9999px;';
  document.body.appendChild(confettiPoolContainer);

  // Pre-compute the base styles that all confetti particles share
  const baseStyle = [
    'position: fixed',
    'pointer-events: none',
    'z-index: 9999',
    'will-change: transform, opacity',
    'transform: translateZ(0)',
    'opacity: 1',
  ].join(';');

  for (let i = 0; i < CONFETTI_POOL_SIZE; i++) {
    const el = document.createElement('div');
    el.style.cssText = baseStyle;
    confettiPoolContainer.appendChild(el);
    confettiPool.push(el);
  }
}

/**
 * acquireConfettiParticles(x, y)
 *
 * Takes CONFETTI_PARTICLE_COUNT elements from the pool, positions them
 * at (x, y) with random sizes/colors/shapes, appends them to body,
 * and returns particle state objects for animation.
 */
function acquireConfettiParticles(x, y) {
  ensureConfettiPool();

  const particles = [];
  const count = Math.min(CONFETTI_PARTICLE_COUNT, confettiPool.length);

  // Batch: grab all elements first, then append in one go
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < count; i++) {
    const el = confettiPool.pop();

    const size = 5 + Math.random() * 6;
    const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    const isCircle = Math.random() > 0.5;

    // Only override per-burst styles — base styles are already set
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.background = color;
    el.style.borderRadius = isCircle ? '50%' : '2px';
    el.style.transform = 'translateZ(0)';
    el.style.opacity = '1';

    fragment.appendChild(el);

    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 120;

    particles.push({
      el,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 80,
      rotateSpeed: isCircle ? 0 : 100 + Math.random() * 200,
      rotation: 0,
    });
  }

  // Single append — one layout operation
  document.body.appendChild(fragment);

  return particles;
}

/**
 * releaseConfettiParticles(particles)
 *
 * Resets and returns confetti elements to the hidden pool container.
 */
function releaseConfettiParticles(particles) {
  for (const p of particles) {
    p.el.remove();
    p.el.style.transform = 'translateZ(0)';
    p.el.style.opacity = '1';
    confettiPool.push(p.el);
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of confetti particles from the given coordinates.
 * Returns a Promise that resolves when the confetti animation finishes.
 * Uses the element pool — no createElement/appendChild during bursts.
 */
function shootConfetti(x, y) {
  return new Promise((resolve) => {
    // Acquire particles from pre-allocated pool (no DOM creation)
    const particles = acquireConfettiParticles(x, y);

    const startTime = performance.now();
    const duration = 700 + Math.random() * 200; // 700–900ms
    const gravity = 600;

    function frame(now) {
      const elapsed = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) {
        releaseConfettiParticles(particles);
        resolve();
        return;
      }

      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;

      for (const p of particles) {
        const px = p.vx * elapsed;
        const py = p.vy * elapsed + 0.5 * gravity * elapsed * elapsed;
        p.rotation += p.rotateSpeed * elapsed;

        p.el.style.transform = `translate3d(${px}px, ${py}px, 0) rotate(${p.rotation}deg)`;
        p.el.style.opacity = opacity;
      }

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  });
}

/**
 * animateCardOut(card)
 *
 * Immediately removes the card from the DOM, but keeps a zero-size
 * placeholder in its place so CSS columns don't reflow the remaining
 * cards during the confetti animation. After confetti finishes, the
 * placeholder is removed and columns reflow once.
 */
async function animateCardOut(card) {
  if (!card) return;

  // Save dimensions BEFORE any DOM changes
  const rect = card.getBoundingClientRect();

  // Keep the card in the DOM with visibility: hidden — this preserves its
  // layout space in CSS columns AND avoids triggering ContentWillBeRemoved
  // (which would cause a 200-300ms style flush during the animation).
  // The card is visually gone but its space stays occupied.
  card.style.visibility = 'hidden';
  card.style.pointerEvents = 'none';

  // Start confetti and wait for it to finish
  await shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  // Confetti is done — now safe to remove from DOM (triggers style flush,
  // but no animation running to compete with it)
  card.remove();
  checkAndShowEmptyState();
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  // Clone the empty state template — no innerHTML
  const emptyState = createFromTemplate('tmpl-empty-state');
  missionsEl.appendChild(emptyState);

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   TEMPLATE CLONING HELPER

   Clones an HTML <template> element and returns the root node.
   Templates are parsed once by the browser (at page load), so
   cloning avoids innerHTML's string parsing on every render.
   ---------------------------------------------------------------- */

function createFromTemplate(id) {
  const tpl = document.getElementById(id);
  if (!tpl) {
    console.warn('[tab-out] Template not found:', id);
    return null;
  }
  return tpl.content.firstElementChild.cloneNode(true);
}

/**
 * createCloseIcon()
 *
 * Builds an SVG close icon element via DOM (no innerHTML).
 */
function createCloseIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke', 'currentColor');
  svg.style.cssText = 'width:12px;height:12px;';
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('d', 'M6 18 18 6M6 6l12 12');
  svg.appendChild(path);
  return svg;
}




/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * isInternalUrl(url)
 *
 * Returns true if the URL is a browser-internal page that should be
 * excluded from the tab dashboard.
 */
function isInternalUrl(url) {
  if (!url) return true;
  const internalSchemes = [
    'about:',
    'moz-extension://',
  ];
  return internalSchemes.some(s => url.startsWith(s));
}

function getRealTabs() {
  return openTabs.filter(t => !isInternalUrl(t.url));
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

/* ----------------------------------------------------------------
   CHIP CREATOR (from template)
   ---------------------------------------------------------------- */

/**
 * createChip(tab, groupDomain)
 *
 * Clones the chip template and fills in tab data.
 * Returns a DOM element (the chip).
 */
function createChip(tab, groupDomain) {
  let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), groupDomain || '');
  try {
    const parsed = new URL(tab.url);
    if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
  } catch {}

  const safeUrl   = tab.url || '';
  const safeTitle = label;
  const chip = createFromTemplate('tmpl-page-chip');

  // Set dynamic attributes
  chip.setAttribute('data-tab-url', safeUrl);
  chip.title = safeTitle;

  // Favicon
  let domain = '';
  try { domain = new URL(tab.url).hostname; } catch {}
  const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
  const faviconImg = chip.querySelector('.chip-favicon');
  if (faviconUrl) {
    faviconImg.src = faviconUrl;
  } else {
    faviconImg.style.display = 'none';
  }

  // Text
  chip.querySelector('.chip-text').textContent = label;

  // Buttons
  const saveBtn = chip.querySelector('.chip-save');
  saveBtn.setAttribute('data-tab-url', safeUrl);
  saveBtn.setAttribute('data-tab-title', safeTitle);

  const closeBtn = chip.querySelector('.chip-close');
  closeBtn.setAttribute('data-tab-url', safeUrl);

  return chip;
}

/**
 * markDupeChip(chip, count)
 *
 * Adds dupe styling and badge to a chip element.
 */
function markDupeChip(chip, count) {
  const dupeBadge = chip.querySelector('.chip-dupe-badge');
  if (dupeBadge) {
    dupeBadge.textContent = `(${count}x)`;
    dupeBadge.style.display = 'inline';
  }
  chip.classList.add('chip-has-dupes');
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS
   ---------------------------------------------------------------- */

/**
 * buildOverflowChips(hiddenTabs, urlCounts)
 *
 * Creates hidden overflow chips and a "+N more" indicator.
 * Returns a DocumentFragment containing both.
 */
function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const frag = document.createDocumentFragment();

  // Overflow container (hidden by default)
  const container = createFromTemplate('tmpl-overflow-container');

  for (const tab of hiddenTabs) {
    const chip = createChip(tab, '');
    const count = urlCounts[tab.url] || 1;
    if (count > 1) markDupeChip(chip, count);
    container.appendChild(chip);
  }

  frag.appendChild(container);

  // "+N more" indicator
  const moreChip = createFromTemplate('tmpl-overflow-chip');
  moreChip.querySelector('.chip-text').textContent = `+${hiddenTabs.length} more`;
  frag.appendChild(moreChip);

  return frag;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER (from template)
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group)
 *
 * Clones the domain card template, fills in group data and chips.
 * Returns a DOM element (the card).
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  // Deduplicate for display
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  // Clone the card template
  const card = createFromTemplate('tmpl-domain-card');
  card.setAttribute('data-domain-id', stableId);
  if (hasDupes) {
    card.classList.remove('has-neutral-bar');
    card.classList.add('has-amber-bar');
  }

  // Domain name
  card.querySelector('.mission-name').textContent =
    isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain));

  // Tab count badge
  card.querySelector('.tab-badge-count').textContent =
    `${tabCount} tab${tabCount !== 1 ? 's' : ''} open`;

  // Dupe badge
  if (hasDupes) {
    const dupeBadge = card.querySelector('.dupe-badge');
    dupeBadge.textContent = `${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}`;
    dupeBadge.style.display = 'inline';
    dupeBadge.style.cssText += ';color:var(--accent-amber);background:rgba(200,113,58,0.08);';
    dupeBadge.classList.add('open-tabs-badge');
  }

  // Page count (mission-meta)
  card.querySelector('.mission-page-count').textContent = String(tabCount);

  // Build and append chips
  const pagesEl = card.querySelector('.mission-pages');
  const frag = document.createDocumentFragment();

  for (const tab of visibleTabs) {
    const chip = createChip(tab, group.domain);
    const count = urlCounts[tab.url];
    if (count > 1) markDupeChip(chip, count);
    frag.appendChild(chip);
  }

  if (extraCount > 0) {
    const overflowFrag = buildOverflowChips(uniqueTabs.slice(8), urlCounts);
    // Append overflow children to fragment
    while (overflowFrag.firstChild) {
      frag.appendChild(overflowFrag.firstChild);
    }
  }

  pagesEl.appendChild(frag);

  // Actions
  const actionsEl = card.querySelector('.actions');
  const closeBtn = actionsEl.querySelector('.close-tabs');
  closeBtn.setAttribute('data-domain-id', stableId);
  closeBtn.querySelector('.close-all-text').textContent =
    `Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}`;

  if (hasDupes) {
    const dedupBtn = actionsEl.querySelector('.dedup-btn');
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    dedupBtn.textContent = `Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}`;
    dedupBtn.setAttribute('data-dupe-urls', dupeUrlsEncoded);
    dedupBtn.style.display = '';
  }

  return card;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from browser.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.textContent = '';
      for (const item of active) {
        list.appendChild(renderDeferredItem(item));
      }
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.textContent = '';
      for (const item of archived) {
        archiveList.appendChild(renderArchiveItem(item));
      }
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Creates one active checklist item (checkbox, title, domain, time, dismiss)
 * from the template. Returns a DOM element.
 */
function renderDeferredItem(item) {
  const el = createFromTemplate('tmpl-deferred-item');
  el.setAttribute('data-deferred-id', item.id);

  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const ago = timeAgo(item.savedAt);

  // Checkbox
  el.querySelector('.deferred-checkbox').setAttribute('data-deferred-id', item.id);

  // Title link
  const link = el.querySelector('.deferred-title');
  link.href = item.url;
  link.title = item.title || item.url;
  link.querySelector('.deferred-title-text').textContent = item.title || item.url;

  // Favicon
  const favicon = el.querySelector('.deferred-favicon');
  if (domain) {
    favicon.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  } else {
    favicon.style.display = 'none';
  }

  // Meta
  el.querySelector('.deferred-domain').textContent = domain;
  el.querySelector('.deferred-time').textContent = ago;

  // Dismiss
  el.querySelector('.deferred-dismiss').setAttribute('data-deferred-id', item.id);

  return el;
}

/**
 * renderArchiveItem(item)
 *
 * Creates one archived item (title + date) from template.
 * Returns a DOM element.
 */
function renderArchiveItem(item) {
  const el = createFromTemplate('tmpl-archive-item');
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);

  const link = el.querySelector('.archive-item-title');
  link.href = item.url;
  link.title = item.title || item.url;
  link.textContent = item.title || item.url;

  el.querySelector('.archive-item-date').textContent = ago;

  return el;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via browser.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';

    // Build section count with inline button (minimal DOM) — avoids innerHTML
    openTabsSectionCount.textContent = '';
    const domainText = document.createTextNode(
      `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''}  ·  `
    );
    openTabsSectionCount.appendChild(domainText);

    const closeAllBtn = document.createElement('button');
    closeAllBtn.className = 'action-btn close-tabs';
    closeAllBtn.setAttribute('data-action', 'close-all-open-tabs');
    closeAllBtn.style.cssText = 'font-size:11px;padding:3px 10px;';
    closeAllBtn.appendChild(createCloseIcon());
    closeAllBtn.appendChild(document.createTextNode(` Close all ${realTabs.length} tabs`));
    openTabsSectionCount.appendChild(closeAllBtn);

    // Build domain cards from template — no innerHTML
    openTabsMissionsEl.textContent = '';
    const frag = document.createDocumentFragment();
    for (const g of domainGroups) {
      frag.appendChild(renderDomainCard(g));
    }
    openTabsMissionsEl.appendChild(frag);

    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  try {
    await renderStaticDashboard();
  } catch (e) {
    console.error('[tab-out] Render failed:', e);
  }
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    playCloseSound();

    // Grab chip reference IMMEDIATELY — before any async operations
    const chip = actionEl.closest('.page-chip');
    if (!chip) return;

    const card = chip.closest('.mission-card');
    const wasLastChip = card ? card.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 1 : false;
    const rect = chip.getBoundingClientRect();

    // Remove chip immediately — instant visual feedback
    chip.remove();

    // If this was the last chip, hide the card instead of removing it
    if (wasLastChip && card) {
      card.style.visibility = 'hidden';
      card.style.pointerEvents = 'none';
    }

    // Close the tab in parallel with confetti
    const closePromise = browser.tabs.query({}).then(allTabs => {
      const match = allTabs.find(t => t.url === tabUrl);
      if (match) return browser.tabs.remove(match.id);
    }).then(() => fetchOpenTabs()).catch(() => {});

    // Fire confetti
    await shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

    // Confetti done — now safe to remove card from DOM
    if (wasLastChip && card) {
      card.remove();
      checkAndShowEmptyState();
    }

    // Wait for tab closure too
    await closePromise;

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to browser.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Firefox
    const allTabs = await browser.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await browser.tabs.remove(match.id);
    await fetchOpenTabs();

    // Remove chip immediately — no CSS transition, no layout reflow
    const chip = actionEl.closest('.page-chip');
    if (chip) chip.remove();

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));

    // Start animation IMMEDIATELY
    if (card) {
      playCloseSound();
    }
    const animPromise = card ? animateCardOut(card) : Promise.resolve();

    // Remove from in-memory groups immediately
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    // Start tab closure in parallel with animation
    const useExact = group.domain === '__landing-pages__' || !!group.label;
    const closePromise = useExact ? closeTabsExact(urls) : closeTabsByUrls(urls);

    // Wait for both animation and tab closure before showing toast
    await Promise.all([animPromise, closePromise]);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('about:') && !t.url.startsWith('moz-extension://'))
      .map(t => t.url);

    // Start all card animations IMMEDIATELY
    playCloseSound();
    const animPromises = [];
    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      animPromises.push(animateCardOut(c));
    });

    // Close tabs in parallel with animation
    const closePromise = closeTabsByUrls(allUrls);

    // Wait for both animation and tab closure before showing toast
    await Promise.all([...animPromises, closePromise]);

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    archiveList.textContent = '';

    let items;
    if (q.length < 2) {
      items = archived;
    } else {
      items = archived.filter(item =>
        (item.title || '').toLowerCase().includes(q) ||
        (item.url  || '').toLowerCase().includes(q)
      );
    }

    if (items.length === 0) {
      const msg = document.createElement('div');
      msg.style.cssText = 'font-size:12px;color:var(--muted);padding:8px 0';
      msg.textContent = 'No results';
      archiveList.appendChild(msg);
    } else {
      for (const item of items) {
        archiveList.appendChild(renderArchiveItem(item));
      }
    }
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
