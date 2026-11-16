// Europe/Madrid local-time helpers built on Intl (no dependencies).
// Slot identity is the LOCAL calendar date plus the slot name, so DST changes
// can never create a second slot for the same day.

const DEFAULT_TZ = 'Europe/Madrid';

function parts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(out.hour), minute: Number(out.minute), second: Number(out.second),
  };
}

export function localDateString(date = new Date(), timeZone = DEFAULT_TZ) {
  const p = parts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

function offsetMinutes(utcMs, timeZone) {
  const p = parts(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - utcMs) / 60000);
}

// Convert a local wall-clock time (YYYY-MM-DD, HH:MM) to a UTC Date.
// For a non-existent local time (spring-forward gap) the result moves forward
// to the first valid instant. For an ambiguous time (autumn fall-back) the
// earlier instant is used. Either way exactly one instant is returned.
export function zonedTimeToUtc(dateStr, hhmm, timeZone = DEFAULT_TZ) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) {
    throw new Error('Invalid local date or time');
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const candidates = new Set();
  for (const guess of [naive - offsetMinutes(naive, timeZone) * 60000,
    naive - offsetMinutes(naive - 3 * 3600000, timeZone) * 60000,
    naive - offsetMinutes(naive + 3 * 3600000, timeZone) * 60000]) {
    const p = parts(new Date(guess), timeZone);
    if (p.year === y && p.month === m && p.day === d && p.hour === hh && p.minute === mm) candidates.add(guess);
  }
  if (candidates.size) return new Date(Math.min(...candidates));
  // Gap: step forward minute by minute (max 2h) to the first valid local time.
  for (let i = 1; i <= 120; i += 1) {
    const guess = naive - offsetMinutes(naive, timeZone) * 60000 + i * 60000;
    const p = parts(new Date(guess), timeZone);
    if (p.year === y && p.month === m && p.day === d && (p.hour > hh || (p.hour === hh && p.minute >= mm))) {
      return new Date(guess);
    }
  }
  throw new Error('Unable to resolve local time');
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
