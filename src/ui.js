import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js';
import { MONTHS, daysInMonth, monthName, formatBirthday } from './utils/dates.js';
import { formatZodiac } from './utils/zodiac.js';
import { REGION_BY_ID, regionLabel } from './regions.js';

// ---------- Custom ID schema (stateless) ----------
// bday:add               -> add new
// bday:update            -> update existing
// bday:remove            -> remove existing
// bday:month:<mode>      -> month select; mode = add|update
// bday:day:<mode>:<m>:<chunkIdx> -> day select for month m
// bday:confirm:<m>:<d>:<region>  -> confirm save (region auto-detected from interaction.locale)
// bday:cancel            -> cancel/restart flow
// debug:perms            -> Check Bot Permissions
// debug:test_announce    -> Test Birthday Announcement
// debug:test_role        -> Test Birthday Role
// debug:today            -> Check Today's Birthdays
// debug:errors           -> View Recent Errors
// debug:rebuild_panel    -> Rebuild Birthday Panel

export const CID = {
  add: 'bday:add',
  update: 'bday:update',
  remove: 'bday:remove',
  month: (mode) => `bday:month:${mode}`,
  day: (mode, m) => `bday:day:${mode}:${m}`,
  confirm: (m, d, region) => `bday:confirm:${m}:${d}:${region}`,
  cancel: 'bday:cancel',
  debug: {
    perms: 'debug:perms',
    testAnnounce: 'debug:test_announce',
    testRole: 'debug:test_role',
    today: 'debug:today',
    errors: 'debug:errors',
    rebuildPanel: 'debug:rebuild_panel',
  },
};

// ---------- Public panel ----------

export function buildPanelMessage() {
  const embed = new EmbedBuilder()
    .setTitle('🎂 Birthday Club')
    .setDescription(
      [
        'Want birthday shoutouts from the community?',
        '',
        'Click a button below to save your birthday.',
        '',
        '_We only store the month and day. We never collect your birth year or age._',
      ].join('\n')
    )
    .setColor(0xff7ab6);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CID.add).setLabel('Add Birthday').setEmoji('🎂').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(CID.update).setLabel('Update Birthday').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(CID.remove).setLabel('Remove Birthday').setEmoji('🗑').setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row] };
}

// ---------- Month select ----------

export function buildMonthSelect(mode = 'add') {
  const select = new StringSelectMenuBuilder()
    .setCustomId(CID.month(mode))
    .setPlaceholder('Select your birth month')
    .addOptions(MONTHS.map((m) => ({ label: m.name, value: String(m.value) })));

  return {
    content: 'Select your birth month.',
    components: [new ActionRowBuilder().addComponents(select)],
    embeds: [],
  };
}

// ---------- Day select ----------

export function buildDaySelect(month, mode = 'add') {
  const m = Number(month);
  const max = daysInMonth(m);
  // Split days into two balanced dropdowns: 1–15 and 16–end. Discord caps
  // selects at 25 options, so we can't show all 31 in one — splitting evenly
  // looks cleaner than 25 + a tiny overflow.
  const all = Array.from({ length: max }, (_, i) => ({ label: String(i + 1), value: String(i + 1) }));
  // Always exactly two dropdowns: 1–15 and 16–end (end = 28/29/30/31).
  const chunks = [all.slice(0, 15), all.slice(15)];

  const components = chunks.map((chunk, idx) => {
    const first = chunk[0].value;
    const last = chunk[chunk.length - 1].value;
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${CID.day(mode, m)}:${idx}`)
        .setPlaceholder(`Days ${first}–${last}`)
        .addOptions(chunk)
    );
  });

  return {
    content: `Selected month: **${monthName(m)}**\nSelect your birth day.`,
    components,
    embeds: [],
  };
}

// ---------- Confirmation ----------

export function buildConfirm(month, day, region) {
  const r = REGION_BY_ID[region];
  const zodiac = formatZodiac(month, day);
  const embed = new EmbedBuilder()
    .setTitle('🎂 Confirm Your Birthday')
    .setDescription(
      `**${formatBirthday(month, day)}**${zodiac ? `  ·  ${zodiac}` : ''}\nRegion: **${regionLabel(region)}** _(auto-detected from your Discord language)_` +
      (r ? `\n_${r.description}_` : '') +
      `\n\nOnly you can see this entry. On your birthday the server will get a public shoutout in your region's window.`
    )
    .setColor(0xff7ab6);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CID.confirm(month, day, region))
      .setLabel('Confirm')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(CID.cancel).setLabel('Change').setEmoji('✏️').setStyle(ButtonStyle.Secondary)
  );

  return { content: '', embeds: [embed], components: [row] };
}

// ---------- Admin debug panel ----------

export function buildDebugPanel(state) {
  const lines = [
    `**Server ID:** \`${state.guildId}\``,
    `**Collection channel:** ${state.settings?.collection_channel_id ? `<#${state.settings.collection_channel_id}>` : '_unset_'}`,
    `**Announcement channel:** ${state.settings?.announcement_channel_id ? `<#${state.settings.announcement_channel_id}>` : '_unset_'}`,
    `**Birthday role:** ${state.settings?.birthday_role_id ? `<@&${state.settings.birthday_role_id}>` : '_unset_'}`,
    `**Audit channel:** ${state.settings?.audit_channel_id ? `<#${state.settings.audit_channel_id}>` : '_unset_'}`,
    `**Alert channel:** ${state.settings?.error_log_channel_id ? `<#${state.settings.error_log_channel_id}>` : '_unset_'}`,
    `**Birthdays saved:** ${state.birthdayCount}`,
    `**Last scheduler run:** ${state.lastRun ? `${state.lastRun.ran_at} (${state.lastRun.was_test ? 'test' : 'real'})` : '_never_'}`,
    `**Last result:** ${
      state.lastRun
        ? `found=${state.lastRun.birthdays_found} · sent=${state.lastRun.announcements_sent} · roles=${state.lastRun.roles_added} · errors=${state.lastRun.errors} · ${state.lastRun.duration_ms}ms`
        : '_n/a_'
    }`,
    `**Next scheduler runs:**`,
    ...Object.entries(state.nextRunsByRegion ?? {}).map(
      ([region, next]) => ` • ${region}: ${next ?? '_unknown_'}`
    ),
    `**Debug mode:** ${state.settings?.debug_mode ? 'ON' : 'off'}`,
  ];

  const embed = new EmbedBuilder()
    .setTitle('🛠 Birthday Bot — Admin Debug Panel')
    .setDescription(lines.join('\n'))
    .setColor(0x5865f2);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CID.debug.perms).setLabel('Check Bot Permissions').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(CID.debug.testAnnounce).setLabel('Test Birthday Announcement').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(CID.debug.testRole).setLabel('Test Birthday Role').setStyle(ButtonStyle.Primary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CID.debug.today).setLabel("Check Today's Birthdays").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(CID.debug.errors).setLabel('View Recent Errors').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(CID.debug.rebuildPanel).setLabel('Rebuild Birthday Panel').setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row1, row2] };
}