# 🌎 OrbitDay

> _The Cosmic Birthday Bot_

A mobile-friendly, privacy-conscious Discord birthday bot that follows the
sun around the world. Members register their birthday using **buttons and
dropdowns only** — no slash commands, no typing dates, no chance of invalid
input. Only the month and day are ever stored, and every shoutout includes
the member's zodiac sign.

## Features

- 🎂 Public **Birthday Club** panel with Add / Update / Remove buttons
- 🧙 **Auto-onboarding:** when added to a server the bot creates a `#birthday-club` channel and posts the panel — zero setup
- 📁 **Two-channel model:** the panel lives in the Birthday Club channel, while shoutouts post in a separate announcement channel of your choice
- �📱 Mobile-friendly select-menu flow (Month → Day → Confirm), fully ephemeral
- 🌍 **Region auto-detected** from each user's Discord client language — no extra click
- 🛡 Privacy: never collects birth year or age
- 📣 **Four daily announcements** (~10am local) so a globe-trotting community gets a shoutout in their own waking hours:
  - 🌎 Americas — 15:00 UTC (10am EST / 11am EDT)
  - 🌍 Europe & Africa — 10:00 UTC (10am GMT / 11am BST)
  - 🌏 South Asia — 04:30 UTC (10am IST)
  - 🌏 East Asia — 02:00 UTC (10am CST/SGT)
- 📦 Each region posts **one consolidated message** listing all that day's birthdays by display name (no @mentions, no ping spam)
- ✨ **Cosmic shoutouts** — each birthday line includes the member's zodiac sign (♈ Aries, ♉ Taurus, …), and the announcement spawns an auto-archiving thread (`🔮 Oct 16 · ♎ Libra`) containing that day's horoscope, coloured by element (Fire / Earth / Air / Water). Toggle with `HOROSCOPE_ENABLED=false` or post inline with `HOROSCOPE_THREAD=false`.
- 🚨 Optional **alert channel** — runtime warnings/errors are auto-posted here so admins notice problems without tailing logs
- 🎭 Optional birthday role (auto-assigned, auto-removed next day)
- 🩺 **Self-healing onboarding** — when added to a server (or when `/birthday-setup` runs) the bot self-grants the channel overwrites it needs on configured channels, auto-creates the birthday role if missing, and DMs the guild owner with a clear diagnostic when it can't fix something itself
- 🔒 **Concurrency-safe scheduler** — daily regional jobs and admin debug buttons are guarded by a `process_locks` table so multiple replicas / overlapping windows can never double-post (lease-based; stale leases auto-expire)
- 🛠 Admin tools:
  - `/birthday-panel` — post the public panel
  - `/birthday-setup` — configure channels, roles, toggles
  - `/birthday-config` — interactive admin panel (channels, role, toggles) with live previews
  - `/birthday-add-for` — manually add a birthday (with optional region override)
  - `/birthday-remove-for` — remove a birthday for a member
  - `/birthday-import` — bulk CSV import. Columns: `discord_user_id` **or** `username`, plus `month`, `day`, and an optional `region` (`americas|emea|apac|oceania`). The slash option `default_region` is used when a row omits the region column; if neither is provided, the bot falls back to the user's Discord locale where available, otherwise `americas`.
  - `/birthday-import-channel` — backfill birthdays by scanning a historical channel of free-text submissions (handles the messy real-world formats: `MM/DD`, `DD/MM`, `M-D`, `Month Day`, `/set`-prefixed, ordinal suffixes, etc.; latest message per author wins)
  - `/birthday-view` — view your (or any member's, for admins) saved birthday
  - `/birthday-debug` — admin debug panel: Test Announcement, Test Role, Check Today, **Catch Up Missed (this month)**, **Post Belated Horoscopes**, Check Permissions, View Errors, Rebuild Panel
- 📒 Optional audit log channel for admin imports

## Stack

- Node.js **≥ 22** (required by `@supabase/realtime-js` for native WebSocket)
- [discord.js](https://discord.js.org) v14
- Supabase Postgres
- `node-cron` for the daily scheduler

## Setup

### 1. Create a Discord application

1. Visit <https://discord.com/developers/applications> and click **New
   Application**.
2. Open the **Bot** tab:
   - Click **Reset Token** and copy it — this is `DISCORD_TOKEN`. Treat it
     like a password.
   - Toggle **Server Members Intent** **ON** (required so the bot can assign
     the birthday role). *Message Content Intent is **not** needed — the bot
     is button/select-menu driven.*
3. Open the **General Information** tab and copy **Application ID** — this is
   `DISCORD_CLIENT_ID`.
4. Open **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `View Channels`, `Send Messages`, `Embed Links`,
     `Manage Roles`, `Manage Channels`
   - Visit the generated URL and add the bot to your server.
5. **In your Discord server**, drag the bot's role **above** your birthday
   role under *Server Settings → Roles* (Discord requires this for the bot to
   assign the role).
6. Optional but recommended for dev: enable Developer Mode in Discord
   (*User Settings → Advanced*), then right-click your test server icon →
   **Copy Server ID** — set this as `DISCORD_DEV_GUILD_ID` so slash commands
   register instantly to that one guild instead of waiting for the global
   propagation delay.

### 2. Provision the database

The schema is defined in [sql/schema.sql](sql/schema.sql) and is **idempotent** —
safe to re-run when upgrading.

You have two options:

**Option A: Supabase SQL editor.** Open your project's SQL editor and paste the
contents of [sql/schema.sql](sql/schema.sql).

**Option B: `psql` from your terminal.** Add your Supabase Postgres connection
string to `.env` as `SUPABASE_DB_URL`, then run:

```bash
npm run db:migrate
```

The connection string lives in **Supabase dashboard → Project Settings →
Database → Connection string**. Use the *Session pooler* URL on IPv4 networks.
This script requires `psql` (`sudo apt-get install -y postgresql-client` or
`brew install libpq`).

### 3. Configure environment

```bash
cp .env.example .env
# fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
```

For fast iteration during development, set `DISCORD_DEV_GUILD_ID` to your
test guild so slash commands appear instantly.

### 4. Install & register

```bash
npm install
npm run register   # register slash commands
npm start
```

### 5. Pick an announcement channel

When the bot joins your server it **auto-creates a `#birthday-club` channel**
and posts the public panel there. That becomes the **collection channel**.
You only need to tell it where to post **shoutouts**:

```text
/birthday-setup announcement_channel:#birthdays birthday_role:@Birthday
```

You can also point runtime warnings/errors at a private admin channel:

```text
/birthday-setup error_log_channel:#bot-alerts
```

Once set, any `warn`/`error` the bot emits is auto-posted there (with a
1-minute per-message throttle so a flapping error can't spam the channel).

The two-channel model:

- **Birthday Club channel** (auto-created `#birthday-club`) — where members
  see the panel and click Add / Update / Remove.
- **Announcement channel** — where the four daily shoutouts are posted.
  Often this is a busier channel (e.g. `#general` or `#birthdays`).

If the bot lacks `Manage Channels` at install time, no channel is created —
just run `/birthday-panel` in any channel you want to use as the Birthday
Club channel. You can also re-run `/birthday-panel` at any time to relocate
the panel.

## CSV Import Format

Either of these formats is accepted (header row required):

```csv
discord_user_id,month,day
123456789012345678,4,16
987654321098765432,7,22
```

```csv
username,month,day
exampleuser,4,16
```

`discord_user_id` is preferred and more reliable. By default existing
entries are **skipped**; pass `overwrite: true` to replace them.

## Scheduler

Four cron jobs fire daily, one per region, all anchored to UTC so the schedule
is stable across hosts. Each is timed to land at roughly **10am local time**
in the region's primary timezone (DST drift of up to 1 hour is accepted):

| Region          | UTC cron      | Anchor timezone     |
| --------------- | ------------- | ------------------- |
| Americas        | `0 15 * * *`  | `America/New_York`  |
| Europe & Africa | `0 10 * * *`  | `Europe/London`     |
| South Asia      | `30 4 * * *`  | `Asia/Kolkata`      |
| East Asia       | `0 2 * * *`   | `Asia/Singapore`    |

A member's region is **auto-detected from their Discord client language**
(`interaction.locale`) at registration time — nothing for them to choose.
Admins can override per-member via `/birthday-add-for region:`.

Each regional run:

1. Looks up every birthday whose `(month, day, region)` matches today (in that
   region's anchor timezone).
2. Posts **one consolidated message** per guild listing the day's birthdays by
   server display name (`nickname → displayName → globalName → username`),
   with `allowedMentions` disabled so nobody gets pinged.
3. Assigns the configured birthday role to each celebrant (if enabled).
4. The earliest window of the day (East Asia) also clears any expired
   birthday roles assigned on a previous date.

Idempotency is enforced by the `birthday_announcements` table: a given
`(guild, user, date)` will only ever be announced once, even across restarts
or overlapping regional windows.

In addition, two layers of locking prevent duplicate work when multiple
replicas run simultaneously:

- **Per-region scheduler lease** — each regional cron acquires a row in
  `process_locks` (keyed by region + date) before posting. Only one process
  per region per day proceeds; stale leases expire automatically.
- **Per-guild debug-button lock** — the admin debug actions (test
  announcement, catch-up, belated horoscopes, etc.) take a short-lived
  per-guild lock so rapid double-clicks can't double-fire.

### Catch-up & belated horoscopes

If the scheduler missed days (outage, late onboarding, retroactive imports),
admins can use the `/birthday-debug` panel:

- **Catch Up Missed (this month)** posts a single belated announcement for
  every member with `month = current, 1 ≤ day < today`, claiming each via
  `birthday_announcements` so a same-day real announcement and the catch-up
  can never double-post. Today is excluded — the scheduler owns it.
- **Post Belated Horoscopes** is the standalone re-poster for when the
  birthday announcement itself succeeded but the horoscope thread failed.
  It posts the header + thread + one horoscope embed per unique zodiac in
  the missed batch (no claims taken).

## Hosting

Any Node **22+** host works. Railway is recommended:

1. Connect this repo.
2. Add the env vars from `.env.example`.
3. Set the start command to `npm start`.
4. Add a one-off `npm run register` deploy step (or run locally once).

### Logging

The bot writes structured logs to stdout. Set `LOG_FORMAT=json` for one-line
JSON per record (recommended on Railway / any log aggregator); leave unset for
human-readable output. Secrets in log payloads are auto-redacted, and each
record is emitted as a single `write()` so concurrent logs never interleave.

Key events you'll see:

- `Birthday saved` — every successful upsert (user flow + admin `/birthday-add-for`)
- `Failed to save birthday` — Supabase write errors (also mirrored to the
  configured error-log channel)
- Per-region scheduler start/finish lines with claim counts

The last ~50 error/warn records are also kept in-memory and viewable via the
**View Errors** button on `/birthday-debug`.

## Security & Privacy Notes

- All user-facing interactions are ephemeral (only the user sees them).
- Only `month`, `day`, `region`, `user_id`, `guild_id`, and an optional
  `username` are stored — no birth year, no age.
- Admin commands are gated on `Administrator`, `Manage Server`, or a
  server-configurable admin role.
- The Supabase **service role key** is required server-side and must
  never be exposed to clients.
