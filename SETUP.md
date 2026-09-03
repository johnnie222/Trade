# Setup

No install, no build, no dependencies. It is a static site plus a service worker.

**Requirement:** it must be served over HTTP. Opening `index.html` by double-clicking it will fail — ES modules and service workers both need a real origin. This is the one thing that trips people up.

---

## 1. Run it on your computer

Unzip, then from inside the folder pick whichever you have:

```bash
python3 -m http.server 8080          # macOS and Linux have this already
npx serve -l 8080                    # if you have Node
php -S localhost:8080                # if you have PHP
```

Open **http://localhost:8080**

`localhost` counts as a secure origin, so everything works there including the service worker and offline mode.

### Run the tests

Node 22 or newer:

```bash
npm test
```

195 tests, nothing to install first.

---

## 2. Put it on your phone

Your phone cannot use `localhost`, and serving over your LAN IP (`http://192.168.x.x`) will load the app but silently disable the service worker — browsers only grant that on a secure origin. It will work; it just will not install properly or run offline.

For a real install, host it. GitHub Pages is free and needs no configuration.

```bash
cd trade-journal
git init
git add .
git commit -m "Trade journal"
git branch -M main
git remote add origin git@github.com:YOUR_USERNAME/trade-journal.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → main → / (root) → Save.**

A minute later it is live at `https://YOUR_USERNAME.github.io/trade-journal/`.

**Make the repository private.** There is no reason for it to be public, and a private repo publishes to Pages the same way on any paid plan. On a free account Pages requires a public repo — if that applies to you, the code being public is harmless (there is no server, no key, no secret), and your journal is still only on your phone. Just confirm `.gitignore` is in place before the first commit; it already excludes every database, screenshot and export.

### Install it

Open the Pages URL in Chrome on Android → menu → **Add to Home screen**.

It then behaves like an app: its own icon, no browser chrome, works with no signal.

On iPhone: Safari → Share → **Add to Home Screen**.

---

## 3. First five minutes

1. **Settings → Account size.** Everything risk-related reads from this one number.
2. **Settings → Default risk per trade.** 1% is the default. It drives the suggested position size and is never enforced.
3. **Settings → Default stop rule.** Choose manual management or `1R→BE, 2R→1R, 3R→2R`. After a standard-plan trade reaches 3R, choose manual management or configure a percentage / dollar broker trail on that trade.
4. **Settings → Choose folder** (Chrome only). Backups then write there silently instead of landing in Downloads.
5. Add a trade. Ticker, entry, stop, shares — the risk, the R targets and the suggested size appear as you type.

---

## 4. Day to day

**Home** is the only screen you need most days. Tap **Update prices**. The app first tries public end-of-day feeds; any missing quotes open in a manual price sheet. The sheet keeps the values you typed while you switch to another app or reload. Every R figure, rule flag and risk total recompute from the saved prices.

**When a stop rule triggers**, Home shows what it says. Two buttons: raise, or skip. If you skip, it asks why once — that sentence is the single most useful thing in the weekly review, so it is worth answering honestly.

**Stats → Copy week** puts the whole week on your clipboard: the numbers, one line per trade, and every stop change and skipped rule with the reason you gave. Paste it into a chat with me and ask what it shows.

---

## 5. Your data

Everything lives in your browser's storage on that device. Nothing is uploaded anywhere.

A JSON snapshot is written automatically when either a day has passed or five events have been recorded. Seven are kept.

**That is not a substitute for keeping one somewhere else.** Browser storage can be cleared by you, wiped by a "clear site data", or evicted by the OS when the phone runs low. Every month or so, **Settings → Export JSON** and put the file somewhere that is backed up. It restores the entire journal on any device.

To move devices: Export JSON on the old one, then **Settings → Restore** on the new one. Choosing *merge* unions the two by event id and is safe to run twice. *Replace* wipes what is there first.

---

## 6. Updating

Edit the files, commit, push. Pages redeploys in about a minute.

The service worker caches aggressively, so bump the version in `sw.js` when you ship a change:

```js
const VERSION = 'tj-v1';   // -> 'tj-v2'
```

Old caches are deleted on activate, so a stale copy cannot survive.

---

## Troubleshooting

**Blank screen.** You opened the file directly instead of through a server. Check the address bar says `http://` or `https://`, not `file://`.

**Changes are not appearing.** The service worker is serving the old cache. Bump `VERSION` in `sw.js`, or in DevTools use Application → Service Workers → Unregister and reload.

**"Storage is unavailable" toast.** Private browsing, or storage is blocked for the site. Nothing will be saved in that session. Open it in a normal window.

**Prices show a dash.** No price has been entered for that ticker yet. Home → Update prices, or tap the price chip on the trade.

**Trade management stats say they need price history.** Correct — MFE, MAE, capture and round-trip detection all need daily bars, and Phase 1 has none. Everything based on your fills works; everything based on what the market offered does not.
