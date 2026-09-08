export type SummaryChipsProps = {
  counts: { overdue: number; today: number; thisWeek: number; unread: number };
  onSelect: (target: "overdue" | "today" | "this-week" | "changes") => void;
};

export const SummaryChips = ({ counts, onSelect }: SummaryChipsProps) => (
  <div className="chips" role="group" aria-label="Workload summary">
    <button type="button" className="chip" data-tone="coral" data-zero={counts.overdue === 0} onClick={() => onSelect("overdue")}>
      <strong>{counts.overdue}</strong>
      <span>Overdue</span>
    </button>
    <button type="button" className="chip" data-tone="amber" data-zero={counts.today === 0} onClick={() => onSelect("today")}>
      <strong>{counts.today}</strong>
      <span>Today</span>
    </button>
    <button type="button" className="chip" data-zero={counts.thisWeek === 0} onClick={() => onSelect("this-week")}>
      <strong>{counts.thisWeek}</strong>
      <span>This week</span>
    </button>
    <button type="button" className="chip" data-tone="blue" data-zero={counts.unread === 0} onClick={() => onSelect("changes")}>
      <strong>{counts.unread}</strong>
      <span>New changes</span>
    </button>
  </div>
);
