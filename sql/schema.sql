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
