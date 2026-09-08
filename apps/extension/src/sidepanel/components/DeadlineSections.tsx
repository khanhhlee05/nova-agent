import { BUCKET_ORDER, type AcademicItem, type Course, type DeadlineBucket } from "@nova-agent/core";
import type { RankedItem } from "@nova-agent/planner";
import { ChevronDown, X } from "lucide-react";
import { Collapsible } from "radix-ui";
import { formatDeadline, formatRelative } from "../format";
import { SECTION_LABELS, STATUS_LABELS, type Dashboard } from "../model";
import { ItemDetails } from "./ItemDetails";
import { KindIcon, StatusIcon } from "./icons";
import { Tip } from "./Tip";

const SECTION_TONE: Partial<Record<DeadlineBucket, "coral" | "amber" | "mint">> = { overdue: "coral", today: "amber", completed: "mint" };

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
  <div className="stack" aria-label="Deadlines">
    {BUCKET_ORDER.filter((bucket) => bucket !== "no-date").map((bucket) => {
      const items = bucket === "later" ? dashboard.buckets.later : dashboard.buckets[bucket];
      const noDate = bucket === "later" ? dashboard.buckets["no-date"] : [];
      const total = items.length + noDate.length;
      const open = !collapsed.has(bucket);
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
              <p className="section-empty">{bucket === "completed" ? "Nothing completed yet." : "Nothing here."}</p>
            ) : (
              <>
                <ul>
                  {items.map((item) => (
                    <TaskRow key={item.key} item={item} bucket={bucket} course={dashboard.courseById.get(item.courseId)} ranked={dashboard.ranked.get(item.key)} now={now} expanded={expandedKey === item.key} onExpand={onExpand} canOpen={canOpen} onOpen={onOpen} onDismiss={onDismiss} />
                  ))}
                </ul>
                {noDate.length > 0 ? (
                  <>
                    <p className="subgroup-label">No due date</p>
                    <ul>
                      {noDate.map((item) => (
                        <TaskRow key={item.key} item={item} bucket="no-date" course={dashboard.courseById.get(item.courseId)} ranked={dashboard.ranked.get(item.key)} now={now} expanded={expandedKey === item.key} onExpand={onExpand} canOpen={canOpen} onOpen={onOpen} onDismiss={onDismiss} />
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
  course: Course | undefined;
  ranked: RankedItem | undefined;
  now: Date;
  expanded: boolean;
  onExpand: (key: string | null) => void;
  canOpen: (url: string | null) => boolean;
  onOpen: (url: string) => void;
  onDismiss: (key: string, title: string) => void;
};

const TaskRow = ({ item, bucket, course, ranked, now, expanded, onExpand, canOpen, onOpen, onDismiss }: TaskRowProps) => {
  const done = item.status === "submitted" || item.status === "completed";
  const dueTone = bucket === "overdue" ? "coral" : bucket === "today" ? "amber" : undefined;
  const detailsId = `details-${item.key.replace(/[^a-z0-9]+/gi, "-")}`;
  return (
    <li className="task" data-done={done} style={{ "--rail": course?.color } as React.CSSProperties}>
      <span className="task-rail" aria-hidden="true" />
      <div className="task-row">
        <span className="task-kind">
          <KindIcon kind={item.kind} />
          <span className="sr-only">{item.kind}</span>
        </span>
        <div className="task-main">
          <span className="task-title" title={item.title}>
            {item.title}
          </span>
          <div className="task-sub">
            <span>{course?.name ?? "Unknown course"}</span>
            <span className="due" data-tone={dueTone}>
              {item.dueAt ? (bucket === "overdue" ? `Overdue · ${formatRelative(item.dueAt, now)}` : formatDeadline(item.dueAt, now)) : "No due date"}
            </span>
          </div>
        </div>
        <div className="task-aside">
          <Tip label={STATUS_LABELS[item.status]}>
            <span className="status-icon" data-status={item.status} tabIndex={0} role="img" aria-label={STATUS_LABELS[item.status]}>
              <StatusIcon status={item.status} />
            </span>
          </Tip>
          <Tip label="Hide until next refresh">
            <button type="button" className="icon-button icon-button-sm" aria-label={`Hide "${item.title}" until next refresh`} onClick={() => onDismiss(item.key, item.title)}>
              <X size={15} aria-hidden="true" />
            </button>
          </Tip>
          <Tip label={expanded ? "Hide details" : "Show details"}>
            <button type="button" className="icon-button icon-button-sm" aria-label={`${expanded ? "Hide" : "Show"} details for ${item.title}`} aria-expanded={expanded} aria-controls={detailsId} onClick={() => onExpand(expanded ? null : item.key)}>
              <ChevronDown size={16} aria-hidden="true" style={{ transform: expanded ? "rotate(180deg)" : undefined, transition: "transform 160ms ease" }} />
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
