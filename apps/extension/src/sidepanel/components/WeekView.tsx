import { CalendarDays, X } from "lucide-react";
import { Popover } from "radix-ui";
import { format } from "date-fns";
import { formatDayHeader, formatTime } from "../format";
import type { Dashboard } from "../model";
import { ItemDetails } from "./ItemDetails";
import { KindIcon } from "./icons";

export type WeekViewProps = {
  dashboard: Dashboard;
  now: Date;
  canOpen: (url: string | null) => boolean;
  onOpen: (url: string) => void;
};

export const WeekView = ({ dashboard, now, canOpen, onOpen }: WeekViewProps) => {
  const total = dashboard.week.reduce((sum, day) => sum + day.entries.length, 0);
  return (
    <div className="stack">
      <div className="week-grid" role="list" aria-label="Next seven days">
        {dashboard.week.map((day) => {
          const header = formatDayHeader(day.date);
          return (
            <div key={day.date.toISOString()} className="day-header" data-today={day.isToday} role="listitem" aria-label={`${format(day.date, "EEEE, MMMM d")}: ${day.entries.length} due`}>
              <span>{header.weekday}</span>
              <strong>{header.day}</strong>
              <span className="dots" aria-hidden="true">
                {day.entries.slice(0, 4).map((entry) => (
                  <i key={entry.item.key} style={{ background: dashboard.courseById.get(entry.item.courseId)?.color }} />
                ))}
              </span>
            </div>
          );
        })}
      </div>
      {total === 0 ? (
        <div className="empty">
          <CalendarDays size={22} aria-hidden="true" />
          <strong>Nothing due in the next seven days</strong>
          <span>Deadlines further out are listed under Later on the Focus tab.</span>
        </div>
      ) : (
        <div className="agenda">
          {dashboard.week.map((day) => (
            <section key={day.date.toISOString()} className="agenda-day" aria-label={format(day.date, "EEEE, MMMM d")}>
              <h3 className="agenda-day-label" data-today={day.isToday}>
                {day.isToday ? "Today" : format(day.date, "EEE")}
                <span>{format(day.date, "MMM d")}</span>
              </h3>
              <div className="agenda-items">
                {day.entries.length === 0 ? (
                  <p className="agenda-empty">Nothing due</p>
                ) : (
                  day.entries.map(({ item, bucket }) => {
                    const course = dashboard.courseById.get(item.courseId);
                    const done = item.status === "submitted" || item.status === "completed";
                    return (
                      <Popover.Root key={item.key}>
                        <Popover.Trigger asChild>
                          <button type="button" className="event-chip" data-tone={bucket === "overdue" ? "coral" : undefined} data-done={done} style={{ "--rail": course?.color } as React.CSSProperties} aria-label={`${item.title}, ${course?.name ?? "course"}, ${formatTime(item.dueAt as string)}${bucket === "overdue" ? ", overdue" : ""}`}>
                            <KindIcon kind={item.kind} size={14} />
                            <span className="title">{item.title}</span>
                            <span className="time">{formatTime(item.dueAt as string)}</span>
                          </button>
                        </Popover.Trigger>
                        <Popover.Portal>
                          <Popover.Content className="popover" sideOffset={6} collisionPadding={8} align="start">
                            <Popover.Close className="icon-button popover-close" aria-label="Close details">
                              <X size={14} aria-hidden="true" />
                            </Popover.Close>
                            <ItemDetails item={item} course={course} ranked={dashboard.ranked.get(item.key)} now={now} canOpen={canOpen(item.url)} onOpen={onOpen} headingLevel="h3" />
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
      )}
    </div>
  );
};
