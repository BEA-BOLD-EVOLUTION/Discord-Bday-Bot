// Free-form birthday text parser, shared by the CLI dump tool
// (src/scripts/parseBirthdays.js) and the /birthday-import-channel
// slash command (src/commands.js).
//
// All functions are pure — no I/O, no Discord/Supabase coupling.

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function valid(month, day) {
  return month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1];
}

// Try to extract {month, day} from free-form text. Returns null if no match.
export function parseBirthday(raw) {
  if (!raw) return null;
  // Strip slash-command prefix, the literal word "set", and common labels.
  // Note: NO word-boundary on "set" because users write things like "03/14set".
  let text = raw
    .toLowerCase()
    .replace(/\/?set/g, ' ')
    .replace(/birthday|bday|b-day|dob|:|🎂|🎉/g, ' ')
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  // 1) Numeric MM/DD or M-D or M.D (year optional, ignored). No word boundaries
  //    so things like "03/14set" → "03/14 " still match cleanly.
  let m = text.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.]\d{2,4})?/);
  if (m) {
    const mo = parseInt(m[1], 10);
    const da = parseInt(m[2], 10);
    if (valid(mo, da)) return { month: mo, day: da };
    if (valid(da, mo)) return { month: da, day: mo };
  }

  // 1b) Bare 4-digit MMDD (e.g. "0302", "1119"). Try MMDD first, then DDMM.
  m = text.match(/(?<!\d)(\d{4})(?!\d)/);
  if (m) {
    const s = m[1];
    const a = parseInt(s.slice(0, 2), 10);
    const b = parseInt(s.slice(2, 4), 10);
    if (valid(a, b)) return { month: a, day: b };
    if (valid(b, a)) return { month: b, day: a };
  }

  // 2) "Month Day"  (e.g. "May 30", "october 28")
  const monthNames = Object.keys(MONTHS).join('|');
  m = text.match(new RegExp(`\\b(${monthNames})\\b\\s*(\\d{1,2})\\b`));
  if (m) {
    const mo = MONTHS[m[1]];
    const da = parseInt(m[2], 10);
    if (valid(mo, da)) return { month: mo, day: da };
  }

  // 3) "Day Month"  (e.g. "30 May")
  m = text.match(new RegExp(`\\b(\\d{1,2})\\s*(${monthNames})\\b`));
  if (m) {
    const da = parseInt(m[1], 10);
    const mo = MONTHS[m[2]];
    if (valid(mo, da)) return { month: mo, day: da };
  }

  return null;
}

// Aggregate a stream of messages into per-author birthday rows. Keeps the
// MOST RECENT parseable message per author. Input messages must have shape:
//   { author_id, author, content, ts (ISO string or Date) }
// Returns:
//   { rows: [{user_id, username, month, day, ts}], unparsed: [{author, content}], total }
export function aggregateBirthdayMessages(messages, { excludeIds = new Set() } = {}) {
  const byUser = new Map();
  const unparsed = [];
  let total = 0;
  for (const m of messages) {
    if (!m?.author_id || !m?.content) continue;
    total++;
    const parsed = parseBirthday(m.content);
    if (!parsed) {
      unparsed.push({ author: m.author, content: m.content });
      continue;
    }
    if (excludeIds.has(m.author_id)) continue;
    const prev = byUser.get(m.author_id);
    if (!prev || new Date(m.ts) > new Date(prev.ts)) {
      byUser.set(m.author_id, {
        username: m.author,
        ts: m.ts,
        month: parsed.month,
        day: parsed.day,
      });
    }
  }
  const rows = [...byUser.entries()].map(([user_id, v]) => ({
    user_id,
    username: v.username,
    month: v.month,
    day: v.day,
    ts: v.ts,
  }));
  return { rows, unparsed, total };
}
