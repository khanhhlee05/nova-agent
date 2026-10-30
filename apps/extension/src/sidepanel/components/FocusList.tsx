import { LONG_OVERDUE_AFTER_DAYS, isDone, type AcademicItem, type Course, type DeadlineBucket } from "@nova-agent/core";
import type { RankedItem } from "@nova-agent/planner";
import { ChevronDown, ChevronUp } from "lucide-react";
import { formatDeadline, formatRelative, pluralize } from "../format";
import { SECTION_LABELS, STATUS_LABELS, UPCOMING_BUCKETS, sortItems, type Dashboard, type FocusCategory, type SortKey } from "../model";
import { courseSwatch } from "../theme";
import { ItemDetails } from "./ItemDetails";
import { KindIcon, StatusIcon } from "./icons";
import { Tip } from "./Tip";

export type FocusListProps = {
  dashboard: Dashboard;
  category: FocusCategory;
  sort: SortKey;
  now: Date;
  courseFiltered: boolean;
  expandedKey: string | null;
  onExpand: (key: string | null) => void;
  canOpen: (url: string | null) => boolean;
  onOpen: (url: string) => void;
  onDismiss: (key: string, title: string) => void;
  /** Sets or clears the on-device done mark. */
  onSetDone: (key: string, title: string, done: boolean) => void;
  /** Session-only: whether items overdue for more than two weeks are listed under Overdue. */
  showLongOverdue: boolean;
  onToggleLongOverdue: () => void;
};

const GROUP_LABELS: Partial<Record<DeadlineBucket, string>> = { ...SECTION_LABELS, "no-date": "No due date" };

const EMPTY_COPY: Record<FocusCategory, { title: string; text: (courseFiltered: boolean) => string }> = {
  overdue: { title: "Nothing overdue", text: () => "Every deadline Nova can see is still ahead of you." },
  upcoming: { title: "Nothing coming up", text: (courseFiltered) => (courseFiltered ? "This course has no open assignments or quizzes. Try All courses." : "No open assignments or quizzes in your courses.") },
  completed: { title: "Nothing completed yet", text: () => "Submitted work and anything you mark done land here." },
};

/** The one list under the category control. Only the Upcoming view groups by day, and only when sorted by due date. */
export const FocusList = ({ dashboard, category, sort, now, courseFiltered, expandedKey, onExpand, canOpen, onOpen, onDismiss, onSetDone, showLongOverdue, onToggleLongOverdue }: FocusListProps) => {
  const rowProps = { dashboard, now, expandedKey, onExpand, canOpen, onOpen, onDismiss, onSetDone };
  const items = category === "overdue" ? dashboard.buckets.overdue : category === "completed" ? dashboard.buckets.completed : UPCOMING_BUCKETS.flatMap((bucket) => dashboard.buckets[bucket]);
  const older = category === "overdue" ? dashboard.longOverdue : [];
  const fold =
    older.length > 0 ? (
      <button type="button" className="button button-ghost button-sm fold" aria-expanded={showLongOverdue} aria-controls="long-overdue" onClick={onToggleLongOverdue}>
        {showLongOverdue ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        {showLongOverdue ? "Hide long overdue" : `Show ${pluralize(older.length, "long overdue item")}`}
      </button>
    ) : null;
  // Weeks-old deadlines are usually closed or no longer tracked. They stay out of the way until asked for.
  const olderGroup =
    older.length > 0 && showLongOverdue ? (
      <section className="group" id="long-overdue" aria-labelledby="group-long-overdue">
        <h3 className="group-label" id="group-long-overdue">
          Long overdue
          <span className="count mono" aria-label={pluralize(older.length, "item")}>
            {older.length}
          </span>
        </h3>
        <p className="group-note">Overdue for more than {LONG_OVERDUE_AFTER_DAYS / 7 === 2 ? "two weeks" : `${LONG_OVERDUE_AFTER_DAYS} days`}. These are often closed or no longer tracked by the instructor.</p>
        <ul className="tasks">
          {sortItems(older, sort, dashboard, "overdue").map((item) => (
            <TaskRow key={item.key} item={item} bucket="overdue" {...rowProps} />
          ))}
        </ul>
      </section>
    ) : null;
  if (items.length === 0) {
    const copy = EMPTY_COPY[category];
    return (
      <div className="groups">
        <div className="empty" role="status">
          <strong>{older.length > 0 ? `Nothing overdue in the last ${LONG_OVERDUE_AFTER_DAYS / 7 === 2 ? "two weeks" : `${LONG_OVERDUE_AFTER_DAYS} days`}` : copy.title}</strong>
          <span>{older.length > 0 ? `${pluralize(older.length, "older item is", "older items are")} hidden.` : copy.text(courseFiltered)}</span>
          {fold}
        </div>
        {olderGroup}
      </div>
    );
  }
  if (category === "upcoming" && sort === "due") {
    return (
      <div className="groups" aria-label="Upcoming">
        {UPCOMING_BUCKETS.map((bucket) => {
          const rows = dashboard.buckets[bucket];
          // Today is the one day the student always wants an answer for, even when the answer is "nothing".
          if (rows.length === 0 && bucket !== "today") return null;
          return (
            <section key={bucket} className="group" aria-labelledby={`group-${bucket}`}>
              <h3 className="group-label" id={`group-${bucket}`} data-tone={bucket === "today" ? "today" : undefined}>
                {GROUP_LABELS[bucket]}
                <span className="count mono" aria-label={pluralize(rows.length, "item")}>
                  {rows.length}
                </span>
              </h3>
              {rows.length === 0 ? (
                <p className="group-empty">Nothing due today.</p>
              ) : (
                <ul className="tasks">
                  {rows.map((item) => (
                    <TaskRow key={item.key} item={item} bucket={bucket} {...rowProps} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    );
  }
  const bucketOf = new Map<string, DeadlineBucket>();
  for (const bucket of Object.keys(dashboard.buckets) as DeadlineBucket[]) for (const item of dashboard.buckets[bucket]) bucketOf.set(item.key, bucket);
  const list = (
    <ul className="tasks" aria-label={category === "overdue" ? "Overdue" : category === "completed" ? "Completed" : "Upcoming"}>
      {sortItems(items, sort, dashboard, category).map((item) => (
        <TaskRow key={item.key} item={item} bucket={bucketOf.get(item.key) ?? "no-date"} {...rowProps} />
      ))}
    </ul>
  );
  if (!fold) return list;
  return (
    <div className="groups">
      {list}
      <div className="fold-row">{fold}</div>
      {olderGroup}
    </div>
  );
};

type TaskRowProps = {
  item: AcademicItem;
  bucket: DeadlineBucket;
  dashboard: Dashboard;
  now: Date;
  expandedKey: string | null;
  onExpand: (key: string | null) => void;
  canOpen: (url: string | null) => boolean;
  onOpen: (url: string) => void;
  onDismiss: (key: string, title: string) => void;
  onSetDone: (key: string, title: string, done: boolean) => void;
};

const TaskRow = ({ item, bucket, dashboard, now, expandedKey, onExpand, canOpen, onOpen, onDismiss, onSetDone }: TaskRowProps) => {
  const course: Course | undefined = dashboard.courseById.get(item.courseId);
  const ranked: RankedItem | undefined = dashboard.ranked.get(item.key);
  const expanded = expandedKey === item.key;
  const submitted = isDone(item);
  const markedAt = dashboard.localDone.get(item.key);
  const done = submitted || markedAt !== undefined;
  const changed = dashboard.changedAt.has(item.key);
  const dueTone = bucket === "overdue" ? "overdue" : bucket === "today" ? "today" : undefined;
  const detailsId = `details-${item.key.replace(/[^a-z0-9]+/gi, "-")}`;
  const when = item.dueAt ? (bucket === "overdue" ? `Overdue · ${formatRelative(item.dueAt, now)}` : formatDeadline(item.dueAt, now)) : "No due date";
  const checkLabel = submitted ? `${item.title}: ${STATUS_LABELS[item.status].toLowerCase()} in Brightspace` : markedAt ? `${item.title}: marked done by you. Uncheck to put it back.` : `Mark "${item.title}" done on this device`;
  return (
    <li className="task" data-done={done}>
      <div className="task-row">
        <Tip label={submitted ? "Submitted in Brightspace" : markedAt ? "Marked done by you" : "Mark done (this device only)"}>
          <span className="task-check">
            <input type="checkbox" className="checkbox" checked={done} disabled={submitted} aria-label={checkLabel} onChange={(event) => onSetDone(item.key, item.title, event.target.checked)} />
          </span>
        </Tip>
        <div className="task-main">
          <span className="task-title" title={item.title}>
            {item.title}
          </span>
          <span className="task-sub">
            <span className="task-course">
              <span className="course-dot" style={{ background: course ? courseSwatch(course.color) : undefined }} aria-hidden="true" />
              {course?.name ?? "Unknown course"}
            </span>
            <span className="due" data-tone={done ? undefined : dueTone}>
              {when}
            </span>
            {markedAt ? <span className="mark-label">Marked done by you</span> : null}
            {changed && !done ? <span className="changed-label">Changed</span> : null}
          </span>
        </div>
        <div className="task-aside">
          <Tip label={`${item.kind === "quiz" ? "Quiz" : "Assignment"} · ${STATUS_LABELS[item.status]}`}>
            <span className="kind-chip" data-status={item.status} role="img" aria-label={`${item.kind === "quiz" ? "Quiz" : "Assignment"}, ${STATUS_LABELS[item.status]}`}>
              {submitted ? <StatusIcon status={item.status} size={15} /> : <KindIcon kind={item.kind} size={15} />}
            </span>
          </Tip>
          <Tip label={expanded ? "Hide details" : "Show details"}>
            <button type="button" className="icon-button icon-button-sm" aria-label={`${expanded ? "Hide" : "Show"} details for ${item.title}`} aria-expanded={expanded} aria-controls={detailsId} onClick={() => onExpand(expanded ? null : item.key)}>
              <ChevronDown size={16} aria-hidden="true" className="chevron" data-open={expanded} />
            </button>
          </Tip>
        </div>
      </div>
      {expanded ? (
        <div className="task-details" id={detailsId}>
          <ItemDetails item={item} course={course} ranked={ranked} now={now} canOpen={canOpen(item.url)} onOpen={onOpen} onDismiss={() => onDismiss(item.key, item.title)} markedAt={markedAt ?? null} />
        </div>
      ) : null}
    </li>
  );
};
