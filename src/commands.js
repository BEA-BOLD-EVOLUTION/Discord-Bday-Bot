import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
  AttachmentBuilder,
} from 'discord.js';
import { buildPanelMessage, buildConfigPanel } from './ui.js';
import {
  getGuildSettings,
  updateGuildSettings,
  upsertBirthday,
  getBirthday,
  bulkInsertBirthdays,
  deleteBirthday,
} from './db.js';
import { MONTHS, daysInMonth, isValidDate, formatBirthday } from './utils/dates.js';
import { formatZodiac } from './utils/zodiac.js';
import { isAdmin } from './utils/permissions.js';
import { logger } from './logger.js';
import { buildDebugPanel, buildDebugState } from './debug.js';
import { REGIONS, isValidRegion, regionLabel, regionFromLocale } from './regions.js';
import { aggregateBirthdayMessages } from './utils/parseBirthdays.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

// ---------- Definitions ----------

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('birthday-panel')
    .setDescription('Post the public Birthday Club panel in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('birthday-config')
    .setDescription('Open the interactive admin config panel for this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('birthday-setup')
    .setDescription('Configure birthday bot settings for this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('collection_channel')
        .setDescription('Channel where the public birthday panel lives.')
        .addChannelTypes(ChannelType.GuildText)
    )
    .addChannelOption((o) =>
      o
        .setName('announcement_channel')
        .setDescription('Channel where birthday announcements are posted.')
        .addChannelTypes(ChannelType.GuildText)
    )
    .addRoleOption((o) =>
      o.setName('birthday_role').setDescription('Role to assign to members on their birthday.')
    )
    .addRoleOption((o) =>
      o.setName('admin_role').setDescription('Additional role allowed to manage the bot.')
    )
    .addChannelOption((o) =>
      o
        .setName('audit_channel')
        .setDescription('Channel for admin import audit logs.')
        .addChannelTypes(ChannelType.GuildText)
    )
    .addChannelOption((o) =>
      o
        .setName('error_log_channel')
        .setDescription('Alert channel: error/warning logs are auto-posted here for admins.')
        .addChannelTypes(ChannelType.GuildText)
    )
    .addBooleanOption((o) =>
      o.setName('announcements_enabled').setDescription('Enable public birthday announcements.')
    )
    .addBooleanOption((o) =>
      o.setName('role_enabled').setDescription('Enable birthday role assignment.')
    )
    .addBooleanOption((o) =>
      o.setName('debug_mode').setDescription('Enable verbose debug logging for this server.')
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('birthday-add-for')
    .setDescription('Admin: add or update a birthday for another member.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
    .addIntegerOption((o) => {
      o.setName('month').setDescription('Birth month').setRequired(true);
      for (const m of MONTHS) o.addChoices({ name: m.name, value: m.value });
      return o;
    })
    .addIntegerOption((o) =>
      o.setName('day').setDescription('Birth day (1–31)').setRequired(true).setMinValue(1).setMaxValue(31)
    )
    .addStringOption((o) => {
      o.setName('region').setDescription('Announcement region (default: Americas)').setRequired(false);
      for (const r of REGIONS) o.addChoices({ name: `${r.emoji} ${r.label}`, value: r.id });
      return o;
    })
    .toJSON(),

  new SlashCommandBuilder()
    .setName('birthday-import')
    .setDescription('Admin: bulk-import birthdays from a CSV file attachment.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addAttachmentOption((o) =>
      o.setName('csv').setDescription('CSV columns: (discord_user_id|username), month, day, [region]').setRequired(true)
    )
    .addStringOption((o) => {
      o.setName('default_region')
        .setDescription('Region used when a row has no region column (default: americas).');
      for (const r of REGIONS) o.addChoices({ name: regionLabel(r.id), value: r.id });
      return o;
    })
    .addBooleanOption((o) =>
      o.setName('overwrite').setDescription('Overwrite existing entries (default: false).')
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('birthday-import-channel')
    .setDescription('Admin: import birthdays by scanning every message in a channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Channel to scan for birthday messages.')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addStringOption((o) => {
      o.setName('region').setDescription('Region used for parsed birthdays (default: americas).');
      for (const r of REGIONS) o.addChoices({ name: regionLabel(r.id), value: r.id });
      return o;
    })
    .addBooleanOption((o) =>
      o.setName('overwrite').setDescription('Overwrite existing entries (default: false).')
    )
    .addBooleanOption((o) =>
      o.setName('dry_run').setDescription('Preview parsed birthdays without writing to the DB.')
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('birthday-view')
    .setDescription('View your saved birthday (or an admin can view another member).')
    .setDMPermission(false)
    .addUserOption((o) =>
      o.setName('member').setDescription('Member to view (admins only).').setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('birthday-remove-for')
    .setDescription('Admin: remove a birthday for a member.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('birthday-debug')
    .setDescription('Admin: open the bot debug panel for this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .toJSON(),
];

// ---------- Dispatcher ----------

export async function handleCommand(interaction) {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;

  try {
    if (name === 'birthday-panel') return await cmdPanel(interaction);
    if (name === 'birthday-config') return await cmdConfig(interaction);
    if (name === 'birthday-setup') return await cmdSetup(interaction);
    if (name === 'birthday-add-for') return await cmdAddFor(interaction);
    if (name === 'birthday-import') return await cmdImport(interaction);
    if (name === 'birthday-import-channel') return await cmdImportChannel(interaction);
    if (name === 'birthday-view') return await cmdView(interaction);
    if (name === 'birthday-remove-for') return await cmdRemoveFor(interaction);
    if (name === 'birthday-debug') return await cmdDebug(interaction);
  } catch (err) {
    logger.error('Command error', { command: name, guild_id: interaction.guildId, user_id: interaction.user?.id, error: err });
    const msg = 'Something went wrong running that command.';
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: msg, ...EPHEMERAL });
      else await interaction.reply({ content: msg, ...EPHEMERAL });
    } catch {
      /* ignore */
    }
  }
}

// ---------- Implementations ----------

async function cmdPanel(interaction) {
  if (!(await isAdmin(interaction))) {
    return interaction.reply({ content: 'You do not have permission to do that.', ...EPHEMERAL });
  }
  await interaction.channel.send(buildPanelMessage());
  await updateGuildSettings(interaction.guildId, { collection_channel_id: interaction.channelId });
  return interaction.reply({ content: '✅ Panel posted.', ...EPHEMERAL });
}

async function cmdConfig(interaction) {
  if (!(await isAdmin(interaction))) {
    return interaction.reply({ content: 'You do not have permission to do that.', ...EPHEMERAL });
  }
  const settings = await getGuildSettings(interaction.guildId);
  return interaction.reply({ ...buildConfigPanel(settings), ...EPHEMERAL });
}

async function cmdSetup(interaction) {
  if (!(await isAdmin(interaction))) {
    return interaction.reply({ content: 'You do not have permission to do that.', ...EPHEMERAL });
  }

  const patch = {};
  const collection = interaction.options.getChannel('collection_channel');
  if (collection) patch.collection_channel_id = collection.id;
  const announce = interaction.options.getChannel('announcement_channel');
  if (announce) patch.announcement_channel_id = announce.id;
  const role = interaction.options.getRole('birthday_role');
  if (role) patch.birthday_role_id = role.id;
  const adminRole = interaction.options.getRole('admin_role');
  if (adminRole) patch.admin_role_id = adminRole.id;
  const audit = interaction.options.getChannel('audit_channel');
  if (audit) patch.audit_channel_id = audit.id;
  const errorLog = interaction.options.getChannel('error_log_channel');
  if (errorLog) patch.error_log_channel_id = errorLog.id;
  const annEnabled = interaction.options.getBoolean('announcements_enabled');
  if (annEnabled !== null) patch.announcements_enabled = annEnabled;
  const roleEnabled = interaction.options.getBoolean('role_enabled');
  if (roleEnabled !== null) patch.role_enabled = roleEnabled;
  const debugMode = interaction.options.getBoolean('debug_mode');
  if (debugMode !== null) patch.debug_mode = debugMode;

  if (Object.keys(patch).length === 0) {
    const current = await getGuildSettings(interaction.guildId);
    const lines = [
      '**Current settings**',
      `• Collection channel: ${current?.collection_channel_id ? `<#${current.collection_channel_id}>` : '_unset_'}`,
      `• Announcement channel: ${current?.announcement_channel_id ? `<#${current.announcement_channel_id}>` : '_unset_'}`,
      `• Birthday role: ${current?.birthday_role_id ? `<@&${current.birthday_role_id}>` : '_unset_'}`,
      `• Admin role: ${current?.admin_role_id ? `<@&${current.admin_role_id}>` : '_unset_'}`,
      `• Audit channel: ${current?.audit_channel_id ? `<#${current.audit_channel_id}>` : '_unset_'}`,
      `• Alert channel: ${current?.error_log_channel_id ? `<#${current.error_log_channel_id}>` : '_unset_'}`,
      `• Announcements enabled: ${current?.announcements_enabled ?? true}`,
      `• Role assignment enabled: ${current?.role_enabled ?? true}`,
      `• Debug mode: ${current?.debug_mode ? 'on' : 'off'}`,
    ];
    return interaction.reply({ content: lines.join('\n'), ...EPHEMERAL });
  }

  await updateGuildSettings(interaction.guildId, patch);
  return interaction.reply({ content: '✅ Settings updated.', ...EPHEMERAL });
}

async function cmdAddFor(interaction) {
  if (!(await isAdmin(interaction))) {
    return interaction.reply({ content: 'You do not have permission to do that.', ...EPHEMERAL });
  }
  const member = interaction.options.getUser('member', true);
  const month = interaction.options.getInteger('month', true);
  const day = interaction.options.getInteger('day', true);
  const region = interaction.options.getString('region') ?? 'americas';

  if (!isValidDate(month, day)) {
    return interaction.reply({
      content: `Invalid date: ${month}/${day}. (Max day for that month is ${daysInMonth(month)}.)`,
      ...EPHEMERAL,
    });
  }
  if (!isValidRegion(region)) {
    return interaction.reply({ content: `Invalid region: ${region}.`, ...EPHEMERAL });
  }

  await upsertBirthday({
    guildId: interaction.guildId,
    userId: member.id,
    username: member.username,
    month,
    day,
    isPublic: true,
    region,
  });

  await auditLog(
    interaction,
    `${interaction.user.tag} added birthday for <@${member.id}> → ${formatBirthday(month, day)} (${regionLabel(region)})`
  );

  return interaction.reply({
    content: `🎂 Birthday added for <@${member.id}> — **${formatBirthday(month, day)}**${(() => { const z = formatZodiac(month, day); return z ? ` — ${z}` : ''; })()} — ${regionLabel(region)}`,
    ...EPHEMERAL,
  });
}

// Reject CSVs larger than this to avoid memory/time abuse. ~2MB easily covers
// tens of thousands of rows of `discord_user_id,month,day`.
const MAX_CSV_BYTES = 2 * 1024 * 1024;
const SNOWFLAKE_RE = /^\d{17,20}$/;

async function cmdImport(interaction) {
  if (!(await isAdmin(interaction))) {
    return interaction.reply({ content: 'You do not have permission to do that.', ...EPHEMERAL });
  }
  const attachment = interaction.options.getAttachment('csv', true);
  const overwrite = interaction.options.getBoolean('overwrite') ?? false;
  const defaultRegion = interaction.options.getString('default_region') ?? 'americas';

  if (!attachment.name?.toLowerCase().endsWith('.csv')) {
    return interaction.reply({ content: 'Please upload a `.csv` file.', ...EPHEMERAL });
  }
  if (typeof attachment.size === 'number' && attachment.size > MAX_CSV_BYTES) {
    return interaction.reply({
      content: `That file is too large (max ${Math.round(MAX_CSV_BYTES / 1024)} KB). Split it and try again.`,
      ...EPHEMERAL,
    });
  }

  await interaction.deferReply(EPHEMERAL);

  let text;
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) {
      return interaction.editReply('Failed to download CSV.');
    }
    text = await res.text();
  } catch (err) {
    logger.warn('CSV download failed', { error: err });
    return interaction.editReply('Failed to download CSV.');
  }
  if (text.length > MAX_CSV_BYTES) {
    return interaction.editReply('CSV is too large after download. Aborting.');
  }

  const { rows, invalid } = parseCsv(text);
  const prepared = [];
  const invalidRows = [...invalid];

  for (const row of rows) {
    let userId = (row.discord_user_id ?? '').trim();
    if (userId && !SNOWFLAKE_RE.test(userId)) {
      invalidRows.push({ row, reason: 'invalid discord_user_id' });
      continue;
    }
    let resolvedMember = null;
    if (!userId && row.username) {
      resolvedMember = await resolveMemberByUsername(interaction.guild, row.username);
      if (resolvedMember) userId = resolvedMember.id;
    }
    if (!userId) {
      invalidRows.push({ row, reason: 'could not resolve user' });
      continue;
    }
    const m = Number(row.month);
    const d = Number(row.day);
    if (!isValidDate(m, d)) {
      invalidRows.push({ row, reason: 'invalid date' });
      continue;
    }

    // Region precedence: row column → slash default → member locale → 'americas'.
    let region = defaultRegion;
    const rawRegion = (row.region ?? '').trim().toLowerCase();
    if (rawRegion) {
      if (!isValidRegion(rawRegion)) {
        invalidRows.push({ row, reason: `invalid region "${rawRegion}"` });
        continue;
      }
      region = rawRegion;
    } else if (!interaction.options.getString('default_region')) {
      // No explicit default — try locale on the resolved member as a fallback.
      if (!resolvedMember && userId) {
        resolvedMember = await interaction.guild.members.fetch(userId).catch(() => null);
      }
      const locale = resolvedMember?.user?.locale ?? null;
      const fromLocale = locale ? regionFromLocale(locale) : null;
      if (fromLocale) region = fromLocale;
    }

    prepared.push({
      guild_id: interaction.guildId,
      user_id: userId,
      username: row.username ?? null,
      month: m,
      day: d,
      birthday_public: true,
      region,
    });
  }

  let inserted = 0;
  let skipped = 0;
  try {
    const r = await bulkInsertBirthdays(prepared, { overwrite });
    inserted = r.inserted;
    skipped = r.skipped;
  } catch (err) {
    logger.error('Bulk insert failed', { error: err });
    return interaction.editReply('Import failed while writing to the database.');
  }

  const summary = [
    '**Import Complete**',
    `Successful Imports: ${inserted}`,
    `Skipped Duplicates: ${skipped}`,
    `Invalid Rows: ${invalidRows.length}`,
  ].join('\n');

  await auditLog(
    interaction,
    `${interaction.user.tag} ran bulk import — ${inserted} added, ${skipped} skipped, ${invalidRows.length} invalid.`
  );

  const files = [];
  if (invalidRows.length > 0) {
    const csvLines = ['row_number,error'];
    for (let i = 0; i < invalidRows.length; i++) {
      const r = invalidRows[i];
      const lineNo = r.row?._line ?? i + 1;
      csvLines.push(`${lineNo},${csvEscape(r.reason)}`);
    }
    files.push(
      new AttachmentBuilder(Buffer.from(csvLines.join('\n'), 'utf8'), {
        name: 'birthday-import-errors.csv',
      })
    );
  }

  return interaction.editReply({ content: summary, files });
}

const CHANNEL_IMPORT_MAX_PAGES = 50;       // 50 * 100 = 5000 messages
const CHANNEL_IMPORT_MAX_MESSAGES = 5000;

async function cmdImportChannel(interaction) {
  if (!(await isAdmin(interaction))) {
    return interaction.reply({ content: 'You do not have permission to do that.', ...EPHEMERAL });
  }

  const channelOpt = interaction.options.getChannel('channel', true);
  const region = interaction.options.getString('region') ?? 'americas';
  const overwrite = interaction.options.getBoolean('overwrite') ?? false;
  const dryRun = interaction.options.getBoolean('dry_run') ?? false;

  if (!isValidRegion(region)) {
    return interaction.reply({ content: `Invalid region "${region}".`, ...EPHEMERAL });
  }

  await interaction.deferReply(EPHEMERAL);

  let channel;
  try {
    channel = await interaction.guild.channels.fetch(channelOpt.id);
  } catch (err) {
    logger.warn('Channel import: fetch channel failed', { error: err, channel_id: channelOpt.id });
    return interaction.editReply('Could not fetch that channel.');
  }
  if (!channel || channel.type !== ChannelType.GuildText) {
    return interaction.editReply('Please pick a regular text channel.');
  }

  const me = interaction.guild.members.me;
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.ReadMessageHistory)) {
    return interaction.editReply(
      `I need **View Channel** and **Read Message History** in <#${channel.id}> to import from it.`
    );
  }

  // Paginate messages oldest-to-newest order doesn't matter; aggregator keeps most-recent by ts.
  const messages = [];
  let before;
  let pages = 0;
  let truncated = false;
  try {
    while (pages < CHANNEL_IMPORT_MAX_PAGES) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (batch.size === 0) break;
      for (const m of batch.values()) {
        if (m.author?.bot) continue;
        messages.push({
          author_id: m.author.id,
          author: m.author.username,
          content: m.content ?? '',
          ts: m.createdTimestamp,
        });
        if (messages.length >= CHANNEL_IMPORT_MAX_MESSAGES) break;
      }
      pages += 1;
      before = batch.last()?.id;
      if (batch.size < 100) break;
      if (messages.length >= CHANNEL_IMPORT_MAX_MESSAGES) { truncated = true; break; }
    }
    if (pages >= CHANNEL_IMPORT_MAX_PAGES) truncated = true;
  } catch (err) {
    logger.error('Channel import: pagination failed', { error: err, channel_id: channel.id });
    return interaction.editReply('Failed to read messages from that channel.');
  }

  if (messages.length === 0) {
    return interaction.editReply('No messages found in that channel.');
  }

  const { rows: parsed, unparsed, total } = aggregateBirthdayMessages(messages, {});
  const dbRows = parsed.map((r) => ({
    guild_id: interaction.guildId,
    user_id: r.user_id,
    username: r.username,
    month: r.month,
    day: r.day,
    birthday_public: true,
    region,
  }));

  const files = [];
  if (unparsed.length > 0) {
    const lines = unparsed.map((u) => `[${u.author}] ${u.content}`).join('\n');
    files.push(
      new AttachmentBuilder(Buffer.from(lines, 'utf8'), { name: 'birthday-import-unparsed.txt' })
    );
  }

  if (dryRun) {
    const sample = dbRows
      .slice()
      .sort((a, b) => a.month - b.month || a.day - b.day)
      .slice(0, 15)
      .map((r) => `• ${String(r.month).padStart(2, '0')}/${String(r.day).padStart(2, '0')} — ${r.username ?? r.user_id}`)
      .join('\n');
    const summary = [
      '**Channel Import — Dry Run**',
      `Scanned: ${total} messages${truncated ? ' (truncated at limit)' : ''}`,
      `Parsed unique users: ${dbRows.length}`,
      `Unparsed messages: ${unparsed.length}`,
      `Region: ${regionLabel(region)}`,
      sample ? `\nSample:\n${sample}` : '',
    ].filter(Boolean).join('\n');
    return interaction.editReply({ content: summary, files });
  }

  let inserted = 0;
  let skipped = 0;
  try {
    const r = await bulkInsertBirthdays(dbRows, { overwrite });
    inserted = r.inserted;
    skipped = r.skipped;
  } catch (err) {
    logger.error('Channel import: bulk insert failed', { error: err });
    return interaction.editReply('Import failed while writing to the database.');
  }

  const summary = [
    '**Channel Import Complete**',
    `Channel: <#${channel.id}>`,
    `Scanned: ${total} messages${truncated ? ' (truncated at limit)' : ''}`,
    `Successful Imports: ${inserted}`,
    `Skipped Duplicates: ${skipped}`,
    `Unparsed messages: ${unparsed.length}`,
    `Region: ${regionLabel(region)}`,
  ].join('\n');

  await auditLog(
    interaction,
    `${interaction.user.tag} ran channel import on #${channel.name} — ${inserted} added, ${skipped} skipped, ${unparsed.length} unparsed.`
  );

  return interaction.editReply({ content: summary, files });
}

async function cmdDebug(interaction) {
  if (!(await isAdmin(interaction))) {
    return interaction.reply({ content: 'You do not have permission to do that.', ...EPHEMERAL });
  }
  await interaction.deferReply(EPHEMERAL);
  const state = await buildDebugState(interaction);
  const panel = buildDebugPanel(state);
  return interaction.editReply(panel);
}

async function cmdView(interaction) {
  const target = interaction.options.getUser('member');
  if (target && target.id !== interaction.user.id) {
    if (!(await isAdmin(interaction))) {
      return interaction.reply({ content: 'You can only view your own birthday.', ...EPHEMERAL });
    }
  }
  const userId = target?.id ?? interaction.user.id;
  const row = await getBirthday(interaction.guildId, userId);
  if (!row) {
    return interaction.reply({ content: 'No birthday saved.', ...EPHEMERAL });
  }
  const zodiac = formatZodiac(row.month, row.day);
  return interaction.reply({
    content: `🎂 <@${userId}> — **${formatBirthday(row.month, row.day)}**${zodiac ? ` — ${zodiac}` : ''}`,
    ...EPHEMERAL,
  });
}

async function cmdRemoveFor(interaction) {
  if (!(await isAdmin(interaction))) {
    return interaction.reply({ content: 'You do not have permission to do that.', ...EPHEMERAL });
  }
  const member = interaction.options.getUser('member', true);
  const existing = await getBirthday(interaction.guildId, member.id);
  if (!existing) {
    return interaction.reply({ content: `<@${member.id}> has no birthday saved.`, ...EPHEMERAL });
  }
  await deleteBirthday(interaction.guildId, member.id);
  await auditLog(
    interaction,
    `${interaction.user.tag} removed birthday for <@${member.id}> (was ${formatBirthday(existing.month, existing.day)})`
  );
  return interaction.reply({
    content: `🗑 Removed birthday for <@${member.id}>.`,
    ...EPHEMERAL,
  });
}

// ---------- helpers ----------

async function auditLog(interaction, content) {
  try {
    const settings = await getGuildSettings(interaction.guildId);
    const channelId = settings?.audit_channel_id;
    if (!channelId) return;
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased?.()) await channel.send(content);
  } catch (err) {
    logger.warn('audit log failed', { error: err });
  }
}

async function resolveMemberByUsername(guild, username) {
  if (!guild) return null;
  const u = username.toLowerCase();
  const cached = guild.members.cache.find(
    (m) => m.user.username.toLowerCase() === u || m.user.tag.toLowerCase() === u
  );
  if (cached) return cached;
  try {
    const fetched = await guild.members.fetch({ query: username, limit: 1 });
    return fetched.first() ?? null;
  } catch {
    return null;
  }
}

// Minimal CSV parser supporting headers and quoted fields.
function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { rows: [], invalid: [] };

  const header = splitCsvLine(lines[0]).map((s) => s.trim().toLowerCase());
  const required = ['month', 'day'];
  const hasUserId = header.includes('discord_user_id');
  const hasUsername = header.includes('username');
  if (!hasUserId && !hasUsername) {
    return { rows: [], invalid: [{ row: { _line: 0 }, reason: 'missing discord_user_id or username column' }] };
  }
  for (const req of required) {
    if (!header.includes(req)) {
      return { rows: [], invalid: [{ row: { _line: 0 }, reason: `missing ${req} column` }] };
    }
  }

  const rows = [];
  const invalid = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length !== header.length) {
      invalid.push({ row: { _line: i, raw: lines[i] }, reason: 'malformed row' });
      continue;
    }
    const obj = { _line: i + 1 };
    header.forEach((h, idx) => (obj[h] = cells[idx]?.trim()));
    rows.push(obj);
  }
  return { rows, invalid };
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else {
      if (c === ',') {
        out.push(cur);
        cur = '';
      } else if (c === '"') {
        inQuotes = true;
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
