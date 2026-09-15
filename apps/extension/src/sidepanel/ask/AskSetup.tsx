import { useState } from "react";
import type { AskClientFactory } from "./askClient";
import { normalizeApiBaseUrl, type AskSettings } from "./askSettings";

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
  const [apiBaseUrl, setApiBaseUrl] = useState(settings.apiBaseUrl);
  const [token, setToken] = useState(settings.token ?? "");
  const [check, setCheck] = useState<{ state: "idle" | "checking" | "ok" | "fail"; text: string }>({ state: "idle", text: "" });
  const normalized = normalizeApiBaseUrl(apiBaseUrl);
  const invalid = apiBaseUrl.trim() !== "" && normalized === null;

  const test = async () => {
    if (!normalized) return;
    setCheck({ state: "checking", text: "Checking…" });
    const result = await clientFactory({ enabled: true, apiBaseUrl: normalized, token: token.trim() || null }).health();
    if (!result.ok) setCheck({ state: "fail", text: result.message ?? "No answer." });
    else if (!result.configured) setCheck({ state: "fail", text: "The API answers but has no model key yet. Add OPENROUTER_API_KEY to apps/api/.env and restart it." });
    else setCheck({ state: "ok", text: `Connected. Model: ${result.model ?? "unknown"}.` });
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
        When you ask a question, Nova sends it with a compact copy of your course data (course names, item titles, due dates, statuses, announcement titles, links) to the Nova API you run at the address below. That API forwards it to a model on OpenRouter and Nova keeps no copy of the conversation.
        Cookies, raw Brightspace responses, announcement bodies, and your name never leave this device.
      </p>
      <label className="ask-field">
        <span>Nova API address</span>
        <input type="url" className="ask-text-input" value={apiBaseUrl} placeholder="http://localhost:8787" aria-invalid={invalid} onChange={(event) => setApiBaseUrl(event.target.value)} />
        {invalid ? <span className="ask-field-error">Enter an http or https address.</span> : null}
      </label>
      <label className="ask-field">
        <span>Access token (only if the API requires one)</span>
        <input type="password" className="ask-text-input" value={token} autoComplete="off" onChange={(event) => setToken(event.target.value)} />
      </label>
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
