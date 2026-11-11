import { isDone } from "@nova-agent/core";
import { format } from "date-fns";
import type { Dashboard } from "../model";
import type { AskTool } from "./useAskThread";

const COURSE_NAME_LIMIT = 40;

/**
 * One more question drawn from the data: the busiest day ahead, or failing
 * that the course with the most open work. Null when neither stands out.
 */
export const dataQuestion = (dashboard: Dashboard): string | null => {
  const busiest = [...dashboard.week]
    .filter((day) => !day.isToday)
    .map((day) => ({ day, open: day.entries.filter((entry) => entry.bucket !== "completed").length }))
    .filter((entry) => entry.open >= 2)
    .sort((a, b) => b.open - a.open || a.day.date.getTime() - b.day.date.getTime())[0];
  if (busiest) return `What is due on ${format(busiest.day.date, "EEEE")}?`;
  const open = new Map<string, number>();
  for (const item of dashboard.items) {
    if (isDone(item) || dashboard.localDone.has(item.key)) continue;
    open.set(item.courseId, (open.get(item.courseId) ?? 0) + 1);
  }
  if (open.size < 2) return null;
  const [courseId] = [...open.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
  const name = courseId ? dashboard.courseById.get(courseId)?.name : undefined;
  return name && name.length <= COURSE_NAME_LIMIT ? `What is left in ${name}?` : null;
};

/** Questions worth asking right now, derived from the data: three fixed slots and one drawn from the week or the courses. */
export const suggestedQuestions = (dashboard: Dashboard): string[] => {
  const first = "What should I start first?";
  const second = dashboard.counts.overdue > 0 ? "What is overdue?" : dashboard.counts.thisWeek > 0 ? "What is due in the next 7 days?" : "What is due next week?";
  const third = dashboard.totalChanges > 0 ? "What changed since my last visit?" : "Any new announcements?";
  const fourth = dataQuestion(dashboard);
  return fourth ? [first, second, third, fourth] : [first, second, third];
};

const FOLLOW_UP_LIMIT = 3;

/**
 * Follow-ups for a finished answer, read from the lookups it made and never
 * from the model's text, so a chip cannot be talked into existence.
 */
export const followUpQuestions = (tools: readonly AskTool[]): string[] => {
  const out: string[] = [];
  for (const tool of tools) {
    if (tool.status !== "ok") continue;
    const input = (tool.input ?? {}) as { range?: unknown; from?: unknown; to?: unknown };
    switch (tool.name) {
      case "list_deadlines":
        if (tool.rows > 1) out.push("What should I start first among these?");
        out.push(input.range === "next-week" ? "What is due in the next 7 days?" : "What is due next week?");
        break;
      case "get_brief":
        out.push("Why that one?");
        break;
      case "get_changes":
        if (tool.rows > 0) out.push("Which of these moved later?");
        break;
      case "build_study_plan":
        out.push(typeof (input as { days?: unknown }).days === "number" && ((input as { days: number }).days >= 7) ? "What should I start first?" : "Plan the next 7 days");
        break;
      case "get_course_load":
        out.push("What should I start first?");
        break;
      case "get_item_details":
        out.push("What else is due in that course?");
        break;
      default:
        break;
    }
  }
  return [...new Set(out)].slice(0, FOLLOW_UP_LIMIT);
};

export type AskChipsProps = { dashboard: Dashboard; disabled: boolean; onPick: (question: string) => void };

export const AskChips = ({ dashboard, disabled, onPick }: AskChipsProps) => (
  <div className="ask-chips" role="group" aria-label="Suggested questions">
    {suggestedQuestions(dashboard).map((question) => (
      <button key={question} type="button" className="chip-on-field" aria-disabled={disabled || undefined} onClick={() => (disabled ? undefined : onPick(question))}>
        {question}
      </button>
    ))}
  </div>
);

export type AskFollowUpsProps = { tools: readonly AskTool[]; onPick: (question: string) => void };

/** Shown under the latest finished answer only. */
export const AskFollowUps = ({ tools, onPick }: AskFollowUpsProps) => {
  const questions = followUpQuestions(tools);
  if (questions.length === 0) return null;
  return (
    <div className="ask-followups" role="group" aria-label="Follow-up questions">
      {questions.map((question) => (
        <button key={question} type="button" className="ask-chip" onClick={() => onPick(question)}>
          {question}
        </button>
      ))}
    </div>
  );
};
