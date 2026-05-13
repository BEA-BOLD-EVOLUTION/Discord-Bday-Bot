import { MessageFlags } from 'discord.js';
import { CID, buildMonthSelect, buildDaySelect, buildConfirm, buildConfigPanel, buildAdvancedConfig } from './ui.js';
import {
  upsertBirthday,
  deleteBirthday,
  getBirthday,
  getGuildSettings,
  updateGuildSettings,
} from './db.js';
import { isValidDate, formatBirthday } from './utils/dates.js';
import { formatZodiac } from './utils/zodiac.js';
import { isValidRegion, regionLabel, regionFromLocale } from './regions.js';
import { logger } from './logger.js';
import { handleDebugButton, reportToErrorChannel } from './debug.js';
import { isAdmin } from './utils/permissions.js';
import { ensureBotPermsOnConfiguredChannels } from './onboarding.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

// Lightweight per-user cooldown for destructive actions to absorb rage-clicks.
const removeCooldown = new Map(); // userId -> timestamp
const REMOVE_COOLDOWN_MS = 3_000;

export async function handleInteraction(interaction) {
  try {
    // Admin config panel — channel/role/string select + buttons under `cfg:`.
    const cid = interaction.customId ?? '';
    if (cid.startsWith('cfg:')) return await handleConfig(interaction);

    if (interaction.isButton()) return await handleButton(interaction);
    if (
      interaction.isStringSelectMenu() ||
      interaction.isChannelSelectMenu() ||
      interaction.isRoleSelectMenu()
    ) {
      return await handleSelect(interaction);
    }
  } catch (err) {
    logger.error('Interaction error', {
      guild_id: interaction.guildId,
      user_id: interaction.user?.id,
      custom_id: interaction.customId,
      error: err,
    });
    // Report technical detail to the admin error channel; show users a plain message.
    if (interaction.guild) {
      reportToErrorChannel(interaction, `Interaction handler failed (customId=${interaction.customId})`, 'error', err)
        .catch(() => {});
    }
    const msg = 'Something went wrong. Please try again.';
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: msg, ...EPHEMERAL });
      } else {
        await interaction.reply({ content: msg, ...EPHEMERAL });
      }
    } catch {
      // best effort
    }
  }
}

async function handleButton(interaction) {
  const id = interaction.customId;

  // Admin debug panel buttons
  if (id.startsWith('debug:')) return await handleDebugButton(interaction);

  if (id === CID.add || id === CID.update) {
    const mode = id === CID.update ? 'update' : 'add';
    return interaction.reply({ ...buildMonthSelect(mode), ...EPHEMERAL });
  }

  if (id === CID.remove) {
    if (!interaction.guildId) return;
    const now = Date.now();
    const last = removeCooldown.get(interaction.user.id) ?? 0;
    if (now - last < REMOVE_COOLDOWN_MS) {
      return interaction.reply({ content: 'Slow down a moment, then try again.', ...EPHEMERAL });
    }
    removeCooldown.set(interaction.user.id, now);
    const existing = await getBirthday(interaction.guildId, interaction.user.id);
    if (!existing) {
      return interaction.reply({ content: 'You have no birthday saved.', ...EPHEMERAL });
    }
    await deleteBirthday(interaction.guildId, interaction.user.id);
    return interaction.reply({ content: '🗑 Your birthday has been removed.', ...EPHEMERAL });
  }

  if (id === CID.cancel) {
    return interaction.update(buildMonthSelect('add'));
  }

  if (id.startsWith('bday:confirm:')) {
    const parts = id.split(':'); // ['bday','confirm',m,d,region]
    const m = Number(parts[2]);
    const d = Number(parts[3]);
    const region = parts[4];
    if (!isValidDate(m, d)) {
      return interaction.reply({ content: 'That date is invalid. Please start over.', ...EPHEMERAL });
    }
    if (!isValidRegion(region)) {
      return interaction.reply({ content: 'That region is invalid. Please start over.', ...EPHEMERAL });
    }
    try {
      await upsertBirthday({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        username: interaction.user.username,
        month: m,
        day: d,
        isPublic: true,
        region,
      });
    } catch (err) {
      logger.error('Failed to save birthday', { guild_id: interaction.guildId, user_id: interaction.user.id, error: err });
      reportToErrorChannel(interaction, 'Failed to save user birthday', 'error', err).catch(() => {});
      return interaction.reply({
        content: 'Something went wrong saving your birthday. Please try again.',
        ...EPHEMERAL,
      });
    }
    return interaction.update({
      content: `🎉 Saved! Your birthday is **${formatBirthday(m, d)}**${(() => { const z = formatZodiac(m, d); return z ? ` — ${z}` : ''; })()} — ${regionLabel(region)}. The server will get a public shoutout on the day.`,
      embeds: [],
      components: [],
    });
  }
}

async function handleSelect(interaction) {
  const id = interaction.customId;

  // bday:month:<mode>
  if (id.startsWith('bday:month:')) {
    const mode = id.split(':')[2];
    const month = Number(interaction.values[0]);
    return interaction.update(buildDaySelect(month, mode));
  }

  // bday:day:<mode>:<m>:<chunkIdx>
  if (id.startsWith('bday:day:')) {
    const parts = id.split(':'); // ['bday','day',mode,m,chunkIdx]
    const month = Number(parts[3]);
    const day = Number(interaction.values[0]);
    if (!isValidDate(month, day)) {
      return interaction.reply({ content: 'Invalid date selected. Please try again.', ...EPHEMERAL });
    }
    // Auto-pick the announcement region from the user's Discord client locale.
    // Falls back to 'americas' for unknown locales. Admins can override later
    // via /birthday-add-for if needed.
    const region = regionFromLocale(interaction.locale);
    return interaction.update(buildConfirm(month, day, region));
  }
}

// ---------- Admin config panel ----------
// Handles every component with a `cfg:` customId. Each handler writes to
// guild_settings and either re-renders the main panel in place (so the
// summary always reflects truth) or sends an ephemeral follow-up for the
// advanced sub-pickers.
async function handleConfig(interaction) {
  if (!interaction.guildId) {
    return interaction.reply({ content: 'Server only.', ...EPHEMERAL });
  }
  if (!(await isAdmin(interaction))) {
    return interaction.reply({ content: 'You do not have permission to do that.', ...EPHEMERAL });
  }

  const id = interaction.customId;
  const guildId = interaction.guildId;

  // Helper: persist a patch, then re-render the main panel in place.
  const saveAndRefresh = async (patch) => {
    if (patch) await updateGuildSettings(guildId, patch);
    const settings = await getGuildSettings(guildId);
    return interaction.update(buildConfigPanel(settings));
  };

  // Channel selects (main + advanced)
  if (interaction.isChannelSelectMenu()) {
    const channelId = interaction.values?.[0];
    if (!channelId) return saveAndRefresh(null);
    // Self-heal: grant the bot any missing perms on the newly-selected channel.
    ensureBotPermsOnConfiguredChannels(interaction.guild).catch(() => {});
    if (id === CID.cfg.chCollection) return saveAndRefresh({ collection_channel_id: channelId });
    if (id === CID.cfg.chAnnouncement) return saveAndRefresh({ announcement_channel_id: channelId });
    if (id === CID.cfg.chAudit) {
      await updateGuildSettings(guildId, { audit_channel_id: channelId });
      await ensureBotPermsOnConfiguredChannels(interaction.guild).catch(() => {});
      return interaction.update({ content: `✅ Audit channel set to <#${channelId}>.`, components: [], embeds: [] });
    }
    if (id === CID.cfg.chErrorLog) {
      await updateGuildSettings(guildId, { error_log_channel_id: channelId });
      await ensureBotPermsOnConfiguredChannels(interaction.guild).catch(() => {});
      return interaction.update({ content: `✅ Alert channel set to <#${channelId}>.`, components: [], embeds: [] });
    }
  }

  // Role selects
  if (interaction.isRoleSelectMenu()) {
    const roleId = interaction.values?.[0];
    if (!roleId) return saveAndRefresh(null);
    if (id === CID.cfg.roleBirthday) return saveAndRefresh({ birthday_role_id: roleId });
    if (id === CID.cfg.roleAdmin) {
      await updateGuildSettings(guildId, { admin_role_id: roleId });
      return interaction.update({ content: `✅ Admin role set to <@&${roleId}>.`, components: [], embeds: [] });
    }
  }

  // Advanced string select (opens a follow-up with the appropriate picker)
  if (interaction.isStringSelectMenu() && id === CID.cfg.advanced) {
    const target = interaction.values?.[0];
    return interaction.reply({ ...buildAdvancedConfig(target), ...EPHEMERAL });
  }

  // Toggle buttons + refresh
  if (interaction.isButton()) {
    const current = await getGuildSettings(guildId);
    if (id === CID.cfg.toggleAnnouncements) {
      const next = current?.announcements_enabled === false ? true : false;
      return saveAndRefresh({ announcements_enabled: next });
    }
    if (id === CID.cfg.toggleRole) {
      const next = current?.role_enabled === false ? true : false;
      return saveAndRefresh({ role_enabled: next });
    }
    if (id === CID.cfg.toggleDebug) {
      const next = !current?.debug_mode;
      return saveAndRefresh({ debug_mode: next });
    }
    if (id === CID.cfg.refresh) {
      return saveAndRefresh(null);
    }
  }

  // Unknown cfg interaction — fall through silently.
  return interaction.reply({ content: 'Unhandled config action.', ...EPHEMERAL });
}
