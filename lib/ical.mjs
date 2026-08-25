/**
 * Minimal iCal parser for Airbnb availability feeds.
 * DTEND with VALUE=DATE is treated as exclusive (RFC 5545).
 */

const DEFAULT_TZ = 'America/Chicago';

export function unfoldIcal(raw) {
  return String(raw).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function parseParams(raw) {
  const params = {};
  for (const part of raw.split(';').slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return params;
}

function ymd(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function dateFromParts(year, month, day, hour, minute, second, tz, isUtc) {
  if (isUtc) {
    const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(dt);
  }
  // Floating or TZID local time: take the calendar date as listed.
  return ymd(year, month, day);
}

export function parseIcalDate(value, params = {}, tz = DEFAULT_TZ) {
  const isDate = (params.VALUE || '').toUpperCase() === 'DATE' || /^\d{8}$/.test(value);
  const zone = params.TZID || tz;
  if (isDate) {
    const compact = value.slice(0, 8);
    return {
      date: ymd(compact.slice(0, 4), compact.slice(4, 6), compact.slice(6, 8)),
      isDate: true,
    };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) throw new Error(`Unsupported iCal date: ${value}`);
  return {
    date: dateFromParts(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], zone, m[7] === 'Z'),
    isDate: false,
  };
}

function parseVevent(block, tz) {
  const fields = {};
  for (const line of block.split('\n')) {
    if (!line || line.startsWith('BEGIN:') || line.startsWith('END:')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const name = left.split(';')[0].toUpperCase();
    fields[name] = { value, params: parseParams(left) };
  }
  if (!fields.DTSTART) return null;
  const start = parseIcalDate(fields.DTSTART.value, fields.DTSTART.params, tz);
  let endDate = start.date;
  let endIsDate = start.isDate;
  if (fields.DTEND) {
    const end = parseIcalDate(fields.DTEND.value, fields.DTEND.params, tz);
    endDate = end.date;
    endIsDate = end.isDate;
  } else if (fields.DURATION) {
    const dur = fields.DURATION.value.toUpperCase();
    const days = Number((dur.match(/(\d+)D/) || [])[1] || 0);
    endDate = addDays(start.date, days || 1);
    endIsDate = true;
  } else {
    endDate = addDays(start.date, 1);
    endIsDate = true;
  }

  // RFC 5545: DATE DTEND is exclusive. Timed DTEND that lands on a later
  // calendar day is treated as checkout (exclusive of that morning).
  let lastInclusive = endDate;
  if (endIsDate || endDate > start.date) {
    lastInclusive = addDays(endDate, -1);
  }
  if (lastInclusive < start.date) lastInclusive = start.date;

  const uid = fields.UID?.value?.trim() || null;
  const summary = fields.SUMMARY?.value?.trim() || 'Airbnb';
  return {
    uid,
    event_date: start.date,
    end_date: lastInclusive,
    summary,
  };
}

export function parseAirbnbIcal(raw, tz = DEFAULT_TZ) {
  const text = unfoldIcal(raw);
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new Error('Response is not a VCALENDAR');
  }
  const hasVevent = /BEGIN:VEVENT/i.test(text);
  const events = [];
  const chunks = text.split(/BEGIN:VEVENT/i).slice(1);
  for (const chunk of chunks) {
    const body = 'BEGIN:VEVENT' + chunk.split(/END:VEVENT/i)[0] + '\nEND:VEVENT';
    const parsed = parseVevent(body, tz);
    if (parsed) events.push(parsed);
  }
  if (hasVevent && events.length === 0) {
    throw new Error('VEVENT blocks were present but none could be parsed');
  }
  return events;
}

export { addDays };
