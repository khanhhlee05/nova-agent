import { apiErrorBodySchema, conversationListResponseSchema, conversationResponseSchema, meResponseSchema, sessionResponseSchema, type AccountUsage, type ConversationBody, type RemoteConversation, type RemoteConversationSummary, type SessionResponse } from "@nova-agent/protocol";

/** A sign-in to one hosted Nova server, kept on this device. The refresh token renews it; signing out deletes both. */
export type AskSession = { apiBaseUrl: string; email: string; accessToken: string; refreshToken: string; /** When the access token stops working, in milliseconds since 1970. */ expiresAt: number };

/** Preference key the session is stored under. */
export const ASK_SESSION_PREFERENCE = "ask.session";

/** Where a turn gets the access token it sends, and how it asks for a new one when the server refuses the old. */
export type AskAuth = { accessToken(): Promise<string | null>; refresh(): Promise<string | null> };

export type AccountDeps = {
  baseUrl: string;
  /** Reads and writes the stored session; null clears it. */
  load: () => Promise<AskSession | null>;
  save: (session: AskSession | null) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
};

export type SignInResult = { ok: true; email: string } | { ok: false; message: string };

/** An access token this close to expiring is renewed before it is used. */
const RENEW_BEFORE_MS = 60_000;

/**
 * The panel's side of an account on a hosted Nova server: signing in with a
 * Google ID token, keeping the session fresh, and ending or deleting it. It
 * holds no state of its own beyond a renewal in flight; the session lives
 * wherever `load` and `save` keep it.
 */
export class AccountClient implements AskAuth {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private renewing: Promise<string | null> | null = null;

  constructor(private readonly deps: AccountDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => Date.now());
  }

  /** The stored session, only when it is for this server. */
  private async current(): Promise<AskSession | null> {
    const session = await this.deps.load();
    return session && session.apiBaseUrl === this.baseUrl ? session : null;
  }

  private async post(path: string, body: unknown, token?: string): Promise<Response | null> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    } catch {
      return null;
    }
  }

  private async keep(session: SessionResponse): Promise<AskSession> {
    const stored: AskSession = { apiBaseUrl: this.baseUrl, email: session.user.email, accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: this.now() + session.expiresIn * 1000 };
    await this.deps.save(stored);
    return stored;
  }

  async signIn(idToken: string): Promise<SignInResult> {
    const response = await this.post("/v1/auth/google", { idToken });
    if (!response) return { ok: false, message: "The Nova server could not be reached. Try again." };
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const error = apiErrorBodySchema.safeParse(body);
      return { ok: false, message: error.success ? error.data.error.message : `The Nova server refused the sign-in (${response.status}).` };
    }
    const session = sessionResponseSchema.safeParse(body);
    if (!session.success) return { ok: false, message: "The Nova server answered the sign-in in a way this panel does not understand." };
    return { ok: true, email: (await this.keep(session.data)).email };
  }

  /** A token that will still work for a minute, renewing first when it will not. Null when not signed in. */
  async accessToken(): Promise<string | null> {
    const session = await this.current();
    if (!session) return null;
    return session.expiresAt - this.now() > RENEW_BEFORE_MS ? session.accessToken : this.refresh();
  }

  /**
   * Trades the refresh token for a new session. A refresh token works once,
   * so concurrent callers share one renewal. When the server says the
   * session is over, it is forgotten here; when the server cannot be
   * reached, it is kept for the next try.
   */
  refresh(): Promise<string | null> {
    this.renewing ??= (async () => {
      const session = await this.current();
      if (!session) return null;
      const response = await this.post("/v1/auth/refresh", { refreshToken: session.refreshToken });
      if (!response) return null;
      if (response.status === 401 || response.status === 400) {
        await this.deps.save(null);
        return null;
      }
      const renewed = response.ok ? sessionResponseSchema.safeParse(await response.json().catch(() => null)) : null;
      return renewed?.success ? (await this.keep(renewed.data)).accessToken : null;
    })().finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  /** Ends the session on the server, best effort, and always forgets it here. */
  async signOut(): Promise<void> {
    const session = await this.current();
    if (session) await this.post("/v1/auth/signout", { refreshToken: session.refreshToken });
    await this.deps.save(null);
  }

  private async authed(path: string, method: "GET" | "DELETE" | "PUT", body?: unknown): Promise<Response | null> {
    const send = async (token: string): Promise<Response | null> => {
      try {
        return await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      } catch {
        return null;
      }
    };
    const token = await this.accessToken();
    if (!token) return null;
    const first = await send(token);
    if (first?.status !== 401) return first;
    const fresh = await this.refresh();
    return fresh ? send(fresh) : first;
  }

  /** How much of the student's own allowance is used. Null when not signed in or the server did not answer. */
  async usage(): Promise<AccountUsage | null> {
    const response = await this.authed("/v1/me", "GET");
    const parsed = response?.ok ? meResponseSchema.safeParse(await response.json().catch(() => null)) : null;
    return parsed?.success ? parsed.data.usage : null;
  }

  /** Deletes the account and everything the server stored for it, then forgets the session. False when the server did not confirm. */
  async deleteAccount(): Promise<boolean> {
    const response = await this.authed("/v1/me", "DELETE");
    if (!response?.ok) return false;
    await this.deps.save(null);
    return true;
  }

  /** The conversations this student keeps on the server, newest first. Null when not signed in or the server did not answer. */
  async listConversations(): Promise<RemoteConversationSummary[] | null> {
    const response = await this.authed("/v1/conversations", "GET");
    const parsed = response?.ok ? conversationListResponseSchema.safeParse(await response.json().catch(() => null)) : null;
    return parsed?.success ? parsed.data.conversations : null;
  }

  async getConversation(id: string): Promise<RemoteConversation | null> {
    const response = await this.authed(`/v1/conversations/${encodeURIComponent(id)}`, "GET");
    const parsed = response?.ok ? conversationResponseSchema.safeParse(await response.json().catch(() => null)) : null;
    return parsed?.success ? parsed.data : null;
  }

  /** True when the server stored it. */
  async putConversation(id: string, body: ConversationBody): Promise<boolean> {
    return (await this.authed(`/v1/conversations/${encodeURIComponent(id)}`, "PUT", body))?.ok === true;
  }

  /** True when the server confirmed it is gone. */
  async deleteConversation(id: string): Promise<boolean> {
    return (await this.authed(`/v1/conversations/${encodeURIComponent(id)}`, "DELETE"))?.ok === true;
  }

  /** Deletes every conversation the server keeps for this student. True when the server confirmed. */
  async deleteConversations(): Promise<boolean> {
    return (await this.authed("/v1/conversations", "DELETE"))?.ok === true;
  }
}
