import type { ChangeEvent } from "@nova-agent/core";
import type { ToolRow } from "@nova-agent/protocol";
import { ExternalLink, Megaphone, Pin } from "lucide-react";
import { KindIcon, StatusIcon, changeIcon } from "../components/icons";
import { Tip } from "../components/Tip";
import { formatDeadline, formatRelative } from "../format";
import { STATUS_LABELS, changeVerb, type Dashboard } from "../model";
import { courseSwatch } from "../theme";

export type AskRowsProps = {
  rows: ToolRow[];
  dashboard: Dashboard;
  now: Date;
  canOpen: (url: string | null) => boolean;
  onOpen: (url: string) => void;
};

const asEvent = (row: Extract<ToolRow, { kind: "change" }>): ChangeEvent => ({
  id: row.id,
  fingerprint: row.id,
  kind: row.changeKind,
  entityKey: row.id,
  courseId: row.courseId,
  detectedAt: row.detectedAt,
  before: row.before,
  after: row.after,
  readAt: null,
});

/**
 * Rows under an answer. They carry ISO dates, so the UI formats them in the
 * student's zone the same way the Focus and Changes tabs do.
 */
export const AskRows = ({ rows, dashboard, now, canOpen, onOpen }: AskRowsProps) => {
  if (rows.length === 0) return null;
  const openFor = (row: ToolRow): string | null => {
    if (canOpen(row.url)) return row.url;
    const home = dashboard.courseById.get(row.courseId)?.homeUrl ?? null;
    return canOpen(home) ? home : null;
  };
  return (
    <ul className="ask-rows" aria-label="Matching items">
      {rows.map((row) => {
        const course = dashboard.courseById.get(row.courseId);
        const dot = <span className="course-dot" style={{ background: course ? courseSwatch(course.color) : undefined }} aria-hidden="true" />;
        const link = openFor(row);
        const open = link ? (
          <Tip label="Open in Brightspace">
            <button type="button" className="icon-button icon-button-sm" aria-label={`Open ${row.title} in Brightspace`} onClick={() => onOpen(link)}>
              <ExternalLink size={15} aria-hidden="true" />
            </button>
          </Tip>
        ) : null;
        if (row.kind === "item") {
          const done = row.status === "submitted" || row.status === "completed";
          const tone = row.bucket === "overdue" ? "overdue" : row.bucket === "today" ? "today" : undefined;
          const when = row.dueAt ? (row.bucket === "overdue" ? `Overdue · ${formatRelative(row.dueAt, now)}` : formatDeadline(row.dueAt, now)) : "No due date";
          return (
            <li key={`item-${row.id}`} className="task" data-done={done}>
              <div className="task-row">
                <div className="task-main">
                  <span className="task-title" title={row.title}>
                    {row.title}
                  </span>
                  <span className="task-sub">
                    <span className="task-course">
                      {dot}
                      {row.courseName}
                    </span>
                    <span className="due" data-tone={tone}>
                      {when}
                    </span>
                  </span>
                </div>
                <div className="task-aside">
                  <span className="kind-chip" data-status={row.status} role="img" aria-label={`${row.itemKind === "quiz" ? "Quiz" : "Assignment"}, ${STATUS_LABELS[row.status]}`}>
                    {done ? <StatusIcon status={row.status} size={15} /> : <KindIcon kind={row.itemKind} size={15} />}
                  </span>
                  {open}
                </div>
              </div>
            </li>
          );
        }
        if (row.kind === "announcement") {
          return (
            <li key={`announcement-${row.id}`} className="task">
              <div className="task-row">
                <div className="task-main">
                  <span className="task-title" title={row.title}>
                    {row.title}
                  </span>
                  <span className="task-sub">
                    <span className="task-course">
                      {dot}
                      {row.courseName}
                    </span>
                    <span className="due">{row.createdAt ? `Posted ${formatRelative(row.createdAt, now)}` : "Posted"}</span>
                    {row.pinned ? (
                      <span className="task-course">
                        <Pin size={12} aria-hidden="true" /> Pinned
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="task-aside">
                  <span className="kind-chip" role="img" aria-label="Announcement">
                    <Megaphone size={15} aria-hidden="true" />
                  </span>
                  {open}
                </div>
              </div>
            </li>
          );
        }
        const event = asEvent(row);
        const { icon, tone } = changeIcon(event);
        const before = row.before?.dueLocal ?? (row.before?.status ? STATUS_LABELS[row.before.status] : null);
        const after = row.after?.dueLocal ?? (row.after?.status ? STATUS_LABELS[row.after.status] : null);
        return (
          <li key={`change-${row.id}`} className="signal" data-unread="false">
            <span className="signal-icon" data-tone={tone} aria-hidden="true">
              {icon}
            </span>
            <div className="signal-main">
              <div className="signal-verb">
                <span>{changeVerb(event)}</span>
                <span aria-hidden="true">·</span>
                <span className="course-name">{row.courseName}</span>
              </div>
              <div className="signal-body">
                {row.title}
                {before && after && before !== after ? (
                  <>
                    : <span className="old">{before}</span>
                    <span className="arrow" aria-hidden="true">→</span>
                    <span className="sr-only">changed to</span>
                    <span className="new">{after}</span>
                  </>
                ) : null}
              </div>
              <div className="signal-meta">
                <span>Detected {formatRelative(row.detectedAt, now)}</span>
              </div>
            </div>
            <div className="signal-aside">{open}</div>
          </li>
        );
      })}
    </ul>
  );
};
