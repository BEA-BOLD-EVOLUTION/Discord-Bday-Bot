-- Discord Birthday Bot schema
-- Run this in your Supabase SQL editor.

create table if not exists birthdays (
  guild_id text not null,
  user_id text not null,
  username text,
  month integer not null check (month between 1 and 12),
  day integer not null check (day between 1 and 31),
  birthday_public boolean default true,
  region text not null default 'americas',
  created_at timestamptz default now(),
  primary key (guild_id, user_id)
);

create index if not exists birthdays_month_day_idx on birthdays (month, day);

create table if not exists guild_settings (
  guild_id text primary key,
  collection_channel_id text,
  announcement_channel_id text,
  birthday_role_id text,
  admin_role_id text,
  audit_channel_id text,
  error_log_channel_id text,
  announcements_enabled boolean default true,
  role_enabled boolean default true,
  debug_mode boolean default false,
  updated_at timestamptz default now()
);

-- Idempotent migrations for older databases (safe to re-run).
alter table guild_settings add column if not exists error_log_channel_id text;
alter table guild_settings add column if not exists debug_mode boolean default false;
alter table birthdays add column if not exists region text not null default 'americas';
create index if not exists birthdays_month_day_region_idx on birthdays (month, day, region);

-- Tracks which users currently have the birthday role assigned (for cleanup next day).
create table if not exists active_birthday_roles (
  guild_id text not null,
  user_id text not null,
  role_id text not null,
  assigned_on date not null default current_date,
  primary key (guild_id, user_id)
);

-- Ensures announcements fire at most once per (guild,user,date). Used by the
-- scheduler to guarantee idempotency across restarts and retries.
create table if not exists birthday_announcements (
  guild_id text not null,
  user_id text not null,
  announced_on date not null,
  created_at timestamptz default now(),
  primary key (guild_id, user_id, announced_on)
);

-- Per-run telemetry written by the scheduler. Used to surface "last run" /
-- "last result" in the admin debug panel and to provide structured visibility
-- into daily job behavior across restarts.
create table if not exists scheduler_runs (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  iso_date date not null,
  timezone text,
  region text,
  birthdays_found integer not null default 0,
  announcements_sent integer not null default 0,
  roles_added integer not null default 0,
  errors integer not null default 0,
  duration_ms integer not null default 0,
  was_test boolean not null default false,
  notes text
);

create index if not exists scheduler_runs_ran_at_idx on scheduler_runs (ran_at desc);
alter table scheduler_runs add column if not exists region text;

-- Cross-process advisory lock table. Used by the scheduler so that if the bot
-- is ever run in more than one container/process at once, the same regional
-- run can't fire twice on the same day. A lease has a TTL — if a holder
-- crashes without releasing, the next caller after expiry can take over.
create table if not exists process_locks (
  lock_key text primary key,
  owner text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create or replace function try_acquire_lock(
  p_key text,
  p_owner text,
  p_ttl_seconds integer
) returns boolean
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_expires timestamptz := v_now + make_interval(secs => p_ttl_seconds);
begin
  -- Take or replace an expired lease in one atomic step.
  insert into process_locks (lock_key, owner, acquired_at, expires_at)
  values (p_key, p_owner, v_now, v_expires)
  on conflict (lock_key) do update
    set owner = excluded.owner,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
    where process_locks.expires_at < v_now;

  -- We won iff the row now belongs to us.
  return exists (
    select 1 from process_locks
    where lock_key = p_key and owner = p_owner
  );
end;
$$;

create or replace function release_lock(
  p_key text,
  p_owner text
) returns boolean
language plpgsql
as $$
begin
  delete from process_locks
  where lock_key = p_key and owner = p_owner;
  return found;
end;
$$;

-- Tracks horoscope threads spawned by the daily birthday announcement so we
-- can delete them after a retention window (default: 7 days). Without this,
-- Discord only archives threads — it never deletes them, so the channel
-- accumulates clutter over time.
create table if not exists horoscope_threads (
  guild_id text not null,
  channel_id text not null,
  thread_id text not null primary key,
  created_at timestamptz not null default now()
);

create index if not exists horoscope_threads_created_at_idx on horoscope_threads (created_at);

-- Per-guild iCalendar feed tokens. A guild that opts into the live calendar
-- subscription feed (/birthday-calendar-feed) gets one random token; the
-- public .ics HTTP endpoint is keyed by this token so the URL is unguessable
-- and revocable (regenerating issues a new token, invalidating the old link).
create table if not exists calendar_feeds (
  guild_id text primary key,
  token text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists calendar_feeds_token_idx on calendar_feeds (token);
