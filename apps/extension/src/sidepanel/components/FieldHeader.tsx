import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { SyncPhase } from "../../messaging/protocol";
import { isRunningPhase } from "../../sync/syncState";
import { formatAge } from "../format";
import type { Theme } from "../theme";
import { ThemeSwitch } from "./ThemeSwitch";
import { Tip } from "./Tip";

export type Freshness = { label: string; tone: "live" | "demo" | "syncing" | "error" | "idle"; text: string };

/** One short line: connection state, then how old the data is. Fits the field's top row at 380 px. */
export const freshness = (mode: "live" | "fixture", phase: SyncPhase, lastSuccessfulSyncAt: string | null, stale: boolean, now: Date): Freshness => {
  const age = lastSuccessfulSyncAt ? formatAge(lastSuccessfulSyncAt, now) : "never refreshed";
  if (isRunningPhase(phase)) return { label: "Refreshing", tone: "syncing", text: "Refreshing…" };
  if (phase === "idle") return { label: "Not connected", tone: "idle", text: "Not connected" };
  const broken = phase === "session-expired" || phase === "permission-required" || phase === "offline" || phase === "failed";
  if (mode === "fixture") return { label: "Demo data", tone: "demo", text: `Demo data · ${age}` };
  if (broken) return { label: "Disconnected", tone: "error", text: `Disconnected · ${age}` };
  return { label: "Live", tone: "live", text: `${stale ? "Stale" : "Live"} · ${age}` };
};

export type FieldHeaderProps = {
  freshness: Freshness;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onRefresh: () => void;
  refreshing: boolean;
  refreshDisabled?: boolean;
  menu: ReactNode;
  hero: ReactNode;
  counts?: ReactNode;
  tabs?: ReactNode;
};

/** The blue field: identity, freshness, the tab's one headline, and the tabs on its lower edge. */
export const FieldHeader = ({ freshness: fresh, theme, onThemeChange, onRefresh, refreshing, refreshDisabled, menu, hero, counts, tabs }: FieldHeaderProps) => (
  <header className="field">
    <div className="field-top">
      <span className="wordmark">NOVA</span>
      <span className="freshness" data-tone={fresh.tone} role="status" aria-label={`Connection: ${fresh.label}`}>
        {fresh.text}
      </span>
      <span className="spacer" />
      <ThemeSwitch theme={theme} onChange={onThemeChange} onField />
      <Tip label={refreshing ? "Refreshing" : "Refresh now"}>
        <button type="button" className="icon-button on-field" aria-label="Refresh now" onClick={onRefresh} disabled={refreshing || refreshDisabled}>
          <RefreshCw size={16} className={refreshing ? "spin" : undefined} aria-hidden="true" />
        </button>
      </Tip>
      {menu}
    </div>
    <div className="field-hero">{hero}</div>
    {counts}
    {tabs ? <div className="field-tabs">{tabs}</div> : null}
  </header>
);

export type HeroProps = { title: string; meta: string; text: string; actions?: ReactNode; aside?: ReactNode; extra?: ReactNode; headingId?: string };

export const Hero = ({ title, meta, text, actions, aside, extra, headingId }: HeroProps) => (
  <div className="hero">
    <div className="hero-head">
      <h2 className="hero-title" id={headingId}>
        {title}
      </h2>
      {aside}
    </div>
    <p className="hero-meta">{meta}</p>
    <p className="hero-text">{text}</p>
    {actions ? <div className="hero-actions">{actions}</div> : null}
    {extra}
  </div>
);
