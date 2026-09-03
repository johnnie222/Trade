const ZONE = 'America/New_York';
const REGULAR_OPEN = 9 * 60 + 30;
const REGULAR_CLOSE = 16 * 60;
const EXTENDED_OPEN = 4 * 60;
const EXTENDED_CLOSE = 20 * 60;

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function parts(date) {
  const out = {};
  for (const p of partsFmt.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n, 12));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((7 + weekday - first) % 7) + (n - 1) * 7;
}

function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - ((7 + last.getUTCDay() - weekday) % 7);
}

function observedFixed(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const wd = d.getUTCDay();
  if (wd === 6) return addDays({ year, month, day }, -1);
  if (wd === 0) return addDays({ year, month, day }, 1);
  return { year, month, day };
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

const key = ({ year, month, day }) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

function holidays(year) {
  const set = new Set();
  const add = (d) => set.add(key(d));
  add(observedFixed(year, 1, 1));
  add({ year, month: 1, day: nthWeekday(year, 1, 1, 3) });
  add({ year, month: 2, day: nthWeekday(year, 2, 1, 3) });
  add(addDays(easterSunday(year), -2));
  add({ year, month: 5, day: lastWeekday(year, 5, 1) });
  add(observedFixed(year, 6, 19));
  add(observedFixed(year, 7, 4));
  add({ year, month: 9, day: nthWeekday(year, 9, 1, 1) });
  add({ year, month: 11, day: nthWeekday(year, 11, 4, 4) });
  add(observedFixed(year, 12, 25));
  add(observedFixed(year + 1, 1, 1));
  return set;
}

function isTradingDay(d) {
  const wd = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return !holidays(d.year).has(key(d)) && !holidays(d.year - 1).has(key(d));
}

function zonedToUtc(y, m, d, hh, mm) {
  const desired = Date.UTC(y, m - 1, d, hh, mm, 0);
  let guess = new Date(desired);
  for (let i = 0; i < 2; i += 1) {
    const p = parts(guess);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second || 0);
    guess = new Date(guess.getTime() + (desired - represented));
  }
  return guess;
}

function targetOn(d, minuteOfDay) {
  return zonedToUtc(d.year, d.month, d.day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
}

function nextTradingDate(from, includeToday = false) {
  for (let i = includeToday ? 0 : 1; i < 12; i += 1) {
    const d = addDays(from, i);
    if (isTradingDay(d)) return d;
  }
  return addDays(from, 1);
}

function duration(ms) {
  const mins = Math.max(0, Math.ceil(ms / 60000));
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const minutes = mins % 60;
  const bits = [];
  if (days) bits.push(`${days}d`);
  if (hours) bits.push(`${hours}h`);
  if (minutes || !bits.length) bits.push(`${minutes}m`);
  return bits.slice(0, 2).join(' ');
}

function nextOpen(now, d, mode) {
  const p = parts(now);
  const minute = p.hour * 60 + p.minute;
  const openMinute = mode === 'extended' ? EXTENDED_OPEN : REGULAR_OPEN;
  if (isTradingDay(d) && minute < openMinute) return targetOn(d, openMinute);
  return targetOn(nextTradingDate(d), openMinute);
}

export function marketStatus(now = new Date(), mode = 'regular') {
  const p = parts(now);
  const d = { year: p.year, month: p.month, day: p.day };
  const minute = p.hour * 60 + p.minute;
  const tradingDay = isTradingDay(d);
  const time = timeFmt.format(now);

  if (tradingDay && minute >= REGULAR_OPEN && minute < REGULAR_CLOSE) {
    const close = targetOn(d, REGULAR_CLOSE);
    return { time, phase: 'regular', icon: '●', label: 'Market open', detail: `Closes in ${duration(close - now)}`, open: true };
  }

  if (tradingDay && minute >= EXTENDED_OPEN && minute < REGULAR_OPEN) {
    const regular = targetOn(d, REGULAR_OPEN);
    return {
      time,
      phase: 'pre',
      icon: '☀',
      label: 'Pre-market',
      detail: mode === 'extended' ? `Regular in ${duration(regular - now)}` : `Opens in ${duration(regular - now)}`,
      open: mode === 'extended',
    };
  }

  if (tradingDay && minute >= REGULAR_CLOSE && minute < EXTENDED_CLOSE) {
    if (mode === 'extended') {
      const close = targetOn(d, EXTENDED_CLOSE);
      return { time, phase: 'after', icon: '☾', label: 'After-hours', detail: `Closes in ${duration(close - now)}`, open: true };
    }
    const opening = nextOpen(now, d, mode);
    return { time, phase: 'after', icon: '☾', label: 'After-hours', detail: `Opens in ${duration(opening - now)}`, open: false };
  }

  const opening = nextOpen(now, d, mode);
  return { time, phase: 'closed', icon: '☾', label: 'Closed', detail: `Opens in ${duration(opening - now)}`, open: false };
}

export function marketStatusHtml(mode = 'regular', now = new Date()) {
  const s = marketStatus(now, mode);
  return `<div class="market-strip ${s.phase}" data-market-clock>
    <span class="market-place">New York <span class="num">${s.time}</span> ET</span>
    <span class="market-session ${s.phase === 'regular' ? 'open' : ''}">
      <span class="market-icon" aria-hidden="true">${s.icon}</span>${s.label}
    </span>
    <span class="market-countdown">${s.detail}</span>
  </div>`;
}

export function updateMarketClock(mode = 'regular', root = document) {
  const el = root.querySelector?.('[data-market-clock]');
  if (!el) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = marketStatusHtml(mode);
  el.replaceWith(wrap.firstElementChild);
}
