// One-off: dump every message from a channel as JSONL to stdout.
// Usage:
//   node src/scripts/dumpChannel.js <channelId> > birthdays.jsonl
//
// Requires MESSAGE CONTENT INTENT enabled for the bot in the Dev Portal,
// and the bot must be a member of the guild with View Channel + Read Message History.
import { REST, Routes } from 'discord.js';
import { config } from '../config.js';

const channelId = process.argv[2];
if (!channelId) {
  console.error('Usage: node src/scripts/dumpChannel.js <channelId>');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(config.discord.token);

let before;
let total = 0;
while (true) {
  const batch = await rest.get(Routes.channelMessages(channelId), {
    query: new URLSearchParams({ limit: '100', ...(before ? { before } : {}) }),
  });
  if (!batch.length) break;
  for (const m of batch) {
    process.stdout.write(
      JSON.stringify({
        id: m.id,
        ts: m.timestamp,
        author: m.author?.username,
        author_id: m.author?.id,
        content: m.content,
      }) + '\n'
    );
  }
  total += batch.length;
  before = batch[batch.length - 1].id;
  console.error(`fetched ${total}...`);
  if (batch.length < 100) break;
}
console.error(`done: ${total} messages`);
