import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  getGuildSettings,
  countBirthdaysForGuild,
  getBirthdaysFor,
} from './db.js';
import { isAdmin, inspectBotPermissions } from './utils/permissions.js';
import {
  runDailyJob,
  getLastRunSummary,
  getNextRunsByRegion,
} from './scheduler.js';
import { CID, buildDebugPanel, buildPanelMessage } from './ui.js';
import { todayInTimezone, formatBirthday } from './utils/dates.js';
import { logger, getRecentErrors } from './logger.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

// Build the state object that buildDebugPanel renders.
export async function buildDebugState(interaction) {
  const settings = await getGuildSettings(interaction.guildId);
  const birthdayCount = await countBirthdaysForGuild(interaction.guildId).catch(() => 0);
  return {
    guildId: interaction.guildId,
    settings,
    birthdayCount,
    lastRun: getLastRunSummary(),
    nextRunsByRegion: getNextRunsByRegion(),
  };
}

export async function handleDebugButton(interaction) {
  if (!(await isAdmin(interaction))) {
    return interaction.reply({ content: 'You do not have permission to do that.', ...EPHEMERAL });
  }
  const id = interaction.customId;

  if (id === CID.debug.perms) return await onCheckPermissions(interaction);
  if (id === CID.debug.testAnnounce) return await onTestAnnouncement(interaction);
  if (id === CID.debug.testRole) return await onTestRole(interaction);
  if (id === CID.debug.today) return await onCheckToday(interaction);
  if (id === CID.debug.errors) return await onViewErrors(interaction);
  if (id === CID.debug.rebuildPanel) return await onRebuildPanel(interaction);
}

async function onCheckPermissions(interaction) {
  await interaction.deferReply(EPHEMERAL);
  const settings = await getGuildSettings(interaction.guildId);
  const checks = await inspectBotPermissions(interaction.guild, settings);
  const lines = checks.map((c) => `${c.ok ? '✅' : '❌'} **${c.check}** — ${c.detail || (c.ok ? 'ok' : 'missing')}`);
  const allOk = checks.every((c) => c.ok);
  await interaction.editReply({
    content: `${allOk ? '✅ All permission checks passed.' : '⚠️ Some checks failed.'}\n\n${lines.join('\n')}`,
  });
}

async function onTestAnnouncement(interaction) {
  await interaction.deferReply(EPHEMERAL);
  const settings = await getGuildSettings(interaction.guildId);
  if (!settings?.announcement_channel_id) {
    return interaction.editReply('No announcement channel configured. Use `/birthday-setup` first.');
  }
  try {
    await runDailyJob(interaction.client, {
      test: true,
      region: 'americas',
      guildId: interaction.guildId,
      testUserId: interaction.user.id,
      testUsername: interaction.user.username,
      notes: `test announcement triggered by ${interaction.user.tag}`,
    });
    await reportToErrorChannel(interaction, `${interaction.user.tag} ran TEST announcement.`, 'info');
    return interaction.editReply('🎉 Test birthday announcement sent successfully.');
  } catch (err) {
    logger.error('Test announcement failed', { guild_id: interaction.guildId, error: err });
    await reportToErrorChannel(interaction, 'Test announcement failed', 'error', err);
    return interaction.editReply('Test announcement failed. Check the error log channel for details.');
  }
}

async function onTestRole(interaction) {
  await interaction.deferReply(EPHEMERAL);
  const settings = await getGuildSettings(interaction.guildId);
  if (!settings?.birthday_role_id) {
    return interaction.editReply('No birthday role configured. Use `/birthday-setup` first.');
  }
  const guild = interaction.guild;
  const me = guild.members.me;
  const role = guild.roles.cache.get(settings.birthday_role_id)
    ?? (await guild.roles.fetch(settings.birthday_role_id).catch(() => null));

  if (!role) return interaction.editReply('Configured birthday role no longer exists.');
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.editReply('Bot lacks `Manage Roles` permission.');
  }
  if (me.roles.highest.comparePositionTo(role) <= 0) {
    return interaction.editReply(`Birthday role @${role.name} is at or above the bot's highest role.`);
  }

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return interaction.editReply('Could not resolve your member record.');

  try {
    await member.roles.add(role, 'Birthday role test (admin debug panel)');
    setTimeout(() => {
      member.roles.remove(role, 'Birthday role test cleanup').catch(() => {});
    }, 5_000);
    await reportToErrorChannel(interaction, `${interaction.user.tag} ran TEST role assignment (auto-cleared in 5s).`, 'info');
    return interaction.editReply(`✅ Assigned @${role.name} to you for 5 seconds, then cleared.`);
  } catch (err) {
    logger.error('Test role failed', { guild_id: interaction.guildId, error: err });
    await reportToErrorChannel(interaction, 'Test role assignment failed', 'error', err);
    return interaction.editReply('Failed to assign the role. See the error log channel.');
  }
}

async function onCheckToday(interaction) {
  await interaction.deferReply(EPHEMERAL);
  const { month, day, isoDate } = todayInTimezone();
  const all = await getBirthdaysFor(month, day);
  const here = all.filter((r) => r.guild_id === interaction.guildId);
  if (here.length === 0) {
    return interaction.editReply(`No birthdays found for **${formatBirthday(month, day)}** (${isoDate}) in this server.`);
  }
  const lines = here.map(
    (r) => `• <@${r.user_id}> — ${formatBirthday(r.month, r.day)}`
  );
  return interaction.editReply(
    `**Today's birthdays (${formatBirthday(month, day)} · ${isoDate}):**\n${lines.join('\n')}`
  );
}

async function onViewErrors(interaction) {
  await interaction.deferReply(EPHEMERAL);
  const recent = getRecentErrors({ guildId: interaction.guildId, limit: 10 });
  if (recent.length === 0) return interaction.editReply('No recent errors. 🎉');
  const blob = recent
    .map((r) => {
      const errPart = r.error ? ` — ${r.error.name ?? ''}: ${r.error.message ?? ''}` : '';
      return `[${r.timestamp}] [${r.level}] ${r.message}${errPart}`;
    })
    .join('\n');
  // Discord caps message length; chunk if needed via attachment.
  if (blob.length < 1900) {
    return interaction.editReply('```\n' + blob + '\n```');
  }
  return interaction.editReply({
    content: 'Recent errors (truncated for chat — full file attached):',
    files: [{ attachment: Buffer.from(blob, 'utf8'), name: 'recent-errors.txt' }],
  });
}

async function onRebuildPanel(interaction) {
  await interaction.deferReply(EPHEMERAL);
  const settings = await getGuildSettings(interaction.guildId);
  const channelId = settings?.collection_channel_id ?? interaction.channelId;
  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    return interaction.editReply('Could not resolve the collection channel. Configure one with `/birthday-setup`.');
  }
  try {
    await channel.send(buildPanelMessage());
    await reportToErrorChannel(interaction, `${interaction.user.tag} rebuilt the birthday panel in <#${channel.id}>.`, 'info');
    return interaction.editReply(`✅ Posted a fresh panel in <#${channel.id}>.`);
  } catch (err) {
    logger.error('Rebuild panel failed', { guild_id: interaction.guildId, error: err });
    await reportToErrorChannel(interaction, 'Rebuild panel failed', 'error', err);
    return interaction.editReply('Failed to post the panel. See the error log channel.');
  }
}

// ---------- error-channel reporting ----------

export async function reportToErrorChannel(interaction, action, level = 'error', err = null) {
  try {
    const settings = await getGuildSettings(interaction.guildId);
    const channelId = settings?.error_log_channel_id;
    if (!channelId) return;
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) return;
    const lines = [
      `**[${level.toUpperCase()}]** ${action}`,
      `• Time: \`${new Date().toISOString()}\``,
      `• Server ID: \`${interaction.guildId}\``,
      `• Triggered by: <@${interaction.user.id}>`,
    ];
    if (err) {
      lines.push(`• Error: \`${(err.name ?? 'Error')}: ${(err.message ?? String(err)).slice(0, 500)}\``);
      lines.push(`• Retry recommended: ${shouldRetry(err) ? 'yes' : 'no'}`);
    }
    await channel.send({ content: lines.join('\n'), allowedMentions: { parse: [] } });
  } catch {
    // never let error reporting itself throw
  }
}

function shouldRetry(err) {
  if (!err) return false;
  const msg = String(err.message ?? '').toLowerCase();
  return /timeout|temporar|rate ?limit|503|504|fetch failed|ECONN/i.test(msg);
}

export { buildDebugPanel };
