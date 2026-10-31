// @vitest-environment jsdom
import "./setup";
import "fake-indexeddb/auto";
import { FixtureTransport, buildDemoTenant, demoResolver } from "@nova-agent/brightspace";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createStubHost } from "../../apps/extension/src/platform/host";
import { App } from "../../apps/extension/src/sidepanel/App";
import { createNovaDb, type NovaDb } from "../../apps/extension/src/storage/novaDb";
import { getSyncStatus, setPreference } from "../../apps/extension/src/storage/repositories";
import { DEMO_SCENARIO_PREFERENCE, type TransportFactory } from "../../apps/extension/src/sync/syncCoordinator";
import { NOW } from "../helpers/demoDashboard";

let db: NovaDb | null = null;

afterEach(async () => {
  cleanup();
  await db?.delete();
  db = null;
});

const LONG = { timeout: 10_000 };

// Homework 4 is open in the demo baseline and submitted in the "changed" scenario (second demo refresh).
const TITLE = "Homework 4: Pipelining Hazards";

describe("local done marks: end to end", () => {
  it("keeps a mark across a refresh, then drops it the moment Brightspace reports the submission", { timeout: 30_000 }, async () => {
    db = createNovaDb(`local-done-${Date.now()}`);
    let clock = NOW;
    const factory: TransportFactory = (_mode, { now, demoScenario }) => new FixtureTransport(demoResolver(buildDemoTenant(now, demoScenario)));
    render(<App db={db} host={createStubHost()} now={() => clock} transportFactory={factory} autoSync={false} />);
    // Both the stored status and the button must settle: a click on a still-disabled Refresh is ignored.
    const synced = async (at: Date) => {
      await waitFor(async () => expect((await getSyncStatus(db as NovaDb)).lastSuccessfulSyncAt).toBe(at.toISOString()), LONG);
      await waitFor(() => expect((screen.getByRole("button", { name: /refresh now/i }) as HTMLButtonElement).disabled).toBe(false), LONG);
    };

    fireEvent.click(await screen.findByRole("button", { name: /explore with demo data/i }));
    await synced(clock);
    fireEvent.click(await screen.findByRole("radio", { name: /^Upcoming,/ }, LONG));
    const box = (await screen.findByRole("checkbox", { name: `Mark "${TITLE}" done on this device` }, LONG)) as HTMLInputElement;
    const upcomingBefore = screen.getByRole("radio", { name: /^Upcoming,/ }).getAttribute("aria-label");
    fireEvent.click(box);

    // The row leaves Upcoming and the count drops; Completed lists it as the student's own mark.
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: `Mark "${TITLE}" done on this device` })).toBeNull(), LONG);
    expect(screen.getByRole("radio", { name: /^Upcoming,/ }).getAttribute("aria-label")).not.toBe(upcomingBefore);
    expect(screen.getByText(/Marked "Homework 4: Pipelining Hazards" done on this device/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /^Completed,/ }));
    const row = (await screen.findByText(TITLE, undefined, LONG)).closest(".task") as HTMLElement;
    expect(within(row).getByText("Marked done by you")).toBeTruthy();
    expect((within(row).getByRole("checkbox") as HTMLInputElement).disabled).toBe(false);

    // A refresh that still shows the item as open keeps the mark. (A demo refresh normally advances to the "changed" scenario; pin the baseline for this one.)
    await setPreference(db, DEMO_SCENARIO_PREFERENCE, "baseline");
    clock = new Date(NOW.getTime() + 20 * 60_000);
    fireEvent.click(screen.getByRole("button", { name: /refresh now/i }));
    await synced(clock);
    expect(await db.localMarks.count()).toBe(1);
    expect(within(screen.getByText(TITLE).closest(".task") as HTMLElement).getByText("Marked done by you")).toBeTruthy();

    // The next refresh carries the "changed" scenario, in which Brightspace reports the submission: the mark is gone and the status is Brightspace's.
    clock = new Date(NOW.getTime() + 40 * 60_000);
    fireEvent.click(screen.getByRole("button", { name: /refresh now/i }));
    await synced(clock);
    expect(await db.localMarks.count()).toBe(0);
    await waitFor(() => expect(within(screen.getByText(TITLE).closest(".task") as HTMLElement).queryByText("Marked done by you")).toBeNull(), LONG);
    const settled = screen.getByText(TITLE).closest(".task") as HTMLElement;
    expect((within(settled).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect(within(settled).getByRole("checkbox").getAttribute("aria-label")).toMatch(/(submitted|completed) in Brightspace$/);
  });

  it("unchecking puts the item back in its list", async () => {
    db = createNovaDb(`local-undone-${Date.now()}`);
    const factory: TransportFactory = (_mode, { now, demoScenario }) => new FixtureTransport(demoResolver(buildDemoTenant(now, demoScenario)));
    render(<App db={db} host={createStubHost()} now={() => NOW} transportFactory={factory} autoSync={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /explore with demo data/i }));
    fireEvent.click(await screen.findByRole("radio", { name: /^Upcoming,/ }, LONG));
    fireEvent.click(await screen.findByRole("checkbox", { name: `Mark "${TITLE}" done on this device` }, LONG));
    fireEvent.click(screen.getByRole("radio", { name: /^Completed,/ }));
    const marked = (await screen.findByRole("checkbox", { name: new RegExp(`^${TITLE}: marked done by you`) }, LONG)) as HTMLInputElement;
    fireEvent.click(marked);
    await waitFor(() => expect(db?.localMarks.count()).resolves.toBe(0), LONG);
    fireEvent.click(screen.getByRole("radio", { name: /^Upcoming,/ }));
    expect(await screen.findByRole("checkbox", { name: `Mark "${TITLE}" done on this device` }, LONG)).toBeTruthy();
  });
});
