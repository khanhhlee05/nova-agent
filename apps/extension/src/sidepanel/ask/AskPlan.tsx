import type { PlanSlot, ToolRow } from "@nova-agent/protocol";
import { CalendarCheck, CalendarPlus, ExternalLink, Trash2 } from "lucide-react";
import { endOfDay, format, isSameDay } from "date-fns";
import { Tip } from "../components/Tip";
import { MAX_DEADLINE_TITLE, type DeadlineDraft } from "../components/DeadlineDialog";
import type { Dashboard } from "../model";
import { courseSwatch } from "../theme";
import type { AskLive } from "./AskRows";

type PlanDay = Extract<ToolRow, { kind: "plan-day" }>;

export const isPlanDay = (row: ToolRow): row is PlanDay => row.kind === "plan-day";

/** One deadline for the Week tab per slot. `id` is stable for a plan, day, and position, so adding the same plan twice replaces it. */
export type PlanDraft = DeadlineDraft & { id: string };

/** "45 min", "2 h", "1 h 30 min". */
export const formatDuration = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

/** A calendar string is a local day: "2026-09-08" is the student's September 8, whatever the zone. */
export const localDay = (date: string): Date => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
};

const PREFIX = "Work on: ";

/**
 * Turns a plan into deadlines for the Week tab: one per slot, on the slot's
 * day, at 11:59 PM or at the item's own deadline when that falls earlier on
 * the same day. Courses the panel does not know are dropped from the draft,
 * not guessed.
 */
export const planDrafts = (days: readonly PlanDay[], knownCourse: (courseId: string) => boolean): PlanDraft[] =>
  days.flatMap((day) =>
    day.slots.map((slot, index) => {
      const date = localDay(day.date);
      const due = slot.dueAt ? new Date(slot.dueAt) : null;
      const at = due && !Number.isNaN(due.getTime()) && isSameDay(due, date) ? due : endOfDay(date);
      const room = MAX_DEADLINE_TITLE - PREFIX.length;
      const title = `${PREFIX}${slot.title.length > room ? `${slot.title.slice(0, room - 1).trimEnd()}…` : slot.title}`;
      return { id: `personal-${day.planId}-${day.date}-${index}`, title, dueAt: new Date(Math.floor(at.getTime() / 60_000) * 60_000).toISOString(), courseId: knownCourse(slot.courseId) ? slot.courseId : null };
    }),
  );

export type AskPlansProps = {
  rows: readonly ToolRow[];
  dashboard: Dashboard;
  now: Date;
  canOpen: (url: string | null) => boolean;
  onOpen: (url: string) => void;
  live?: AskLive;
};

/** Every plan an answer built, one card each, in the order they were built. Unlike other rows a plan is shown open: it is the answer. */
export const AskPlans = ({ rows, ...rest }: AskPlansProps) => {
  const days = rows.filter(isPlanDay);
  if (days.length === 0) return null;
  const planIds = [...new Set(days.map((day) => day.planId))];
  return (
    <>
      {planIds.map((planId) => (
        <AskPlan key={planId} planId={planId} days={days.filter((day) => day.planId === planId).sort((a, b) => a.date.localeCompare(b.date))} {...rest} />
      ))}
    </>
  );
};

type AskPlanProps = Omit<AskPlansProps, "rows"> & { planId: string; days: PlanDay[] };

const AskPlan = ({ planId, days, dashboard, now, canOpen, onOpen, live }: AskPlanProps) => {
  const slotCount = days.reduce((sum, day) => sum + day.slots.length, 0);
  const capacity = days[0]?.capacityMinutes ?? 0;
  const onWeek = live ? live.personal.filter((deadline) => deadline.planId === planId).length : 0;
  const add = live?.actions.onAddPlan;
  const remove = live?.actions.onRemovePlan;
  return (
    <section className="ask-plan" aria-label="Study plan">
      <header className="ask-plan-head">
        <strong>Study plan</strong>
        <span>
          {days.length} {days.length === 1 ? "day" : "days"} · {formatDuration(capacity)} a day
        </span>
      </header>
      <ol className="ask-plan-days">
        {days.map((day) => {
          const date = localDay(day.date);
          return (
            <li key={day.id} className="ask-plan-day">
              <h4 className="ask-plan-day-label" data-today={isSameDay(date, now)}>
                {isSameDay(date, now) ? "Today" : format(date, "EEE")}
                <span>{format(date, "MMM d")}</span>
                <span className="ask-plan-load mono">{day.slots.length > 0 ? `${formatDuration(day.totalMinutes)} of ${formatDuration(day.capacityMinutes)}` : ""}</span>
              </h4>
              {day.slots.length === 0 ? (
                <p className="group-empty">Nothing planned.</p>
              ) : (
                <ul className="ask-plan-slots">
                  {day.slots.map((slot, index) => (
                    <PlanSlotRow key={`${slot.itemId}-${index}`} slot={slot} dashboard={dashboard} canOpen={canOpen} onOpen={onOpen} />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      <p className="ask-note">Times are Nova's estimates from each item's kind, points, and time limit. Brightspace does not say how long work takes.</p>
      {slotCount > 0 && add && remove ? (
        <div className="card-actions">
          {onWeek > 0 ? (
            <>
              <span className="ask-plan-added" role="status">
                <CalendarCheck size={14} aria-hidden="true" />
                On your Week tab
              </span>
              <button type="button" className="button button-ghost button-sm" onClick={() => remove(planId)}>
                <Trash2 size={14} aria-hidden="true" />
                Remove from Week
              </button>
            </>
          ) : (
            <button type="button" className="button button-sm" onClick={() => add(planId, planDrafts(days, (courseId) => dashboard.courseById.has(courseId)))}>
              <CalendarPlus size={14} aria-hidden="true" />
              Add to Week
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
};

const PlanSlotRow = ({ slot, dashboard, canOpen, onOpen }: { slot: PlanSlot; dashboard: Dashboard; canOpen: (url: string | null) => boolean; onOpen: (url: string) => void }) => {
  const course = dashboard.courseById.get(slot.courseId);
  const home = course?.homeUrl ?? null;
  const link = canOpen(slot.url) ? slot.url : canOpen(home) ? home : null;
  return (
    <li className="ask-plan-slot">
      <div className="task-main">
        <span className="task-title" title={slot.title}>
          {slot.title}
        </span>
        <span className="task-sub">
          <span className="task-course">
            <span className="course-dot" data-hollow={!course} style={course ? { background: courseSwatch(course.color) } : undefined} aria-hidden="true" />
            {slot.courseName}
          </span>
          <span className="due mono">{formatDuration(slot.minutes)}</span>
        </span>
        <span className="ask-plan-reason">{slot.reason}</span>
      </div>
      {link ? (
        <Tip label="Open in Brightspace">
          <button type="button" className="icon-button icon-button-sm" aria-label={`Open ${slot.title} in Brightspace`} onClick={() => onOpen(link)}>
            <ExternalLink size={15} aria-hidden="true" />
          </button>
        </Tip>
      ) : null}
    </li>
  );
};
