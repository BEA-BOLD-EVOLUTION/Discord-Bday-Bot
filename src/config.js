import './utils/loadEnv.js';

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}

export const config = {
  discord: {
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    devGuildId: process.env.DISCORD_DEV_GUILD_ID?.trim() || null,
    // Opt-in: (re)register slash commands automatically on startup so a redeploy
    // keeps Discord in sync without a separate `npm run register` step.
    registerOnBoot: process.env.REGISTER_ON_BOOT === 'true',
  },
  supabase: {
    url: required('SUPABASE_URL'),
    serviceKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },
  calendar: {
    // Live .ics subscription feed. On by default; set CALENDAR_FEED_ENABLED=false
    // to skip starting the HTTP server entirely (the downloadable export command
    // still works regardless).
    enabled: process.env.CALENDAR_FEED_ENABLED !== 'false',
    // Most hosts (Railway, etc.) inject PORT for the publicly-exposed port.
    port: Number(process.env.PORT || process.env.CALENDAR_PORT || 8080),
    // Public base URL of this bot, e.g. https://your-bot.up.railway.app — needed
    // so /birthday-calendar-feed can print a full subscribe link. Trailing
    // slashes are trimmed.
    publicUrl: process.env.CALENDAR_PUBLIC_URL?.trim().replace(/\/+$/, '') || null,
  },
};
