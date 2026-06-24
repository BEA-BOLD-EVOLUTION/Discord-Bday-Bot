#!/usr/bin/env node
// Apply sql/schema.sql to the Supabase Postgres instance.
//
// Required env (in .env or shell):
//   SUPABASE_DB_URL  e.g. postgresql://postgres.<ref>:<password>@aws-1-...pooler.supabase.com:5432/postgres
// Or set the individual parts and we'll build it for you:
//   SUPABASE_DB_HOST, SUPABASE_DB_PORT, SUPABASE_DB_NAME, SUPABASE_DB_USER, SUPABASE_DB_PASSWORD
//
// This script requires `psql` on the PATH. Install with:
//   sudo apt-get install -y postgresql-client   # Debian/Ubuntu
//   brew install libpq && brew link --force libpq  # macOS

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import '../utils/loadEnv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, '..', '..', 'sql', 'schema.sql');

if (!fs.existsSync(schemaPath)) {
  console.error(`schema file not found at ${schemaPath}`);
  process.exit(1);
}

function buildUrl() {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  const host = process.env.SUPABASE_DB_HOST;
  const user = process.env.SUPABASE_DB_USER;
  const pwd = process.env.SUPABASE_DB_PASSWORD;
  if (!host || !user || !pwd) return null;
  const port = process.env.SUPABASE_DB_PORT ?? '5432';
  const db = process.env.SUPABASE_DB_NAME ?? 'postgres';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pwd)}@${host}:${port}/${db}`;
}

const url = buildUrl();
if (!url) {
  console.error('Missing SUPABASE_DB_URL (or SUPABASE_DB_HOST/USER/PASSWORD).');
  console.error(
    'Add it to .env. Find it in Supabase dashboard \u2192 Project Settings \u2192 Database \u2192 Connection string.'
  );
  process.exit(1);
}

console.log(`Applying ${path.relative(process.cwd(), schemaPath)} to Supabase...`);

const child = spawn('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f', schemaPath], { stdio: 'inherit' });

child.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error('`psql` not found on PATH. Install postgresql-client.');
  } else {
    console.error(err);
  }
  process.exit(1);
});

child.on('exit', (code) => process.exit(code ?? 1));
