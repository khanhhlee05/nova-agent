import type { AccountUsage } from "@nova-agent/protocol";
import { useEffect, useState } from "react";
import type { AskClientFactory } from "./askClient";
import { API_URL_MESSAGES, DEFAULT_ASK_SETTINGS, checkApiBaseUrl, hostOf, type AskSettings } from "./askSettings";

export type AskSetupProps = {
  settings: AskSettings;
  onChange: (patch: Partial<AskSettings>) => void;
  /** Used to test a connection before turning Ask Nova on. */
  clientFactory: AskClientFactory;
  /** Editing an enabled setup shows Save and Turn off instead of Turn on. */
  editing: boolean;
  onClose?: () => void;
  /** Ratings of answers kept on this device, and the way to save them as a file. */
  feedback?: { count: number; onExport: () => void };
  /** The student's account on a hosted Nova server. Absent where there is no way to sign in or out. */
  account?: AskAccountControls;
};

/** Sign-in state for a Nova server that asks for it, and what the student can do about it. */
export type AskAccountControls = {
  /** The address signed in with, for the saved server; null when not signed in. */
  email: string | null;
  /** False where Google's sign-in window cannot be opened (the preview harness, a test). */
  canSignIn: boolean;
  busy: boolean;
  error: string | null;
  /** The student's own allowance, when the server has reported it. */
  usage: AccountUsage | null;
  onSignIn: (googleClientId: string) => void;
  onSignOut: () => void;
  /** Deletes the account and everything the server stored for it. */
  onDeleteAccount: () => void;
};

/**
 * The consent step. It says exactly what leaves the device and where it
 * goes, and Ask Nova stays off until the student turns it on here.
 */
export const AskSetup = ({ settings, onChange, clientFactory, editing, onClose, feedback, account }: AskSetupProps) => {
  const [apiBaseUrl, setApiBaseUrl] = useState(settings.apiBaseUrl || DEFAULT_ASK_SETTINGS.apiBaseUrl);
  const [token, setToken] = useState(settings.token ?? "");
  const [persist, setPersist] = useState(settings.persistConversations === true);
  const [readFiles, setReadFiles] = useState(settings.readAttachments !== false);
  // The default server is prefilled, so the address and access code stay folded away until someone needs them.
  const [showServer, setShowServer] = useState(editing || apiBaseUrl !== DEFAULT_ASK_SETTINGS.apiBaseUrl || token !== "");
  const [check, setCheck] = useState<{ state: "idle" | "checking" | "ok" | "fail"; text: string }>({ state: "idle", text: "" });
  // Whether the saved server asks for a sign-in, learned from the server itself.
  const [server, setServer] = useState<{ auth: "none" | "google"; googleClientId: string | null } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const savedAddress = settings.apiBaseUrl;
  const savedToken = settings.token;
  useEffect(() => {
    if (!editing || !account) return;
    let current = true;
    void clientFactory({ enabled: true, apiBaseUrl: savedAddress, token: savedToken })
      .health()
      .then((health) => {
        if (current && health.ok) setServer({ auth: health.auth ?? "none", googleClientId: health.googleClientId ?? null });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
    // Asked once per saved address while the settings are open. Whether there is an account at all does not change while they are.
  }, [clientFactory, editing, savedAddress, savedToken, account === undefined]);
  const signInRequired = server?.auth === "google";
  const address = checkApiBaseUrl(apiBaseUrl);
  const normalized = address.url;
  const invalid = apiBaseUrl.trim() !== "" && address.reason !== null;

  const test = async () => {
    if (!normalized) return;
    setCheck({ state: "checking", text: "Checking the Nova server…" });
    const result = await clientFactory({ enabled: true, apiBaseUrl: normalized, token: token.trim() || null }).health();
    if (result.ok) setServer({ auth: result.auth ?? "none", googleClientId: result.googleClientId ?? null });
    if (!result.ok) setCheck({ state: "fail", text: result.message ?? "The Nova server did not answer." });
    else if (!result.configured) setCheck({ state: "fail", text: "The Nova server is running but cannot answer yet: it still needs a model key. Whoever set up the server can add one." });
    else setCheck({ state: "ok", text: `Connected. Answers come from ${result.model ?? "an unnamed model"}.${result.auth === "google" ? " This server asks you to sign in with Google." : ""}` });
  };

  const save = (enabled: boolean) => {
    if (!normalized) return;
    onChange({ enabled, apiBaseUrl: normalized, token: token.trim() || null, persistConversations: persist, readAttachments: readFiles });
    onClose?.();
  };

  return (
    <section className="ask-setup" aria-labelledby="ask-setup-title">
      {editing ? (
        <h3 id="ask-setup-title" className="ask-setup-title">
          Ask Nova settings
        </h3>
      ) : (
        <p id="ask-setup-title" className="ask-setup-title">
          What leaves this device
        </p>
      )}
      <p className="ask-setup-text">
        Each question you ask goes to the Nova server with a short summary of your courses: course names, assignment and quiz titles, due dates, submission status, announcement titles, links, the items you marked done on this device, and the deadlines you added by hand. The server passes it to an AI model on OpenRouter to write the answer, and Nova keeps no copy of the conversation.
        Your Brightspace login, full announcement text, and your name never leave this device. A file or a course's materials are opened only after you allow it, on this device, and only the text a question needs is sent.
      </p>
      {showServer ? (
        <>
          <label className="ask-field">
            <span>Nova server address</span>
            <input type="url" className="ask-text-input" value={apiBaseUrl} placeholder={DEFAULT_ASK_SETTINGS.apiBaseUrl} aria-invalid={invalid} onChange={(event) => setApiBaseUrl(event.target.value)} />
            {invalid && address.reason ? <span className="ask-field-error">{API_URL_MESSAGES[address.reason]}</span> : null}
          </label>
          <label className="ask-field">
            <span>Access code (only if the server gave you one)</span>
            <input type="password" className="ask-text-input" value={token} autoComplete="off" onChange={(event) => setToken(event.target.value)} />
          </label>
        </>
      ) : (
        <p className="ask-setup-server">
          <span>
            Nova server: <span className="mono">{hostOf(apiBaseUrl)}</span>
          </span>
          <button type="button" className="button button-ghost button-sm" aria-label="Change Nova server address" onClick={() => setShowServer(true)}>
            Change
          </button>
        </p>
      )}
      <label className="ask-toggle">
        <input type="checkbox" className="checkbox" checked={persist} onChange={(event) => setPersist(event.target.checked)} />
        <span>
          <strong>Save conversations on this device</strong>
          <span className="ask-toggle-note">
            {persist
              ? "Nova keeps your newest 20 conversations in this browser until you delete them. They are not sent anywhere."
              : settings.persistConversations
                ? "Saving this turns it off and deletes every saved conversation."
                : "Off: a conversation is gone when you close the panel."}
          </span>
        </span>
      </label>
      <label className="ask-toggle">
        <input type="checkbox" className="checkbox" checked={readFiles} onChange={(event) => setReadFiles(event.target.checked)} />
        <span>
          <strong>Let Nova read assignment files when a question needs one</strong>
          <span className="ask-toggle-note">
            {readFiles
              ? "Nova asks once per session before the first file. The file is opened on this device, and the text your question needs is sent with it. File names go with every question."
              : "Off: Nova never opens a handout or a submitted file, and their names are not sent."}
          </span>
        </span>
      </label>
      {account && (signInRequired || account.email) ? (
        <div className="ask-account" role="group" aria-label="Nova account">
          {account.email ? (
            <>
              <p className="ask-setup-text">
                Signed in as <strong>{account.email}</strong>.
                {account.usage && account.usage.dailyCap > 0 ? ` Used today: ${account.usage.usedToday.toLocaleString("en-US")} of ${account.usage.dailyCap.toLocaleString("en-US")} tokens.` : ""} The server keeps your email address and how much you use, and nothing about your courses.
              </p>
              <div className="card-actions">
                <button type="button" className="button button-sm" onClick={account.onSignOut} disabled={account.busy}>
                  Sign out
                </button>
                {confirmingDelete ? (
                  <button type="button" className="button button-danger button-sm" onClick={account.onDeleteAccount} disabled={account.busy}>
                    Delete the account and everything stored for it
                  </button>
                ) : (
                  <button type="button" className="button button-ghost button-sm" onClick={() => setConfirmingDelete(true)} disabled={account.busy}>
                    Delete my account…
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="ask-setup-text">This Nova server asks you to sign in with Google, so it can count use per student. It keeps your email address and how much you use, and nothing about your courses.</p>
              <div className="card-actions">
                <button type="button" className="button button-sm" onClick={() => (server?.googleClientId ? account.onSignIn(server.googleClientId) : undefined)} disabled={account.busy || !account.canSignIn || !server?.googleClientId}>
                  {account.busy ? "Signing in…" : "Sign in with Google"}
                </button>
              </div>
              {!account.canSignIn ? <p className="ask-toggle-note">Signing in works in the installed extension, not in this preview.</p> : null}
            </>
          )}
          {account.error ? (
            <p className="ask-field-error" role="alert">
              {account.error}
            </p>
          ) : null}
        </div>
      ) : null}
      {editing && feedback ? (
        <p className="ask-setup-server">
          <span>{feedback.count === 0 ? "Rate an answer with the thumbs under it. Ratings stay on this device." : `${feedback.count} ${feedback.count === 1 ? "answer" : "answers"} rated. Ratings stay on this device until you export them.`}</span>
          <button type="button" className="button button-ghost button-sm" onClick={feedback.onExport} disabled={feedback.count === 0}>
            Export ratings
          </button>
        </p>
      ) : null}
      {check.state !== "idle" ? (
        <p className="ask-check" data-state={check.state} role="status">
          {check.text}
        </p>
      ) : null}
      <div className="card-actions">
        <button type="button" className="button" onClick={() => void test()} disabled={!normalized || check.state === "checking"}>
          Test connection
        </button>
        <button type="button" className="button button-primary" onClick={() => save(true)} disabled={!normalized}>
          {editing ? "Save" : "Turn on Ask Nova"}
        </button>
        {editing ? (
          <>
            <button type="button" className="button button-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="button button-danger" onClick={() => save(false)}>
              Turn off
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
};
