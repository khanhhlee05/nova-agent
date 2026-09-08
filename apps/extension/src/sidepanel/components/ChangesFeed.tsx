import type { ChangeEvent } from "@nova-agent/core";
import { Check, CheckCheck, ExternalLink, Radio, X } from "lucide-react";
import { formatDeadline, formatDetected } from "../format";
import { STATUS_LABELS, changeTitle, changeVerb, type Dashboard } from "../model";
import { changeIcon } from "./icons";
import { Tip } from "./Tip";

export type ChangesFeedProps = {
  dashboard: Dashboard;
  now: Date;
  baselineOnly: boolean;
  canOpen: (url: string | null) => boolean;
  onOpen: (url: string) => void;
  onMarkAllRead: () => void;
  onSetRead: (id: string, read: boolean) => void;
  onDismiss: (id: string, title: string) => void;
};

const GROUPS: { key: keyof Dashboard["changes"]; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "earlier", label: "Earlier" },
];

export const ChangesFeed = ({ dashboard, now, baselineOnly, canOpen, onOpen, onMarkAllRead, onSetRead, onDismiss }: ChangesFeedProps) => (
  <div className="stack">
    <div className="feed-header">
      <h2>Since your last visit</h2>
      <button type="button" className="button button-ghost button-sm" onClick={onMarkAllRead} disabled={dashboard.counts.unread === 0}>
        <CheckCheck size={14} aria-hidden="true" />
        Mark all read
      </button>
    </div>
    {dashboard.totalChanges === 0 ? (
      <div className="empty">
        <Radio size={22} aria-hidden="true" />
        <strong>{baselineOnly ? "Baseline captured" : "No changes since your last visit"}</strong>
        <span>{baselineOnly ? "Nova now knows your courses. New items, moved deadlines, and announcements will appear here after the next refresh." : "Nova compares every refresh with the last one and only lists meaningful changes."}</span>
      </div>
    ) : (
      GROUPS.filter((group) => dashboard.changes[group.key].length > 0).map((group) => (
        <section key={group.key} className="feed-group" aria-label={group.label}>
          <h3 className="feed-group-label">{group.label}</h3>
          <ul className="feed-group">
            {dashboard.changes[group.key].map((event) => (
              <SignalRow key={event.id} event={event} dashboard={dashboard} now={now} canOpen={canOpen} onOpen={onOpen} onSetRead={onSetRead} onDismiss={onDismiss} />
            ))}
          </ul>
        </section>
      ))
    )}
  </div>
);

type SignalRowProps = Pick<ChangesFeedProps, "dashboard" | "now" | "canOpen" | "onOpen" | "onSetRead" | "onDismiss"> & { event: ChangeEvent };

const SignalRow = ({ event, dashboard, now, canOpen, onOpen, onSetRead, onDismiss }: SignalRowProps) => {
  const { icon, tone } = changeIcon(event);
  const course = dashboard.courseById.get(event.courseId);
  const item = dashboard.itemByKey.get(event.entityKey);
  const link = item && canOpen(item.url) ? item.url : course?.homeUrl ?? null;
  const unread = event.readAt === null;
  const title = changeTitle(event);
  return (
    <li className="signal" data-unread={unread} aria-label={`${changeVerb(event)}: ${title}`}>
      <span className="signal-icon" data-tone={tone} aria-hidden="true">
        {icon}
      </span>
      <div className="signal-main">
        <div className="signal-verb">
          <span>{changeVerb(event)}</span>
          <span aria-hidden="true">·</span>
          <span className="course-name">{course?.name ?? "Course"}</span>
        </div>
        <div className="signal-body">
          <EventBody event={event} title={title} now={now} />
        </div>
        <div className="signal-meta">
          <span>{formatDetected(event.detectedAt, now)}</span>
          {link ? (
            <button type="button" className="disclosure" style={{ minHeight: 24, marginLeft: -2 }} onClick={() => onOpen(link)}>
              <ExternalLink size={12} aria-hidden="true" />
              Open
            </button>
          ) : null}
        </div>
      </div>
      <div className="signal-aside">
        <Tip label={unread ? "Mark as read" : "Mark as unread"}>
          <button type="button" className="icon-button" data-active={!unread} aria-label={unread ? `Mark "${title}" as read` : `Mark "${title}" as unread`} aria-pressed={!unread} onClick={() => onSetRead(event.id, unread)}>
            <Check size={16} aria-hidden="true" />
          </button>
        </Tip>
        <Tip label="Hide until next refresh">
          <button type="button" className="icon-button icon-button-sm" aria-label={`Hide change "${title}" until next refresh`} onClick={() => onDismiss(event.id, title)}>
            <X size={15} aria-hidden="true" />
          </button>
        </Tip>
      </div>
    </li>
  );
};

const EventBody = ({ event, title, now }: { event: ChangeEvent; title: string; now: Date }) => {
  if (event.kind === "due-date-changed") {
    return (
      <>
        {title}: <span className="old">{formatDeadline((event.before?.dueAt as string | null) ?? null, now)}</span>
        <span className="arrow" aria-hidden="true">→</span>
        <span className="sr-only">changed to</span>
        <span className="new">{formatDeadline((event.after?.dueAt as string | null) ?? null, now)}</span>
      </>
    );
  }
  if (event.kind === "became-overdue") {
    return (
      <>
        {title} was due <span className="new">{formatDeadline((event.after?.dueAt as string | null) ?? null, now)}</span>
      </>
    );
  }
  if (event.kind === "status-changed") {
    const label = (value: unknown): string => STATUS_LABELS[value as keyof typeof STATUS_LABELS] ?? "Unknown";
    return (
      <>
        {title}: <span className="old">{label(event.before?.status)}</span>
        <span className="arrow" aria-hidden="true">→</span>
        <span className="sr-only">changed to</span>
        <span className="new">{label(event.after?.status)}</span>
      </>
    );
  }
  if (event.kind === "item-added" && event.after?.dueAt) {
    return (
      <>
        {title} · due {formatDeadline(event.after.dueAt as string, now)}
      </>
    );
  }
  return <>{title}</>;
};
