import type { Course, CourseMaterial } from "@nova-agent/core";
import { ChevronDown, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useState } from "react";
import { MATERIAL_READ_LIMITS, isReadable, topicsToRead, type CourseReadProgress } from "../../files/materials";
import { formatAge } from "../format";
import { courseSwatch } from "../theme";

/** One course's materials as the dialog shows them. */
export type CourseMaterialsState = {
  course: Course;
  /** The student turned this course's materials on. */
  allowed: boolean;
  /** The course's Content topics, or null before the table of contents has been fetched. */
  topics: readonly CourseMaterial[] | null;
  fetchedAt: string | null;
  /** Topic ids the student unticked. */
  excluded: ReadonlySet<string>;
  /** Topic ids whose text is on this device, and those that gave none. */
  readIds: ReadonlySet<string>;
  unreadableIds: ReadonlySet<string>;
  /** Characters of text kept for the course. */
  chars: number;
  /** Set while the course is being read. */
  progress: CourseReadProgress | null;
  /** Why the last listing or reading stopped, if it did. */
  error: string | null;
};

export type AskMaterialsControls = {
  courses: readonly CourseMaterialsState[];
  /** Turns a course on: lists its Content area and reads the chosen files. */
  onAllow: (courseId: string) => Promise<void> | void;
  /** Turns a course off and deletes everything read from it. */
  onForget: (courseId: string) => void;
  /** Reads what is new or changed. */
  onRead: (courseId: string) => void;
  onToggleTopic: (courseId: string, topicId: string, include: boolean) => void;
};

export type AskMaterialsProps = AskMaterialsControls & { now: Date; onClose: () => void };

const statusOf = (state: CourseMaterialsState, now: Date): string => {
  if (state.progress) return state.progress.title ? `Reading ${state.progress.done + 1} of ${state.progress.total}: ${state.progress.title}` : "Finishing…";
  if (state.topics === null) return "Listing the course's Content area…";
  const readable = state.topics.filter(isReadable);
  if (readable.length === 0) return "No files Nova can read in this course's Content area.";
  const chosen = topicsToRead(state.topics, state.excluded);
  const read = chosen.filter((topic) => state.readIds.has(topic.id)).length;
  const unreadable = chosen.filter((topic) => state.unreadableIds.has(topic.id)).length;
  const kept = state.chars > 0 ? ` ${state.chars.toLocaleString("en-US")} characters of text kept on this device.` : "";
  return `${read} of ${chosen.length} files read${unreadable > 0 ? `, ${unreadable} with no text` : ""}.${kept}${state.fetchedAt ? ` Listed ${formatAge(state.fetchedAt, now)}.` : ""}`;
};

/**
 * Which courses' Content areas Nova may read, course by course. Turning one
 * on lists it and reads its files; turning it off forgets them. Everything
 * shown here stays on this device.
 */
export const AskMaterials = ({ courses, now, onAllow, onForget, onRead, onToggleTopic, onClose }: AskMaterialsProps) => {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Dialog.Root open onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog ask-materials" aria-describedby="ask-materials-note">
          <Dialog.Close className="icon-button icon-button-sm dialog-close" aria-label="Close course materials">
            <X size={14} aria-hidden="true" />
          </Dialog.Close>
          <Dialog.Title asChild>
            <h2>Course materials</h2>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p id="ask-materials-note">
              Let Nova read a course's Content area (syllabus, slides, readings) to answer from it. Files are downloaded through your Brightspace session, up to {MATERIAL_READ_LIMITS.files} per course, and their text is kept on this device. Only the passages a question needs are sent.
            </p>
          </Dialog.Description>
          <ul className="ask-material-courses" aria-label="Courses">
            {courses.map((state) => {
              const { course } = state;
              const readable = (state.topics ?? []).filter(isReadable);
              const chosen = state.topics ? topicsToRead(state.topics, state.excluded) : [];
              const pending = chosen.filter((topic) => !state.readIds.has(topic.id) && !state.unreadableIds.has(topic.id)).length;
              const busy = state.progress !== null;
              const listed = open === course.id;
              return (
                <li key={course.id} className="ask-material-course">
                  <div className="ask-material-head">
                    <span className="course-dot" style={{ background: courseSwatch(course.color) }} aria-hidden="true" />
                    <strong>{course.name}</strong>
                  </div>
                  {state.allowed ? (
                    <>
                      <p className="ask-material-status" role="status">
                        {statusOf(state, now)}
                      </p>
                      {state.error ? (
                        <p className="ask-material-status" data-tone="error" role="alert">
                          {state.error}
                        </p>
                      ) : null}
                      {readable.length > MATERIAL_READ_LIMITS.files ? <p className="ask-material-status">This course has {readable.length} files. Nova reads the first {MATERIAL_READ_LIMITS.files} that are ticked below; untick some to choose others.</p> : null}
                      <div className="card-actions">
                        {pending > 0 || state.error ? (
                          <button type="button" className="button button-sm" disabled={busy} onClick={() => onRead(course.id)}>
                            {busy ? "Reading…" : state.error ? "Try again" : `Read ${pending} ${pending === 1 ? "file" : "files"}`}
                          </button>
                        ) : null}
                        {readable.length > 0 ? (
                          <button type="button" className="button button-ghost button-sm" aria-expanded={listed} onClick={() => setOpen(listed ? null : course.id)}>
                            <ChevronDown size={14} aria-hidden="true" className="chevron" data-open={listed} />
                            {listed ? "Hide files" : "Choose files"}
                          </button>
                        ) : null}
                        <button type="button" className="button button-ghost button-sm button-danger-ghost" disabled={busy} onClick={() => onForget(course.id)}>
                          Forget materials
                        </button>
                      </div>
                      {listed ? (
                        <ul className="ask-material-topics" aria-label={`Files in ${course.name}`}>
                          {readable.map((topic) => {
                            const included = !state.excluded.has(topic.id);
                            const state_ = state.readIds.has(topic.id) ? "Read" : state.unreadableIds.has(topic.id) ? "No text" : included ? (chosen.some((entry) => entry.id === topic.id) ? "Not read yet" : "Past the limit") : "Skipped";
                            return (
                              <li key={topic.id}>
                                <label className="ask-material-topic">
                                  <input type="checkbox" className="checkbox" checked={included} disabled={busy} onChange={(event) => onToggleTopic(course.id, topic.id, event.target.checked)} />
                                  <span>
                                    <span className="ask-material-title">{topic.title}</span>
                                    <span className="ask-material-meta">
                                      {topic.modulePath.join(" › ")} · {state_}
                                    </span>
                                  </span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </>
                  ) : (
                    <div className="card-actions">
                      <button type="button" className="button button-sm" onClick={() => void onAllow(course.id)}>
                        Let Nova read this course
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
