import type { Sql } from "./sql";

/**
 * The schema, as ordered steps that are never edited once released: a change
 * is a new step. Course data has no table. A saved conversation holds what a
 * student chose to keep on the server, and only while they have that turned on.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    id uuid PRIMARY KEY,
    google_sub text NOT NULL UNIQUE,
    email text NOT NULL,
    created_at timestamptz NOT NULL
  );
  CREATE TABLE refresh_tokens (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL
  );
  CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id);
  CREATE TABLE usage (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    at timestamptz NOT NULL,
    tokens integer NOT NULL,
    prompt_tokens integer,
    completion_tokens integer,
    model text,
    settled boolean NOT NULL DEFAULT false
  );
  CREATE INDEX usage_user_at ON usage (user_id, at);
  CREATE TABLE conversations (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id text NOT NULL,
    title text NOT NULL,
    messages jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX conversations_user_updated ON conversations (user_id, updated_at DESC);
  `,
];

/** Applies every step not applied yet, each in its own transaction. Returns how many ran. Safe to call on every start. */
export const migrate = async (sql: Sql, now: () => Date = () => new Date()): Promise<number> => {
  await sql.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL)");
  const applied = new Set((await sql.query<{ version: number }>("SELECT version FROM schema_migrations")).map((row) => Number(row.version)));
  let ran = 0;
  for (const [index, step] of MIGRATIONS.entries()) {
    const version = index + 1;
    if (applied.has(version)) continue;
    await sql.transaction(async (tx) => {
      for (const statement of step.split(";").map((part) => part.trim()).filter(Boolean)) await tx.query(statement);
      await tx.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)", [version, now().toISOString()]);
    });
    ran += 1;
  }
  return ran;
};
