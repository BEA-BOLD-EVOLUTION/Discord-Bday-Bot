import { setLogNotifier } from './logger.js';
import { getGuildSettings } from './db.js';
import { formatRecord } from './alertFormat.js';

// Throttle: avoid spamming the alert channel with the same error in a loop.
// Key = `${guildId}|${level}|${message}` → last-sent timestamp (ms).
const SUPPRESS_WINDOW_MS = 60_000; // 1 minute
const lastSent = new Map();

// Tiny LRU-ish cap so we never grow unbounded.
function rememberSent(key, now) {
  lastSent.set(key, now);
  if (lastSent.size > 500) {
    const oldestKey = lastSent.keys().next().value;
    lastSent.delete(oldestKey);
  }
}

function shouldSuppress(key, now) {
  const prev = lastSent.get(key);
  return prev && now - prev < SUPPRESS_WINDOW_MS;
}

// Install the notifier. Called once after the Discord client is ready so we
// can resolve guilds and channels.
export function installAlertNotifier(client) {
  setLogNotifier((record) => {
    // Only guild-scoped errors get forwarded; global errors stay in stdout
    // (they have nowhere sensible to go).
    const guildId = record.guild_id;
    if (!guildId) return;

    const key = `${guildId}|${record.level}|${record.message}`;
    const now = Date.now();
    if (shouldSuppress(key, now)) return;
    rememberSent(key, now);

    // Fire-and-forget; never block the logger.
    deliver(client, guildId, record).catch(() => {});
  });
}

async function deliver(client, guildId, record) {
  let settings;
  try {
    settings = await getGuildSettings(guildId);
  } catch {
    return;
  }
  const channelId = settings?.error_log_channel_id;
  if (!channelId) return;

  const guild =
    client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return;

  const channel =
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased?.()) return;

  try {
    await channel.send({
      content: formatRecord(record),
      allowedMentions: { parse: [] },
    });
  } catch {
    // swallow — re-logging here would risk a feedback loop
  }
}
