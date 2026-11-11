import { shortId } from "@nova-agent/agent";
import { isDone, type AcademicItem, type ChangeEvent } from "@nova-agent/core";
import type { ToolRow } from "@nova-agent/protocol";
import { CalendarDays, Check, ChevronDown, ExternalLink, EyeOff, Megaphone, PenLine, Pin } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { KindIcon, StatusIcon, changeIcon } from "../components/icons";
import { Tip } from "../components/Tip";
import { formatDeadline, formatRelative } from "../format";
import { STATUS_LABELS, changeVerb, type Dashboard, type PersonalDeadline } from "../model";
import { courseSwatch } from "../theme";

/** What a row can do besides opening Brightspace. Each one is the same handler the Focus, Week, or Changes tab calls. */
export type AskRowActions = {
  onSetDone: (key: string, title: string, done: boolean) => void;
  onDismiss: (key: string, title: string) => void;
  onSetRead: (id: string, read: boolean) => void;
  onSetPersonalDone?: (id: string, title: string, done: boolean) => void;
  onShowPersonal?: (deadline: PersonalDeadline) => void;
};

/**
 * Live state for every course, because Ask ignores the course filter the
 * dashboard was built with. Rows read it so a done mark or a hide made a
 * moment ago shows on an answer given earlier.
 */
export type AskLive = {
  localMarks: ReadonlyMap<string, string>;
  dismissed: ReadonlySet<string>;
  events: readonly ChangeEvent[];
  personal: readonly PersonalDeadline[];
  actions: AskRowActions;
};

export type AskRowsProps = {
  rows: ToolRow[];
  dashboard: Dashboard;
  now: Date;
  canOpen: (url: string | null) => boolean;
  onOpen: (url: string) => void;
  /** Absent in read-only contexts: rows then only open links. */
  live?: AskLive;
};

type ItemRow = Extract<ToolRow, { kind: "item" }>;
type AnnouncementRow = Extract<ToolRow, { kind: "announcement" }>;
type ChangeRow = Extract<ToolRow, { kind: "change" }>;
type PersonalRow = Extract<ToolRow, { kind: "personal" }>;

/** Rows the list under an answer knows how to draw. Other kinds have their own cards. */
export type ListRow = ItemRow | AnnouncementRow | ChangeRow | PersonalRow;

export const isListRow = (row: ToolRow): row is ListRow => row.kind === "item" || row.kind === "announcement" || row.kind === "change" || row.kind === "personal";

const asEvent = (row: ChangeRow): ChangeEvent => ({
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
 * The rows behind a toggle, collapsed for every message, so a long lookup
 * never pushes the answer and the composer out of view. The open state is
 * local to the message and lasts for the session, like the thread.
 */
export const AskRowsDisclosure = (props: AskRowsProps) => {
  const [open, setOpen] = useState(false);
  const id = useId();
  const rows = props.rows.filter(isListRow);
  if (rows.length === 0) return null;
  const count = rows.length;
  return (
    <div className="ask-rows-disclosure">
      <button type="button" className="ask-rows-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
        <ChevronDown size={14} aria-hidden="true" className="chevron" data-open={open} />
        {open ? "Hide matching items" : `Show ${count} matching ${count === 1 ? "item" : "items"}`}
      </button>
      <div id={id} hidden={!open}>
        {open ? <AskRows {...props} rows={rows} /> : null}
      </div>
    </div>
  );
};

/**
 * Rows under an answer. They carry ISO dates, so the UI formats them in the
 * student's zone the same way the Focus and Changes tabs do. With `live`
 * they also carry the controls of the tab they came from.
 */
export const AskRows = ({ rows, dashboard, now, canOpen, onOpen, live }: AskRowsProps) => {
  // Rows name items by the short id the snapshot sent; the panel's own key is looked up here.
  const itemByShortId = useMemo(() => new Map(dashboard.snapshot.items.map((item) => [shortId(item.key, item.kind), item])), [dashboard.snapshot.items]);
  const list = rows.filter(isListRow);
  if (list.length === 0) return null;
  // Change rows carry the event id clipped the way the snapshot clips it.
  const eventById = new Map((live?.events ?? [...dashboard.changes.today, ...dashboard.changes.yesterday, ...dashboard.changes.earlier]).map((event) => [event.id.slice(0, 80), event]));
  const openButton = (title: string, url: string | null, courseId: string | null): ReactNode => {
    const home = courseId ? (dashboard.courseById.get(courseId)?.homeUrl ?? null) : null;
    const link = canOpen(url) ? url : canOpen(home) ? home : null;
    return link ? (
      <Tip label="Open in Brightspace">
        <button type="button" className="icon-button icon-button-sm" aria-label={`Open ${title} in Brightspace`} onClick={() => onOpen(link)}>
          <ExternalLink size={15} aria-hidden="true" />
        </button>
      </Tip>
    ) : null;
  };
  const dotFor = (courseId: string | null): ReactNode => {
    const course = courseId ? dashboard.courseById.get(courseId) : undefined;
    return <span className="course-dot" data-hollow={!course} style={course ? { background: courseSwatch(course.color) } : undefined} aria-hidden="true" />;
  };
  return (
    <ul className="ask-rows" aria-label="Matching items">
      {list.map((row) => {
        if (row.kind === "item") {
          const found = itemByShortId.get(row.id);
          const item: AcademicItem | undefined = found && found.courseId === row.courseId ? found : undefined;
          return <ItemRowView key={`item-${row.id}`} row={row} item={item} now={now} live={live} dot={dotFor(row.courseId)} open={openButton(row.title, row.url, row.courseId)} />;
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
                      {dotFor(row.courseId)}
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
                  {openButton(row.title, row.url, row.courseId)}
                </div>
              </div>
            </li>
          );
        }
        if (row.kind === "personal") {
          return <PersonalRowView key={`personal-${row.id}`} row={row} deadline={live?.personal.find((entry) => entry.id === row.id)} now={now} live={live} dot={dotFor(row.courseId)} />;
        }
        return <ChangeRowView key={`change-${row.id}`} row={row} stored={eventById.get(row.id)} now={now} live={live} open={openButton(row.title, row.url, row.courseId)} />;
      })}
    </ul>
  );
};

type ItemRowViewProps = { row: ItemRow; item: AcademicItem | undefined; now: Date; live: AskLive | undefined; dot: ReactNode; open: ReactNode };

const ItemRowView = ({ row, item, now, live, dot, open }: ItemRowViewProps) => {
  // Live state wins over the row: the answer may be older than a mark, a hide, or a refresh.
  const submitted = item ? isDone(item) : row.status === "submitted" || row.status === "completed";
  const markedAt = item && live ? live.localMarks.get(item.key) : undefined;
  const marked = live ? markedAt !== undefined && !submitted : row.doneLocally === true;
  const done = submitted || marked;
  const hidden = !!item && !!live && live.dismissed.has(item.key);
  const status = item?.status ?? row.status;
  const overdue = row.bucket === "overdue" || (!!row.dueAt && new Date(row.dueAt).getTime() < now.getTime());
  const tone = done ? undefined : overdue ? "overdue" : row.bucket === "today" ? "today" : undefined;
  const when = row.dueAt ? (overdue && !done ? `Overdue · ${formatRelative(row.dueAt, now)}` : formatDeadline(row.dueAt, now)) : "No due date";
  const actionable = !!item && !!live;
  const checkLabel = submitted ? `${row.title}: ${STATUS_LABELS[status].toLowerCase()} in Brightspace` : marked ? `${row.title}: marked done by you. Uncheck to put it back.` : `Mark "${row.title}" done on this device`;
  return (
    <li className="task" data-done={done} data-hidden={hidden || undefined}>
      <div className="task-row" data-actions={actionable || undefined}>
        {actionable ? (
          <Tip label={submitted ? "Submitted in Brightspace" : marked ? "Marked done by you" : "Mark done (this device only)"}>
            <span className="task-check">
              <input type="checkbox" className="checkbox" checked={done} disabled={submitted} aria-label={checkLabel} onChange={(event) => live.actions.onSetDone(item.key, item.title, event.target.checked)} />
            </span>
          </Tip>
        ) : null}
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
            {marked ? <span className="mark-label">Marked done by you</span> : null}
            {hidden ? <span className="hidden-label">Hidden until next refresh</span> : null}
          </span>
        </div>
        <div className="task-aside">
          <span className="kind-chip" data-status={status} role="img" aria-label={`${row.itemKind === "quiz" ? "Quiz" : "Assignment"}, ${STATUS_LABELS[status]}`}>
            {submitted ? <StatusIcon status={status} size={15} /> : <KindIcon kind={row.itemKind} size={15} />}
          </span>
          {actionable && !hidden ? (
            <Tip label="Hide until next refresh">
              <button type="button" className="icon-button icon-button-sm" aria-label={`Hide "${row.title}" until next refresh`} onClick={() => live.actions.onDismiss(item.key, item.title)}>
                <EyeOff size={15} aria-hidden="true" />
              </button>
            </Tip>
          ) : null}
          {open}
        </div>
      </div>
    </li>
  );
};

type PersonalRowViewProps = { row: PersonalRow; deadline: PersonalDeadline | undefined; now: Date; live: AskLive | undefined; dot: ReactNode };

const PersonalRowView = ({ row, deadline, now, live, dot }: PersonalRowViewProps) => {
  const done = deadline ? deadline.completedAt !== null : row.done;
  const dueAt = deadline?.dueAt ?? row.dueAt;
  const title = deadline?.title ?? row.title;
  const overdue = !done && new Date(dueAt).getTime() < now.getTime();
  const setDone = deadline && live?.actions.onSetPersonalDone ? live.actions.onSetPersonalDone : null;
  const show = deadline && live?.actions.onShowPersonal ? live.actions.onShowPersonal : null;
  return (
    <li className="task" data-done={done} data-personal="true">
      <div className="task-row" data-actions={setDone ? true : undefined}>
        {deadline && setDone ? (
          <Tip label={done ? "Done. Uncheck to put it back." : "Mark done"}>
            <span className="task-check">
              <input type="checkbox" className="checkbox" checked={done} aria-label={done ? `${title}: done. Uncheck to put it back.` : `Mark your deadline "${title}" done`} onChange={(event) => setDone(deadline.id, deadline.title, event.target.checked)} />
            </span>
          </Tip>
        ) : null}
        <div className="task-main">
          <span className="task-title" title={title}>
            {title}
          </span>
          <span className="task-sub">
            <span className="task-course">
              {dot}
              {row.courseName ?? "No course"}
            </span>
            <span className="due" data-tone={overdue ? "overdue" : undefined}>
              {overdue ? `Overdue · ${formatRelative(dueAt, now)}` : formatDeadline(dueAt, now)}
            </span>
            <span className="own-tag">Added by you</span>
          </span>
        </div>
        <div className="task-aside">
          <span className="kind-chip" role="img" aria-label="Your own deadline">
            <PenLine size={15} aria-hidden="true" />
          </span>
          {deadline && show ? (
            <Tip label="Show on Week">
              <button type="button" className="icon-button icon-button-sm" aria-label={`Show "${title}" on the Week tab`} onClick={() => show(deadline)}>
                <CalendarDays size={15} aria-hidden="true" />
              </button>
            </Tip>
          ) : null}
        </div>
      </div>
    </li>
  );
};

type ChangeRowViewProps = { row: ChangeRow; stored: ChangeEvent | undefined; now: Date; live: AskLive | undefined; open: ReactNode };

const ChangeRowView = ({ row, stored, now, live, open }: ChangeRowViewProps) => {
  const event = asEvent(row);
  const { icon, tone } = changeIcon(event);
  const side = (fields: ChangeRow["before"]): string | null => (fields?.dueAt !== undefined ? formatDeadline(fields.dueAt, now) : fields?.status ? STATUS_LABELS[fields.status] : null);
  const before = side(row.before);
  const after = side(row.after);
  const unread = stored ? stored.readAt === null : false;
  return (
    <li className="signal" data-unread={unread}>
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
      <div className="signal-aside">
        {stored && live ? (
          <Tip label={unread ? "Mark as read" : "Mark as unread"}>
            <button type="button" className="icon-button icon-button-sm" data-active={!unread} aria-label={unread ? `Mark "${row.title}" as read` : `Mark "${row.title}" as unread`} aria-pressed={!unread} onClick={() => live.actions.onSetRead(stored.id, unread)}>
              <Check size={15} aria-hidden="true" />
            </button>
          </Tip>
        ) : null}
        {open}
      </div>
    </li>
  );
};
