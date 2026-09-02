# Trade Journal

A local-first journal for long swing trades in US equities. R-denominated, event-sourced, no backend, no dependencies.

Full product spec: `spec.md` · Setup and deployment: `SETUP.md`

## Status

**Phase 1 complete.** A working PWA. Open `index.html` over HTTP and it installs.

- [x] Event log vocabulary
- [x] Projection engine — R, position, risk, stop history
- [x] Stop rules + counterfactual simulator
- [x] MFE / MAE / capture / round-trip detection
- [x] IndexedDB persistence + swappable storage adapter
- [x] Automatic backup, restore and merge
- [x] Statistics: dashboard, monthly/weekly rollups, breakdowns, comparison
- [x] All seven screens, PWA shell, offline service worker
- [x] Review export (Markdown), trades CSV, events CSV, JSON
- [ ] EOD market data provider (Phase 2)
- [ ] Screenshots and Android share target (Phase 2)
- [ ] Hebrew / RTL (Phase 2)

## Running it

Node 22+. Nothing to install, nothing to build.

```bash
npm test          # 195 tests
npm start         # serves on http://localhost:8080
```

It is a plain static site: any HTTP server works, and GitHub Pages needs no
configuration. Opening `index.html` from the filesystem will not work — ES
modules and service workers both require an origin.

195 tests, zero dependencies, no build step.

## The model

A trade is not a row that gets updated. It is an **append-only list of events**, and every number in the product is a pure projection of that list.

```js
import { open, add, trim, stopChange, close } from './src/core/events.js';
import { projectTrade, currentR, realizedR } from './src/core/engine.js';

const events = [
  open('2026-08-21T13:35:00Z', { price: 471, qty: 42, stop: 461 }),
  stopChange('2026-08-27T13:40:00Z', { to: 474, reason: 'structure' }),
  trim('2026-08-29T14:02:00Z', { price: 491, qty: 21 }),
  close('2026-09-02T19:55:00Z', { price: 486, reason: 'trailing stop' }),
];

const trade = projectTrade(events, { ticker: 'DELL' });
realizedR(trade); // 1.55
```

Consequences worth knowing:

- Fixing a formula fixes every historical trade on the next render. There is no stored calculated state to migrate.
- Replay is free — it's a different rendering of the same list.
- Cloud sync later is a merge of append-only events rather than a merge of mutable rows.

## The one invariant

```
R = (entryPrice − initialStop) × initialQty        [dollars, locked at open]
```

**R never changes.** Not on an add, not on a trim, not when the stop is raised, not across a split. It is the dollar amount originally put at risk, and holding it fixed is what makes a $40 stock and a $900 stock directly comparable.

The split case is the interesting one: a 2:1 split halves `riskPerShare` and doubles `initialQty`, so R comes out identical by construction. `engine.test.js` asserts this.

## Design decisions that are easy to get wrong

**Stop rule triggers use daily closes. MFE uses daily highs.** A wick to 2R that closes at 1.2R is not a 2R trade — triggering rules on highs makes every rule fire on noise. But MFE is asking a different question ("what was on the table"), so it correctly uses highs.

**MFE and MAE ignore adds and trims.** They are price ratios against the original entry. They measure what the trade *offered*, not what was *captured* — the gap between them is the whole point, and collapsing the two would erase it.

**Capture has a denominator floor.** A trade whose high was 0.1R above entry never offered anything to capture, and `realized / 0.1` yields numbers like −1000% that poison every average downstream. Below 0.25R, capture is reported as absent.

**The counterfactual checks the stop as it stood that morning.** Daily bars can't tell you whether a day's high or its low came first. Applying a close-triggered stop retroactively to the same day's low would invent exits that never happened.

**A gap through the stop exits at the open, not at the stop.** This is what makes the simulator honest about what stops actually cost.

**Widened stops are recorded, not rejected.** This is a journal. It records what the trader did, and a widened stop is among the more informative things to be able to count later.

**Events sort by `(at, seq)`, not by write order.** Backdating has to work — logging a trim you forgot on Tuesday must re-sort it into place so average cost and realized R recompute correctly. Sorting by insertion alone would pin it to the end and quietly produce wrong numbers.

**Every append is projected before it is written.** If the resulting log would throw, the write is rejected and storage is untouched. There is no code path that stores a trade the engine cannot read.

**Restore verifies before it reports success.** A corrupt backup is named, with the trade and the reason, rather than restored into a journal that throws when opened.

**Periods are grouped in market time, not device time.** A fill at 22:30 in Israel is 15:30 in New York on the *same* trading day. Grouping by the device's calendar files it under tomorrow and silently moves trades between weeks and months.

**Statistics return `null` where a number does not exist.** Profit factor in a period with no losers is not infinity, and a win rate over zero trades is not zero. Every empty case is `null` so the UI shows a dash instead of a fabricated figure.

**Win rate excludes scratches from the denominator.** A trade closed flat is neither a win nor a loss; counting it as a loss understates the hit rate of the decisions that actually resolved.

**Capture is reported two ways.** `mfeCaptured` is total realized over total available and is the number to quote. `avgTradeCapture` is the mean of per-trade ratios, where a trade offering 0.3R and returning 0.3R scores 100% and pulls the mean as hard as a 3R trade — a real divergence, so both are exposed rather than one being picked silently.

**Comparison arrows are withheld below five trades a side.** The delta is always reported; the claim that it means something is not.

**Prices are not events.** The log records decisions the trader made; a quote is an observation about the market. Mixing them would put a row in the trade timeline every time a price refreshed. Prices live in settings under `price:TICKER` and are replaced, never appended — which is also why swapping manual entry for an EOD feed in Phase 2 touches nothing else.

**`ACTIONS` and `LIVE` live in `registry.js`, a module with no imports.** `app.js` imports the screens and the screens need somewhere to register handlers; if that somewhere were `app.js`, the screen bodies would run during its import phase, before its `const` declarations initialise, and every screen would throw on load.

**`projectTrade` spreads `meta` first so computed fields win.** Any field the trade record also carries has to be seeded from `meta` in the defaults, or the default silently overwrites it — this cost one real bug where every stop rule came back `null`.

## Layout

```
src/core/
  money.js       rounding, epsilon comparison
  events.js      event vocabulary, factories, validation
  engine.js      projection: events -> trade state, R, risk
  stopRules.js   rule evaluation + counterfactual simulator
  metrics.js     MFE/MAE, capture, round trips, trade summary
  stats.js       aggregation, breakdowns, period comparison, dashboard

src/export/
  csv.js         trades and events, RFC 4180 quoted
  markdown.js    the review block that gets pasted into an AI chat

src/ui/
  app.js         state, router, actions, render loop
  registry.js    ACTIONS / LIVE — a leaf module, to break the import cycle
  format.js      display formatting and the R rail
  styles.css     design tokens, dark and light
  screens/       home, newTrade, trades, tradeDetail, log, stats, settings
src/data/
  store.js       storage adapters: IdbStore (browser), MemoryStore (tests)
  repo.js        the only writer — validates every append before it persists
  backup.js      policy, serialize, restore, merge
  browserBackup.js  File System Access API + download fallback

test/            195 tests, node:test
```

The core is pure and framework-free. It runs unchanged in Node and in the browser.

## Data ownership

The journal database, screenshots and exports are device-local and are in `.gitignore`. Nothing in this repository should ever contain trading history.
