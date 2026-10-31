import { ChevronLeft, ChevronRight } from "lucide-react";
import { format } from "date-fns";
import type { WeekPage } from "../model";
import { Tip } from "./Tip";

export type WeekNavProps = {
  page: WeekPage;
  /** The last page that still has a deadline on it. */
  lastOffset: number;
  onChange: (offset: number) => void;
};

/** Pages the Week tab seven days at a time, forward only, never past the last known deadline. */
export const WeekNav = ({ page, lastOffset, onChange }: WeekNavProps) => {
  const range = `${format(page.from, "MMM d")} to ${format(page.to, "MMM d")}`;
  const canForward = page.offset < lastOffset;
  return (
    <div className="week-nav">
      <Tip label={page.offset === 0 ? "This is the current week" : "Previous 7 days"}>
        <button type="button" className="icon-button icon-button-sm on-field" aria-label="Previous 7 days" disabled={page.offset === 0} onClick={() => onChange(page.offset - 1)}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
      </Tip>
      <span className="week-nav-range" aria-live="polite">
        {range}
        {page.offset > 0 ? <span className="week-nav-ahead"> · {page.offset === 1 ? "1 week ahead" : `${page.offset} weeks ahead`}</span> : null}
      </span>
      {page.offset > 0 ? (
        <button type="button" className="button button-on-field button-sm" onClick={() => onChange(0)}>
          Today
        </button>
      ) : null}
      <Tip label={canForward ? "Next 7 days" : "No deadlines further ahead"}>
        <button type="button" className="icon-button icon-button-sm on-field" aria-label="Next 7 days" disabled={!canForward} onClick={() => onChange(page.offset + 1)}>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </Tip>
    </div>
  );
};
