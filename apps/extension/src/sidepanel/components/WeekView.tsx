import { X } from "lucide-react";
import { Popover } from "radix-ui";
import { format } from "date-fns";
import { formatTime } from "../format";
import type { Dashboard } from "../model";
import { courseSwatch } from "../theme";
import { ItemDetails } from "./ItemDetails";
import { KindIcon } from "./icons";

export type WeekViewProps = {
  dashboard: Dashboard;
  now: Date;
  canOpen: (url: string | null) => boolean;
  onOpen: (url: string) => void;
  onDismiss: (key: string, title: string) => void;
};

/** Time-led agenda. The seven-day strip lives in the field above; this is the list under it. */
export const WeekView = ({ dashboard, now, canOpen, onOpen, onDismiss }: WeekViewProps) => {
  const nextBusy = dashboard.week.find((day) => !day.isToday && day.entries.some((entry) => entry.bucket !== "completed"));
  return (
    <div className="agenda">
      {dashboard.week.map((day) => (
        <section key={day.date.toISOString()} className="agenda-day" aria-label={format(day.date, "EEEE, MMMM d")}>
          <h3 className="agenda-day-label" data-today={day.isToday}>
            {day.isToday ? "Today" : format(day.date, "EEE")}
            <span>{format(day.date, "MMM d")}</span>
          </h3>
          <div className="agenda-items">
            {day.entries.length === 0 ? (
              <p className="agenda-empty">{nextBusy && nextBusy.date > day.date ? `Nothing due. ${format(nextBusy.date, "EEEE")} is next.` : "Nothing due."}</p>
            ) : (
              day.entries.map(({ item, bucket }) => {
                const course = dashboard.courseById.get(item.courseId);
                const done = item.status === "submitted" || item.status === "completed";
                return (
                  <Popover.Root key={item.key}>
                    <Popover.Trigger asChild>
                      <button type="button" className="event-chip" data-tone={bucket === "overdue" ? "overdue" : undefined} data-done={done} aria-label={`${item.title}, ${course?.name ?? "course"}, ${formatTime(item.dueAt as string)}${bucket === "overdue" ? ", overdue" : done ? ", submitted" : ""}`}>
                        <span className="time mono">{formatTime(item.dueAt as string)}</span>
                        <span className="event-main">
                          <span className="title">{item.title}</span>
                          <span className="event-sub">
                            <span className="course-dot" style={{ background: course ? courseSwatch(course.color) : undefined }} aria-hidden="true" />
                            <span className="course-name">{course?.name ?? "Unknown course"}</span>
                            {done ? <span className="done-label">· Submitted</span> : null}
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
                        <ItemDetails item={item} course={course} ranked={dashboard.ranked.get(item.key)} now={now} canOpen={canOpen(item.url)} onOpen={onOpen} headingLevel="h3" onDismiss={() => onDismiss(item.key, item.title)} />
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
