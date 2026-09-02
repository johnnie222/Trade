/**
 * Browser-side file writing for backups.
 *
 * Two paths, because browser file access is uneven:
 *
 *   1. File System Access API — the user picks a folder once, and every
 *      subsequent backup writes there silently. Chrome and Edge on Android and
 *      desktop. This is the path we want.
 *   2. Download fallback — a plain anchor click into Downloads. Works
 *      everywhere, but the browser may show a prompt and cannot prune old
 *      snapshots, so pruning is skipped rather than faked.
 *
 * Not covered by the Node test suite. The policy and serialization it depends
 * on are, in backup.test.js.
 */

import { serialize, shouldBackup, snapshotName, snapshotsToPrune, BACKUP_POLICY } from './backup.js';

const DIR_HANDLE_KEY = 'backupDirHandle';
const LAST_BACKUP_KEY = 'lastBackup';

export function hasFileSystemAccess() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Called once, from Settings, in response to a click. */
export async function chooseBackupFolder(repo) {
  if (!hasFileSystemAccess()) throw new Error('This browser cannot write to a folder');
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'trade-journal' });
  await repo.setSetting(DIR_HANDLE_KEY, handle);
  return handle;
}

async function verifyPermission(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

async function writeToFolder(handle, filename, text) {
  const file = await handle.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(text);
  await writable.close();
}

async function pruneFolder(handle, keep = BACKUP_POLICY.KEEP_SNAPSHOTS) {
  const names = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind === 'file') names.push(name);
  }
  for (const name of snapshotsToPrune(names, keep)) {
    await handle.removeEntry(name).catch(() => {});
  }
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Call on app open. Silent when nothing is due, silent when it succeeds. The
 * user sees the backup date in Settings and is never interrupted by a dialog.
 */
export async function autoBackup(repo, { now = new Date(), force = false } = {}) {
  const last = (await repo.getSetting(LAST_BACKUP_KEY)) ?? {};
  const eventCount = await repo.eventCount();

  const decision = force
    ? { backup: true, reason: 'manual' }
    : shouldBackup({
        lastBackupAt: last.at,
        eventCountAtLastBackup: last.eventCount ?? 0,
        eventCount,
        now,
      });

  if (!decision.backup) return { written: false, reason: null, lastBackupAt: last.at ?? null };

  const payload = await serialize(repo, { exportedAt: new Date(now).toISOString() });
  const text = JSON.stringify(payload, null, 2);
  const filename = snapshotName(now);

  const handle = await repo.getSetting(DIR_HANDLE_KEY);
  let method = 'download';

  if (handle && (await verifyPermission(handle).catch(() => false))) {
    await writeToFolder(handle, filename, text);
    await pruneFolder(handle);
    method = 'folder';
  } else {
    // Cannot prune Downloads; old snapshots accumulate there and that is fine.
    download(filename, text);
  }

  await repo.setSetting(LAST_BACKUP_KEY, {
    at: new Date(now).toISOString(),
    eventCount,
    filename,
    method,
  });

  return { written: true, reason: decision.reason, filename, method, bytes: text.length };
}

/** Restore from a file the user picks. */
export async function readBackupFile(file) {
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON');
  }
}
