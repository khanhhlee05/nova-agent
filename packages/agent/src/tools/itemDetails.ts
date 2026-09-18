import { z } from "zod";
import { changeData, changeRow, defineTool, findItems, itemData, itemRow } from "./shared";

export const getItemDetails = defineTool({
  name: "get_item_details",
  description: "Details for one assignment or quiz: due date, status, points, priority with reasons, and any recent changes to it. Look it up by id (from an earlier result) or by part of its title.",
  input: z
    .object({
      id: z.string().max(40).optional().describe("Item id such as 'a4101' or 'q5101'."),
      titleQuery: z.string().max(200).optional().describe("Part of the item title, for example 'timer interrupts'."),
    })
    .refine((value) => Boolean(value.id) || Boolean(value.titleQuery), { message: "Provide id or titleQuery." }),
  run: (input, { snapshot }) => {
    const byId = input.id ? snapshot.items.find((item) => item.id === input.id) : undefined;
    const fuzzy = !byId && input.titleQuery ? findItems(snapshot, input.titleQuery) : [];
    const item = byId ?? fuzzy[0];
    if (!item) return { ok: false, error: `No item matches ${input.id ? `id "${input.id}"` : `"${input.titleQuery}"`}. Try list_deadlines with range "all".` };
    const changes = snapshot.changes.filter((change) => change.itemId === item.id);
    const otherMatches = fuzzy.slice(1, 6).map((candidate) => ({ id: candidate.id, title: candidate.title }));
    return {
      ok: true,
      summary: `${item.title}: ${item.bucket === "completed" ? "done" : `due ${item.dueLocal ?? "no date"}`}, ${item.status.replace("-", " ")}.`,
      data: {
        item: { ...itemData(snapshot, item), reasons: item.reasons, visibility: item.visibility },
        recentChanges: changes.map((change) => changeData(snapshot, change)),
        otherMatches,
      },
      rows: [itemRow(snapshot, item), ...changes.map((change) => changeRow(snapshot, change))],
    };
  },
});
