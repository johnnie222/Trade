/** Display formatting shared by every screen. */

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
 * Minimal capsule rail. Stop is intentionally not drawn here: it already has
 * a dedicated field in the card and adding it to the rail made the compact
 * view read like a technical axis. The rail's single job is progress through
 * Entry -> 1R -> 2R, with a current-price marker.
 */
export function rail({ entry, current, riskPerShare }) {
  if (![entry, riskPerShare].every(Number.isFinite) || riskPerShare <= 0) return '';

  const nowR = Number.isFinite(current) ? (current - entry) / riskPerShare : null;
  const minR = Math.min(-0.35, nowR == null ? 0 : nowR - 0.12);
  const maxR = Math.max(2.35, nowR == null ? 2.35 : nowR + 0.18);
  const span = maxR - minR;
  const atR = (r) => `${(((r - minR) / span) * 100).toFixed(2)}%`;

  const fillFromR = nowR == null ? 0 : Math.min(0, nowR);
  const fillToR = nowR == null ? 0 : Math.max(0, nowR);
  const fillTone = nowR == null ? '' : nowR > 0 ? 'pos' : nowR < 0 ? 'neg' : '';
  const milestones = [
    { r: 0, text: 'entry', cls: 'entry' },
    { r: 1, text: '1R', cls: '' },
    { r: 2, text: '2R', cls: '' },
  ];

  return `
    <div class="rail" role="img" aria-label="${nowR == null ? 'R progress' : `Current position ${nowR.toFixed(2)} R`}">
      <div class="rail-track"></div>
      ${
        nowR != null
          ? `<div class="rail-fill ${fillTone}" style="left:${atR(fillFromR)};width:${(
              ((fillToR - fillFromR) / span) * 100
            ).toFixed(2)}%"></div>`
          : ''
      }
      ${milestones
        .map(
          (m) => `<div class="rail-dot ${m.cls}" style="left:${atR(m.r)}"></div>
                  <div class="rail-label" style="left:${atR(m.r)}">${m.text}</div>`
        )
        .join('')}
      ${nowR != null ? `<div class="rail-now ${fillTone}" style="left:${atR(nowR)}"></div>` : ''}
    </div>`;
}
