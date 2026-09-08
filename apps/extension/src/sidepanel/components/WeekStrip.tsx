import type { Course } from "@nova-agent/core";
import { format } from "date-fns";
import type { WeekDay } from "../model";
import { courseSwatch } from "../theme";

export type WeekStripProps = { week: WeekDay[]; courseById: ReadonlyMap<string, Course> };

/** Seven days on the field. Today is a white pill; dots are course colors, at most four per day. */
export const WeekStrip = ({ week, courseById }: WeekStripProps) => (
  <div className="week-strip" role="list" aria-label="Next seven days">
    {week.map((day) => {
      const active = day.entries.filter((entry) => entry.bucket !== "completed");
      return (
        <div key={day.date.toISOString()} className="week-day" data-today={day.isToday} role="listitem" aria-label={`${format(day.date, "EEEE, MMMM d")}: ${active.length} due`}>
          <span className="week-day-name">{format(day.date, "EEE")}</span>
          <strong className="mono">{format(day.date, "d")}</strong>
          <span className="dots" aria-hidden="true">
            {active.slice(0, 4).map((entry) => {
              const course = courseById.get(entry.item.courseId);
              return <i key={entry.item.key} style={day.isToday && course ? { background: courseSwatch(course.color) } : undefined} />;
            })}
          </span>
        </div>
      );
    })}
  </div>
);
