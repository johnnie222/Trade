/**
 * Repository.
 *
 * The only thing that writes to storage. Two properties it guarantees:
 *
 * 1. THE LOG IS NEVER INVALID. Every append is projected before it is written.
 *    If the resulting log would throw — trimming more than is open, adding to a
 *    closed trade, a stop above entry — the write is rejected and storage is
 *    left untouched. There is no code path that produces a trade the engine
 *    cannot read.
 *
 * 2. ORDER IS (at, seq). Events sort by timestamp, with an insertion counter
 *    breaking ties. Backdating is therefore supported and correct: logging a
 *    trim you forgot last Tuesday re-sorts it into place and every downstream
 *    number recomputes. seq alone would pin it to the end and silently produce
 *    the wrong average cost.
 */

import { projectTrade } from '../core/engine.js';
import { EventType, newId, validateOpen, TradeError } from '../core/events.js';

export const SCHEMA_VERSION = 1;

export function sortEvents(events) {
  return [...events].sort((a, b) => {
    const t = new Date(a.at) - new Date(b.at);
    return t !== 0 ? t : (a.seq ?? 0) - (b.seq ?? 0);
  });
}

export class Repository {
  constructor(store) {
    this.store = store;
  }

  /* ---------------- trades ---------------- */

  /**
   * Creates the trade record and its OPEN event atomically-ish: the OPEN is
   * validated before anything is written, so a rejected open leaves no orphan.
   */
  async createTrade(meta, openEvent) {
    if (openEvent.type !== EventType.OPEN) throw new TradeError('createTrade needs an OPEN event');
    validateOpen(openEvent.payload);

    const id = meta.id ?? newId('t');
    const now = new Date().toISOString();
    const trade = {
      id,
      ticker: meta.ticker,
      account: meta.account ?? 'default',
      setup: meta.setup ?? null,
      thesis: meta.thesis ?? null,
      invalidation: meta.invalidation ?? null,
      timeframe: meta.timeframe ?? null,
      entryEmotion: meta.entryEmotion ?? null,
      rule: meta.rule ?? null,
      managementMode: meta.managementMode ?? 'manual',
      trailType: meta.trailType ?? null,
      trailValue: meta.trailValue ?? null,
      levels: meta.levels ?? [],
      lesson: meta.lesson ?? null,
      planFollowed: meta.planFollowed ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.put('trades', trade);
    await this.store.put('events', { ...openEvent, tradeId: id, seq: 0 });
    return this.getTrade(id);
  }

  /** Rejects any append that would make the log unprojectable. */
  async appendEvent(tradeId, ev) {
    const trade = await this.store.get('trades', tradeId);
    if (!trade) throw new TradeError(`No such trade: ${tradeId}`);

    const existing = await this.store.where('events', 'tradeId', tradeId);
    const seq = existing.reduce((m, e) => Math.max(m, e.seq ?? 0), 0) + 1;
    const record = { ...ev, tradeId, seq };

    // Dry run. Throws before anything is persisted.
    projectTrade(sortEvents([...existing, record]), trade);

    await this.store.put('events', record);
    await this.store.put('trades', { ...trade, updatedAt: new Date().toISOString() });
    return record;
  }

  async setManagementPlan(tradeId, plan) {
    const trade = await this.store.get('trades', tradeId);
    if (!trade) throw new TradeError(`No such trade: ${tradeId}`);
    const next = {
      ...trade,
      managementMode: plan.managementMode === 'trailing' ? 'trailing' : 'manual',
      trailType: plan.managementMode === 'trailing' ? plan.trailType : null,
      trailValue: plan.managementMode === 'trailing' ? Number(plan.trailValue) : null,
      updatedAt: new Date().toISOString(),
    };
    if (
      next.managementMode === 'trailing' &&
      (!['TRAIL_PCT', 'TRAIL_USD'].includes(next.trailType) || !(next.trailValue > 0))
    ) {
      throw new TradeError('Choose percent or dollars and enter a positive trail');
    }
    await this.store.put('trades', next);
    return this.getTrade(tradeId);
  }

  /** Correct a past event in place, and record that a correction happened. */
  async editEvent(eventId, changes, { at = new Date().toISOString() } = {}) {
    const ev = await this.store.get('events', eventId);
    if (!ev) throw new TradeError(`No such event: ${eventId}`);

    const updated = { ...ev, payload: { ...ev.payload, ...changes } };
    const siblings = (await this.store.where('events', 'tradeId', ev.tradeId)).map((e) =>
      e.id === eventId ? updated : e
    );
    const trade = await this.store.get('trades', ev.tradeId);

    projectTrade(sortEvents(siblings), trade); // validate before writing

    await this.store.put('events', updated);
    for (const [field, to] of Object.entries(changes)) {
      await this.store.put('events', {
        id: newId(),
        tradeId: ev.tradeId,
        seq: siblings.reduce((m, e) => Math.max(m, e.seq ?? 0), 0) + 1,
        type: EventType.TRADE_EDIT,
        at,
        payload: { targetEventId: eventId, field, from: ev.payload[field], to },
        note: null,
        screenshotIds: [],
      });
    }
    return updated;
  }

  /** Projected trade state, ready for any screen. */
  async getTrade(id) {
    const trade = await this.store.get('trades', id);
    if (!trade) return null;
    const events = sortEvents(await this.store.where('events', 'tradeId', id));
    return projectTrade(events, trade);
  }

  async listTrades({ status = null, ticker = null } = {}) {
    const trades = await this.store.all('trades');
    const all = await Promise.all(trades.map((t) => this.getTrade(t.id)));
    return all
      .filter((t) => (status ? t.status === status : true))
      .filter((t) => (ticker ? t.ticker === ticker : true))
      .sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
  }

  /**
   * Nothing is ever really deleted, but a mistyped trade should not pollute
   * statistics forever. Archived trades stay in storage and in exports, and are
   * excluded from reviews.
   */
  async archiveTrade(id) {
    const trade = await this.store.get('trades', id);
    if (!trade) throw new TradeError(`No such trade: ${id}`);
    await this.store.put('trades', { ...trade, archived: true });
  }

  /* ---------------- account-level log ---------------- */

  async appendJournal(entry) {
    const record = { id: entry.id ?? newId('j'), ...entry };
    await this.store.put('journal', record);
    return record;
  }

  /**
   * The global activity feed: every trade event and every account-level entry,
   * newest first, with the ticker joined in so the UI does not have to.
   *
   * STOP_CHANGE rows are enriched with the stop they moved FROM. That value is
   * derived by the projection and deliberately not stored on the event, so a
   * raw dump of the log can only render "stop ? → 474". The feed is a read
   * model and joining is its job — the alternative is denormalising a derived
   * number into the log, which is exactly what §2 exists to avoid.
   */
  async activityLog({ from = null, to = null, types = null, ticker = null } = {}) {
    const trades = await this.store.all('trades');
    const byId = new Map(trades.map((t) => [t.id, t]));
    const events = await this.store.all('events');
    const journal = await this.store.all('journal');

    // Walk each trade's ordered events once, tracking the running stop.
    const stopFrom = new Map();
    const byTrade = new Map();
    for (const e of events) {
      if (!byTrade.has(e.tradeId)) byTrade.set(e.tradeId, []);
      byTrade.get(e.tradeId).push(e);
    }
    for (const [, evs] of byTrade) {
      let stop = null;
      for (const e of sortEvents(evs)) {
        if (e.type === EventType.OPEN) stop = e.payload.stop;
        else if (e.type === EventType.STOP_CHANGE) {
          stopFrom.set(e.id, stop);
          stop = e.payload.to;
        } else if (e.type === EventType.RULE_OVERRIDE) {
          stopFrom.set(e.id, stop);
        }
      }
    }

    const rows = [
      ...events.map((e) => ({
        ...e,
        ticker: byId.get(e.tradeId)?.ticker ?? null,
        payload: stopFrom.has(e.id)
          ? { ...e.payload, from: e.payload.from ?? stopFrom.get(e.id), actualStop: e.payload.actualStop ?? stopFrom.get(e.id) }
          : e.payload,
      })),
      ...journal.map((j) => ({ ...j, tradeId: null, ticker: null })),
    ];

    return rows
      .filter((r) => (from ? new Date(r.at) >= new Date(from) : true))
      .filter((r) => (to ? new Date(r.at) <= new Date(to) : true))
      .filter((r) => (types ? types.includes(r.type) : true))
      .filter((r) => (ticker ? r.ticker === ticker : true))
      .sort((a, b) => new Date(b.at) - new Date(a.at) || (b.seq ?? 0) - (a.seq ?? 0));
  }

  /** Total events written, used by the auto-backup policy. */
  async eventCount() {
    const [events, journal] = await Promise.all([
      this.store.all('events'),
      this.store.all('journal'),
    ]);
    return events.length + journal.length;
  }

  /* ---------------- settings ---------------- */

  async getSetting(key, fallback = null) {
    const row = await this.store.get('settings', key);
    return row ? row.value : fallback;
  }

  async setSetting(key, value) {
    await this.store.put('settings', { id: key, value });
    return value;
  }
}
