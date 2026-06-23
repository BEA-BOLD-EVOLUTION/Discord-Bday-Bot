// Pure formatting helper for alert messages. Kept in its own module (free of
// Discord/Supabase imports) so it can be unit-tested without booting the bot.

// Context fields worth surfacing in the alert body. role_id matters for the
// "Configured birthday role not found" / permission warnings — without it the
// admin can't tell which role to fix.
const CONTEXT_KEYS = ['guild_id', 'channel_id', 'user_id', 'role_id', 'region'];

export function formatRecord(record) {
  const lines = [
    `**[${record.level.toUpperCase()}]** ${record.message}`,
    `\`${record.timestamp}\``,
  ];
  if (record.error) {
    const e = record.error;
    const detail = `${e.name ?? 'Error'}: ${(e.message ?? String(e)).slice(0, 500)}`;
    lines.push(`Error: \`${detail}\``);
  }
  const ctx = {};
  for (const k of CONTEXT_KEYS) {
    if (record[k]) ctx[k] = record[k];
  }
  if (Object.keys(ctx).length) {
    lines.push('```json\n' + JSON.stringify(ctx, null, 2) + '\n```');
  }
  return lines.join('\n');
}
