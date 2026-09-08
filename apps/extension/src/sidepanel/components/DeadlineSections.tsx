import { BUCKET_ORDER, type AcademicItem, type Course, type DeadlineBucket } from "@nova-agent/core";
import type { RankedItem } from "@nova-agent/planner";
import { ChevronDown, X } from "lucide-react";
import { Collapsible } from "radix-ui";
import { formatDeadline, formatRelative } from "../format";
import { SECTION_LABELS, STATUS_LABELS, type Dashboard } from "../model";
import { courseSwatch } from "../theme";
import { ItemDetails } from "./ItemDetails";
import { KindIcon, StatusIcon } from "./icons";
import { Tip } from "./Tip";

const SECTION_TONE: Partial<Record<DeadlineBucket, "overdue" | "today" | "done">> = { overdue: "overdue", today: "today", completed: "done" };

export type DeadlineSectionsProps = {
  dashboard: Dashboard;
  now: Date;
  collapsed: ReadonlySet<DeadlineBucket>;
  onToggle: (bucket: DeadlineBucket) => void;
  expandedKey: string | null;
  onExpand: (key: string | null) => void;
  canOpen: (url: string | null) => boolean;
  onOpen: (url: string) => void;
  onDismiss: (key: string, title: string) => void;
};

export const DeadlineSections = ({ dashboard, now, collapsed, onToggle, expandedKey, onExpand, canOpen, onOpen, onDismiss }: DeadlineSectionsProps) => (
  <div className="sections" aria-label="Deadlines">
    {BUCKET_ORDER.filter((bucket) => bucket !== "no-date").map((bucket) => {
      const items = bucket === "later" ? dashboard.buckets.later : dashboard.buckets[bucket];
      const noDate = bucket === "later" ? dashboard.buckets["no-date"] : [];
      const total = items.length + noDate.length;
      const open = !collapsed.has(bucket);
      const rowProps = { now, expandedKey, onExpand, canOpen, onOpen, onDismiss, dashboard };
      return (
        <Collapsible.Root key={bucket} className="section" data-tone={SECTION_TONE[bucket]} open={open} onOpenChange={() => onToggle(bucket)}>
          <Collapsible.Trigger className="section-trigger" id={`section-${bucket}`}>
            <h3>{SECTION_LABELS[bucket]}</h3>
            <span className="count mono" aria-label={`${total} items`}>
              {total}
            </span>
            <ChevronDown size={16} className="chevron" aria-hidden="true" />
          </Collapsible.Trigger>
          <Collapsible.Content className="section-content">
            {total === 0 ? (
              <p className="section-empty">{bucket === "completed" ? "Nothing completed yet." : bucket === "tomorrow" ? "Nothing due tomorrow." : "Nothing here."}</p>
            ) : (
              <>
                <ul className="tasks">
                  {items.map((item) => (
                    <TaskRow key={item.key} item={item} bucket={bucket} {...rowProps} />
                  ))}
                </ul>
                {noDate.length > 0 ? (
                  <>
                    <p className="subgroup-label">No due date</p>
                    <ul className="tasks">
                      {noDate.map((item) => (
                        <TaskRow key={item.key} item={item} bucket="no-date" {...rowProps} />
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            )}
          </Collapsible.Content>
        </Collapsible.Root>
      );
    })}
  </div>
);

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
};

const TaskRow = ({ item, bucket, dashboard, now, expandedKey, onExpand, canOpen, onOpen, onDismiss }: TaskRowProps) => {
  const course: Course | undefined = dashboard.courseById.get(item.courseId);
  const ranked: RankedItem | undefined = dashboard.ranked.get(item.key);
  const expanded = expandedKey === item.key;
  const done = item.status === "submitted" || item.status === "completed";
  const dueTone = bucket === "overdue" ? "overdue" : bucket === "today" ? "today" : undefined;
  const detailsId = `details-${item.key.replace(/[^a-z0-9]+/gi, "-")}`;
  const when = item.dueAt ? (bucket === "overdue" ? `Overdue · ${formatRelative(item.dueAt, now)}` : formatDeadline(item.dueAt, now)) : "No due date";
  return (
    <li className="task" data-done={done}>
      <div className="task-row">
        <div className="task-main">
          <span className="task-title" title={item.title}>
            {item.title}
          </span>
          <span className="task-sub">
            <span className="task-course">
              <span className="course-dot" style={{ background: course ? courseSwatch(course.color) : undefined }} aria-hidden="true" />
              {course?.name ?? "Unknown course"}
            </span>
            <span className="due" data-tone={dueTone}>
              {when}
            </span>
          </span>
        </div>
        <div className="task-aside">
          <Tip label={`${item.kind === "quiz" ? "Quiz" : "Assignment"} · ${STATUS_LABELS[item.status]}`}>
            <span className="kind-chip" data-status={item.status} tabIndex={0} role="img" aria-label={`${item.kind === "quiz" ? "Quiz" : "Assignment"}, ${STATUS_LABELS[item.status]}`}>
              {done ? <StatusIcon status={item.status} size={15} /> : <KindIcon kind={item.kind} size={15} />}
            </span>
          </Tip>
          <Tip label="Hide until next refresh">
            <button type="button" className="icon-button icon-button-sm" aria-label={`Hide "${item.title}" until next refresh`} onClick={() => onDismiss(item.key, item.title)}>
              <X size={15} aria-hidden="true" />
            </button>
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
          <ItemDetails item={item} course={course} ranked={ranked} now={now} canOpen={canOpen(item.url)} onOpen={onOpen} onDismiss={() => onDismiss(item.key, item.title)} />
        </div>
      ) : null}
    </li>
  );
};
