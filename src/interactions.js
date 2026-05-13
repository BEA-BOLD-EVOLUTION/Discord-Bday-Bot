import { MessageFlags } from 'discord.js';
import { CID, buildMonthSelect, buildDaySelect, buildConfirm } from './ui.js';
import {
  upsertBirthday,
  deleteBirthday,
  getBirthday,
} from './db.js';
import { isValidDate, formatBirthday } from './utils/dates.js';
import { formatZodiac } from './utils/zodiac.js';
import { isValidRegion, regionLabel, regionFromLocale } from './regions.js';
import { logger } from './logger.js';
import { handleDebugButton, reportToErrorChannel } from './debug.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

// Lightweight per-user cooldown for destructive actions to absorb rage-clicks.
const removeCooldown = new Map(); // userId -> timestamp
const REMOVE_COOLDOWN_MS = 3_000;

export async function handleInteraction(interaction) {
  try {
    if (interaction.isButton()) return await handleButton(interaction);
    if (interaction.isStringSelectMenu()) return await handleSelect(interaction);
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
