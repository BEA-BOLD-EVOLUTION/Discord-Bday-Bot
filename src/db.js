import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

export const supabase = createClient(config.supabase.url, config.supabase.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------- birthdays ----------

export async function upsertBirthday({ guildId, userId, username, month, day, isPublic, region }) {
  const { error } = await supabase
    .from('birthdays')
    .upsert(
      {
        guild_id: guildId,
        user_id: userId,
        username: username ?? null,
        month,
        day,
        birthday_public: isPublic ?? true,
        region: region ?? 'americas',
      },
      { onConflict: 'guild_id,user_id' }
    );
  if (error) throw error;
}

export async function getBirthday(guildId, userId) {
  const { data, error } = await supabase
    .from('birthdays')
    .select('*')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function deleteBirthday(guildId, userId) {
  const { error } = await supabase
    .from('birthdays')
    .delete()
    .eq('guild_id', guildId)
    .eq('user_id', userId);
  if (error) throw error;
}

export async function getBirthdaysFor(month, day) {
  const { data, error } = await supabase
    .from('birthdays')
    .select('*')
    .eq('month', month)
    .eq('day', day);
  if (error) throw error;
  return data ?? [];
}

export async function getBirthdaysForRegion(month, day, region) {
  const { data, error } = await supabase
    .from('birthdays')
    .select('*')
    .eq('month', month)
    .eq('day', day)
    .eq('region', region);
  if (error) throw error;
  return data ?? [];
}

// All public birthdays for a guild, ordered by calendar date. Used to build the
// iCalendar export / live feed. Private (birthday_public = false) rows are
// intentionally excluded so they never leak into an exported calendar.
export async function getGuildPublicBirthdays(guildId) {
  const { data, error } = await supabase
    .from('birthdays')
    .select('*')
    .eq('guild_id', guildId)
    .eq('birthday_public', true)
    .order('month', { ascending: true })
    .order('day', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// Birthdays in a guild for a given month, with day in [minDay, maxDay].
// Used by the "catch up missed birthdays this month" admin debug action.
export async function getGuildBirthdaysInMonthRange(guildId, month, minDay, maxDay) {
  const { data, error } = await supabase
    .from('birthdays')
    .select('*')
    .eq('guild_id', guildId)
    .eq('month', month)
    .gte('day', minDay)
    .lte('day', maxDay)
    .order('day', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// Bulk insert; returns counts. Dedupes within the batch and (by default)
// skips entries already present in the database.
export async function bulkInsertBirthdays(rows, { overwrite = false } = {}) {
  let inserted = 0;
  let skipped = 0;
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.guild_id}:${row.user_id}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    if (!overwrite) {
      const existing = await getBirthday(row.guild_id, row.user_id);
      if (existing) {
        skipped++;
        continue;
      }
    }
    const { error } = await supabase.from('birthdays').upsert(row, { onConflict: 'guild_id,user_id' });
    if (error) throw error;
    inserted++;
  }
  return { inserted, skipped };
}

// ---------- guild settings ----------

export async function getGuildSettings(guildId) {
  const { data, error } = await supabase
    .from('guild_settings')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function updateGuildSettings(guildId, patch) {
  const { error } = await supabase
    .from('guild_settings')
    .upsert({ guild_id: guildId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'guild_id' });
  if (error) throw error;
}

// ---------- active birthday roles ----------

export async function recordActiveBirthdayRole(guildId, userId, roleId) {
  const { error } = await supabase
    .from('active_birthday_roles')
    .upsert(
      { guild_id: guildId, user_id: userId, role_id: roleId, assigned_on: new Date().toISOString().slice(0, 10) },
      { onConflict: 'guild_id,user_id' }
    );
  if (error) throw error;
}

export async function getActiveBirthdayRolesOlderThanToday() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('active_birthday_roles')
    .select('*')
    .neq('assigned_on', today);
  if (error) throw error;
  return data ?? [];
}

export async function clearActiveBirthdayRole(guildId, userId) {
  const { error } = await supabase
    .from('active_birthday_roles')
    .delete()
    .eq('guild_id', guildId)
    .eq('user_id', userId);
  if (error) throw error;
}

// ---------- horoscope threads (auto-cleanup) ----------

export async function recordHoroscopeThread(guildId, channelId, threadId) {
  const { error } = await supabase
    .from('horoscope_threads')
    .upsert({ guild_id: guildId, channel_id: channelId, thread_id: threadId }, { onConflict: 'thread_id' });
  if (error) throw error;
}

// Returns threads created before `cutoffIso` (ISO timestamp). Caller deletes
// them on Discord and then calls `deleteHoroscopeThread` to drop the row.
export async function getHoroscopeThreadsOlderThan(cutoffIso) {
  const { data, error } = await supabase
    .from('horoscope_threads')
    .select('*')
    .lt('created_at', cutoffIso);
  if (error) throw error;
  return data ?? [];
}

export async function deleteHoroscopeThread(threadId) {
  const { error } = await supabase
    .from('horoscope_threads')
    .delete()
    .eq('thread_id', threadId);
  if (error) throw error;
}

// ---------- announcement dedupe ----------

// Attempts to claim an announcement slot for (guild,user,date). Returns true if
// this caller is the one that should send the announcement, false if it has
// already been claimed (i.e. previously sent today).
export async function claimAnnouncement(guildId, userId, dateStr) {
  const { error } = await supabase
    .from('birthday_announcements')
    .insert({ guild_id: guildId, user_id: userId, announced_on: dateStr });
  if (!error) return true;
  // 23505 = unique_violation in PostgREST; any duplicate-key error means already claimed.
  if (error.code === '23505' || /duplicate/i.test(error.message ?? '')) return false;
  throw error;
}

// ---------- scheduler runs ----------

export async function recordSchedulerRun(record) {
  const { error } = await supabase.from('scheduler_runs').insert(record);
  if (error) throw error;
}

export async function getLastSchedulerRun() {
  const { data, error } = await supabase
    .from('scheduler_runs')
    .select('*')
    .order('ran_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// ---------- cross-process advisory locks ----------

// Attempts to acquire a leased lock named `key` for `ownerId`. Returns true
// if this caller now holds the lock, false if another live owner holds it.
// `ttlSeconds` is the lease lifetime — a crashed owner's lock auto-expires.
export async function tryAcquireDbLock(key, ownerId, ttlSeconds) {
  const { data, error } = await supabase.rpc('try_acquire_lock', {
    p_key: key,
    p_owner: ownerId,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) throw error;
  return data === true;
}

export async function releaseDbLock(key, ownerId) {
  const { error } = await supabase.rpc('release_lock', {
    p_key: key,
    p_owner: ownerId,
  });
  if (error) throw error;
}

// ---------- calendar feed tokens ----------

export async function getCalendarFeed(guildId) {
  const { data, error } = await supabase
    .from('calendar_feeds')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function getCalendarFeedByToken(token) {
  const { data, error } = await supabase
    .from('calendar_feeds')
    .select('*')
    .eq('token', token)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// Creates the feed row, or replaces the token when an admin regenerates it
// (which revokes the previous subscription URL).
export async function upsertCalendarFeed(guildId, token) {
  const { error } = await supabase
    .from('calendar_feeds')
    .upsert(
      { guild_id: guildId, token, created_at: new Date().toISOString() },
      { onConflict: 'guild_id' }
    );
  if (error) throw error;
}

// ---------- counts / debug helpers ----------

export async function countBirthdaysForGuild(guildId) {
  const { count, error } = await supabase
    .from('birthdays')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', guildId);
  if (error) throw error;
  return count ?? 0;
}

export async function setDebugMode(guildId, enabled) {
  await updateGuildSettings(guildId, { debug_mode: !!enabled });
}

// Lightweight DB ping used by the startup health check. Returns true if the
// required tables are reachable; false otherwise.
export async function pingDatabase() {
  const required = ['birthdays', 'guild_settings', 'active_birthday_roles', 'birthday_announcements', 'scheduler_runs'];
  const results = {};
  for (const t of required) {
    const { error } = await supabase.from(t).select('*', { count: 'exact', head: true });
    results[t] = error ? error.message : 'ok';
  }
  return results;
}
