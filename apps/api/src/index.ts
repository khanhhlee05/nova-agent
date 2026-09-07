export type HealthResponse = { status: "ok"; service: "nova-agent-api" };
export const health = (): HealthResponse => ({ status: "ok", service: "nova-agent-api" });
