import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { createHash, randomBytes, webcrypto } from "node:crypto";

/** Who Google says is signing in. */
export type GoogleIdentity = { sub: string; email: string };

/** Checks a Google ID token and returns who it is for, or null when it is not a token this server should accept. */
export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity | null>;

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/**
 * A verifier for ID tokens issued to this project's own OAuth client: the
 * signature against Google's published keys, the issuer, the audience, the
 * expiry, and a verified email address. A token issued to any other client
 * is refused, so a token taken from another site cannot sign in here.
 */
export const createGoogleVerifier = (clientId: string, keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL)), now: () => Date = () => new Date()): GoogleVerifier => {
  return async (idToken) => {
    try {
      const { payload } = await jwtVerify(idToken, keys, { issuer: GOOGLE_ISSUERS, audience: clientId, algorithms: ["RS256"], clockTolerance: 5, currentDate: now() });
      if (typeof payload.sub !== "string" || payload.sub === "" || typeof payload.email !== "string" || payload.email_verified !== true) return null;
      return { sub: payload.sub, email: payload.email.toLowerCase() };
    } catch {
      return null;
    }
  };
};

const ISSUER = "nova-agent-api";
const AUDIENCE = "nova-extension";

/** Signs and checks the server's own short-lived access tokens. */
export class AccessTokens {
  /** The secret as an HMAC key that can sign and verify and cannot be read back out. */
  private readonly key: Promise<webcrypto.CryptoKey>;

  constructor(
    secret: string,
    readonly ttlSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.key = webcrypto.subtle.importKey("raw", Buffer.from(secret, "utf8"), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }

  async sign(userId: string): Promise<string> {
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    return new SignJWT({}).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setSubject(userId).setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt(issuedAt).setExpirationTime(issuedAt + this.ttlSeconds).sign(await this.key);
  }

  /** The user id a token was issued to, or null when the token is not ours, has been altered, or has expired. */
  async verify(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, await this.key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"], currentDate: this.now() });
      return typeof payload.sub === "string" && payload.sub !== "" ? payload.sub : null;
    } catch {
      return null;
    }
  }
}

/** A new refresh token: 256 random bits. Only its hash is stored. */
export const newRefreshToken = (): string => randomBytes(32).toString("base64url");

export const hashRefreshToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** True when the address belongs to one of the allowed domains, or when no domain is required. */
export const emailAllowed = (email: string, domains: readonly string[]): boolean => {
  if (domains.length === 0) return true;
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return email.includes("@") && domains.includes(domain);
};
