import type { CompactSnapshot, ToolName } from "@nova-agent/protocol";
import type { ScriptedRouter } from "./scripted";
import { addCalendarDays } from "./tools/period";

/**
 * Answers without a model, for the questions the panel itself suggests and
 * their close variants: one lookup, chosen by a small grammar, and a sentence
 * made from the lookup's own summary. Used on the device when the server
 * cannot answer. A question the grammar does not recognise gets no answer
 * here: guessing a lookup for it would look like an answer and not be one.
 */
export type Intent = { name: ToolName; args: Record<string, unknown> };

/** The model id an answer made this way reports. */
export const OFFLINE_MODEL_ID = "on-device";

const MAX_QUESTION = 160;

/** Questions that need reading, reasoning, or an action. A lookup alone would not answer them. */
const NEEDS_A_MODEL = /\b(why|explain|syllabus|rubric|handout|attachment|lecture|slides?|readings?|notes|manual|policy|remind|mark|hide|add|move|summari[sz]e|grades?|graded|score|scores|email|compare|difference|should i drop)\b/;

/** Questions about something said earlier ("among these", "that course"). Without the conversation a lookup cannot know what is meant. */
const POINTS_BACK = /\b(these|those|that one|this one|that course|that class|them|the same)\b/;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const fold = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The course the question names by its name or code, if exactly one does. */
const courseIn = (question: string, snapshot: CompactSnapshot): string | null => {
  const named = snapshot.courses.filter((course) => {
    const name = fold(course.name);
    const code = course.code ? fold(course.code) : "";
    return (name.length >= 3 && question.includes(name)) || (code.length >= 3 && question.includes(code));
  });
  return named.length === 1 ? (named[0]?.id ?? null) : null;
};

/** The next calendar day with this weekday, today included. */
const nextWeekday = (today: string, weekday: number): string => {
  const from = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addCalendarDays(today, (weekday - from + 7) % 7);
};

/**
 * The one lookup that answers this question, or null when the grammar does
 * not recognise it. Deterministic, and reads nothing but the question and
 * the snapshot's courses and calendar.
 */
export const matchIntent = (message: string, snapshot: CompactSnapshot): Intent | null => {
  const question = fold(message);
  if (question === "" || question.length > MAX_QUESTION || NEEDS_A_MODEL.test(question) || POINTS_BACK.test(question)) return null;
  const courseId = courseIn(question, snapshot);
  const course = courseId ? { course: courseId } : {};

  if (/\bplan\b/.test(question)) {
    const days = /\bweek\b|\b7 days\b|\bseven days\b/.test(question) ? 7 : /\b(2|two) days\b/.test(question) ? 2 : /\btoday\b|\btonight\b/.test(question) ? 1 : 3;
    return { name: "build_study_plan", args: { days, ...course } };
  }
  if (/\b(start|do|work on|tackle|focus on)\b.*\b(first|next|now)\b|\bwhat should i (do|start|work on)\b|\bnext move\b|\bmost (urgent|important)\b|\bpriorit/.test(question)) return { name: "get_brief", args: {} };
  if (/\bwhich course\b|\b(busiest|heaviest|hardest) course\b|\bworkload\b|\bcourse load\b|\bneeds? (the )?most attention\b/.test(question)) return { name: "get_course_load", args: {} };
  if (/\bannouncements?\b|\bnews\b/.test(question)) return { name: "get_recent_announcements", args: { ...course } };
  if (/\b(changed|changes)\b|\bwhats new\b|\bwhat is new\b|\banything new\b|\bsince (my )?last visit\b|\bwhat did i miss\b/.test(question)) return { name: "get_changes", args: { since: "week", ...course } };
  if (/\boverdue\b|\bpast due\b|\blate\b|\bmissing\b|\bbehind on\b/.test(question)) return { name: "list_deadlines", args: { range: "overdue", ...course } };
  if (courseId && /\b(left|remaining|open|still to do)\b/.test(question)) return { name: "list_deadlines", args: { range: "all", course: courseId } };

  const weekday = WEEKDAYS.findIndex((day) => new RegExp(`\\b${day}\\b`).test(question));
  const asksWhatIsDue = /\bdue\b|\bdeadlines?\b|\bcoming up\b|\bupcoming\b|\bon my plate\b|\bto do\b/.test(question);
  const namesAPeriod = /\b(this|next) week\b|\btoday\b|\btonight\b|\btomorrow\b/.test(question) || weekday !== -1;
  if (!asksWhatIsDue && !(namesAPeriod && /\bwhat\b|\banything\b|\bshow\b|\blist\b/.test(question)) && !(courseId && /\bweek\b/.test(question))) return null;
  if (/\bnext week\b/.test(question)) return { name: "list_deadlines", args: { range: "next-week", ...course } };
  if (/\btomorrow\b/.test(question)) return { name: "list_deadlines", args: { range: "tomorrow", ...course } };
  if (/\btoday\b|\btonight\b/.test(question)) return { name: "list_deadlines", args: { range: "today", ...course } };
  if (weekday !== -1) {
    const date = nextWeekday(snapshot.calendar.today, weekday);
    return { name: "list_deadlines", args: { from: date, to: date, ...course } };
  }
  return { name: "list_deadlines", args: { range: "week", ...course } };
};

const NO_MODEL = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/**
 * A scripted model that makes the intent's lookup, then says what the lookup
 * said. The sentence is the tool's own summary, so it is true of the rows
 * under it by construction.
 */
export const intentRouter =
  (intent: Intent): ScriptedRouter =>
  (input) => {
    const lastTool = [...input.messages].reverse().find((message) => message.role === "tool");
    if (!lastTool) return { toolCalls: [{ name: intent.name, args: intent.args }], model: OFFLINE_MODEL_ID, usage: NO_MODEL };
    let result: { summary?: unknown; error?: unknown } = {};
    try {
      result = JSON.parse(lastTool.content) as { summary?: unknown; error?: unknown };
    } catch {
      result = {};
    }
    if (typeof result.summary !== "string" || result.summary.trim() === "") return { text: ["I could not look that up on this device."], model: OFFLINE_MODEL_ID, usage: NO_MODEL };
    return { text: [`${result.summary.trim().replace(/[.!?]+$/, "")}.`, " The rows below come straight from the data on this device."], model: OFFLINE_MODEL_ID, usage: NO_MODEL };
  };
