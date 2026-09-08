import { BrightspaceClient, FixtureTransport, buildDemoTenant, demoResolver, type DemoScenario } from "@nova-agent/brightspace";
import { createSnapshot, diffSnapshots, type AcademicSnapshot, type ChangeEvent } from "@nova-agent/core";
import { buildDashboard, type Dashboard } from "../../apps/extension/src/sidepanel/model";

export const TENANT = "https://brightspace.villanova.edu";
export const NOW = new Date("2026-09-08T14:00:00-04:00");

export const demoSnapshot = async (scenario: DemoScenario, now = NOW, overrides: Record<string, unknown> = {}): Promise<AcademicSnapshot> => {
  const client = new BrightspaceClient(new FixtureTransport(demoResolver(buildDemoTenant(now, scenario), overrides)), { tenantOrigin: TENANT, now: () => now });
  const state = await client.loadAcademicState();
  return createSnapshot({ ...state, capturedAt: now.toISOString() });
};

export const demoDashboard = async (options: { courseFilter?: string | null; withChanges?: boolean; now?: Date } = {}): Promise<{ dashboard: Dashboard; events: ChangeEvent[]; snapshot: AcademicSnapshot }> => {
  const now = options.now ?? NOW;
  const earlier = new Date(now.getTime() - 3_600_000);
  const baseline = await demoSnapshot("baseline", earlier);
  const snapshot = options.withChanges ? await demoSnapshot("changed", now) : baseline;
  const events = options.withChanges ? diffSnapshots({ current: snapshot, history: [baseline] }) : [];
  const dashboard = buildDashboard({ snapshot, events, now, courseFilter: options.courseFilter ?? null });
  return { dashboard, events, snapshot };
};
