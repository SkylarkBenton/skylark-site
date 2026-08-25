/**
 * Next open Fri–Sun dates for the public calendar teaser.
 * One date per weekend (first open day Fri, then Sat, then Sun).
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function fmtDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

export function formatWeekendLabel(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function startOfLocalDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d, n) {
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  return next;
}

/**
 * @param {Date} from
 * @param {(iso: string) => 'booked'|'pending'|'open'} occupancy
 * @param {{ weeks?: number, limit?: number }} [opts]
 * @returns {string[]} ISO dates, at most `limit`, one per weekend
 */
export function nextOpenWeekendDates(from, occupancy, opts = {}) {
  const weeks = opts.weeks ?? 8;
  const limit = opts.limit ?? 3;
  const start = startOfLocalDay(from);
  const found = [];
  const seenWeekend = new Set();

  for (let i = 0; i < weeks * 7 && found.length < limit; i++) {
    const day = addDays(start, i);
    const dow = day.getDay(); // 0 Sun ... 5 Fri 6 Sat
    if (dow !== 5 && dow !== 6 && dow !== 0) continue;
    const iso = fmtDate(day);
    if (occupancy(iso) !== 'open') continue;

    const weekendKey = dow === 0
      ? fmtDate(addDays(day, -2))
      : dow === 6
        ? fmtDate(addDays(day, -1))
        : iso;
    if (seenWeekend.has(weekendKey)) continue;
    seenWeekend.add(weekendKey);
    found.push(iso);
  }
  return found;
}
