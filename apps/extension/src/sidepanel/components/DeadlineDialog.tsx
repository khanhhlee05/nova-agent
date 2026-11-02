import type { Course } from "@nova-agent/core";
import { format, isValid, parse } from "date-fns";
import { Dialog } from "radix-ui";
import { useEffect, useState, type FormEvent } from "react";
import type { PersonalDeadline } from "../model";

export const MAX_DEADLINE_TITLE = 120;

export type DeadlineDraft = { title: string; dueAt: string; courseId: string | null };

export type DeadlineDialogProps = {
  /** The day the deadline belongs to. Fixed: to pick another day, close and tap it. */
  date: Date;
  courses: readonly Course[];
  /** Present when editing; absent when adding. */
  existing?: PersonalDeadline | null;
  onSave: (draft: DeadlineDraft) => void;
  onClose: () => void;
};

const NO_COURSE = "__none__";

/** Returns the draft or an error sentence. Pure so the rule is testable without a DOM. */
export const validateDeadline = (fields: { title: string; date: Date; time: string; courseId: string | null }, courses: readonly Course[]): { draft: DeadlineDraft } | { error: string } => {
  // Control characters become spaces, then runs of whitespace collapse; no regex over control ranges so lint stays quiet.
  const title = [...fields.title]
    .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char))
    .join("")
    .trim()
    .replace(/\s+/g, " ");
  if (title.length === 0) return { error: "Give the deadline a name." };
  if (title.length > MAX_DEADLINE_TITLE) return { error: `Keep the name under ${MAX_DEADLINE_TITLE} characters.` };
  const at = parse(`${format(fields.date, "yyyy-MM-dd")} ${fields.time}`, "yyyy-MM-dd HH:mm", new Date());
  if (!isValid(at)) return { error: "Pick a time." };
  if (fields.courseId !== null && !courses.some((course) => course.id === fields.courseId)) return { error: "Pick one of your courses, or no course." };
  return { draft: { title, dueAt: at.toISOString(), courseId: fields.courseId } };
};

/**
 * Add or edit one of the student's own deadlines. Three fields, no more: the
 * date is already chosen by tapping a day, so the form is a name, a time, and
 * an optional course.
 */
export const DeadlineDialog = ({ date, courses, existing = null, onSave, onClose }: DeadlineDialogProps) => {
  const [title, setTitle] = useState(existing?.title ?? "");
  const [time, setTime] = useState(existing ? format(new Date(existing.dueAt), "HH:mm") : "23:59");
  const [courseId, setCourseId] = useState<string | null>(existing?.courseId ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [title, time, courseId]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateDeadline({ title, date, time, courseId }, courses);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    onSave(result.draft);
  };

  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog" aria-describedby="deadline-dialog-note">
          <form onSubmit={submit} className="deadline-form">
            <Dialog.Title asChild>
              <h2>{existing ? "Edit your deadline" : "Add a deadline"}</h2>
            </Dialog.Title>
            <Dialog.Description asChild>
              <p id="deadline-dialog-note">
                {format(date, "EEEE, MMMM d")}. Kept on this device only, never in Brightspace.
              </p>
            </Dialog.Description>
            <label className="deadline-field">
              <span>Name</span>
              <input className="input" type="text" value={title} maxLength={MAX_DEADLINE_TITLE + 20} autoFocus placeholder="Study for the midterm" onChange={(event) => setTitle(event.target.value)} />
            </label>
            <div className="deadline-row">
              <label className="deadline-field">
                <span>Time</span>
                <input className="input" type="time" value={time} required onChange={(event) => setTime(event.target.value)} />
              </label>
              <label className="deadline-field">
                <span>Course</span>
                <select className="input" value={courseId ?? NO_COURSE} onChange={(event) => setCourseId(event.target.value === NO_COURSE ? null : event.target.value)}>
                  <option value={NO_COURSE}>No course</option>
                  {courses.map((course) => (
                    <option key={course.id} value={course.id}>
                      {course.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {error ? (
              <p className="deadline-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="card-actions">
              <Dialog.Close asChild>
                <button type="button" className="button">
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" className="button button-primary">
                {existing ? "Save" : "Add deadline"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
