# Tab Out

**Keep tabs on your tabs.**

Tab Out is a Firefox extension that replaces your new tab page with a dashboard of everything you have open. Tabs are grouped by domain, with homepages (Gmail, X, LinkedIn, etc.) pulled into their own group. Close tabs with a satisfying swoosh + confetti.

No server. No account. No external API calls. Just a Firefox extension built with `browser.*` API.

---

## Features

- **See all your tabs at a glance** on a clean grid, grouped by domain
- **Homepages group** pulls Gmail inbox, X home, YouTube, LinkedIn, GitHub homepages into one card
- **Close tabs with style** with swoosh sound + confetti burst
- **Duplicate detection** flags when you have the same page open twice, with one-click cleanup
- **Click any tab to jump to it** across windows, no new tab opened
- **Save for later** bookmark tabs to a checklist before closing them
- **Localhost grouping** shows port numbers next to each tab so you can tell your projects apart
- **Expandable groups** show the first 8 tabs with a clickable "+N more"
- **100% local** your data never leaves your machine
- **Pure Firefox extension** no server, no Node.js, no npm, no setup beyond loading the extension

---

## Manual Setup

**1. Clone the repo**

```bash
git clone https://github.com/zarazhangrui/tab-out.git
```

**2. Load the Firefox extension**

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`
2. Click **"Load Temporary Add-on…"**
3. Navigate to the `extension/` folder and select `manifest.json`
4. Click **Open**

**3. Open a new tab**

You'll see Tab Out.

---

## How it works

```
You open a new tab
  -> Tab Out shows your open tabs grouped by domain
  -> Homepages (Gmail, X, etc.) get their own group at the top
  -> Click any tab title to jump to it
  -> Close groups you're done with (swoosh + confetti)
  -> Save tabs for later before closing them
```

Everything runs inside the Firefox extension. No external server, no API calls, no data sent anywhere. Saved tabs are stored in `browser.storage.local`.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Firefox Manifest V3 (event page background) |
| API | `browser.*` (Firefox native, not Chrome shim) |
| Storage | browser.storage.local |
| Sound | Web Audio API (synthesized, no files) |
| Confetti | DOM element pool with `translate3d` GPU compositing |
| Animations | `requestAnimationFrame` + `will-change` GPU hints |

---

## Performance notes

Tab Out was tuned with Firefox Profiler to eliminate jank during close/confetti animations:

- **Element pool**: 128 pre-allocated confetti DOM elements — no `createElement` during bursts
- **`visibility: hidden`** instead of `card.remove()` during animation — avoids `nsCSSFrameConstructor::ContentWillBeRemoved` cascade (was causing 250ms style flushes)
- **Immediate animation**: card hides and confetti fires before `browser.tabs.remove()` — no async delay
- **Single RAF loop**: all 8 confetti particles updated in one `requestAnimationFrame` call per frame
- **No CSS transitions on chips**: chip removed instantly, confetti is the visual feedback
- **No SVG noise filter**: replaced with lightweight CSS gradients (original `feTurbulence` caused full-page CPU repaints)
- **`will-change` GPU hints**: on mission cards, toast, and confetti particles for compositor-only rendering

---

## License

MIT

---

Built by [Zara](https://x.com/zarazhangrui)
