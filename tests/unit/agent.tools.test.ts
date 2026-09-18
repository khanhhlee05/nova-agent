import { TOOLS, compactSnapshot, executeTool, toolSchemasForModel, type ToolContext } from "@nova-agent/agent";
import { diffSnapshots } from "@nova-agent/core";
import type { CompactSnapshot, ToolRow } from "@nova-agent/protocol";
import { describe, expect, it } from "vitest";
import { makeSnapshot } from "../helpers/factories";
import { NOW, demoSnapshot } from "../helpers/demoDashboard";

let baseline: CompactSnapshot;
let changed: CompactSnapshot;

const load = async () => {
  if (baseline && changed) return;
  const earlier = await demoSnapshot("baseline", new Date(NOW.getTime() - 3_600_000));
  const current = await demoSnapshot("changed", NOW);
  baseline = compactSnapshot(earlier, [], NOW, { mode: "demo", timezone: "America/New_York" });
  changed = compactSnapshot(current, diffSnapshots({ current, history: [earlier] }), NOW, { mode: "demo", timezone: "America/New_York" });
};

const run = (name: string, args: unknown, snapshot: CompactSnapshot) => executeTool(name, args, { snapshot } satisfies ToolContext);
const ok = (result: ReturnType<typeof run>) => {
  if (!result.ok) throw new Error(result.error);
  return result;
};
const titles = (rows: ToolRow[]) => rows.map((row) => row.title);

describe("tool schemas", () => {
  it("expose OpenAI-style function definitions without $schema and with optional fields not required", () => {
    const defs = toolSchemasForModel();
    expect(defs.map((def) => def.function.name)).toEqual(["get_brief", "list_deadlines", "get_item_details", "get_recent_announcements", "get_changes"]);
    for (const def of defs) {
      expect(def.type).toBe("function");
      expect(def.function.description.length).toBeGreaterThan(20);
      expect("$schema" in def.function.parameters).toBe(false);
      expect(def.function.parameters.type).toBe("object");
    }
    const deadlines = defs.find((def) => def.function.name === "list_deadlines")?.function.parameters as { required?: string[]; properties: Record<string, { description?: string }> };
    expect(deadlines.required ?? []).toEqual([]);
    expect(deadlines.properties.range?.description).toContain("week");
  });

  it("rejects unknown tools and invalid arguments without throwing", async () => {
    await load();
    expect(run("open_page", {}, baseline)).toMatchObject({ ok: false });
    const bad = run("list_deadlines", { range: "someday" }, baseline);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("range");
    expect(run("get_item_details", {}, baseline).ok).toBe(false);
    expect(run("list_deadlines", { course: "Underwater Basket Weaving" }, baseline)).toMatchObject({ ok: false, error: expect.stringContaining("No course matches") });
    expect(TOOLS).toHaveLength(5);
  });
});

describe("get_brief", () => {
  it("returns counts, the next move with reasons, and rows for overdue and today", async () => {
    await load();
    const result = ok(run("get_brief", {}, baseline));
    const data = result.data as { counts: CompactSnapshot["counts"]; nextMove: { title: string; reasons: string[] } | null; overdue: { title: string }[]; dueToday: { title: string }[] };
    expect(data.counts).toEqual(baseline.counts);
    expect(data.nextMove).not.toBeNull();
    expect(data.nextMove?.reasons.length).toBeGreaterThan(0);
    expect(data.overdue.map((item) => item.title)).toContain("Lab 2: GPIO and Debouncing");
    expect(data.dueToday.map((item) => item.title)).toContain("Problem Set 6: Fourier Series");
    expect(result.rows.length).toBeLessThanOrEqual(8);
    expect(result.rows[0]?.title).toBe(data.nextMove?.title);
    expect(result.summary).toContain(data.nextMove?.title ?? "");
  });

  it("is honest on an empty snapshot", () => {
    const empty = compactSnapshot(makeSnapshot(NOW.toISOString(), []), [], NOW, { mode: "live" });
    const result = ok(run("get_brief", {}, empty));
    expect((result.data as { nextMove: unknown }).nextMove).toBeNull();
    expect(result.rows).toEqual([]);
    expect(result.summary).toBe("Nothing active right now.");
  });
});

describe("list_deadlines", () => {
  it("defaults to this week, excludes done items, and orders by due date", async () => {
    await load();
    const result = ok(run("list_deadlines", {}, baseline));
    const names = titles(result.rows);
    expect(names).toContain("Problem Set 6: Fourier Series");
    expect(names).toContain("Lab 3: Timer Interrupts");
    expect(names).toContain("MATLAB Lab: Filters");
    expect(names).not.toContain("Lab 2: GPIO and Debouncing");
    expect(names).not.toContain("Project Proposal");
    expect(names).not.toContain("Lab 1: Toolchain Setup");
    const dues = result.rows.map((row) => (row.kind === "item" ? row.dueAt ?? "" : ""));
    expect([...dues].sort()).toEqual(dues);
  });

  it("filters by course name fragment, kind, and range, and can include done items", async () => {
    await load();
    const micro = ok(run("list_deadlines", { range: "all", course: "micro" }, baseline));
    expect(titles(micro.rows)).toEqual(expect.arrayContaining(["Lab 3: Timer Interrupts", "Lab 2: GPIO and Debouncing", "Project Proposal", "Quiz 2: Interrupt Latency"]));
    expect(titles(micro.rows)).not.toContain("Lab 1: Toolchain Setup");
    expect(micro.rows.every((row) => row.courseName === "Microcontrollers")).toBe(true);
    const withDone = ok(run("list_deadlines", { range: "all", course: "ECE-2042-001", includeDone: true }, baseline));
    expect(titles(withDone.rows)).toContain("Lab 1: Toolchain Setup");
    const quizzes = ok(run("list_deadlines", { range: "all", kind: "quiz" }, baseline));
    expect(quizzes.rows.every((row) => row.kind === "item" && row.itemKind === "quiz")).toBe(true);
    const overdue = ok(run("list_deadlines", { range: "overdue" }, baseline));
    expect(titles(overdue.rows)).toEqual(["Lab 2: GPIO and Debouncing"]);
    const limited = ok(run("list_deadlines", { range: "all", limit: 2 }, baseline));
    expect(limited.rows).toHaveLength(2);
    expect(limited.summary).toContain("showing 2");
  });
});

describe("get_item_details", () => {
  it("finds an item by title fragment and by id and lists its recent changes", async () => {
    await load();
    const byTitle = ok(run("get_item_details", { titleQuery: "timer interrupts" }, changed));
    const data = byTitle.data as { item: { id: string; title: string; reasons: string[] }; recentChanges: { kind: string }[] };
    expect(data.item.title).toBe("Lab 3: Timer Interrupts");
    expect(data.item.id).toBe("a4101");
    expect(data.recentChanges.map((change) => change.kind)).toContain("due-date-changed");
    expect(byTitle.rows.map((row) => row.kind)).toEqual(["item", "change"]);
    const byId = ok(run("get_item_details", { id: "q5101" }, baseline));
    expect((byId.data as { item: { title: string } }).item.title).toBe("Quiz 2: Interrupt Latency");
    const fuzzy = ok(run("get_item_details", { titleQuery: "fourier homework" }, baseline));
    expect((fuzzy.data as { item: { title: string } }).item.title).toBe("Problem Set 6: Fourier Series");
    expect(run("get_item_details", { titleQuery: "underwater basket" }, baseline).ok).toBe(false);
  });
});

describe("get_recent_announcements", () => {
  it("returns recent and pinned announcements, newest first, optionally per course", async () => {
    await load();
    const all = ok(run("get_recent_announcements", {}, baseline));
    expect(titles(all.rows)).toEqual(["Guest lecture Thursday", "Lab 3 kit pickup", "Midterm logistics"]);
    // Only the pinned announcement is older than 12 hours and still listed.
    const recent = ok(run("get_recent_announcements", { sinceHours: 12 }, baseline));
    expect(titles(recent.rows)).toEqual(["Midterm logistics"]);
    const micro = ok(run("get_recent_announcements", { course: "Microcontrollers" }, changed));
    expect(titles(micro.rows)).toEqual(["Lab 3 deadline extended", "Lab 3 kit pickup"]);
    expect(JSON.stringify(micro.data)).not.toContain("stockroom");
  });
});

describe("get_changes", () => {
  it("lists changes with before and after values and filters by course, since, kind, and read state", async () => {
    await load();
    const all = ok(run("get_changes", {}, changed));
    expect(all.rows).toHaveLength(changed.changes.length);
    expect(all.rows.length).toBeGreaterThanOrEqual(4);
    const moved = ok(run("get_changes", { kind: "due-date-changed" }, changed));
    expect(moved.rows).toHaveLength(1);
    const row = moved.rows[0];
    expect(row?.kind === "change" && row.before?.dueLocal && row.after?.dueLocal).toBeTruthy();
    const micro = ok(run("get_changes", { course: "31001", since: "today" }, changed));
    expect(micro.rows.every((change) => change.courseName === "Microcontrollers")).toBe(true);
    expect(titles(micro.rows)).toEqual(expect.arrayContaining(["Lab 3: Timer Interrupts", "Quiz 3: Serial Protocols", "Lab 3 deadline extended"]));
    const read = { ...changed, changes: changed.changes.map((change, index) => ({ ...change, read: index === 0 })) };
    expect(ok(run("get_changes", { unreadOnly: true }, read)).rows).toHaveLength(changed.changes.length - 1);
    expect(ok(run("get_changes", {}, baseline)).rows).toEqual([]);
  });
});
