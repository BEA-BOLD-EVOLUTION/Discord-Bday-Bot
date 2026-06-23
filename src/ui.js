import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType,
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
    catchUpMonth: 'debug:catchup_month',
    belatedHoroscopes: 'debug:belated_horoscopes',
  },
  // Admin config panel. All custom IDs are prefixed `cfg:` so the
  // interaction router can dispatch in one place.
  cfg: {
    chCollection: 'cfg:ch:collection',
    chAnnouncement: 'cfg:ch:announcement',
    chAudit: 'cfg:ch:audit',
    chErrorLog: 'cfg:ch:errorlog',
    roleBirthday: 'cfg:role:birthday',
    roleAdmin: 'cfg:role:admin',
    toggleAnnouncements: 'cfg:toggle:announcements',
    toggleRole: 'cfg:toggle:role',
    toggleDebug: 'cfg:toggle:debug',
    advanced: 'cfg:advanced',
    refresh: 'cfg:refresh',
  },
};

// ---------- Setup-pending notice ----------
// Posted in the freshly-created Birthday Club channel when the server has
// not yet configured an announcement channel. We deliberately do NOT post
// the user-facing collection panel until admins finish setup, otherwise
// users save birthdays that have nowhere to be announced.
//
// The footer string is a stable marker so post-config code can find and
// delete this notice to replace it with the real panel.
export const SETUP_PENDING_MARKER = 'orbitday:setup-pending:v1';

export function buildSetupPendingMessage() {
  const embed = new EmbedBuilder()
    .setTitle('🎂 Birthday Club — setup required')
    .setDescription(
      [
        'Thanks for adding OrbitDay! This channel will host the public birthday panel once setup is complete.',
        '',
        "**Admins:** run `/birthday-config` and set, at minimum, the **Announcement channel** (where birthday shoutouts will be posted). The public panel will appear here automatically once that's saved.",
        '',
        '_You can also configure a Birthday role, audit channel, and alert channel from the same panel._',
      ].join('\n')
    )
    .setColor(0xffc857)
    .setFooter({ text: SETUP_PENDING_MARKER });

  return { embeds: [embed], components: [] };
}

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
    new ButtonBuilder()
      .setCustomId(CID.add)
      .setLabel('Add Birthday')
      .setEmoji('🎂')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(CID.update)
      .setLabel('Update Birthday')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CID.remove)
      .setLabel('Remove Birthday')
      .setEmoji('🗑')
      .setStyle(ButtonStyle.Danger)
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
  const all = Array.from({ length: max }, (_, i) => ({
    label: String(i + 1),
    value: String(i + 1),
  }));
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
    new ButtonBuilder()
      .setCustomId(CID.cancel)
      .setLabel('Change')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary)
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
        ? `found=${state.lastRun.birthdays_found} · sent=${state.lastRun.announcements_sent} · roles=${state.lastRun.roles_added} · unverified=${state.lastRun.members_unverified ?? 0} · errors=${state.lastRun.errors} · ${state.lastRun.duration_ms}ms`
        : '_n/a_'
    }`,
    `**Next scheduler runs:**`,
    ...Object.entries(state.nextRunsByRegion ?? {}).map(
      ([region, next]) => ` • ${region}: ${next ?? '_unknown_'}`
    ),
    `**Debug mode:** ${state.settings?.debug_mode ? 'ON' : 'off'}`,
  ];

  const embed = new EmbedBuilder()
    .setTitle('🛠 Birthday Bot — Admin Debug Panel')
    .setDescription(lines.join('\n'))
    .setColor(0x5865f2);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CID.debug.perms)
      .setLabel('Check Bot Permissions')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CID.debug.testAnnounce)
      .setLabel('Test Birthday Announcement')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(CID.debug.testRole)
      .setLabel('Test Birthday Role')
      .setStyle(ButtonStyle.Primary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CID.debug.today)
      .setLabel("Check Today's Birthdays")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CID.debug.catchUpMonth)
      .setLabel('Catch Up Missed (This Month)')
      .setEmoji('⏪')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(CID.debug.belatedHoroscopes)
      .setLabel('Post Belated Horoscopes')
      .setEmoji('🔮')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(CID.debug.errors)
      .setLabel('View Recent Errors')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CID.debug.rebuildPanel)
      .setLabel('Rebuild Birthday Panel')
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row1, row2] };
}

// ---------- Admin config panel ----------
// One ephemeral interactive surface that replaces /birthday-setup's nine
// slash options. Layout:
//   Row 1: ChannelSelect — collection (panel) channel
//   Row 2: ChannelSelect — announcement channel
//   Row 3: RoleSelect    — birthday role
//   Row 4: StringSelect  — "Configure more…" (advanced channels/role)
//   Row 5: Buttons       — toggles + refresh
// Discord caps a message at 5 ActionRows, so the less-common settings
// (audit/error-log channels, admin role) live behind the advanced select.

function settingsSummary(settings) {
  const s = settings ?? {};
  return [
    `**Collection channel:** ${s.collection_channel_id ? `<#${s.collection_channel_id}>` : '_unset_'}`,
    `**Announcement channel:** ${s.announcement_channel_id ? `<#${s.announcement_channel_id}>` : '_unset_'}`,
    `**Birthday role:** ${s.birthday_role_id ? `<@&${s.birthday_role_id}>` : '_unset_'}`,
    `**Admin role:** ${s.admin_role_id ? `<@&${s.admin_role_id}>` : '_unset_'}`,
    `**Audit channel:** ${s.audit_channel_id ? `<#${s.audit_channel_id}>` : '_unset_'}`,
    `**Alert channel:** ${s.error_log_channel_id ? `<#${s.error_log_channel_id}>` : '_unset_'}`,
    `**Announcements:** ${s.announcements_enabled === false ? '❌ off' : '✅ on'}`,
    `**Birthday role assignment:** ${s.role_enabled === false ? '❌ off' : '✅ on'}`,
    `**Debug mode:** ${s.debug_mode ? '🐛 on' : 'off'}`,
  ].join('\n');
}

export function buildConfigPanel(settings) {
  const s = settings ?? {};
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Birthday Bot — Configuration')
    .setDescription(
      [
        'Click the menus below to update settings. Changes save instantly.',
        '',
        settingsSummary(s),
        '',
        '**What each setting does**',
        '• **Collection channel** — hosts the public Birthday Club panel where members save their birthday.',
        '• **Announcement channel** — where the daily birthday shoutouts are posted.',
        '• **Birthday role** — auto-assigned to members on their birthday, then removed the next day.',
        '• **Admin role** — extra role (besides Manage Server) allowed to manage the bot.',
        '• **Audit channel** — logs who ran bulk imports and the results.',
        '• **Alert channel** — the bot auto-posts error/warning logs here so admins catch problems early.',
      ].join('\n')
    )
    .setColor(0x5865f2);

  const collectionRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(CID.cfg.chCollection)
      .setPlaceholder('Collection channel (where the Birthday Club panel lives)')
      .addChannelTypes(ChannelType.GuildText)
      .setMinValues(1)
      .setMaxValues(1)
  );

  const announceRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(CID.cfg.chAnnouncement)
      .setPlaceholder('Announcement channel (daily birthday shoutouts)')
      .addChannelTypes(ChannelType.GuildText)
      .setMinValues(1)
      .setMaxValues(1)
  );

  const roleRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId(CID.cfg.roleBirthday)
      .setPlaceholder('Birthday role (auto-assigned on members’ birthdays)')
      .setMinValues(1)
      .setMaxValues(1)
  );

  const advancedRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(CID.cfg.advanced)
      .setPlaceholder('Configure more…')
      .addOptions(
        {
          label: 'Audit channel',
          value: 'audit',
          description: 'Where bulk import audit logs are posted.',
        },
        {
          label: 'Alert channel',
          value: 'errorlog',
          description: 'Where error/warning logs are auto-posted.',
        },
        {
          label: 'Admin role',
          value: 'admin_role',
          description: 'Extra role allowed to manage the bot.',
        }
      )
  );

  const annOn = s.announcements_enabled !== false;
  const roleOn = s.role_enabled !== false;
  const debugOn = !!s.debug_mode;
  const toggleRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CID.cfg.toggleAnnouncements)
      .setLabel(`Announcements: ${annOn ? 'ON' : 'OFF'}`)
      .setStyle(annOn ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CID.cfg.toggleRole)
      .setLabel(`Role assign: ${roleOn ? 'ON' : 'OFF'}`)
      .setStyle(roleOn ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CID.cfg.toggleDebug)
      .setLabel(`Debug: ${debugOn ? 'ON' : 'OFF'}`)
      .setStyle(debugOn ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CID.cfg.refresh)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [collectionRow, announceRow, roleRow, advancedRow, toggleRow],
  };
}

// Follow-up panel shown after the user picks an "advanced" option above.
// Returns a single-row component matching the chosen target.
export function buildAdvancedConfig(target) {
  if (target === 'audit') {
    return {
      content: 'Choose an **audit channel** (admin import audit logs):',
      components: [
        new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId(CID.cfg.chAudit)
            .setPlaceholder('Select audit channel')
            .addChannelTypes(ChannelType.GuildText)
            .setMinValues(1)
            .setMaxValues(1)
        ),
      ],
      embeds: [],
    };
  }
  if (target === 'errorlog') {
    return {
      content: 'Choose an **alert channel** (error/warning logs):',
      components: [
        new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId(CID.cfg.chErrorLog)
            .setPlaceholder('Select alert channel')
            .addChannelTypes(ChannelType.GuildText)
            .setMinValues(1)
            .setMaxValues(1)
        ),
      ],
      embeds: [],
    };
  }
  if (target === 'admin_role') {
    return {
      content: 'Choose an **admin role** (extra role allowed to manage the bot):',
      components: [
        new ActionRowBuilder().addComponents(
          new RoleSelectMenuBuilder()
            .setCustomId(CID.cfg.roleAdmin)
            .setPlaceholder('Select admin role')
            .setMinValues(1)
            .setMaxValues(1)
        ),
      ],
      embeds: [],
    };
  }
  return { content: 'Unknown option.', components: [], embeds: [] };
}
