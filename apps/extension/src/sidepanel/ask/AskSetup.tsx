import { useState } from "react";
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
};

/**
 * The consent step. It says exactly what leaves the device and where it
 * goes, and Ask Nova stays off until the student turns it on here.
 */
export const AskSetup = ({ settings, onChange, clientFactory, editing, onClose }: AskSetupProps) => {
  const [apiBaseUrl, setApiBaseUrl] = useState(settings.apiBaseUrl || DEFAULT_ASK_SETTINGS.apiBaseUrl);
  const [token, setToken] = useState(settings.token ?? "");
  // The default server is prefilled, so the address and access code stay folded away until someone needs them.
  const [showServer, setShowServer] = useState(editing || apiBaseUrl !== DEFAULT_ASK_SETTINGS.apiBaseUrl || token !== "");
  const [check, setCheck] = useState<{ state: "idle" | "checking" | "ok" | "fail"; text: string }>({ state: "idle", text: "" });
  const address = checkApiBaseUrl(apiBaseUrl);
  const normalized = address.url;
  const invalid = apiBaseUrl.trim() !== "" && address.reason !== null;

  const test = async () => {
    if (!normalized) return;
    setCheck({ state: "checking", text: "Checking the Nova server…" });
    const result = await clientFactory({ enabled: true, apiBaseUrl: normalized, token: token.trim() || null }).health();
    if (!result.ok) setCheck({ state: "fail", text: result.message ?? "The Nova server did not answer." });
    else if (!result.configured) setCheck({ state: "fail", text: "The Nova server is running but cannot answer yet: it still needs a model key. Whoever set up the server can add one." });
    else setCheck({ state: "ok", text: `Connected. Answers come from ${result.model ?? "an unnamed model"}.` });
  };

  const save = (enabled: boolean) => {
    if (!normalized) return;
    onChange({ enabled, apiBaseUrl: normalized, token: token.trim() || null });
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
        Each question you ask goes to the Nova server with a short summary of your courses: course names, assignment and quiz titles, due dates, submission status, announcement titles, and links. The server passes it to an AI model on OpenRouter to write the answer, and Nova keeps no copy of the conversation.
        Your Brightspace login, full announcement text, and your name never leave this device.
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
