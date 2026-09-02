/**
 * Display formatting.
 *
 * Every function here returns an em dash for a missing value rather than a
 * zero. The statistics layer is careful to return null where a number does not
 * exist, and rendering that null as "0.00" would throw the honesty away at the
 * last step.
 */

export const DASH = '—';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function money(x, { sign = false, dp = 2 } = {}) {
  if (x == null || !Number.isFinite(x)) return DASH;
  const abs = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const prefix = x < 0 ? '-$' : sign ? '+$' : '$';
  return `${prefix}${abs}`;
}

export function dollars(x, { sign = true } = {}) {
  if (x == null || !Number.isFinite(x)) return DASH;
  const abs = Math.round(Math.abs(x)).toLocaleString('en-US');
  return `${x < 0 ? '-$' : sign ? '+$' : '$'}${abs}`;
}

export function price(x) {
  if (x == null || !Number.isFinite(x)) return DASH;
  // Sub-dollar names need more places; anything else reads better without them.
  return x < 10 ? x.toFixed(3).replace(/0$/, '') : x.toFixed(2);
}

export function rval(x, { dp = 2 } = {}) {
  if (x == null || !Number.isFinite(x)) return DASH;
  return `${x >= 0 ? '+' : ''}${x.toFixed(dp)}R`;
}

export function pct(x, { dp = 0 } = {}) {
  if (x == null || !Number.isFinite(x)) return DASH;
  return `${(x * 100).toFixed(dp)}%`;
}

export function num(x, dp = 2) {
  if (x == null || !Number.isFinite(x)) return DASH;
  return x.toFixed(dp);
}

/** Class name for a signed value. Neutral at zero rather than green. */
export function tone(x) {
  if (x == null || !Number.isFinite(x) || x === 0) return '';
  return x > 0 ? 'pos' : 'neg';
}

export function shortDate(iso) {
  if (!iso) return DASH;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function dayAndTime(iso) {
  if (!iso) return DASH;
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(
    'en-US',
    { hour: '2-digit', minute: '2-digit', hour12: false }
  )}`;
}

export function daysBetween(a, b = new Date()) {
  if (!a) return null;
  return Math.max(1, Math.round((new Date(b) - new Date(a)) / 86400000));
}

/* ------------------------------------------------------------------ */
/* The R rail                                                          */
/* ------------------------------------------------------------------ */

/**
 * A proportional axis from the stop to a little past 2R, with the entry, the
 * milestones and the current price placed by true position.
 *
 * The scale deliberately extends past 2R rather than ending at the current
 * price, so that a trade at +0.3R and a trade at +1.9R do not both render as a
 * bar most of the way across. The rail's job is to show where a trade sits in
 * its own risk terms at a glance; rescaling to fit the marker would destroy
 * exactly that.
 */
export function rail({ entry, stop, activeStop, current, riskPerShare }) {
  if (![entry, stop, riskPerShare].every(Number.isFinite) || riskPerShare <= 0) return '';

  const lo = Math.min(stop, activeStop ?? stop, current ?? entry) - riskPerShare * 0.15;
  const hiCandidates = [entry + riskPerShare * 2.2, current ?? entry, activeStop ?? stop];
  const hi = Math.max(...hiCandidates) + riskPerShare * 0.15;
  const span = hi - lo;
  if (!(span > 0)) return '';

  const at = (v) => `${(((v - lo) / span) * 100).toFixed(2)}%`;
  const inRange = (v) => Number.isFinite(v) && v >= lo && v <= hi;

  const marks = [
    { v: activeStop ?? stop, cls: 'stop', text: 'stop' },
    { v: entry, cls: 'entry', text: 'entry' },
    { v: entry + riskPerShare, cls: '', text: '1R' },
    { v: entry + riskPerShare * 2, cls: '', text: '2R' },
  ].filter((m) => inRange(m.v));

  const now = Number.isFinite(current) ? current : null;
  const fillFrom = now != null ? Math.min(entry, now) : entry;
  const fillTo = now != null ? Math.max(entry, now) : entry;
  const fillTone = now == null ? '' : now > entry ? 'pos' : now < entry ? 'neg' : '';

  return `
    <div class="rail" role="img" aria-label="Position from stop to 2R">
      <div class="rail-track"></div>
      ${
        now != null
          ? `<div class="rail-fill ${fillTone}" style="left:${at(fillFrom)};width:${(
              ((fillTo - fillFrom) / span) * 100
            ).toFixed(2)}%"></div>`
          : ''
      }
      ${marks
        .map(
          (m) => `<div class="rail-tick ${m.cls}" style="left:${at(m.v)}"></div>
                  <div class="rail-label" style="left:${at(m.v)}">${m.text}</div>`
        )
        .join('')}
      ${now != null ? `<div class="rail-now" style="left:${at(now)}"></div>` : ''}
    </div>`;
}
