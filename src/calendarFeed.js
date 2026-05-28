// Live iCalendar subscription feed.
//
// Serves a per-guild .ics over HTTP, keyed by an unguessable token, so calendar
// apps (Google "From URL", Apple "New Calendar Subscription", Outlook) can
// subscribe once and auto-refresh. Uses Node's built-in http server — no extra
// dependency, no framework. Also exposes /healthz for platform health checks.

import http from 'node:http';
import { logger } from './logger.js';
import { config } from './config.js';
import { getCalendarFeedByToken, getGuildPublicBirthdays } from './db.js';
import { buildBirthdayIcs } from './utils/ics.js';

// base64url alphabet, length-bounded to reject obviously bogus paths early.
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const FEED_PATH_RE = /^\/calendar\/([^/]+?)\.ics$/;

export function startCalendarServer(client) {
  if (!config.calendar.enabled) {
    logger.info('calendar_feed_disabled');
    return null;
  }

  const server = http.createServer((req, res) => {
    handle(client, req, res).catch((err) => {
      logger.error('calendar_feed_error', { error: err, url: req.url });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    });
  });

  server.on('error', (err) => logger.error('calendar_feed_server_error', { error: err }));
  server.listen(config.calendar.port, () => {
    logger.info('calendar_feed_listening', {
      port: config.calendar.port,
      public_url: config.calendar.publicUrl ?? '(unset — set CALENDAR_PUBLIC_URL)',
    });
  });
  return server;
}

async function handle(client, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', req.method);
  }

  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/' || pathname === '/healthz') {
    return send(res, 200, 'text/plain; charset=utf-8', 'ok', req.method);
  }

  const match = pathname.match(FEED_PATH_RE);
  if (!match) return send(res, 404, 'text/plain; charset=utf-8', 'Not Found', req.method);

  let token;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return send(res, 404, 'text/plain; charset=utf-8', 'Not Found', req.method);
  }
  if (!TOKEN_RE.test(token)) {
    return send(res, 404, 'text/plain; charset=utf-8', 'Not Found', req.method);
  }

  const feed = await getCalendarFeedByToken(token);
  if (!feed) return send(res, 404, 'text/plain; charset=utf-8', 'Not Found', req.method);

  const guild = client.guilds.cache.get(feed.guild_id) ?? null;
  const calendarName = guild ? `${guild.name} Birthdays` : 'Birthdays';

  const rows = await getGuildPublicBirthdays(feed.guild_id);
  const birthdays = rows.map((r) => ({
    guild_id: r.guild_id,
    user_id: r.user_id,
    username: r.username,
    displayName: guild?.members?.cache?.get(r.user_id)?.displayName || r.username || r.user_id,
    month: r.month,
    day: r.day,
    region: r.region,
  }));

  const ics = buildBirthdayIcs({ calendarName, birthdays });
  const body = Buffer.from(ics, 'utf8');
  res.writeHead(200, {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': 'inline; filename="birthdays.ics"',
    'cache-control': 'public, max-age=3600',
    'content-length': body.length,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function send(res, status, contentType, body, method) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length });
  res.end(method === 'HEAD' ? undefined : buf);
}
