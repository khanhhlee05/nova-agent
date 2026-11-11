/**
 * The ID token in the address Google sends the sign-in window back to, when it answers the request this
 * panel made: the token's nonce has to be the one that was sent. The server checks everything else.
 */
export const idTokenFromRedirect = (redirect: string, nonce: string): string | null => {
  try {
    const token = new URLSearchParams(new URL(redirect).hash.replace(/^#/, "")).get("id_token");
    const payload = token?.split(".")[1];
    if (!token || !payload) return null;
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { nonce?: unknown };
    return claims.nonce === nonce ? token : null;
  } catch {
    return null;
  }
};
