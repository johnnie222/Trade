# Trade Journal — Product Specification v2

## 1. What This Is

A local-first journal for **long swing/position trades in US equities**.

Its job is to record what you did, calculate everything derivable from that record, and produce weekly and monthly summaries you can review — and export — to get better.

**It is a journal, not a live system.**

### Explicitly out of scope

| Not building | Why |
|---|---|
| Shorts | Not traded. Halves the formula surface. |
| Options, futures, TASE, non-USD | Not traded. |
| Real-time prices | Costs money. Delayed/EOD is sufficient for a journal. |
| Push notifications, background monitoring | The app has no reason to run when closed. |
| Insight engine / correlation mining | Export to an AI instead. Small samples produce false patterns. |
| Automatic structure detection (higher lows, pivots) | A whole subsystem serving an alerting product that doesn't exist here. |
| Broker import | Manual entry. |
| Commissions, fees, slippage | Deferred. |
| Composite "process score" | Arbitrary weighting. Show the raw metrics. |
| Cloud sync | Phase 3. Data model supports it from day one. |

### Two rules that govern every decision

1. **If the app can derive it, never ask for it.**
2. **Every derived number must be recomputable from the event log.** No stored calculated state that can drift.

---

## 2. Core Model: Event Log

A trade is not a row that gets updated. It is an **append-only list of events**.

```
Trade
  id, account_id, ticker, direction (always LONG), created_at, closed_at
  initial_stop            ← immutable, set at open
  initial_qty             ← immutable, set at open
  entry_price             ← immutable, price of the opening BUY
  setup, thesis, invalidation, timeframe
  levels[] (support / resistance / target)
  entry_emotion           ← tagged at open, not at close
  status: OPEN | CLOSED

Event  (ordered, immutable)
  id, trade_id, timestamp, type, payload, note, screenshot_ids[]

  types:
    OPEN         { price, qty, stop }
    ADD          { price, qty }
    TRIM         { price, qty }
    STOP_CHANGE  { from, to, reason }
    NOTE         { text }
    SPLIT        { ratio }
    CLOSE        { price, qty, reason }
```

Every screen is a projection of this log. Fixing a formula bug fixes all history automatically. Replay (§12) is free. Sync later is a merge of append-only events instead of a merge of mutable state.

**Corrections:** the user can edit an event's fields. That is an in-place edit of the log, not a compensating event. Simpler, and this is a personal journal — there is no audit requirement.

---

## 3. The R Engine

This is the heart of the product. Everything else is UI around these formulas.

### Locked at open

```
risk_per_share = entry_price − initial_stop        (must be > 0)
R              = risk_per_share × initial_qty      ← a DOLLAR amount
```

**R never changes for the life of the trade.** Not when you add, not when you trim, not when you raise the stop. It is the dollar amount you originally decided to risk. This is what makes trades comparable.

### Display targets

```
1R price = entry_price + risk_per_share
2R price = entry_price + 2 × risk_per_share
3R price = entry_price + 3 × risk_per_share
```

These are display-only reference prices. They are not the source of truth for anything.

### P&L and R, with adds and trims

Position accounting uses **weighted average cost**:

```
after ADD:   avg_cost = (avg_cost × qty + add_price × add_qty) / (qty + add_qty)
             qty += add_qty

after TRIM:  realized_pnl += trim_qty × (trim_price − avg_cost)
             qty −= trim_qty
             avg_cost unchanged
```

Then:

```
open_pnl    = open_qty × (current_price − avg_cost)
total_pnl   = realized_pnl + open_pnl

Realized R  = realized_pnl / R
Current R   = total_pnl / R
```

A trade with no adds and no trims gives `Current R = (current_price − entry) / risk_per_share`, exactly as expected.

### Risk

```
initial_risk      = R
initial_risk_%    = R / account_equity

open_risk         = max(0, (avg_cost − active_stop)) × open_qty
```

If the active stop is above average cost, `open_risk = 0` and the trade shows **Protected** with the locked-in amount displayed separately.

### Portfolio open risk (Home screen)

```
portfolio_risk = Σ open_risk across open trades
```

Labelled precisely: **`Assumed Risk $X / Y% — excludes gaps`**. It assumes every stop fills at its price, which is false on a gap. The label says so once; no further hand-wringing in the UI.

---

## 4. MFE / MAE

Computed from **daily** high/low bars over the holding period, purely in price terms relative to the original entry:

```
MFE_R = (max_high_during_trade − entry_price) / risk_per_share
MAE_R = (min_low_during_trade  − entry_price) / risk_per_share     (negative)

MFE_captured = Realized R / MFE_R          (only when MFE_R > 0)
```

Two consequences, both intentional:

- MFE/MAE **ignore adds and trims**. They measure what the trade offered, not what you captured. That is the correct semantic — the gap between the two is precisely what `MFE_captured` exposes.
- They are **daily-resolution**. A trade that dipped to −0.9R intraday and closed the day at −0.2R shows −0.2R. Every display is labelled `MFE (daily)` / `MAE (daily)` so the number is never mistaken for something it isn't.

If no price history is available, both fields are empty and manually editable.

### Round trip flag

```
round_trip = (MFE_R ≥ 1.5) AND (Realized_R ≤ 0.35 × MFE_R)
```

The flag marks the event. It does not judge the trade — a deliberate structural hold and sloppy profit protection look identical to a formula. The user reads the timeline and decides.

---

## 5. Market Data

Market data is **optional enrichment, never a dependency**. The entire app works with zero connectivity and manually typed prices.

### Provider interface

```
interface MarketDataProvider {
  getLastClose(ticker) → { date, close } | null
  getDailyBars(ticker, from, to) → Bar[] | null
}
```

One implementation ships in v1 (a free EOD source such as Stooq's CSV endpoint — no key, no rate limit worth worrying about). If it breaks or a better source appears, one file changes.

### Refresh policy

- Fetch on app open, at most once per day per ticker, only for tickers with open trades.
- Cache daily bars locally; only fetch the missing tail.
- On failure: silent. Use the last cached value, show its date.

### Staleness is always visible

Every price shows its origin:

```
$482.30   ·   Close, Aug 27
$482.30   ·   entered manually
```

The user is never misled about how current a number is, and can overwrite any price at any time.

---

## 6. Home

Answers one question: *what needs my attention?*

```
OPEN RISK
$412  ·  1.37% of account  ·  4 positions
Largest: NVDA $180

──────────────

DELL              LONG · SWING
+0.74R                Protected
$482.30 · Close Aug 27

Entry $471   Stop $474   1R $481 ✓

──────────────

JPM               LONG · SWING
−0.31R
$188.20 · Close Aug 27

Entry $192   Stop $186   1R $198

──────────────

TODAY'S NOTE
[ tap to write ]

RECENT
DELL — stop raised → $474
NVDA — trimmed 50% @ +2.1R
SCHW — opened
```

Statuses are computed, not stored: `Open · At 1R · At 2R · Protected · Near Stop` (within 25% of the entry→stop distance).

The daily note is one free-text field per calendar day. Not required, not prompted.

---

## 7. New Trade

Opens instantly. One screen, no steps.

```
Ticker      [ DELL          ]
Entry       [ 471.00        ]
Stop        [ 461.00        ]
Shares      [ 42            ]

────────────────────────────
Risk/share      $10.00
Stop distance   2.12%
Risk            $420  ·  0.84%
1R  $481    2R  $491    3R  $501

Suggested size at 1%: 50 shares
────────────────────────────

Feeling:  ○ Calm  ○ Confident  ○ FOMO  ○ Unsure
Stop rule:  [ Ladder 1R→BE, 2R→1R  ▾ ]

▸ Setup & thesis
▸ Levels
📷 Screenshot

[  Open Trade  ]
```

Everything below the divider updates live while typing. No Calculate button.

**Emotion is tagged here, at entry — never at close.** Tagged after the outcome is known, it just reproduces the outcome: losers get labelled FOMO, winners get labelled Disciplined, and the "insight" that FOMO trades lose money is a tautology. Tagged before, it is real data.

`Suggested size` is advisory. Typing a different number never triggers a warning.

**Direction is not a field.** Long only.

### Behind "Setup & thesis"

Setup (tag list, most-used first) · Thesis · What proves me wrong? · Timeframe (Day / Swing / Position)

### Behind "Levels"

Support · Resistance · Target — each a price with an optional label. When a resistance exists:

```
Resistance $493  →  potential +2.2R
```

---

## 8. Trade Detail

```
DELL                          LONG · OPEN
$482.30 · Close Aug 27
+1.42R                        Day 6

Entry    Initial Stop   Active Stop   1R      2R
$471     $461           $474 ✓        $481    $491

├────────●─────────┼──────────┼────────
Stop   Entry    now       1R        2R

MFE (daily)  +1.71R      MAE (daily)  −0.24R
Resistance $493  ·  +1.1R remaining

────────────────────────────────────
Aug 27  ·  STOP RAISED  $461 → $474
           Reason: structure
           +1.34R at the time

Aug 24  ·  NOTE
           Holding through the gap fill

Aug 21  ·  OPEN  42 @ $471, stop $461
           [screenshot]
────────────────────────────────────

[ Raise Stop ]  [ Add Note ]  [ Trim ]  [ Close ]
```

Every action is 1–2 taps and appends an event. Raise Stop opens a single number field prefilled with the current stop plus an optional reason chip; it records the old stop, new stop, current R and timestamp automatically.

The app never invents a stop level and never comments on price action. The only thing it will ever surface is the stop rule the user declared themselves (§9).

---

## 9. Stop Rules

A stop rule is a **policy the trader declares in advance**. The app never moves a stop and never sends anything. It compares the rule against the trade whenever it has a price, shows the gap, and records what the trader actually did.

The value is not the suggestion. It is the adherence record, and the counterfactual.

### Rule types

Rules are defined once in Settings and picked from a dropdown at open (default = account default). Defining a rule from scratch per trade would break the 15-second entry.

| Type | Definition |
|---|---|
| `NONE` | Fully discretionary |
| `LADDER` | List of `(trigger_R → stop_at_R)` pairs |
| `TRAIL_R` | `stop = highest_close − n × risk_per_share` |
| `TRAIL_PCT` | `stop = highest_close × (1 − x%)` |
| `TRAIL_USD` | `stop = highest_close − $x` |

`LADDER` covers every milestone scheme with one structure:

```
[ (1.0 → 0.0), (2.0 → 1.0), (3.0 → 2.0) ]
```
reads as: at 1R move to breakeven, at 2R move to 1R, at 3R move to 2R.

`TRAIL_R` is the most natural fit in an R-denominated product — "trail 1.5R below the high" is directly comparable across tickers, unlike a percentage.

### Evaluation

```
rule_stop  = evaluate(rule, bars, entry, risk_per_share)
target     = max(active_stop, rule_stop)        ← ratchet, never moves down
```

Two resolution decisions, both deliberate:

- **Triggers use daily closes, not highs.** A wick to 2R that closes at 1.2R is not a 2R trade. Triggering on highs makes the rule fire on noise. MFE still uses highs (§4) — different question, different bar field.
- **Evaluation is per closed day.** The rule may surface a day late. For a swing journal that is acceptable; for anything faster it wouldn't be, which is another reason this product is scoped to swing trades.

### Presentation

Passive. A flag on the card, nothing else. No push, no sound, no badge.

```
DELL                          LONG · OPEN
+2.14R                        ⚑ RULE

Your stop $461  ·  rule says $481

[ Apply → $481 ]        [ Skip ]
```

`Apply` appends `STOP_CHANGE { from, to, reason: "rule" }` — one tap.
`Skip` appends `RULE_OVERRIDE { rule_stop, actual_stop, reason? }`.

The override event is the point of the whole feature. A journal that only records compliance teaches nothing.

### Counterfactual

Once daily bars exist (Phase 2), every closed trade computes what it would have returned had its rule been followed exactly:

```
Realized        +0.4R
Rule would have  +1.9R      ← rule was overridden twice
```

Simulation: walk the daily bars, recompute `rule_stop` each close, exit at the stop when a later low breaches it. If the day gaps below the stop, exit at that day's open. This is approximate — daily bars cannot resolve whether the high or the low came first — and is labelled `estimated`.

This is the honest way to settle the question the rule raises. "At 2R move to 1R" mechanically caps a portion of your winners at 1R on any normal pullback. Whether that costs more than the round trips it prevents is not answerable in the abstract; it is answerable from your own 40 trades. The counterfactual answers it, and it needs no live data to do so.

---

## 10. Close

```
[ Close Trade ]

Price     [ 489.50 ]      ← prefilled with last close
Shares    [ 42     ]      ← prefilled with full remaining
Reason    Target · Stop hit · Structure broken ·
          Trailing stop · Event risk · Mistake · Other

[ Close ]
```

Partial close = TRIM. Full close = CLOSE. Same dialog.

Then a lightweight review, dismissible with one tap:

```
DELL CLOSED     +1.84R     $773

MFE +2.71R  ·  captured 68%
MAE −0.32R  ·  held 12 days

Did you follow your plan?   Yes  ·  Partly  ·  No

Lesson (optional)
[                              ]

[ Done ]
```

Emotion is **not** asked here — it was recorded at entry. Only plan adherence and the lesson, both optional.

---

## 11. Activity Log

Everything the trader does is already an event (§2). This section makes that record visible, searchable and exportable.

Nothing is ever deleted. Closing or deleting a trade does not remove its events.

### What gets logged

Every event carries `timestamp`, `trade_id`, `ticker`, `type`, `payload`, `price_at_time`, `current_R_at_time`, and an optional note and screenshot. In addition to the trade events in §2, the log records:

```
ACCOUNT_EQUITY_CHANGE   { from, to }
RULE_CHANGE             { trade_id, from_rule, to_rule }
TRADE_EDIT              { field, from, to }      ← corrections to past events
DAILY_NOTE              { text }
REVIEW_COMPLETED        { period, plan_followed, lesson }
```

`TRADE_EDIT` matters: §2 allows editing a past event in place, and without this the correction would be invisible. The corrected value is what all projections use; the log preserves that a correction happened.

### Stop history

Every trade's full stop history is a first-class view, not something to be reconstructed by reading a timeline:

```
STOP HISTORY — DELL

$461  Aug 21   initial
$474  Aug 27   rule (2R → 1R)      +2.14R
$481  Aug 29   manual · structure  +2.61R
$481  Sep 02   rule said $488 — skipped
                "holding for the gap fill"

Time at initial stop     6 days
Stop changes             2
Rule overrides           1
```

The last line of the block is the one worth having: a skipped rule sits in the stop history permanently, with the reason the trader gave at the time.

### Global log view

An account-wide chronological feed, not per-trade. Filterable by date range, ticker, and event type.

```
LOG                      [ Aug 24–28 ▾ ]  [ All types ▾ ]

Aug 28  14:02   NVDA   TRIM 50 @ $181.20        +2.10R
Aug 28  09:15   DELL   STOP $474 → $481         +2.61R
Aug 27  22:40   —      DAILY NOTE
Aug 27  16:30   DELL   RULE SKIPPED  $481       +2.14R
Aug 27  16:30   DELL   STOP $461 → $474  rule   +2.14R
Aug 25  10:11   JPM    OPEN 30 @ $192, stop $186

                                    [ Export ]
```

This is also the fastest way to answer "what did I actually do last Tuesday" without opening six trades.

---

## 12. Weekly & Monthly Review

Deterministic aggregation. No interpretation, no AI, no correlation mining. Numbers, plus the same numbers for the previous period.

```
WEEK OF AUG 24–28              vs last week

Trades              8              6
Net R           +4.3R          +1.8R    ↑
Win rate          63%            50%    ↑
Avg winner      +1.42R         +1.10R
Avg loser       −0.93R         −1.20R
Expectancy      +0.54R         +0.15R   ↑
Profit factor     1.87           1.21

Avg MFE         +2.06R         +2.40R
MFE captured       61%            42%   ↑
Avg MAE         −0.41R         −0.55R

Reached 1R       6 / 8          3 / 6
Reached 2R       3 / 8          2 / 6
Round trips          2              5   ↓

Avg risk         0.81%          0.76%
Stop changes         5              2

STOP RULE
Followed         6 / 8          3 / 6
Overridden           2              3
Realized on followed      +3.9R
Realized on overridden    +0.4R
Rule counterfactual       +1.9R

BY SETUP
Breakout    4    +3.1R    +0.78R avg
Pullback    3    +1.6R    +0.53R avg
Reversal    1    −0.4R    −0.40R avg

BY ENTRY EMOTION
Calm        5    +4.1R
Confident   2    +0.6R
FOMO        1    −0.4R

[ Export for analysis ]     [ Note ]
```

Weeks are Monday–Friday in **US market time**, not device time. The user's evening is the same trading day; a Monday 22:30 fill in Israel must land in Monday's week, not Tuesday's.

The monthly review is the same view over a month, plus largest winner/loser, average holding period, and 1R→loss / 2R→loss counts.

Setup and emotion breakdowns are shown as raw counts with no ranking language, no "best/worst", no arrows on rows with fewer than 5 trades. The numbers are the output; the interpretation is the user's.

### Export for analysis

The button that replaces the insight engine. Available on both the weekly and the monthly review, and on any custom date range from the log (§11).

Produces one Markdown block containing:

1. The period's aggregates, exactly as displayed
2. One line per trade closed in the period
3. One line per trade still open at period end
4. The complete event log for the period — every stop change, every rule override with its reason, every note
5. Full event timelines for any trade flagged as a round trip

Copied to the clipboard in one tap. Small enough to paste into a chat, complete enough that the analysis is grounded in what actually happened rather than in summary statistics.

The same content is available as JSON for anything programmatic, and as PDF for archiving.

---

## 13. Screenshots

First-class objects on events, not attachments buried in notes.

- Camera, gallery, or Android share sheet from TradingView
- Each inherits ticker, date, trade stage and R at capture automatically
- Stored in app-private storage, referenced by id from events
- Compressed on import (long edge 1600px, JPEG q80) — a journal with 500 trades should not consume a gigabyte

Sharing an image into the app offers: **Add to open trade** (list) or **New trade from screenshot**.

---

## 14. Replay

A closed trade renders its event log as a vertical timeline with screenshots inline at their points. It is a different rendering of §8, not a separate feature — this is the payoff of the event log.

---

## 15. Splits

A manual action on an open trade, not automatic detection. Price-ratio heuristics produce false positives on gaps and are not worth the complexity.

```
Apply split:  [ 2 ] : [ 1 ]

Entry        $471.00  →  $235.50
Initial stop $461.00  →  $230.50
Active stop  $474.00  →  $237.00
Shares            42  →       84

R stays $420.
```

Appends a SPLIT event; all prior events keep their original values and are adjusted at projection time. Closed trades are historical records and are left alone.

---

## 16. Data, Storage, Export

Local IndexedDB. No account, no network required, ever. The event log is the database; everything else is a projection.

**Export**
- **Trades CSV** — one row per trade: id, ticker, setup, entry date/price, initial stop, R, size, exit date/price, realized R, max R, MFE, MAE, MFE captured %, holding days, exit reason, entry emotion, stop rule, stop changes, rule overrides, plan followed, round trip flag, notes
- **Events CSV** — one row per event: timestamp, trade id, ticker, type, payload fields, price at time, R at time, reason, note. The raw log, for anything the trades CSV can't answer.
- **JSON** — complete event log plus settings. This is the real backup.
- **Backup archive** — JSON + screenshots in one file, restorable on another device

### Automatic backup

Browser storage can be cleared by the user or evicted by the OS under storage pressure. A journal that silently disappears is worse than no journal.

On every app open, if the last backup is older than 24 hours or more than 5 events have been appended since it, write a full JSON snapshot to the device — File System Access API to a folder the user picks once, falling back to a plain download into Downloads. Keep the last 7 rolling snapshots, named `journal-YYYY-MM-DD.json`.

No prompt, no dialog. The user sees the backup date in Settings and nothing else.
- **Markdown / PDF** — the weekly, monthly or custom-range export of §12

Nothing is trapped in the app.

---

## 17. Accounts

One or more accounts: name, starting equity, default risk %. Equity is manually updated whenever the user cares to. It is used only for the risk-% display and the suggested-size hint — nothing depends on it being accurate.

---

## 18. Design

Institutional precision, consumer-app restraint. Dark and light themes.

- Neutral surfaces. Green and red carry meaning: green = positive R and protected stops, red = negative R and stop proximity. Nothing else is coloured.
- Numbers are the interface. Tabular figures, generous spacing, strong hierarchy.
- One chart in the entire product: the horizontal trade-progress bar. No decorative dashboards.
- Animations under 200ms and never blocking.
- One-handed operation. Large targets. Persistent floating **+**.
- Haptics on: trade opened, stop raised, trade closed.

**i18n from day one** — no hardcoded strings, no hardcoded LTR assumptions in layout. Hebrew ships in Phase 2 (§18), but retrofitting RTL into a built UI costs ten times what building it neutral does.

---

## 19. Build Order

**Phase 1 — MVP**

Manual entry only. No network.

1. Event log + IndexedDB + projections
2. R engine (§3) with a full unit-test suite — this is where correctness matters most
3. New Trade
4. Home
5. Trade Detail + Raise Stop / Trim / Note / Close
6. Stop rules — definition, evaluation, apply / skip events (§9)
7. Post-trade review
8. Activity log — global feed, stop history, filters (§11)
9. Weekly review, including rule adherence + `Export for analysis`
10. Trades CSV + Events CSV + JSON export
11. Dark/light

At this point the product is genuinely usable. MFE/MAE are manual fields.

**Phase 2**

12. Market data provider + EOD prices + automatic MFE/MAE + rule counterfactual
13. Screenshots + Android share sheet
14. Monthly review, trends over 30d/3m/1y
15. Replay
16. Hebrew / RTL
17. Search and filters
18. Splits

**Phase 3**

19. Desktop (same event log, wider layout: timeline centre, stats right, screenshot comparison)
20. Cloud sync — an append-only event merge, which is why §2 exists

---

## 20. Stack & Repository

**Stack: PWA.** One codebase, installable on Android from the browser, runs on desktop as the same app. IndexedDB for storage, Web Share Target for the TradingView screenshot flow in Phase 2, service worker for full offline operation. The costs are real but small at this scope: storage is browser-sandboxed rather than OS-encrypted, and biometric unlock is WebAuthn rather than native. For a single-user journal with no live data and no background work, neither justifies a native toolchain.

**Repository: private GitHub repo.** Code only.

The journal database, screenshots and every export are device-local and belong in `.gitignore` — a first commit that includes a live trading history is an unpleasant thing to discover later.

```
.gitignore
  *.db  *.sqlite  /backups  /screenshots  /exports  .env
```

Free hosting on GitHub Pages, which also gives the HTTPS origin a PWA needs to be installable. Nothing runs server-side, so there is no backend to pay for or maintain.

---

## 21. Open Decisions

1. **Free EOD provider.** Pick and verify one before Phase 2. The interface in §5 keeps this cheap to change, but confirm the source is stable, unauthenticated, and CORS-accessible from a browser — the last one is what usually eliminates otherwise fine sources for a PWA.
2. **Round-trip thresholds.** `MFE ≥ 1.5R` and `realized ≤ 35% of MFE` are starting values. Revisit once there are 50 real trades to calibrate against.
3. **Adds in Phase 1's UI.** Supported in the model and tested. Worth confirming whether the button ships in Phase 1 or stays model-only until needed.
