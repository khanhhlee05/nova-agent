import { describeError, type BrightspaceError, type SyncWarning } from "@nova-agent/brightspace";
import type { Course } from "@nova-agent/core";
import { AlertTriangle, CloudOff, FlaskConical, KeyRound, LockKeyhole, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { SyncPhase } from "../../messaging/protocol";
import { PHASE_LABELS, isRunningPhase } from "../../sync/syncState";
import { formatAge, formatUpdated, pluralize } from "../format";

type BannerProps = { tone: "info" | "warn" | "critical" | "success"; icon: ReactNode; title: string; children?: ReactNode; actions?: ReactNode; role?: "status" | "alert" };

export const Banner = ({ tone, icon, title, children, actions, role = "status" }: BannerProps) => (
  <div className="banner" data-tone={tone} role={role}>
    {icon}
    <div className="banner-main">
      <strong>{title}</strong>
      {children}
      {actions ? <div className="card-actions">{actions}</div> : null}
    </div>
  </div>
);

export type StateBannersProps = {
  mode: "live" | "fixture";
  phase: SyncPhase;
  error: BrightspaceError | null;
  warnings: SyncWarning[];
  failedCourseIds: string[];
  courses: ReadonlyMap<string, Course>;
  lastSuccessfulSyncAt: string | null;
  lastAttemptedSyncAt: string | null;
  stale: boolean;
  hasData: boolean;
  now: Date;
  onRefresh: () => void;
  onConnectLive: () => void;
  onOpenBrightspace: () => void;
  onUseDemo: () => void;
};

/** Every non-happy state is rendered here so it is never an afterthought. */
export const StateBanners = (props: StateBannersProps) => {
  const { mode, phase, error, warnings, failedCourseIds, courses, lastSuccessfulSyncAt, stale, hasData, now, onRefresh, onConnectLive, onOpenBrightspace, onUseDemo } = props;
  const banners: ReactNode[] = [];
  const retry = (
    <button type="button" className="button button-sm" onClick={onRefresh} disabled={isRunningPhase(phase)}>
      <RefreshCw size={14} aria-hidden="true" />
      Retry
    </button>
  );

  if (mode === "fixture") {
    banners.push(
      <Banner
        key="fixture"
        tone="warn"
        icon={<FlaskConical size={16} aria-hidden="true" />}
        title="Demo data"
        actions={
          <button type="button" className="button button-sm" onClick={onConnectLive}>
            <KeyRound size={14} aria-hidden="true" />
            Connect to Brightspace
          </button>
        }
      >
        <p>These courses are fictional. Nothing here comes from your Brightspace account.</p>
      </Banner>,
    );
  }

  if (phase === "session-expired") {
    banners.push(
      <Banner
        key="expired"
        tone="critical"
        role="alert"
        icon={<LockKeyhole size={16} aria-hidden="true" />}
        title="Brightspace session expired"
        actions={
          <>
            <button type="button" className="button button-primary button-sm" onClick={onOpenBrightspace}>
              Open Brightspace
            </button>
            {retry}
          </>
        }
      >
        <p>{hasData ? `Showing what Nova last saw ${formatAge(lastSuccessfulSyncAt, now)}. Sign in to Brightspace, then retry.` : "Sign in to Brightspace in a tab, then retry."}</p>
      </Banner>,
    );
  } else if (phase === "permission-required") {
    banners.push(
      <Banner
        key="permission"
        tone="critical"
        role="alert"
        icon={<KeyRound size={16} aria-hidden="true" />}
        title="Connection requires authorization"
        actions={
          <>
            {retry}
            {mode !== "fixture" ? (
              <button type="button" className="button button-ghost button-sm" onClick={onUseDemo}>
                Use demo data
              </button>
            ) : null}
          </>
        }
      >
        <p>Brightspace refused the read-only routes for your session. Official OAuth access must be registered by Villanova before live data can load.</p>
        {error ? <p className="faint">{describeError(error)}</p> : null}
      </Banner>,
    );
  } else if (phase === "offline") {
    banners.push(
      <Banner key="offline" tone="warn" role="alert" icon={<CloudOff size={16} aria-hidden="true" />} title="Brightspace is unreachable" actions={<>{retry}<button type="button" className="button button-ghost button-sm" onClick={onOpenBrightspace}>Open Brightspace</button></>}>
        <p>{error?.kind === "network" && error.operation === "no-brightspace-tab" ? "Open brightspace.villanova.edu in a tab so Nova can read through your session." : hasData ? `Showing what Nova last saw ${formatAge(lastSuccessfulSyncAt, now)}.` : "Check your connection and try again."}</p>
      </Banner>,
    );
  } else if (phase === "failed") {
    banners.push(
      <Banner key="failed" tone="critical" role="alert" icon={<AlertTriangle size={16} aria-hidden="true" />} title="Refresh failed" actions={retry}>
        <p>{error ? describeError(error) : "Something went wrong."}{hasData ? ` Showing what Nova last saw ${formatAge(lastSuccessfulSyncAt, now)}.` : ""}</p>
      </Banner>,
    );
  } else if (stale && hasData && !isRunningPhase(phase)) {
    banners.push(
      <Banner key="stale" tone="info" icon={<AlertTriangle size={16} aria-hidden="true" />} title="This may be out of date" actions={retry}>
        <p>{formatUpdated(lastSuccessfulSyncAt, now)}. Refresh to check for changes.</p>
      </Banner>,
    );
  }

  if ((phase === "partial" || failedCourseIds.length > 0) && hasData) {
    banners.push(
      <Banner key="partial" tone="warn" icon={<AlertTriangle size={16} aria-hidden="true" />} title={`${pluralize(failedCourseIds.length, "course")} could not be refreshed`} actions={retry}>
        <p>Data for other courses is current. Nova will not report removals for courses it could not read.</p>
        <details>
          <summary>Details</summary>
          <ul>
            {failedCourseIds.map((id) => (
              <li key={id}>{courses.get(id)?.name ?? `Course ${id}`}</li>
            ))}
          </ul>
        </details>
      </Banner>,
    );
  }

  if (warnings.length > 0 && hasData) {
    banners.push(
      <Banner key="warnings" tone="info" icon={<AlertTriangle size={16} aria-hidden="true" />} title="Some details are unavailable">
        <details>
          <summary>{pluralize(warnings.length, "notice")}</summary>
          <ul>
            {warnings.map((warning, index) => (
              <li key={`${warning.courseId}-${warning.operation}-${index}`}>
                {warning.courseId ? `${courses.get(warning.courseId)?.name ?? "Course"}: ` : ""}
                {warning.message}
              </li>
            ))}
          </ul>
        </details>
      </Banner>,
    );
  }

  return banners.length > 0 ? <div className="stack">{banners}</div> : null;
};

export const SyncProgress = ({ phase, progress }: { phase: SyncPhase; progress: { completed: number; total: number } | null }) => {
  if (!isRunningPhase(phase)) return null;
  const percent = progress && progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : null;
  return (
    <div className="progress" aria-hidden="true">
      <span>{PHASE_LABELS[phase]}{percent !== null ? ` · ${progress?.completed}/${progress?.total}` : ""}</span>
      <span className="progress-bar" data-indeterminate={percent === null}>
        <i style={{ "--progress": percent === null ? undefined : `${percent}%` } as React.CSSProperties} />
      </span>
    </div>
  );
};
