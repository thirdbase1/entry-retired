import postgres from "postgres";

// Lazy client — postgres() throws at import time with an empty URL, and Next
// collects page data before env is loaded in some build phases.
let _sql: ReturnType<typeof postgres> | null = null;

export function getSql() {
  if (!_sql) {
    _sql = postgres(process.env.DATABASE_URL ?? "", { max: 5, idle_timeout: 20 });
  }
  return _sql;
}

/** Runtime tables for the desktop device flow (idempotent). */
export async function ensureTables() {
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS desktop_device_codes (
      device_code TEXT PRIMARY KEY,
      code TEXT UNIQUE,
      session_token TEXT,
      user_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      approved_at TIMESTAMPTZ
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS desktop_oauth_states (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      device_code TEXT,
      expires_at TIMESTAMPTZ NOT NULL
    )`;
}
