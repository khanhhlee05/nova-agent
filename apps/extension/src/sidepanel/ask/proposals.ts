import { shortId } from "@nova-agent/agent";
import { isDone, type AcademicItem, type ChangeEvent, type Course } from "@nova-agent/core";
import type { ProposalPayload } from "@nova-agent/protocol";
import { format } from "date-fns";
import type { PersonalDeadline } from "../model";

/**
 * pending: waiting for the student. confirmed: carried out on this device.
 * undone: carried out, then reversed from the card. dismissed: the student
 * said no. expired: restored from a saved conversation, where a suggestion
 * made against older data is no longer offered.
 */
export type AskProposalState = "pending" | "confirmed" | "dismissed" | "undone" | "expired";

/** What confirming actually touched, kept so Undo reverses exactly that and nothing else. */
export type ProposalApplied = { itemKeys?: string[]; eventIds?: string[]; personalId?: string; previousDueAt?: string };

export type AskProposal = { id: string; label: string; payload: ProposalPayload; state: AskProposalState; applied?: ProposalApplied };

/** The data on this device a proposal is checked against, for every course. */
export type ProposalContext = {
  items: readonly AcademicItem[];
  courseById: ReadonlyMap<string, Course>;
  localMarks: ReadonlyMap<string, string>;
  dismissed: ReadonlySet<string>;
  events: readonly ChangeEvent[];
  personal: readonly PersonalDeadline[];
};

/**
 * A proposal read against the data on this device: the sentence the card
 * shows, and exactly what confirming would touch. Anything already done,
 * already hidden, already read, or no longer here is left out, so the
 * sentence and the effect cannot drift apart.
 */
export type ResolvedProposal =
  | { kind: "mark_done"; text: string; items: AcademicItem[] }
  | { kind: "hide_item"; text: string; items: AcademicItem[] }
  | { kind: "mark_changes_read"; text: string; events: ChangeEvent[] }
  | { kind: "add_personal_deadline"; text: string; draft: { title: string; dueAt: string; courseId: string | null } }
  | { kind: "move_personal_deadline"; text: string; deadline: PersonalDeadline; dueAt: string }
  | { kind: "complete_personal_deadline"; text: string; deadline: PersonalDeadline }
  | { kind: "unavailable"; text: string };

const quoted = (titles: string[]): string => (titles.length <= 3 ? titles.map((title) => `"${title}"`).join(", ") : `"${titles[0]}", "${titles[1]}", and ${titles.length - 2} more`);

const WHEN = "EEE, MMM d 'at' h:mm a";

/** A local calendar day and a 24-hour clock time, as an instant in the student's own zone. Null when either is not a real date or time. */
export const localInstant = (date: string, time: string): Date | null => {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{2}):(\d{2})$/.exec(time);
  if (!day || !clock) return null;
  const at = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), Number(clock[1]), Number(clock[2]), 0, 0);
  // The Date constructor rolls impossible dates over (Feb 30 becomes Mar 2); those are rejected, not silently moved.
  return Number.isNaN(at.getTime()) || at.getDate() !== Number(day[3]) || at.getMonth() !== Number(day[2]) - 1 ? null : at;
};

const titleOf = (event: ChangeEvent): string => ((event.after?.title ?? event.before?.title) as string | undefined) ?? "an item";

export const resolveProposal = (payload: ProposalPayload, context: ProposalContext): ResolvedProposal => {
  const itemByShortId = new Map(context.items.map((item) => [shortId(item.key, item.kind), item]));
  switch (payload.kind) {
    case "mark_done": {
      const known = payload.itemIds.flatMap((id) => itemByShortId.get(id) ?? []);
      const items = known.filter((item) => !isDone(item) && !context.localMarks.has(item.key));
      if (items.length === 0) return { kind: "unavailable", text: known.length === 0 ? "Nothing to mark: that work is no longer in your data." : "Nothing left to mark: that work is already done." };
      return { kind: "mark_done", items, text: items.length === 1 ? `Mark ${quoted([items[0]?.title ?? ""])} done on this device. Brightspace is not changed.` : `Mark ${items.length} items done on this device: ${quoted(items.map((item) => item.title))}. Brightspace is not changed.` };
    }
    case "hide_item": {
      const known = payload.itemIds.flatMap((id) => itemByShortId.get(id) ?? []);
      const items = known.filter((item) => !context.dismissed.has(item.key));
      if (items.length === 0) return { kind: "unavailable", text: known.length === 0 ? "Nothing to hide: that work is no longer in your data." : "Nothing left to hide: that work is already hidden." };
      return { kind: "hide_item", items, text: items.length === 1 ? `Hide ${quoted([items[0]?.title ?? ""])} until the next refresh.` : `Hide ${items.length} items until the next refresh: ${quoted(items.map((item) => item.title))}.` };
    }
    case "mark_changes_read": {
      // The snapshot clips change ids to 80 characters; the same clip finds the stored event.
      const byId = new Map(context.events.map((event) => [event.id.slice(0, 80), event]));
      const events = payload.changeIds.flatMap((id) => byId.get(id) ?? []).filter((event) => event.readAt === null);
      if (events.length === 0) return { kind: "unavailable", text: "Nothing left to mark: those changes are already read or gone." };
      return { kind: "mark_changes_read", events, text: events.length === 1 ? `Mark the change to "${titleOf(events[0] as ChangeEvent)}" as read.` : `Mark ${events.length} changes as read.` };
    }
    case "add_personal_deadline": {
      const at = localInstant(payload.dueDate, payload.time);
      if (!at) return { kind: "unavailable", text: "This suggestion has a date Nova cannot read." };
      const course = payload.courseId ? context.courseById.get(payload.courseId) : undefined;
      if (payload.courseId && !course) return { kind: "unavailable", text: "This suggestion names a course that is not in your data." };
      return { kind: "add_personal_deadline", draft: { title: payload.title, dueAt: at.toISOString(), courseId: course?.id ?? null }, text: `Add "${payload.title}" to your Week tab: ${format(at, WHEN)}${course ? `, under ${course.name}` : ""}. It stays on this device.` };
    }
    case "move_personal_deadline": {
      const deadline = context.personal.find((entry) => entry.id === payload.personalId);
      const at = localInstant(payload.dueDate, payload.time);
      if (!deadline) return { kind: "unavailable", text: "That deadline is no longer on your Week tab." };
      if (!at) return { kind: "unavailable", text: "This suggestion has a date Nova cannot read." };
      if (at.toISOString() === deadline.dueAt) return { kind: "unavailable", text: `"${deadline.title}" is already at that time.` };
      return { kind: "move_personal_deadline", deadline, dueAt: at.toISOString(), text: `Move your deadline "${deadline.title}" from ${format(new Date(deadline.dueAt), WHEN)} to ${format(at, WHEN)}.` };
    }
    case "complete_personal_deadline": {
      const deadline = context.personal.find((entry) => entry.id === payload.personalId);
      if (!deadline) return { kind: "unavailable", text: "That deadline is no longer on your Week tab." };
      if (deadline.completedAt !== null) return { kind: "unavailable", text: `"${deadline.title}" is already done.` };
      return { kind: "complete_personal_deadline", deadline, text: `Mark your deadline "${deadline.title}" done.` };
    }
  }
};

/** What the card says once the student has decided, in place of the buttons. */
export const SETTLED_COPY: Record<Exclude<AskProposalState, "pending">, string> = {
  confirmed: "Done.",
  undone: "Undone.",
  dismissed: "Dismissed. Nothing changed.",
  expired: "From an earlier session. Ask again if you still want it.",
};

/** Whether a confirmed proposal of this kind can be reversed from its card. */
export const canUndo = (proposal: AskProposal): boolean => proposal.state === "confirmed" && !!proposal.applied && (proposal.payload.kind === "mark_done" || proposal.payload.kind === "mark_changes_read" || proposal.payload.kind === "move_personal_deadline" || proposal.payload.kind === "complete_personal_deadline");
