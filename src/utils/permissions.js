import { PermissionFlagsBits } from 'discord.js';
import { getGuildSettings } from '../db.js';

export async function isAdmin(interaction) {
  if (!interaction.guild) return false;
  const member = interaction.member;
  if (!member) return false;

  // Permissions: Administrator OR ManageGuild
  const perms = member.permissions;
  if (perms?.has?.(PermissionFlagsBits.Administrator)) return true;
  if (perms?.has?.(PermissionFlagsBits.ManageGuild)) return true;

  // Configurable bot admin role
  try {
    const settings = await getGuildSettings(interaction.guildId);
    const adminRoleId = settings?.admin_role_id;
    if (adminRoleId && member.roles?.cache?.has?.(adminRoleId)) return true;
  } catch {
    // ignore
  }
  return false;
}

// Inspects the bot's effective permissions in a guild against everything the
// bot needs to do its job. Returns an array of { check, ok, detail } entries
// suitable for rendering in the admin debug panel.
export async function inspectBotPermissions(guild, settings) {
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const out = [];

  const push = (check, ok, detail = '') => out.push({ check, ok: !!ok, detail });

  if (!me) {
    push('Bot member resolved', false, 'guild.members.me missing');
    return out;
  }

  const guildPerms = me.permissions;
  push('Manage Roles (guild-wide)', guildPerms.has(PermissionFlagsBits.ManageRoles));

  const channelChecks = [
    ['Collection channel', settings?.collection_channel_id, ['ViewChannel', 'SendMessages', 'EmbedLinks']],
    ['Announcement channel', settings?.announcement_channel_id, ['ViewChannel', 'SendMessages', 'EmbedLinks']],
    ['Audit channel', settings?.audit_channel_id, ['ViewChannel', 'SendMessages']],
    ['Alert channel', settings?.error_log_channel_id, ['ViewChannel', 'SendMessages']],
  ];

  for (const [label, channelId, perms] of channelChecks) {
    if (!channelId) {
      push(label, false, 'not configured');
      continue;
    }
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      push(label, false, `channel ${channelId} not found`);
      continue;
    }
    const cp = channel.permissionsFor(me);
    if (!cp) {
      push(label, false, 'cannot read channel permissions');
      continue;
    }
    const missing = perms.filter((p) => !cp.has(PermissionFlagsBits[p]));
    push(label, missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `#${channel.name}`);
  }

  // Buttons & select menus are sent as part of message components; if SendMessages is
  // present in the relevant channel and the bot has the application.commands scope
  // (covered by the install link), no extra permission is required at runtime.
  push('Use buttons / select menus', true, 'message components require SendMessages only');

  // Birthday role checks
  if (!settings?.birthday_role_id) {
    push('Assign birthday role', false, 'birthday_role not configured');
  } else {
    const role = guild.roles.cache.get(settings.birthday_role_id)
      ?? (await guild.roles.fetch(settings.birthday_role_id).catch(() => null));
    if (!role) {
      push('Assign birthday role', false, `role ${settings.birthday_role_id} not found`);
    } else if (!guildPerms.has(PermissionFlagsBits.ManageRoles)) {
      push('Assign birthday role', false, 'bot lacks ManageRoles');
    } else if (me.roles.highest.comparePositionTo(role) <= 0) {
      push('Assign birthday role', false, `role @${role.name} is at/above the bot's highest role`);
    } else {
      push('Assign birthday role', true, `@${role.name}`);
    }
  }

  return out;
}
