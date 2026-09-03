/**
 * Settings.
 *
 * Account, backup, data. The backup section is first because it is the only
 * thing here that can cost the trader something if ignored.
 */

import { ACTIONS } from '../registry.js';
import { state, setSetting, applyTheme, render, toast, refresh } from '../app.js';
import { PRESETS } from '../../core/stopRules.js';
import { serialize, restore } from '../../data/backup.js';
import { autoBackup, chooseBackupFolder, hasFileSystemAccess } from '../../data/browserBackup.js';
import { dollars, shortDate, esc } from '../format.js';

export function renderSettings(s) {
  const last = s.draft.lastBackup;

  return `
    <div class="section-title"><span class="label">Backup</span></div>
    <div class="card">
      <p style="margin:0 0 var(--sp-2)">
        ${
          last
            ? `Last backup ${shortDate(last.at)} · ${esc(last.method === 'folder' ? 'to your folder' : 'to Downloads')}`
            : 'Backups run automatically when you open the app.'
        }
      </p>
      <p class="muted" style="margin:0 0 var(--sp-3);font-size:var(--step--1)">
        Browser storage can be cleared or evicted. A snapshot is written after a day has passed
        or five events have been recorded, whichever comes first. Seven are kept.
      </p>
      <div class="btn-row">
        ${
          hasFileSystemAccess()
            ? '<button class="btn" data-action="chooseFolder">Choose folder</button>'
            : '<span class="muted" style="font-size:var(--step--1)">This browser saves to Downloads.</span>'
        }
        <button class="btn" data-action="backupNow">Back up now</button>
      </div>
    </div>

    <div class="section-title"><span class="label">Account</span></div>
    <div class="card">
      <div class="field">
        <label class="label" for="s-equity">Account size</label>
        <input id="s-equity" inputmode="decimal" data-action-blur value="${s.settings.equity}"
               data-set="equity">
      </div>
      <div class="field">
        <label class="label" for="s-risk">Default risk per trade (%)</label>
        <input id="s-risk" inputmode="decimal" value="${s.settings.riskPct}" data-set="riskPct">
      </div>
      <div class="field" style="margin-bottom:0">
        <label class="label" for="s-rule">Default stop rule</label>
        <select id="s-rule" data-set="defaultRule">
          ${Object.entries(PRESETS)
            .map(
              ([k, r]) =>
                `<option value="${k}" ${s.settings.defaultRule === k ? 'selected' : ''}>${r.label}</option>`
            )
            .join('')}
        </select>
      </div>
      <p class="muted" style="margin:var(--sp-3) 0 0;font-size:var(--step--1)">
        Used for the suggested position size and preselected on new trades. Never enforced.
      </p>
    </div>

    <div class="section-title"><span class="label">Prices</span></div>
    <div class="card">
      <label class="switch">
        <input type="checkbox" data-set="autoPrices" ${s.settings.autoPrices ? 'checked' : ''}>
        <span>Fetch prices when the app opens</span>
      </label>
      <p class="muted" style="margin:var(--sp-3) 0 0;font-size:var(--step--1)">
        The app quietly tries two public sources for open positions. If neither is available,
        manual entry remains the fallback without error messages.
      </p>
    </div>

    <div class="section-title"><span class="label">Appearance</span></div>
    <div class="card">
      <div class="chips">
        ${['system', 'light', 'dark']
          .map(
            (t) =>
              `<button class="chip" data-action="setTheme" data-v="${t}"
                       aria-pressed="${s.settings.theme === t}">${t[0].toUpperCase()}${t.slice(1)}</button>`
          )
          .join('')}
      </div>
    </div>

    <div class="section-title"><span class="label">Data</span></div>
    <div class="card">
      <p class="muted" style="margin:0 0 var(--sp-3);font-size:var(--step--1)">
        ${s.trades.length} trades · ${s.log.length} events. The JSON export is the complete journal
        and is what a restore reads.
      </p>
      <div class="btn-row">
        <button class="btn" data-action="exportJson">Export JSON</button>
        <button class="btn" data-action="importJson">Restore</button>
      </div>
    </div>

    <p class="muted" style="text-align:center;margin-top:var(--sp-6);font-size:var(--step--1)">
      Everything is stored on this device. Nothing is sent anywhere.
    </p>`;
}

document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-set]');
  if (!el) return;
  const key = el.dataset.set;
  const numeric = ['equity', 'riskPct'];
  let value;
  if (el.type === 'checkbox') value = el.checked;
  else if (numeric.includes(key)) value = Number.parseFloat(el.value);
  else value = el.value;
  if (numeric.includes(key) && !(Number.isFinite(value) && value > 0)) return;
  await setSetting(key, value);
  toast('Saved');
});

ACTIONS.setTheme = async (el) => {
  await setSetting('theme', el.dataset.v);
  applyTheme();
  render();
};

ACTIONS.chooseFolder = async () => {
  try {
    await chooseBackupFolder(state.repo);
    toast('Folder set. Backups will write there.');
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message);
  }
};

ACTIONS.backupNow = async () => {
  try {
    const r = await autoBackup(state.repo, { force: true });
    state.draft.lastBackup = { at: new Date().toISOString(), method: r.method };
    toast(`Backed up ${(r.bytes / 1024).toFixed(0)} KB`);
  } catch (err) {
    toast(err.message);
  }
};

ACTIONS.exportJson = async () => {
  const snap = await serialize(state.repo);
  const text = JSON.stringify(snap, null, 2);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `journal-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported');
};

/**
 * Restore asks which mode, because the two are not interchangeable and the
 * destructive one must never be the default. Replace wipes what is here;
 * merge unions by event id and is safe to run twice.
 */
ACTIONS.importJson = () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      return toast('That file is not valid JSON.');
    }
    const merge = window.confirm(
      `Restore ${payload.counts?.trades ?? '?'} trades.\n\n` +
        'OK — merge into what is already here.\n' +
        'Cancel — replace everything on this device.'
    );
    try {
      const result = await restore(state.repo, payload, { mode: merge ? 'merge' : 'replace' });
      await refresh();
      render();
      toast(
        result.failures.length
          ? `Restored with ${result.failures.length} unreadable trade(s)`
          : `Restored ${result.trades} trades`
      );
    } catch (err) {
      toast(err.message);
    }
  };
  input.click();
};
