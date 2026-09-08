import type { Course } from "@nova-agent/core";
import { format } from "date-fns";
import type { WeekDay } from "../model";
import { courseSwatch } from "../theme";

export const dayKey = (date: Date): string => format(date, "yyyy-MM-dd");

export type WeekStripProps = {
  week: WeekDay[];
  courseById: ReadonlyMap<string, Course>;
  /** Day key of the selected day, or null for the whole week. */
  selected: string | null;
  onSelect: (key: string | null) => void;
};

/**
 * Seven days on the field. Tap a day to show only that day; tap it again for
 * the whole week. The selected day takes the white pill; today keeps a marker.
 */
export const WeekStrip = ({ week, courseById, selected, onSelect }: WeekStripProps) => (
  <div className="week-strip" role="list" aria-label="Next seven days">
    {week.map((day) => {
      const key = dayKey(day.date);
      const active = day.entries.filter((entry) => entry.bucket !== "completed");
      const isSelected = selected === key;
      const highlighted = isSelected || (selected === null && day.isToday);
      return (
        <div key={key} role="listitem">
          <button
            type="button"
            className="week-day"
            data-today={day.isToday}
            data-selected={highlighted}
            aria-pressed={isSelected}
            aria-label={`${format(day.date, "EEEE, MMMM d")}: ${active.length} due${isSelected ? ", selected" : ""}`}
            onClick={() => onSelect(isSelected ? null : key)}
          >
            <span className="week-day-name">{day.isToday ? "Today" : format(day.date, "EEE")}</span>
            <strong className="mono">{format(day.date, "d")}</strong>
            <span className="dots" aria-hidden="true">
              {active.slice(0, 4).map((entry) => {
                const course = courseById.get(entry.item.courseId);
                return <i key={entry.item.key} style={highlighted && course ? { background: courseSwatch(course.color) } : undefined} />;
              })}
            </span>
          </button>
        </div>
      );
    })}
  </div>
);
