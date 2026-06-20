# AGENTS.md -- Tab Out: Setup & Onboarding Guide

You're installing **Tab Out** for Firefox. Your job is not just to set it up — it's to get them excited about using it.

---

## Step 0 -- Introduce the product

Before doing anything technical, tell the user what they're about to get:

> **Tab Out** replaces your new tab page with a clean dashboard of everything you have open, grouped by domain.
>
> Here's what makes it great:
> - **See all your open tabs at a glance** grouped by domain on a grid
> - **Homepages group** pulls Gmail, X, LinkedIn, YouTube, GitHub homepages into one card for easy cleanup
> - **Close tabs with style** satisfying swoosh sound + confetti burst
> - **Duplicate detection** flags when you have the same page open twice
> - **Click any tab title to jump to it** even across different Firefox windows
> - **Save for later** bookmark individual tabs to a checklist before closing them
> - **100% local** no server, no accounts, no data sent anywhere
>
> It's a Firefox extension built with `browser.*` API (not Chrome's `chrome.*` shim). Setup takes about 1 minute.

---

## Step 1 -- Clone the repo

```bash
git clone https://github.com/zarazhangrui/tab-out.git
cd tab-out
```

---

## Step 2 -- Install the Firefox extension

This is the one step that requires manual action from the user. Make it as easy as possible.

**First**, print the full path to the `extension/` folder:
```bash
echo "Extension folder: $(cd extension && pwd)"
```

**Then**, open Firefox's debugging page:
- macOS: `open "about:debugging#/runtime/this-firefox"`
- Linux: `xdg-open "about:debugging#/runtime/this-firefox"`
- Windows: Start Firefox and paste `about:debugging#/runtime/this-firefox` into the URL bar

**Then**, walk the user through it step by step:

> I've noted the extension folder path. Now:
>
> 1. In Firefox, you should see the **about:debugging** page with "This Firefox" selected in the left sidebar.
> 2. Under **"Temporary Extensions"**, click the **"Load Temporary Add-on…"** button.
> 3. A file picker will open. Navigate to the extension folder, select `manifest.json`, and click "Open".
> 4. Tab Out will appear in the list with its icon, name, and a "Reload" / "Remove" button.
>
> That's it! Open a new tab and you'll see Tab Out in action.

**Also**, open the file browser directly to the extension folder as a fallback:
- macOS: `open extension/`
- Linux: `xdg-open extension/`
- Windows: `explorer extension\\`

---

## Step 3 -- Show them around

Once the extension is loaded:

> You're all set! Open a **new tab** and you'll see Tab Out.
>
> Here's how it works:
> 1. **Your open tabs are grouped by domain** in a grid layout.
> 2. **Homepages** (Gmail inbox, X home, YouTube, etc.) are in their own group at the top.
> 3. **Click any tab title** to jump directly to that tab.
> 4. **Click the X** next to any tab to close just that one (with swoosh + confetti).
> 5. **Click "Close all N tabs"** on a group to close the whole thing.
> 6. **Duplicate tabs** are flagged with an amber "(2x)" badge. Click "Close duplicates" to keep one copy.
> 7. **Save a tab for later** by clicking the bookmark icon before closing it. Saved tabs appear in the sidebar.
>
> That's it! No server to run, no config files. Everything works right away.

---

## Key Facts

- Tab Out is a **pure Firefox extension** (Manifest V3, event page background, `browser.*` API). No server, no Node.js, no npm.
- Saved tabs are stored in `browser.storage.local` (persists across sessions).
- 100% local. No data is sent to any external service.
- Built with Firefox best practices (event-driven background page, not a service worker).
- To update: `cd tab-out && git pull`, then reload the extension in `about:debugging#/runtime/this-firefox`.
- For production deployment, submit to [Mozilla Add-ons (AMO)](https://addons.mozilla.org/). The `browser_specific_settings.gecko.id` is already set up.
