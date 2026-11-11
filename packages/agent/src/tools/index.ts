import type { ToolName } from "@nova-agent/protocol";
import { getRecentAnnouncements } from "./announcements";
import { getBrief } from "./brief";
import { getChanges } from "./changes";
import { getCourseLoad } from "./courseLoad";
import { listDeadlines } from "./deadlines";
import { getItemDetails } from "./itemDetails";
import { proposeHide, proposeMarkDone, proposeMarkRead, proposePersonalDeadline } from "./propose";
import type { ToolContext, ToolResult, ToolSpec } from "./shared";
import { buildStudyPlan } from "./studyPlan";

export * from "./shared";
export * from "./period";
export { ESTIMATE_NOTE, PLAN_DEFAULTS, formatMinutes, type PlanLeftOut } from "./studyPlan";
export { PROPOSED_NOTE, parseClock } from "./propose";
export { getBrief, listDeadlines, getItemDetails, getRecentAnnouncements, getChanges, buildStudyPlan, getCourseLoad, proposeMarkDone, proposeHide, proposeMarkRead, proposePersonalDeadline };

/**
 * Every tool is read-only over the compact snapshot. There is no tool that fetches, writes, or opens anything.
 * The propose_ tools return a suggestion for the student to confirm; they change nothing themselves.
 */
export const TOOLS: readonly ToolSpec[] = [getBrief, listDeadlines, getItemDetails, getRecentAnnouncements, getChanges, buildStudyPlan, getCourseLoad, proposeMarkDone, proposeHide, proposeMarkRead, proposePersonalDeadline] as readonly ToolSpec[];

export type ToolDefinition = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

export const toolSchemasForModel = (tools: readonly ToolSpec[] = TOOLS): ToolDefinition[] =>
  tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.jsonSchema } }));

export const isToolName = (name: string, tools: readonly ToolSpec[] = TOOLS): name is ToolName => tools.some((tool) => tool.name === name);

/** Never throws: unknown tools and invalid arguments come back as `ok: false` with a message the model can act on. */
export const executeTool = (name: string, rawArgs: unknown, context: ToolContext, tools: readonly ToolSpec[] = TOOLS): ToolResult => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return { ok: false, error: `Unknown tool "${name}". Available: ${tools.map((candidate) => candidate.name).join(", ")}.` };
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
    return { ok: false, error: `Invalid arguments for ${name}: ${issues}` };
  }
  try {
    return tool.run(parsed.data, context);
  } catch (error) {
    return { ok: false, error: `${name} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
};
