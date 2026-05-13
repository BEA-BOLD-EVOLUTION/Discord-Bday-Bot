import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  getGuildSettings,
  countBirthdaysForGuild,
  getBirthdaysFor,
  getGuildBirthdaysInMonthRange,
  claimAnnouncement,
} from './db.js';
import { isAdmin, inspectBotPermissions } from './utils/permissions.js';
import {
  runDailyJob,
  getLastRunSummary,
  getNextRunsByRegion,
} from './scheduler.js';
import { CID, buildDebugPanel, buildPanelMessage } from './ui.js';
import { todayInTimezone, formatBirthday } from './utils/dates.js';
import { formatZodiac, zodiacFor } from './utils/zodiac.js';
import { fetchDailyHoroscope, horoscopeEnabled, threadsEnabled } from './utils/horoscope.js';
import { logger, getRecentErrors } from './logger.js';

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Embed accent color keyed to the zodiac element (mirrors scheduler.js).
function elementColor(element) {
  switch (element) {
    case 'Fire':  return 0xff5a3c;
    case 'Earth': return 0x7a8f3d;
    case 'Air':   return 0x8ec5ff;
    case 'Water': return 0x5aa2e6;
    default:      return 0xff7ab6;
  }
}

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
  if (id === CID.debug.catchUpMonth) return await onCatchUpMonth(interaction);
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

// Posts a single belated announcement for any birthday earlier this month
// that wasn't announced yet (e.g. bot was offline that day). Idempotent:
// each entry is claimed in `birthday_announcements` so re-clicking, or the
// scheduler later catching up, won't double-post.
async function onCatchUpMonth(interaction) {
  await interaction.deferReply(EPHEMERAL);
  const settings = await getGuildSettings(interaction.guildId);
  if (!settings?.announcement_channel_id) {
    return interaction.editReply('No announcement channel configured. Use `/birthday-config` first.');
  }

  const { month, day: today, isoDate: todayIso } = todayInTimezone();
  if (today < 2) {
    return interaction.editReply(`Nothing to catch up — today is ${todayIso}.`);
  }

  const year = todayIso.slice(0, 4);
  const mm = String(month).padStart(2, '0');

  // Earlier this month, NOT including today (today is the scheduler's job).
  const candidates = await getGuildBirthdaysInMonthRange(interaction.guildId, month, 1, today - 1);
  if (candidates.length === 0) {
    return interaction.editReply(`No birthdays earlier this month to catch up on.`);
  }

  // Claim each (guild, user, original-date). Anyone already claimed
  // (already announced on their actual day) is skipped.
  const missed = [];
  let alreadyAnnounced = 0;
  for (const row of candidates) {
    const dd = String(row.day).padStart(2, '0');
    const isoForRow = `${year}-${mm}-${dd}`;
    let claimed = false;
    try {
      claimed = await claimAnnouncement(interaction.guildId, row.user_id, isoForRow);
    } catch (err) {
      logger.error('Catch-up claim failed', { guild_id: interaction.guildId, user_id: row.user_id, error: err });
      continue;
    }
    if (claimed) missed.push(row);
    else alreadyAnnounced++;
  }

  if (missed.length === 0) {
    return interaction.editReply(
      `Nothing to post — all ${alreadyAnnounced} earlier birthday(s) this month were already announced.`
    );
  }

  const channel = await interaction.guild.channels
    .fetch(settings.announcement_channel_id)
    .catch(() => null);
  if (!channel?.isTextBased?.()) {
    return interaction.editReply('Announcement channel is missing or inaccessible.');
  }

  const lines = missed.map((r) => {
    const z = formatZodiac(r.month, r.day);
    const base = `• <@${r.user_id}> — ${formatBirthday(r.month, r.day)}`;
    return z ? `${base} · ${z}` : base;
  });
  const content = [
    `🎂 **Belated Happy Birthday!**`,
    `_We missed these earlier this month — sending love now:_`,
    '',
    ...lines,
  ].join('\n');

  let sentMessage = null;
  try {
    sentMessage = await channel.send({
      content,
      // Ping the honorees so they actually see it.
      allowedMentions: { users: missed.map((r) => r.user_id) },
    });
  } catch (err) {
    logger.error('Catch-up announcement send failed', { guild_id: interaction.guildId, error: err });
    await reportToErrorChannel(interaction, 'Catch-up announcement failed', 'error', err);
    return interaction.editReply('Failed to post the catch-up message. See the error log channel.');
  }

  // Horoscope embeds — one per unique zodiac sign across the missed batch,
  // posted in a thread off the belated message (or inline if threads are
  // disabled / unsupported). Best-effort; failures are logged and skipped.
  if (sentMessage && horoscopeEnabled()) {
    // Group missed birthdays by zodiac sign id so each sign gets exactly
    // one horoscope embed, listing whose belated birthday it covers.
    const bySign = new Map();
    for (const r of missed) {
      const sign = zodiacFor(r.month, r.day);
      if (!sign) continue;
      if (!bySign.has(sign.id)) bySign.set(sign.id, { sign, members: [] });
      bySign.get(sign.id).members.push(r);
    }

    if (bySign.size > 0) {
      let target = channel;
      if (threadsEnabled() && typeof sentMessage.startThread === 'function') {
        const thread = await sentMessage
          .startThread({
            name: `🔮 Belated Horoscopes · ${MONTH_NAMES[month - 1]}`,
            autoArchiveDuration: 1440,
            reason: 'OrbitDay belated horoscope thread',
          })
          .catch((err) => {
            logger.warn('Failed to create catch-up horoscope thread; falling back to channel', {
              guild_id: interaction.guildId,
              error: err,
            });
            return null;
          });
        if (thread) target = thread;
      }

      for (const { sign, members } of bySign.values()) {
        try {
          const text = await fetchDailyHoroscope(sign.id, todayIso);
          if (!text) continue;
          const who = members
            .map((m) => `<@${m.user_id}> (${formatBirthday(m.month, m.day)})`)
            .join(', ');
          const embed = new EmbedBuilder()
            .setTitle(`${sign.emoji} Today's ${sign.name} Horoscope`)
            .setDescription(text.length > 4000 ? `${text.slice(0, 3997)}…` : text)
            .addFields({ name: 'For', value: who.slice(0, 1024) })
            .setFooter({ text: `OrbitDay · The Cosmic Birthday Bot · ${sign.element}` })
            .setColor(elementColor(sign.element));
          await target.send({
            embeds: [embed],
            allowedMentions: { users: members.map((m) => m.user_id) },
          });
        } catch (err) {
          logger.warn('Failed to send catch-up horoscope embed', {
            guild_id: interaction.guildId,
            sign: sign.id,
            error: err,
          });
        }
      }
    }
  }

  await reportToErrorChannel(
    interaction,
    `${interaction.user.tag} ran catch-up: ${missed.length} belated, ${alreadyAnnounced} already announced.`,
    'info'
  );
  return interaction.editReply(
    `✅ Posted belated message in <#${channel.id}> for ${missed.length} member(s). ` +
      `${alreadyAnnounced} were already announced and skipped.`
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
