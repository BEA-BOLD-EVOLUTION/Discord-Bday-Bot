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
