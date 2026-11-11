import { ACCOUNT_LIMITS, type ConversationBody, type RemoteConversation, type RemoteConversationSummary } from "@nova-agent/protocol";
import { randomUUID } from "node:crypto";
import type { Queryable, Sql } from "./sql";

export type User = { id: string; googleSub: string; email: string; createdAt: string };

export type TurnLimits = {
  /** Tokens a student may use per UTC day; 0 means no limit. */
  dailyCap: number;
  /** Questions a student may ask per ten minutes; 0 means no limit. */
  turnLimit: number;
};

export type TurnReservation = { ok: true; id: string } | { ok: false; reason: "daily_cap" | "rate" | "no_user"; retryAfterSeconds?: number };

export type UsageNow = { usedToday: number; recentTurns: number };

export const RATE_WINDOW_MS = 10 * 60_000;

const iso = (value: unknown): string => new Date(value as string | Date).toISOString();
const startOfUtcDay = (now: Date): string => `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;

type UserRow = { id: string; google_sub: string; email: string; created_at: unknown };
const toUser = (row: UserRow): User => ({ id: row.id, googleSub: row.google_sub, email: row.email, createdAt: iso(row.created_at) });

/**
 * Accounts, sessions, per-student use, and saved conversations, in Postgres.
 * Every method is scoped by the user id it is given: there is no query here
 * that can return another student's row.
 */
export class AccountStore {
  constructor(private readonly sql: Sql) {}

  /** The account for a Google identity, created on first sign-in. The email follows Google's. */
  async upsertUser(googleSub: string, email: string, now: Date): Promise<User> {
    const rows = await this.sql.query<UserRow>(
      "INSERT INTO users (id, google_sub, email, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email RETURNING id, google_sub, email, created_at",
      [randomUUID(), googleSub, email, now.toISOString()],
    );
    return toUser(rows[0] as UserRow);
  }

  async getUser(id: string): Promise<User | null> {
    const rows = await this.sql.query<UserRow>("SELECT id, google_sub, email, created_at FROM users WHERE id = $1", [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  /** Deletes the account and, through the schema, every row that belongs to it. */
  async deleteUser(id: string): Promise<void> {
    await this.sql.query("DELETE FROM users WHERE id = $1", [id]);
  }

  async putRefreshToken(userId: string, tokenHash: string, expiresAt: Date, now: Date): Promise<void> {
    await this.sql.query("INSERT INTO refresh_tokens (token_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)", [tokenHash, userId, expiresAt.toISOString(), now.toISOString()]);
    // Expired sessions of this student go as new ones arrive, so the table does not grow without end.
    await this.sql.query("DELETE FROM refresh_tokens WHERE user_id = $1 AND expires_at <= $2", [userId, now.toISOString()]);
  }

  /** Uses a refresh token up: it is deleted, and its user is returned when it had not expired. A token works once. */
  async takeRefreshToken(tokenHash: string, now: Date): Promise<string | null> {
    const rows = await this.sql.query<{ user_id: string; expires_at: unknown }>("DELETE FROM refresh_tokens WHERE token_hash = $1 RETURNING user_id, expires_at", [tokenHash]);
    const row = rows[0];
    return row && new Date(row.expires_at as string | Date).getTime() > now.getTime() ? row.user_id : null;
  }

  async deleteRefreshToken(tokenHash: string): Promise<void> {
    await this.sql.query("DELETE FROM refresh_tokens WHERE token_hash = $1", [tokenHash]);
  }

  private async usageWithin(db: Queryable, userId: string, now: Date): Promise<UsageNow & { oldestRecent: Date | null }> {
    const day = await db.query<{ tokens: unknown }>("SELECT COALESCE(SUM(tokens), 0) AS tokens FROM usage WHERE user_id = $1 AND at >= $2", [userId, startOfUtcDay(now)]);
    const recent = await db.query<{ turns: unknown; oldest: unknown }>("SELECT COUNT(*) AS turns, MIN(at) AS oldest FROM usage WHERE user_id = $1 AND at > $2", [userId, new Date(now.getTime() - RATE_WINDOW_MS).toISOString()]);
    return { usedToday: Number(day[0]?.tokens ?? 0), recentTurns: Number(recent[0]?.turns ?? 0), oldestRecent: recent[0]?.oldest ? new Date(recent[0].oldest as string | Date) : null };
  }

  async usageNow(userId: string, now: Date): Promise<UsageNow> {
    const { usedToday, recentTurns } = await this.usageWithin(this.sql, userId, now);
    return { usedToday, recentTurns };
  }

  /**
   * Counts a question against the student's limits before the model is
   * called, charging the worst case. The check and the charge happen under
   * a lock on the student's row, so two questions sent at once cannot both
   * slip under the limit.
   */
  async reserveTurn(userId: string, estimate: number, limits: TurnLimits, now: Date): Promise<TurnReservation> {
    return this.sql.transaction(async (tx) => {
      const locked = await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      if (locked.length === 0) return { ok: false, reason: "no_user" } as const;
      const used = await this.usageWithin(tx, userId, now);
      if (limits.turnLimit > 0 && used.recentTurns >= limits.turnLimit) {
        const wait = used.oldestRecent ? Math.ceil((used.oldestRecent.getTime() + RATE_WINDOW_MS - now.getTime()) / 1000) : 60;
        return { ok: false, reason: "rate", retryAfterSeconds: Math.max(1, wait) } as const;
      }
      if (limits.dailyCap > 0 && used.usedToday + estimate > limits.dailyCap) return { ok: false, reason: "daily_cap" } as const;
      const id = randomUUID();
      await tx.query("INSERT INTO usage (id, user_id, at, tokens, settled) VALUES ($1, $2, $3, $4, false)", [id, userId, now.toISOString(), Math.max(0, Math.round(estimate))]);
      return { ok: true, id } as const;
    });
  }

  /** Replaces a reservation with what the turn really used. */
  async settleTurn(id: string, used: { tokens: number; promptTokens: number | null; completionTokens: number | null; model: string | null }): Promise<void> {
    await this.sql.query("UPDATE usage SET tokens = $2, prompt_tokens = $3, completion_tokens = $4, model = $5, settled = true WHERE id = $1", [id, Math.max(0, Math.round(used.tokens)), used.promptTokens, used.completionTokens, used.model]);
  }

  /** Tokens and questions per UTC day, oldest first, for the last `days` days. */
  async usageByDay(userId: string, days: number, now: Date): Promise<{ day: string; tokens: number; turns: number }[]> {
    const since = new Date(new Date(startOfUtcDay(now)).getTime() - (Math.max(1, days) - 1) * 86_400_000).toISOString();
    const rows = await this.sql.query<{ day: string; tokens: unknown; turns: unknown }>(
      "SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COALESCE(SUM(tokens), 0) AS tokens, COUNT(*) AS turns FROM usage WHERE user_id = $1 AND at >= $2 GROUP BY 1 ORDER BY 1",
      [userId, since],
    );
    return rows.map((row) => ({ day: row.day, tokens: Number(row.tokens), turns: Number(row.turns) }));
  }

  async listConversations(userId: string): Promise<RemoteConversationSummary[]> {
    const rows = await this.sql.query<{ id: string; title: string; created_at: unknown; updated_at: unknown; message_count: unknown }>(
      "SELECT id, title, created_at, updated_at, jsonb_array_length(messages) AS message_count FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC, id",
      [userId],
    );
    return rows.map((row) => ({ id: row.id, title: row.title, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), messageCount: Number(row.message_count) }));
  }

  async getConversation(userId: string, id: string): Promise<RemoteConversation | null> {
    const rows = await this.sql.query<{ id: string; title: string; messages: unknown; created_at: unknown; updated_at: unknown }>("SELECT id, title, messages, created_at, updated_at FROM conversations WHERE user_id = $1 AND id = $2", [userId, id]);
    const row = rows[0];
    if (!row) return null;
    const messages = typeof row.messages === "string" ? (JSON.parse(row.messages) as unknown) : row.messages;
    return { id: row.id, title: row.title, messages: Array.isArray(messages) ? messages : [], createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
  }

  /** Saves a conversation, replacing an earlier save of the same one, and keeps the student's newest few. */
  async putConversation(userId: string, id: string, body: ConversationBody): Promise<void> {
    await this.sql.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO conversations (user_id, id, title, messages, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6) ON CONFLICT (user_id, id) DO UPDATE SET title = EXCLUDED.title, messages = EXCLUDED.messages, updated_at = EXCLUDED.updated_at",
        [userId, id, body.title, JSON.stringify(body.messages), body.createdAt, body.updatedAt],
      );
      await tx.query("DELETE FROM conversations WHERE user_id = $1 AND id NOT IN (SELECT id FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC, id LIMIT $2)", [userId, ACCOUNT_LIMITS.conversations]);
    });
  }

  async deleteConversation(userId: string, id: string): Promise<void> {
    await this.sql.query("DELETE FROM conversations WHERE user_id = $1 AND id = $2", [userId, id]);
  }

  async deleteConversations(userId: string): Promise<void> {
    await this.sql.query("DELETE FROM conversations WHERE user_id = $1", [userId]);
  }

  close(): Promise<void> {
    return this.sql.close();
  }
}
