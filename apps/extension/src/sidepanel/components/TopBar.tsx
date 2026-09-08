import type { Course } from "@nova-agent/core";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import { Select } from "radix-ui";
import type { ReactNode } from "react";
import type { SyncPhase } from "../../messaging/protocol";
import { isRunningPhase } from "../../sync/syncState";
import { formatUpdated } from "../format";
import type { CourseFilter } from "../model";
import type { Theme } from "../theme";
import { ThemeSwitch } from "./ThemeSwitch";
import { Tip } from "./Tip";
import { courseSwatch } from "../theme";

export type ConnectionTone = "live" | "demo" | "syncing" | "error" | "idle";

export const connectionTone = (mode: "live" | "fixture", phase: SyncPhase): { tone: ConnectionTone; label: string } => {
  if (phase === "idle") return { tone: "idle", label: "Not connected" };
  if (isRunningPhase(phase)) return { tone: "syncing", label: "Refreshing" };
  if (phase === "session-expired" || phase === "permission-required" || phase === "offline" || phase === "failed") return { tone: "error", label: mode === "fixture" ? "Demo" : "Disconnected" };
  if (mode === "fixture") return { tone: "demo", label: "Demo data" };
  if (phase === "ready" || phase === "partial") return { tone: "live", label: "Live" };
  return { tone: "idle", label: "Not connected" };
};

export type TopBarProps = {
  mode: "live" | "fixture";
  phase: SyncPhase;
  lastSuccessfulSyncAt: string | null;
  stale: boolean;
  now: Date;
  courses: Course[];
  courseFilter: CourseFilter;
  onCourseFilter: (value: CourseFilter) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onRefresh: () => void;
  refreshDisabled?: boolean;
  menu: ReactNode;
};

const ALL = "__all__";

export const TopBar = ({ mode, phase, lastSuccessfulSyncAt, stale, now, courses, courseFilter, onCourseFilter, theme, onThemeChange, onRefresh, refreshDisabled, menu }: TopBarProps) => {
  const connection = connectionTone(mode, phase);
  const syncing = isRunningPhase(phase);
  return (
    <header className="topbar">
      <div className="topbar-row">
        <div className="wordmark" aria-label="Nova Mission Control">
          <span className="wordmark-orb" aria-hidden="true" />
          NOVA <small>Mission Control</small>
        </div>
        <span className="spacer" />
        <span className="connection" data-tone={connection.tone} role="status" aria-label={`Connection: ${connection.label}`}>
          <span className="connection-dot" aria-hidden="true" />
          {connection.label}
        </span>
        <ThemeSwitch theme={theme} onChange={onThemeChange} />
        {menu}
      </div>
      <div className="topbar-row">
        <Select.Root value={courseFilter ?? ALL} onValueChange={(value) => onCourseFilter(value === ALL ? null : value)}>
          <Select.Trigger className="select-trigger" aria-label="Filter by course">
            <Select.Value placeholder="All courses" />
            <Select.Icon>
              <ChevronDown size={14} aria-hidden="true" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content className="select-content" position="popper" sideOffset={6} collisionPadding={8}>
              <Select.Viewport>
                <Select.Item className="select-item" value={ALL}>
                  <Select.ItemText>All courses</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check size={14} aria-hidden="true" />
                  </Select.ItemIndicator>
                </Select.Item>
                {courses.map((course) => (
                  <Select.Item className="select-item" value={course.id} key={course.id}>
                    <span className="course-dot" style={{ background: courseSwatch(course.color) }} aria-hidden="true" />
                    <Select.ItemText>{course.name}</Select.ItemText>
                    <Select.ItemIndicator>
                      <Check size={14} aria-hidden="true" />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
        <span className="spacer" />
        <span className="updated" data-stale={stale} aria-live="off">
          {syncing ? "Refreshing…" : stale && lastSuccessfulSyncAt ? `Stale · ${formatUpdated(lastSuccessfulSyncAt, now)}` : formatUpdated(lastSuccessfulSyncAt, now)}
        </span>
        <Tip label={syncing ? "Refreshing" : "Refresh now"}>
          <button type="button" className="icon-button" aria-label="Refresh now" onClick={onRefresh} disabled={syncing || refreshDisabled}>
            <RefreshCw size={16} className={syncing ? "spin" : undefined} aria-hidden="true" />
          </button>
        </Tip>
      </div>
    </header>
  );
};
