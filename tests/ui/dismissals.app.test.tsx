// @vitest-environment jsdom
import "./setup";
import "fake-indexeddb/auto";
import { FixtureTransport, buildDemoTenant, demoResolver } from "@nova-agent/brightspace";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createStubHost } from "../../apps/extension/src/platform/host";
import { App } from "../../apps/extension/src/sidepanel/App";
import { createNovaDb, type NovaDb } from "../../apps/extension/src/storage/novaDb";
import type { TransportFactory } from "../../apps/extension/src/sync/syncCoordinator";
import { NOW } from "../helpers/demoDashboard";

let db: NovaDb | null = null;

afterEach(async () => {
  cleanup();
  await db?.delete();
  db = null;
});

describe("session dismissals: end to end", () => {
  it("hides an item for the session and repopulates it on refresh", async () => {
    db = createNovaDb(`dismiss-${Date.now()}`);
    let clock = NOW;
    const factory: TransportFactory = (_mode, { now, demoScenario }) => new FixtureTransport(demoResolver(buildDemoTenant(now, demoScenario)));
    render(<App db={db} host={createStubHost()} now={() => clock} transportFactory={factory} autoSync={false} />);

    fireEvent.click(await screen.findByRole("button", { name: /explore with demo data/i }));
    const hide = await screen.findAllByRole("button", { name: /^Hide ".*" until next refresh$/ }, { timeout: 10_000 });
    const label = (hide[0] as HTMLButtonElement).getAttribute("aria-label") as string;
    const title = /^Hide "(.*)" until next refresh$/.exec(label)?.[1] as string;
    expect(screen.getAllByText(title).length).toBeGreaterThan(0);

    fireEvent.click(hide[0] as HTMLButtonElement);
    await waitFor(() => expect(screen.getByText(/1 item hidden until the next refresh/i)).toBeTruthy());
    expect(screen.queryByText(title)).toBeNull();

    clock = new Date(NOW.getTime() + 30 * 60_000);
    fireEvent.click(screen.getByRole("button", { name: /refresh now/i }));
    await waitFor(() => expect(screen.queryByText(/hidden until the next refresh/i)).toBeNull(), { timeout: 10_000 });
    await waitFor(() => expect(screen.getAllByText(title).length).toBeGreaterThan(0), { timeout: 10_000 });
  }, 30_000);
});
