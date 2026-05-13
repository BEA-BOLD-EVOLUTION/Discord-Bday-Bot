// Parse birthdays.jsonl produced by dumpChannel.js and (optionally) insert into DB.
//
// Usage:
//   node src/scripts/parseBirthdays.js <guildId> [--file birthdays.jsonl] [--commit] [--overwrite] [--region americas]
//
// Default is dry-run: prints what *would* be inserted, plus what couldn't be parsed.
// Add --commit to actually write to the DB.
// Add --overwrite to replace existing rows for the same (guild,user).
//
// Per-user dedupe: keeps the MOST RECENT parseable message for each author.

import fs from 'node:fs';
import readline from 'node:readline';
import { bulkInsertBirthdays } from '../db.js';

const args = process.argv.slice(2);
const guildId = args.find((a) => /^\d{5,}$/.test(a));
const file = (args.find((a) => a.startsWith('--file='))?.split('=')[1]) || 'birthdays.jsonl';
const region = (args.find((a) => a.startsWith('--region='))?.split('=')[1]) || 'americas';
const commit = args.includes('--commit');
const overwrite = args.includes('--overwrite');
const excludeIds = new Set(
  (args.find((a) => a.startsWith('--exclude='))?.split('=')[1] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

if (!guildId) {
  console.error('Usage: node src/scripts/parseBirthdays.js <guildId> [--file=birthdays.jsonl] [--commit] [--overwrite] [--region=americas]');
  process.exit(1);
}

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
function parseBirthday(raw) {
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

async function main() {
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  // Collect messages per user, sorted oldest -> newest, last parseable wins.
  const byUser = new Map(); // user_id -> { username, ts, month, day }
  const unparsed = []; // { author, content }
  let total = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (!m.author_id || !m.content) continue;
    total++;
    const parsed = parseBirthday(m.content);
    if (!parsed) {
      unparsed.push({ author: m.author, content: m.content });
      continue;
    }
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

  const rows = [...byUser.entries()]
    .filter(([user_id]) => !excludeIds.has(user_id))
    .map(([user_id, v]) => ({
    guild_id: guildId,
    user_id,
    username: v.username,
    month: v.month,
    day: v.day,
    birthday_public: true,
    region,
  }));

  console.log(`\n=== Parsed ${rows.length} unique users from ${total} messages ===\n`);
  rows
    .sort((a, b) => a.month - b.month || a.day - b.day)
    .forEach((r) => console.log(`${String(r.month).padStart(2,'0')}/${String(r.day).padStart(2,'0')}  ${r.username.padEnd(25)}  ${r.user_id}`));

  if (unparsed.length) {
    console.log(`\n=== ${unparsed.length} messages could not be parsed (likely conversational) ===`);
    unparsed.slice(0, 30).forEach((u) => console.log(`  [${u.author}] ${u.content.slice(0, 80)}`));
    if (unparsed.length > 30) console.log(`  ...and ${unparsed.length - 30} more`);
  }

  if (!commit) {
    console.log('\n(dry-run) re-run with --commit to write to the database.');
    return;
  }

  console.log(`\nWriting to DB (overwrite=${overwrite})...`);
  const result = await bulkInsertBirthdays(rows, { overwrite });
  console.log(`Done. inserted=${result.inserted} skipped=${result.skipped}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
