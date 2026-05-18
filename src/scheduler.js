import cron from 'node-cron';
import { EmbedBuilder } from 'discord.js';
import {
  getBirthdaysForRegion,
  getGuildSettings,
  recordActiveBirthdayRole,
  getActiveBirthdayRolesOlderThanToday,
  clearActiveBirthdayRole,
  claimAnnouncement,
  recordSchedulerRun,
  recordHoroscopeThread,
  getHoroscopeThreadsOlderThan,
  deleteHoroscopeThread,
} from './db.js';
import { logger } from './logger.js';
import { todayInTimezone } from './utils/dates.js';
import { formatZodiac, zodiacFor } from './utils/zodiac.js';
import { fetchDailyHoroscope, horoscopeEnabled, threadsEnabled } from './utils/horoscope.js';
import { nextRunAt } from './utils/cron.js';
import { REGIONS, REGION_BY_ID, regionLabel } from './regions.js';
import { withLock, withDbLock } from './utils/locks.js';

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// In-memory "last run" state, surfaced to the admin debug panel.
// Stored per-region so the panel can show all four windows.
const lastRunByRegion = new Map(); // regionId -> summary
let lastRunSummary = null; // most recent across all regions

export function getLastRunSummary() {
  return lastRunSummary;
}

export function getLastRunByRegion() {
  return Object.fromEntries(lastRunByRegion);
}

export function getNextRunsByRegion() {
  const out = {};
  for (const r of REGIONS) {
    try {
      out[r.id] = nextRunAt(r.cron, 'UTC');
    } catch {
      out[r.id] = null;
    }
  }
  return out;
}

// Backwards-compat for code paths that still ask for a single next run.
export function getNextRunAt() {
  const all = Object.values(getNextRunsByRegion()).filter(Boolean).sort();
  return all[0] ?? null;
}

export function startScheduler(client) {
  for (const r of REGIONS) {
    logger.info('Scheduling regional birthday job', { region: r.id, cron: r.cron });
    cron.schedule(
      r.cron,
      () => {
        runDailyJob(client, { region: r.id }).catch((err) =>
          logger.error('Daily birthday job failed', { region: r.id, error: err })
        );
      },
      { timezone: 'UTC' }
    );
  }
}

// Runs the daily job for a single region.
//
// options:
//   region:     region id (required for real runs; defaults to 'americas' for tests)
//   test:       if true, sends a clearly-marked preview to the calling guild
//   guildId:    restrict to one guild (used by tests and by single-guild jobs)
//   testUserId / testUsername: identify who triggered the test
//   notes:      free-form note persisted to scheduler_runs
export async function runDailyJob(client, options = {}) {
  const isTest = !!options.test;
  const regionId = options.region ?? 'americas';

  // Serialize concurrent invocations of the same region (cron + manual
  // trigger overlap, or a slow run lingering past the next cron tick).
  // Two layers:
  //   1. withDbLock — cross-process lease (defends against running >1 bot
  //      replica). TTL is generous (15 min) so a crashed run eventually
  //      releases. Falls open if the DB lock table is unreachable.
  //   2. withLock — in-process mutex, cheap and instant.
  // Tests are allowed to run in parallel with the real schedule because
  // they target a specific guild and skip DB reads. Single-guild manual
  // runs from a debug button also bypass the lock — they're rare and
  // already covered by per-row claimAnnouncement.
  const lockKey = `scheduler:${regionId}`;
  const skipLock = isTest || !!options.guildId;
  if (!skipLock) {
    const dbR = await withDbLock(lockKey, 15 * 60, () =>
      withLock(lockKey, () => _runDailyJobInner(client, options)),
    );
    if (!dbR.acquired) {
      logger.warn('birthday_scheduler_skipped_overlap', {
        region: regionId,
        reason: 'another process holds the scheduler lease',
      });
      return lastRunByRegion.get(regionId) ?? null;
    }
    const r = dbR.result;
    if (!r.acquired) {
      logger.warn('birthday_scheduler_skipped_overlap', {
        region: regionId,
        reason: 'previous run still in progress',
      });
      return lastRunByRegion.get(regionId) ?? null;
    }
    return r.result;
  }
  return _runDailyJobInner(client, options);
}

async function _runDailyJobInner(client, options = {}) {
  const startedAt = Date.now();
  const isTest = !!options.test;
  const regionId = options.region ?? 'americas';
  const region = REGION_BY_ID[regionId] ?? REGION_BY_ID.americas;
  const { month, day, isoDate } = todayInTimezone(region.anchorTz);

  logger.info('birthday_scheduler_run_start', {
    iso_date: isoDate,
    region: region.id,
    timezone: region.anchorTz,
    test: isTest,
    target_guild: options.guildId ?? null,
  });

  let totals = { birthdays_found: 0, announcements_sent: 0, roles_added: 0, errors: 0 };

  try {
    if (!isTest) {
      // Cleanup runs once per day on the earliest UTC window so expired roles
      // clear as soon as a new day has begun for the East-Asia anchor.
      if (region.id === 'east_asia') {
        try {
          await removeExpiredBirthdayRoles(client);
        } catch (err) {
          totals.errors++;
          logger.error('Failed to remove expired birthday roles', { error: err });
        }
        try {
          await removeExpiredHoroscopeThreads(client);
        } catch (err) {
          totals.errors++;
          logger.error('Failed to remove expired horoscope threads', { error: err });
        }
      }
    }

    let rows = isTest ? [] : await getBirthdaysForRegion(month, day, region.id);
    totals.birthdays_found = rows.length;

    // Group by guild
    const byGuild = new Map();
    for (const row of rows) {
      if (!byGuild.has(row.guild_id)) byGuild.set(row.guild_id, []);
      byGuild.get(row.guild_id).push(row);
    }

    if (isTest && options.guildId) {
      byGuild.set(options.guildId, [
        {
          guild_id: options.guildId,
          user_id: options.testUserId ?? client.user.id,
          username: options.testUsername ?? 'Test User',
          month,
          day,
          birthday_public: true,
          region: region.id,
          _test: true,
        },
      ]);
    } else if (options.guildId) {
      const onlyRows = byGuild.get(options.guildId);
      byGuild.clear();
      if (onlyRows) byGuild.set(options.guildId, onlyRows);
    }

    for (const [guildId, guildRows] of byGuild) {
      try {
        const sub = await processGuildBirthdays(client, guildId, guildRows, isoDate, region, { isTest });
        totals.announcements_sent += sub.announcements_sent;
        totals.roles_added += sub.roles_added;
        totals.errors += sub.errors;
      } catch (err) {
        totals.errors++;
        logger.error('Birthday processing failed for guild', { guild_id: guildId, region: region.id, error: err });
      }
    }
  } finally {
    const duration_ms = Date.now() - startedAt;
    const summary = {
      ran_at: new Date().toISOString(),
      iso_date: isoDate,
      region: region.id,
      timezone: region.anchorTz,
      ...totals,
      duration_ms,
      was_test: isTest,
    };
    lastRunByRegion.set(region.id, summary);
    lastRunSummary = summary;
    logger.info('birthday_scheduler_run', { action: 'birthday_scheduler_run', ...summary });
    try {
      await recordSchedulerRun({ ...summary, notes: options.notes ?? null });
    } catch (err) {
      logger.warn('Failed to persist scheduler run record', { error: err });
    }
  }

  return lastRunSummary;
}

// Pick the best display name for a member: nickname > global display name > username.
function pickDisplayName(member, fallback) {
  if (!member) return fallback ?? 'Unknown';
  return (
    member.nickname ||
    member.displayName ||
    member.user?.globalName ||
    member.user?.username ||
    fallback ||
    'Unknown'
  );
}

function escapeMd(s) {
  return String(s).replace(/([*_`~|\\>])/g, '\\$1');
}

// A real <@id> mention only resolves to a clickable @name (and pings) for
// actual guild members. For synthetic/imported rows with no member it would
// render as a raw "<@number>", so fall back to the escaped display name.
function mentionOrName(entry) {
  return entry._member
    ? `<@${entry.user_id}>`
    : escapeMd(entry.displayName ?? entry.username ?? 'Member');
}

// Embed accent color keyed to the zodiac element — a tiny visual touch that
// no other birthday bot does. Falls back to the default pink on unknown
// elements.
function elementColor(element) {
  switch (element) {
    case 'Fire':  return 0xff5a3c;
    case 'Earth': return 0x7a8f3d;
    case 'Air':   return 0x8ec5ff;
    case 'Water': return 0x5aa2e6;
    default:      return 0xff7ab6;
  }
}

async function processGuildBirthdays(client, guildId, rows, isoDate, region, { isTest = false } = {}) {
  const sub = { announcements_sent: 0, roles_added: 0, errors: 0 };
  const settings = await getGuildSettings(guildId);
  if (!settings) {
    logger.warn('No settings for guild; skipping announcements', { guild_id: guildId });
    return sub;
  }

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return sub;

  // Resolve display names + claim announcements before composing the consolidated message.
  const announceable = [];
  for (const row of rows) {
    // Skip rows for users who are no longer a member of this guild. This
    // prevents announcing for ex-members whose birthday row was left behind
    // when they left the server. Fetch the member BEFORE claiming the
    // announcement slot so the claim isn't consumed by a no-op; if they
    // rejoin later the next scheduled run can still pick them up.
    // In test mode we keep the synthetic row regardless so admins can preview.
    let member = null;
    if (!isTest) {
      member = await guild.members.fetch(row.user_id).catch(() => null);
      if (!member) {
        logger.info('Skipping birthday for non-member', {
          guild_id: guildId,
          user_id: row.user_id,
          username: row.username ?? null,
        });
        continue;
      }
    }

    if (!isTest) {
      let claimed = false;
      try {
        claimed = await claimAnnouncement(guildId, row.user_id, isoDate);
      } catch (err) {
        sub.errors++;
        logger.error('Failed to claim announcement', { guild_id: guildId, user_id: row.user_id, error: err });
        continue;
      }
      if (!claimed) {
        logger.debug('Announcement already sent today', { guild_id: guildId, user_id: row.user_id });
        continue;
      }
    }
    announceable.push({
      ...row,
      displayName: pickDisplayName(member, row.username ?? 'Member'),
      _member: member,
    });
  }

  if (
    (isTest || settings.announcements_enabled !== false) &&
    settings.announcement_channel_id &&
    announceable.length > 0
  ) {
    const channel = await guild.channels.fetch(settings.announcement_channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) {
      sub.errors++;
      logger.warn('Announcement channel missing/inaccessible', { guild_id: guildId });
    } else {
      const lines = announceable.map((a) => `• ${mentionOrName(a)}`);
      // Everyone announced today shares the same birthday (and therefore the
      // same zodiac sign), so put the sign once in the header rather than
      // repeating it next to each user.
      const { month: hMonth, day: hDay } = announceable[0];
      const headerZodiac = formatZodiac(hMonth, hDay);
      const zodiacSuffix = headerZodiac ? ` · ${headerZodiac}` : '';
      const header = isTest
        ? `🧪 **TEST ONLY — Birthday announcement preview**\n\n🎉 **Today's Birthdays** 🎂${zodiacSuffix}`
        : `🎉 **Today's Birthdays** 🎂${zodiacSuffix}`;
      const content = `${header}\n_${regionLabel(region.id)}_\n${lines.join('\n')}`;

      let sentMessage = null;
      try {
        sentMessage = await channel.send({
          content,
          // Ping exactly the birthday members so they get notified, without
          // allowing @everyone/@here or role pings to leak through.
          allowedMentions: {
            users: announceable.filter((a) => a._member).map((a) => a.user_id),
          },
        });
        sub.announcements_sent = announceable.length;
      } catch (err) {
        sub.errors++;
        logger.warn('Failed to send announcement', { guild_id: guildId, region: region.id, error: err });
      }

      // Daily horoscope — one embed per region, posted in a thread off the
      // announcement message. Because birthdays only fire on a person's
      // actual birthday, everyone announced today shares the same zodiac
      // sign, so a single horoscope serves all of them. Best-effort: any
      // failure (network, permissions, no thread support) is logged and
      // skipped so role assignment below still runs.
      if (sentMessage && horoscopeEnabled()) {
        // All rows in this batch are people whose birthday is "today" for
        // this region, so they share the same month/day. Pull from the
        // first row — `month`/`day` are NOT in scope here (they live in
        // runDailyJob), which used to throw a silent ReferenceError and
        // suppress the entire thread + horoscope path.
        const { month, day } = announceable[0];
        const sign = zodiacFor(month, day);
        if (sign) {
          try {
            const text = await fetchDailyHoroscope(sign.id, isoDate);
            if (text) {
              const monthName = MONTH_NAMES[month - 1];
              const embed = new EmbedBuilder()
                .setTitle(`${sign.emoji} Today's ${sign.name} Horoscope`)
                .setDescription(text.length > 4000 ? `${text.slice(0, 3997)}…` : text)
                .setFooter({ text: `OrbitDay · The Cosmic Birthday Bot · ${sign.element}` })
                .setColor(elementColor(sign.element));

              let target = channel;
              if (threadsEnabled() && typeof sentMessage.startThread === 'function') {
                const thread = await sentMessage
                  .startThread({
                    name: `🔮 ${monthName} ${day} · ${sign.emoji} ${sign.name}`,
                    // Discord's max auto-archive is 7 days (10080 min). We
                    // also persist the thread + run a daily cleanup pass
                    // (see removeExpiredHoroscopeThreads) so archived
                    // threads get fully deleted, not just hidden.
                    autoArchiveDuration: 10080,
                    reason: 'OrbitDay daily horoscope thread',
                  })
                  .catch((err) => {
                    logger.warn('Failed to create horoscope thread; falling back to channel', {
                      guild_id: guildId,
                      error: err,
                    });
                    return null;
                  });
                if (thread) {
                  target = thread;
                  if (!isTest) {
                    try {
                      await recordHoroscopeThread(guildId, channel.id, thread.id);
                    } catch (err) {
                      logger.warn('Failed to record horoscope thread for later cleanup', {
                        guild_id: guildId,
                        thread_id: thread.id,
                        error: err,
                      });
                    }
                  }
                }
              }

              await target.send({ embeds: [embed], allowedMentions: { parse: [] } });
            }
          } catch (err) {
            logger.warn('Failed to send horoscope embed', { guild_id: guildId, region: region.id, error: err });
          }
        }
      }
    }
  }

  if (!isTest && settings.role_enabled !== false && settings.birthday_role_id) {
    const me = guild.members.me;
    const role =
      guild.roles.cache.get(settings.birthday_role_id) ??
      (await guild.roles.fetch(settings.birthday_role_id).catch(() => null));

    if (!role) {
      sub.errors++;
      logger.warn('Configured birthday role not found', { guild_id: guildId, role_id: settings.birthday_role_id });
    } else if (!me?.permissions.has('ManageRoles')) {
      sub.errors++;
      logger.warn('Missing ManageRoles permission', { guild_id: guildId });
    } else if (me.roles.highest.comparePositionTo(role) <= 0) {
      sub.errors++;
      logger.warn("Birthday role is at or above the bot's highest role", { guild_id: guildId });
    } else {
      for (const a of announceable) {
        try {
          const member = a._member ?? (await guild.members.fetch(a.user_id).catch(() => null));
          if (!member) continue;
          await member.roles.add(role, 'Birthday role');
          await recordActiveBirthdayRole(guildId, a.user_id, role.id);
          sub.roles_added++;
        } catch (err) {
          sub.errors++;
          logger.warn('Failed to assign birthday role', { guild_id: guildId, user_id: a.user_id, error: err });
        }
      }
    }
  }

  return sub;
}

async function removeExpiredBirthdayRoles(client) {
  const expired = await getActiveBirthdayRolesOlderThanToday();
  for (const r of expired) {
    try {
      const guild = await client.guilds.fetch(r.guild_id).catch(() => null);
      if (!guild) {
        await clearActiveBirthdayRole(r.guild_id, r.user_id);
        continue;
      }
      const member = await guild.members.fetch(r.user_id).catch(() => null);
      if (member) {
        await member.roles.remove(r.role_id, 'Birthday role expired').catch(() => {});
      }
      await clearActiveBirthdayRole(r.guild_id, r.user_id);
    } catch (err) {
      logger.warn('Failed to clear expired birthday role', { error: err });
    }
  }
}

// Deletes horoscope threads older than the retention window. Discord itself
// only ever archives threads — never deletes them — so without this pass the
// announcement channel slowly accumulates a thread per day forever.
// Retention window is configurable via HOROSCOPE_THREAD_RETENTION_DAYS
// (default: 7 days). Set to 0 or negative to disable cleanup entirely.
async function removeExpiredHoroscopeThreads(client) {
  const days = Number(process.env.HOROSCOPE_THREAD_RETENTION_DAYS ?? 7);
  if (!Number.isFinite(days) || days <= 0) {
    logger.info('Horoscope thread cleanup disabled', { retention_days: days });
    return;
  }
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const expired = await getHoroscopeThreadsOlderThan(cutoffIso);
  if (expired.length === 0) return;

  logger.info('Removing expired horoscope threads', { count: expired.length, cutoff: cutoffIso });
  let deleted = 0;
  let dropped = 0;
  for (const t of expired) {
    try {
      const guild = await client.guilds.fetch(t.guild_id).catch(() => null);
      if (!guild) {
        // Bot is no longer in the guild — just drop the bookkeeping row.
        await deleteHoroscopeThread(t.thread_id);
        dropped++;
        continue;
      }
      const thread = await guild.channels.fetch(t.thread_id).catch(() => null);
      if (thread && typeof thread.delete === 'function') {
        await thread.delete('OrbitDay horoscope thread retention expired').catch((err) => {
          logger.warn('Failed to delete expired horoscope thread', {
            guild_id: t.guild_id,
            thread_id: t.thread_id,
            error: err,
          });
        });
        deleted++;
      } else {
        // Thread already gone (manually deleted, channel deleted, etc.) —
        // just clean up the row.
        dropped++;
      }
      await deleteHoroscopeThread(t.thread_id);
    } catch (err) {
      logger.warn('Horoscope thread cleanup error', { thread_id: t.thread_id, error: err });
    }
  }
  logger.info('Horoscope thread cleanup complete', { deleted, dropped_rows_only: dropped, retention_days: days });
}
