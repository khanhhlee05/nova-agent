import type { Course } from "@nova-agent/core";
import { Check, Pencil, Trash2, Undo2 } from "lucide-react";
import { formatExact, formatRelative } from "../format";
import type { PersonalDeadline } from "../model";

export type PersonalDetailsProps = {
  deadline: PersonalDeadline;
  course: Course | undefined;
  now: Date;
  onSetDone: (done: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
};

/** Popover body for one of the student's own deadlines. Says where it came from before anything else can be mistaken for Brightspace. */
export const PersonalDetails = ({ deadline, course, now, onSetDone, onEdit, onDelete }: PersonalDetailsProps) => {
  const done = deadline.completedAt !== null;
  return (
    <div className="details">
      <h3>{deadline.title}</h3>
      <dl>
        <dt>Source</dt>
        <dd>Added by you on {formatExact(deadline.createdAt).replace(/ at .*$/, "")}. Not in Brightspace.</dd>
        <dt>Due</dt>
        <dd>
          {formatExact(deadline.dueAt)}
          <span className="muted"> ({formatRelative(deadline.dueAt, now)})</span>
        </dd>
        <dt>Course</dt>
        <dd>{course?.name ?? "No course"}</dd>
        <dt>Status</dt>
        <dd>{done ? `Done, marked ${formatRelative(deadline.completedAt as string, now)}` : "Not done"}</dd>
      </dl>
      <div className="card-actions">
        <button type="button" className="button button-sm" onClick={() => onSetDone(!done)}>
          {done ? <Undo2 size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
          {done ? "Mark not done" : "Mark done"}
        </button>
        <button type="button" className="button button-sm" onClick={onEdit}>
          <Pencil size={14} aria-hidden="true" />
          Edit
        </button>
        <button type="button" className="button button-ghost button-sm button-danger-ghost" onClick={onDelete}>
          <Trash2 size={14} aria-hidden="true" />
          Delete
        </button>
      </div>
    </div>
  );
};
