/**
 * background.js — Event Page for Badge Updates
 *
 * Firefox event page (non-persistent background script) for Tab Out.
 * Its only job: keep the toolbar badge showing the current open tab count.
 *
 * Uses the Firefox-native `browser.*` API throughout.
 *
 * The badge counts real web tabs (skipping about:, moz-extension://,
 * and other internal pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not about:, not moz-extension://, not other internal pages.
 */
async function updateBadge() {
  try {
    const tabs = await browser.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('about:') &&
        !url.startsWith('moz-extension://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await browser.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await browser.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    browser.action.setBadgeText({ text: '' });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
browser.runtime.onInstalled.addListener(() => {
  updateBadge();
});

// Update badge when browser starts up (supported in Firefox event pages)
browser.runtime.onStartup.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is opened
browser.tabs.onCreated.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is closed
browser.tabs.onRemoved.addListener(() => {
  updateBadge();
});

// Update badge when a tab's URL changes (e.g. navigating to/from about: pages)
browser.tabs.onUpdated.addListener(() => {
  updateBadge();
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the event page first loads
updateBadge();
