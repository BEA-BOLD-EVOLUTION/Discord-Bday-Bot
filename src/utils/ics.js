// iCalendar (.ics) generation for birthdays.
//
// Birthdays are stored as month + day only (no year), so every event is an
// all-day, yearly-recurring VEVENT. We anchor DTSTART to a fixed leap year so
// that Feb 29 is always a valid start date; per RFC 5545 a Feb 29 + yearly
// recurrence then correctly recurs only in leap years.
//
// The output is consumed identically by Google Calendar (import or
// subscribe-from-URL), Apple Calendar / iCal, and Outlook.

import { formatZodiac } from './zodiac.js';
import { regionLabel } from '../regions.js';

const ANCHOR_YEAR = 2000; // divisible by 400 → leap year → Feb 29 is valid

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Escape text per RFC 5545 §3.3.11 (TEXT): backslash, semicolon, comma, and
// newlines are the only characters that must be escaped.
function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

// Fold a content line to <=75 octets (RFC 5545 §3.1). Continuation lines begin
// with a single space, which counts toward the octet budget. We split on whole
// code points so multi-byte characters (emoji) are never cut in half.
function foldLine(line) {
  let out = '';
  let cur = '';
  let curBytes = 0;
  let first = true;
  for (const cp of Array.from(line)) {
    const b = Buffer.byteLength(cp, 'utf8');
    const limit = first ? 75 : 74; // continuation line spends 1 byte on its leading space
    if (curBytes + b > limit) {
      out += (out ? '\r\n ' : '') + cur;
      cur = cp;
      curBytes = b;
      first = false;
    } else {
      cur += cp;
      curBytes += b;
    }
  }
  out += (out ? '\r\n ' : '') + cur;
  return out;
}

function formatDateUtc(year, month, day) {
  return `${year}${pad2(month)}${pad2(day)}`;
}

// All-day DTEND is exclusive, so it must be the day after DTSTART. Compute it in
// UTC against the anchor year to handle month/year rollover (incl. Feb 29).
function nextDay(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + 1);
  return formatDateUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function formatDateTimeUtc(d) {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

/**
 * Build an iCalendar document from birthday rows.
 *
 * @param {object} args
 * @param {string} [args.calendarName] Display name (X-WR-CALNAME).
 * @param {string} [args.prodId] PRODID identifier.
 * @param {Array<{guild_id?:string,user_id?:string,username?:string,displayName?:string,month:number,day:number,region?:string,uid?:string}>} [args.birthdays]
 * @returns {string} CRLF-delimited .ics text.
 */
export function buildBirthdayIcs({
  calendarName = 'Birthdays',
  prodId = '-//OrbitDay//Birthday Bot//EN',
  birthdays = [],
} = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `NAME:${escapeText(calendarName)}`,
    'X-PUBLISHED-TTL:PT12H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
  ];

  const dtstamp = formatDateTimeUtc(new Date());

  for (const b of birthdays) {
    const month = Number(b.month);
    const day = Number(b.day);
    if (!Number.isInteger(month) || !Number.isInteger(day)) continue;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;

    const name = b.displayName || b.username || b.user_id || 'Someone';
    const zodiac = formatZodiac(month, day);
    const uid = b.uid || `bday-${b.guild_id ?? 'guild'}-${b.user_id ?? name}@orbitday`;

    const descParts = [];
    if (zodiac) descParts.push(zodiac);
    if (b.region) descParts.push(`Region: ${regionLabel(b.region)}`);

    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(uid)}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${formatDateUtc(ANCHOR_YEAR, month, day)}`,
      `DTEND;VALUE=DATE:${nextDay(ANCHOR_YEAR, month, day)}`,
      'RRULE:FREQ=YEARLY',
      `SUMMARY:🎂 ${escapeText(name)}${zodiac ? ` — ${escapeText(zodiac)}` : ''}`
    );
    if (descParts.length) lines.push(`DESCRIPTION:${escapeText(descParts.join(' · '))}`);
    lines.push('TRANSP:TRANSPARENT', 'CATEGORIES:Birthday', 'CLASS:PUBLIC', 'END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
