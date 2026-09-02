/**
 * Backup.
 *
 * Browser storage is not durable. The user can clear site data, and the OS can
 * evict it under storage pressure. A journal that silently disappears is worse
 * than no journal, so backups are automatic and unprompted rather than a menu
 * item nobody clicks.
 *
 * Everything here is pure and testable. The file-writing half — File System
 * Access API with a download fallback — lives in browserBackup.js.
 */

import { SCHEMA_VERSION, sortEvents } from './repo.js';

export const BACKUP_POLICY = {
  MAX_AGE_HOURS: 24,
  MAX_EVENTS_SINCE: 5,
  KEEP_SNAPSHOTS: 7,
};

/**
 * Backs up when either trigger fires: a day has passed, or enough has happened
 * that losing it would hurt. Age alone would lose a heavy trading morning;
 * event count alone would let a quiet week drift with no snapshot at all.
 */
export function shouldBackup({
  lastBackupAt,
  eventCountAtLastBackup = 0,
  eventCount = 0,
  now = new Date(),
  policy = BACKUP_POLICY,
}) {
  if (!lastBackupAt) return { backup: true, reason: 'no backup yet' };

  const ageHours = (new Date(now) - new Date(lastBackupAt)) / 3600000;
  if (ageHours >= policy.MAX_AGE_HOURS) {
    return { backup: true, reason: `last backup ${Math.floor(ageHours)}h ago` };
  }

  const since = eventCount - eventCountAtLastBackup;
  if (since >= policy.MAX_EVENTS_SINCE) {
    return { backup: true, reason: `${since} events since last backup` };
  }

  return { backup: false, reason: null };
}

export function snapshotName(date = new Date()) {
  return `journal-${new Date(date).toISOString().slice(0, 10)}.json`;
}

/**
 * Oldest-first list of snapshots to delete, keeping the newest N.
 *
 * The count is taken from the filtered list, not from everything in the folder.
 * Counting unfiltered means an unrelated file sitting next to the backups
 * inflates the total and deletes a snapshot that should have been kept — the
 * one failure mode where a bug here costs real data.
 */
export function snapshotsToPrune(names, keep = BACKUP_POLICY.KEEP_SNAPSHOTS) {
  const snapshots = [...names]
    .filter((n) => /^journal-\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .sort();
  return snapshots.slice(0, Math.max(0, snapshots.length - keep));
}

/* ------------------------------------------------------------------ */
/* Serialize / restore                                                 */
/* ------------------------------------------------------------------ */

export async function serialize(repo, { exportedAt = new Date().toISOString() } = {}) {
  const [trades, events, journal, settings] = await Promise.all([
    repo.store.all('trades'),
    repo.store.all('events'),
    repo.store.all('journal'),
    repo.store.all('settings'),
  ]);
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    counts: { trades: trades.length, events: events.length, journal: journal.length },
    trades,
    events: sortEvents(events),
    journal,
    settings,
  };
}

export class RestoreError extends Error {}

/**
 * @param {'replace'|'merge'} mode
 *
 * `merge` unions by id and keeps the existing copy on collision. Because the
 * log is append-only, that is already the correct semantics for two devices
 * holding overlapping history — which is why cloud sync later is a merge of
 * events rather than a reconciliation of mutable rows.
 */
export async function restore(repo, payload, { mode = 'replace' } = {}) {
  if (!payload || typeof payload !== 'object') throw new RestoreError('Backup is not an object');
  if (payload.schemaVersion == null) throw new RestoreError('Backup has no schemaVersion');
  if (payload.schemaVersion > SCHEMA_VERSION) {
    throw new RestoreError(
      `Backup is from a newer version (${payload.schemaVersion} > ${SCHEMA_VERSION}). Update the app first.`
    );
  }
  for (const key of ['trades', 'events']) {
    if (!Array.isArray(payload[key])) throw new RestoreError(`Backup is missing ${key}`);
  }

  const tables = {
    trades: payload.trades,
    events: payload.events,
    journal: payload.journal ?? [],
    settings: payload.settings ?? [],
  };

  if (mode === 'replace') {
    for (const table of Object.keys(tables)) await repo.store.clear(table);
    for (const [table, rows] of Object.entries(tables)) await repo.store.putMany(table, rows);
  } else if (mode === 'merge') {
    for (const [table, rows] of Object.entries(tables)) {
      const existing = new Set((await repo.store.all(table)).map((r) => r.id));
      const incoming = rows.filter((r) => !existing.has(r.id));
      if (incoming.length) await repo.store.putMany(table, incoming);
    }
  } else {
    throw new RestoreError(`Unknown restore mode: ${mode}`);
  }

  // A restored log that cannot be projected is a corrupt backup, and it is far
  // better to say so now than to hand the user a journal that throws on open.
  const trades = await repo.store.all('trades');
  const failures = [];
  for (const t of trades) {
    try {
      await repo.getTrade(t.id);
    } catch (err) {
      failures.push({ id: t.id, ticker: t.ticker, error: err.message });
    }
  }

  return {
    mode,
    trades: trades.length,
    events: (await repo.store.all('events')).length,
    failures,
  };
}
