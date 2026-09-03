/** Settings: backup, account, market snapshots, appearance, data. */

import { ACTIONS } from '../registry.js';
import { state, setSetting, applyTheme, render, toast, refresh } from '../app.js';
import { PRESETS } from '../../core/stopRules.js';
import { serialize, restore } from '../../data/backup.js';
import { autoBackup, chooseBackupFolder, hasFileSystemAccess } from '../../data/browserBackup.js';
import { getTwelveDataKey, setTwelveDataKey } from '../../data/marketData.js';
import { shortDate, esc } from '../format.js';

const ACTIVE_RULES = ['discretionary', 'ladderClassic'];

export function renderSettings(s) {
  const last = s.draft.lastBackup;
  const quoteKey = getTwelveDataKey();

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
        <input id="s-equity" inputmode="decimal" data-action-blur value="${s.settings.equity}" data-set="equity">
      </div>
      <div class="field">
        <label class="label" for="s-risk">Default risk per trade (%)</label>
        <input id="s-risk" inputmode="decimal" value="${s.settings.riskPct}" data-set="riskPct">
      </div>
      <div class="field" style="margin-bottom:0">
        <label class="label" for="s-rule">Default stop rule</label>
        <select id="s-rule" data-set="defaultRule">
          ${Object.entries(PRESETS)
            .filter(([key]) => ACTIVE_RULES.includes(key))
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

    <div class="section-title"><span class="label">Price snapshots</span></div>
    <div class="card">
      <div class="field">
        <label class="label" for="s-twelve-key">Twelve Data API key</label>
        <input id="s-twelve-key" type="password" autocomplete="off" spellcheck="false"
               value="${esc(quoteKey)}" placeholder="Optional API key">
      </div>
      <div class="btn-row">
        <button class="btn" data-action="saveTwelveKey">${quoteKey ? 'Update key' : 'Save key'}</button>
        ${quoteKey ? '<button class="btn" data-action="clearTwelveKey">Clear</button>' : ''}
      </div>
      <p class="muted" style="margin:var(--sp-3) 0 0;font-size:var(--step--1)">
        Twelve Data is tried first when a key is saved, then Yahoo. If neither works, manual entry stays available.
        Quotes are snapshots only — no streaming, polling or automatic refresh on app launch.
      </p>
      <p class="muted" style="margin:var(--sp-2) 0 0;font-size:var(--step--1)">
        The key stays only in this browser and is not included in journal backups or exports.
      </p>
    </div>

    <div class="section-title"><span class="label">Market hours</span></div>
    <div class="card">
      <div class="chips">
        ${['regular', 'extended']
          .map(
            (v) =>
              `<button class="chip" data-action="setMarketHours" data-v="${v}"
                       aria-pressed="${s.settings.marketHours === v}">${v === 'regular' ? 'Regular' : 'Extended'}</button>`
          )
          .join('')}
      </div>
      <p class="muted" style="margin:var(--sp-3) 0 0;font-size:var(--step--1)">
        Regular is 09:30–16:00 New York time. Extended adds pre-market and after-hours to the Today clock.
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
      Trading history is stored on this device. Nothing is sent anywhere except quote requests you explicitly trigger.
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

ACTIONS.setMarketHours = async (el) => {
  const value = el.dataset.v === 'extended' ? 'extended' : 'regular';
  await setSetting('marketHours', value);
  render();
};

ACTIONS.saveTwelveKey = () => {
  const value = document.getElementById('s-twelve-key')?.value ?? '';
  setTwelveDataKey(value);
  toast(value.trim() ? 'API key saved on this device' : 'API key cleared');
};

ACTIONS.clearTwelveKey = () => {
  setTwelveDataKey('');
  render();
  toast('API key cleared');
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
