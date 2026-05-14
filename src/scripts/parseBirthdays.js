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
import { aggregateBirthdayMessages } from '../utils/parseBirthdays.js';

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

async function main() {
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  const messages = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { messages.push(JSON.parse(line)); } catch { /* ignore */ }
  }

  const { rows: parsedRows, unparsed, total } = aggregateBirthdayMessages(messages, { excludeIds });
  const rows = parsedRows.map((r) => ({
    guild_id: guildId,
    user_id: r.user_id,
    username: r.username,
    month: r.month,
    day: r.day,
    birthday_public: true,
    region,
  }));

  console.log(`\n=== Parsed ${rows.length} unique users from ${total} messages ===\n`);
  rows
    .sort((a, b) => a.month - b.month || a.day - b.day)
    .forEach((r) => console.log(`${String(r.month).padStart(2,'0')}/${String(r.day).padStart(2,'0')}  ${(r.username ?? '').padEnd(25)}  ${r.user_id}`));

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
