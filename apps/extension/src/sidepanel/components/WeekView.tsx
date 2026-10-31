import { PenLine, Plus, X } from "lucide-react";
import { Popover } from "radix-ui";
import { format } from "date-fns";
import { formatTime } from "../format";
import type { Dashboard, PersonalDeadline, WeekDay, WeekEntry } from "../model";
import { courseSwatch } from "../theme";
import { ItemDetails } from "./ItemDetails";
import { PersonalDetails } from "./PersonalDetails";
import { dayKey } from "./WeekStrip";
import { KindIcon } from "./icons";

export type PersonalActions = {
  /** Opens the add dialog for a day. */
  onAdd: (date: Date) => void;
  onEdit: (deadline: PersonalDeadline) => void;
  onDelete: (deadline: PersonalDeadline) => void;
  onSetDone: (deadline: PersonalDeadline, done: boolean) => void;
};

type AgendaRow = { kind: "brightspace"; at: string; entry: WeekEntry } | { kind: "personal"; at: string; deadline: PersonalDeadline };

/** Brightspace entries and the student's own deadlines in one time order; the row itself keeps them apart. */
const agendaRows = (day: WeekDay): AgendaRow[] =>
  [...day.entries.map((entry): AgendaRow => ({ kind: "brightspace", at: entry.item.dueAt as string, entry })), ...day.custom.map((deadline): AgendaRow => ({ kind: "personal", at: deadline.dueAt, deadline }))].sort(
    (a, b) => a.at.localeCompare(b.at),
  );

export type WeekViewProps = {
  dashboard: Dashboard;
  /** The seven days to list; defaults to the next seven. */
  days?: WeekDay[];
  now: Date;
  canOpen: (url: string | null) => boolean;
  onOpen: (url: string) => void;
  onDismiss: (key: string, title: string) => void;
  /** Day key to show alone, or null for the whole week. */
  selectedDay: string | null;
  /** Present when the student can add their own deadlines from a picked day. */
  personal?: PersonalActions;
};

/** Time-led agenda. The seven-day strip lives in the field above; this is the list under it. */
export const WeekView = ({ dashboard, days: page = dashboard.week, now, canOpen, onOpen, onDismiss, selectedDay, personal }: WeekViewProps) => {
  const nextBusy = page.find((day) => !day.isToday && (day.entries.some((entry) => entry.bucket !== "completed") || day.custom.some((deadline) => deadline.completedAt === null)));
  const days = selectedDay ? page.filter((day) => dayKey(day.date) === selectedDay) : page;
  return (
    <div className="agenda">
      {days.map((day) => (
        <section key={day.date.toISOString()} className="agenda-day" aria-label={format(day.date, "EEEE, MMMM d")}>
          <h3 className="agenda-day-label" data-today={day.isToday}>
            {day.isToday ? "Today" : format(day.date, "EEE")}
            <span>{format(day.date, "MMM d")}</span>
          </h3>
          <div className="agenda-items">
            {personal && selectedDay ? (
              <button type="button" className="button button-ghost button-sm agenda-add" onClick={() => personal.onAdd(day.date)}>
                <Plus size={14} aria-hidden="true" />
                Add your own deadline
              </button>
            ) : null}
            {day.entries.length === 0 && day.custom.length === 0 ? (
              <p className="agenda-empty">{nextBusy && nextBusy.date > day.date ? `Nothing due. ${format(nextBusy.date, "EEEE")} is next.` : "Nothing due."}</p>
            ) : (
              agendaRows(day).map((row) => {
                if (row.kind === "personal") {
                  const { deadline } = row;
                  const course = deadline.courseId ? dashboard.courseById.get(deadline.courseId) : undefined;
                  const done = deadline.completedAt !== null;
                  return (
                    <Popover.Root key={`personal-${deadline.id}`}>
                      <Popover.Trigger asChild>
                        <button type="button" className="event-chip" data-personal="true" data-done={done} aria-label={`${deadline.title}, added by you, ${course?.name ?? "no course"}, ${formatTime(deadline.dueAt)}${done ? ", done" : ""}`}>
                          <span className="time mono">{formatTime(deadline.dueAt)}</span>
                          <span className="event-main">
                            <span className="title">{deadline.title}</span>
                            <span className="event-sub">
                              <span className="course-dot" data-hollow={!course} style={course ? { background: courseSwatch(course.color) } : undefined} aria-hidden="true" />
                              <span className="course-name">{course?.name ?? "No course"}</span>
                              <span className="own-tag">Added by you</span>
                              {done ? <span className="done-label">· Done</span> : null}
                            </span>
                          </span>
                          <PenLine size={14} aria-hidden="true" />
                        </button>
                      </Popover.Trigger>
                      <Popover.Portal>
                        <Popover.Content className="popover" sideOffset={6} collisionPadding={8} align="start">
                          <Popover.Close className="icon-button icon-button-sm popover-close" aria-label="Close details">
                            <X size={14} aria-hidden="true" />
                          </Popover.Close>
                          <PersonalDetails deadline={deadline} course={course} now={now} onSetDone={(value) => personal?.onSetDone(deadline, value)} onEdit={() => personal?.onEdit(deadline)} onDelete={() => personal?.onDelete(deadline)} />
                        </Popover.Content>
                      </Popover.Portal>
                    </Popover.Root>
                  );
                }
                const { item, bucket } = row.entry;
                const course = dashboard.courseById.get(item.courseId);
                const marked = dashboard.localDone.has(item.key);
                const done = marked || item.status === "submitted" || item.status === "completed";
                const doneLabel = marked ? "Marked done" : "Submitted";
                return (
                  <Popover.Root key={item.key}>
                    <Popover.Trigger asChild>
                      <button type="button" className="event-chip" data-tone={bucket === "overdue" ? "overdue" : undefined} data-done={done} aria-label={`${item.title}, ${course?.name ?? "course"}, ${formatTime(item.dueAt as string)}${bucket === "overdue" ? ", overdue" : done ? `, ${doneLabel.toLowerCase()}` : ""}`}>
                        <span className="time mono">{formatTime(item.dueAt as string)}</span>
                        <span className="event-main">
                          <span className="title">{item.title}</span>
                          <span className="event-sub">
                            <span className="course-dot" style={{ background: course ? courseSwatch(course.color) : undefined }} aria-hidden="true" />
                            <span className="course-name">{course?.name ?? "Unknown course"}</span>
                            {done ? <span className="done-label">· {doneLabel}</span> : null}
                          </span>
                        </span>
                        <KindIcon kind={item.kind} size={14} />
                      </button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content className="popover" sideOffset={6} collisionPadding={8} align="start">
                        <Popover.Close className="icon-button icon-button-sm popover-close" aria-label="Close details">
                          <X size={14} aria-hidden="true" />
                        </Popover.Close>
                        <ItemDetails item={item} course={course} ranked={dashboard.ranked.get(item.key)} now={now} canOpen={canOpen(item.url)} onOpen={onOpen} headingLevel="h3" onDismiss={() => onDismiss(item.key, item.title)} markedAt={dashboard.localDone.get(item.key) ?? null} />
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                );
              })
            )}
          </div>
        </section>
      ))}
    </div>
  );
};
