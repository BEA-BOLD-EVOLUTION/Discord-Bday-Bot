// Loads env vars from .env.local first (developer overrides), then .env
// (committed/template or CI-injected). dotenv won't overwrite vars that
// are already set, so .env.local always wins.
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
