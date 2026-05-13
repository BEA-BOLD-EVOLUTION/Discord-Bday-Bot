export const MONTHS = [
  { name: 'January', value: 1, days: 31 },
  { name: 'February', value: 2, days: 29 }, // allow Feb 29 per spec
  { name: 'March', value: 3, days: 31 },
  { name: 'April', value: 4, days: 30 },
  { name: 'May', value: 5, days: 31 },
  { name: 'June', value: 6, days: 30 },
  { name: 'July', value: 7, days: 31 },
  { name: 'August', value: 8, days: 31 },
  { name: 'September', value: 9, days: 30 },
  { name: 'October', value: 10, days: 31 },
  { name: 'November', value: 11, days: 30 },
  { name: 'December', value: 12, days: 31 },
];

export function monthName(m) {
  return MONTHS.find((x) => x.value === Number(m))?.name ?? null;
}

export function daysInMonth(m) {
  return MONTHS.find((x) => x.value === Number(m))?.days ?? 0;
}

export function isValidDate(month, day) {
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > daysInMonth(m)) return false;
  return true;
}

export function formatBirthday(month, day) {
  const name = monthName(month);
  return name ? `${name} ${day}` : `${month}/${day}`;
}

// Returns today's calendar date in the given IANA timezone (or system tz if
// unset). Using Intl avoids drift around DST and prevents announcements from
// firing on the wrong calendar day when the cron timezone differs from the
// host's timezone.
export function todayInTimezone(tz) {
  const now = new Date();
  if (!tz) {
    return {
      month: now.getMonth() + 1,
      day: now.getDate(),
      isoDate: toIsoDate(now),
    };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  return {
    month,
    day,
    isoDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
