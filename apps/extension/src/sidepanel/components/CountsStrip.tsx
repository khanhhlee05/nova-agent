export type CountsStripProps = {
  counts: { overdue: number; thisWeek: number; unread: number };
  onSelect: (target: "overdue" | "this-week" | "changes") => void;
};

/** Three numbers in one line, inside the field. Each is a jump, not a tile. */
export const CountsStrip = ({ counts, onSelect }: CountsStripProps) => (
  <div className="field-counts" role="group" aria-label="Workload summary">
    <button type="button" className="count" onClick={() => onSelect("overdue")}>
      <strong>{counts.overdue}</strong>
      <span>Overdue</span>
    </button>
    <button type="button" className="count" onClick={() => onSelect("this-week")}>
      <strong>{counts.thisWeek}</strong>
      <span>This week</span>
    </button>
    <button type="button" className="count" onClick={() => onSelect("changes")}>
      <strong>{counts.unread}</strong>
      <span>New changes</span>
    </button>
  </div>
);
