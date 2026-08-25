export const DEFAULT_TZ = 'America/Chicago';

export function unfoldIcal(raw: string): string {
  return String(raw).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function parseParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const part of raw.split(';').slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return params;
}

function ymd(year: number | string, month: number | string, day: number | string): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function dateFromParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
  isUtc: boolean,
): string {
  if (isUtc) {
    const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(dt);
  }
  return ymd(year, month, day);
}

export function parseIcalDate(
  value: string,
  params: Record<string, string> = {},
  tz = DEFAULT_TZ,
): { date: string; isDate: boolean } {
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

function parseVevent(block: string, tz: string) {
  const fields: Record<string, { value: string; params: Record<string, string> }> = {};
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

  let lastInclusive = endDate;
  if (endIsDate || endDate > start.date) {
    lastInclusive = addDays(endDate, -1);
  }
  if (lastInclusive < start.date) lastInclusive = start.date;

  return {
    uid: fields.UID?.value?.trim() || null,
    event_date: start.date,
    end_date: lastInclusive,
    summary: fields.SUMMARY?.value?.trim() || 'Airbnb',
  };
}

export type FeedEvent = {
  uid: string | null;
  event_date: string;
  end_date: string;
  summary: string;
};

export function parseAirbnbIcal(raw: string, tz = DEFAULT_TZ): FeedEvent[] {
  const text = unfoldIcal(raw);
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new Error('Response is not a VCALENDAR');
  }
  const hasVevent = /BEGIN:VEVENT/i.test(text);
  const events: FeedEvent[] = [];
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

export async function fetchIcalWithRetry(url: string, attempts = 5): Promise<string> {
  let lastError: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/calendar, text/plain, */*',
        },
        redirect: 'follow',
      });
      if (res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504) {
        lastError = new Error(`Airbnb iCal HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Airbnb iCal HTTP ${res.status}`);
      }
      const text = await res.text();
      if (!/BEGIN:VCALENDAR/i.test(text)) {
        throw new Error('Airbnb iCal body was not a calendar');
      }
      return text;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw lastError || new Error('Airbnb iCal fetch failed');
}
