import type { serve as honoServe } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { isLoopbackHost, loadConfig, validateDeployment } from "../../apps/api/src/config";
import { createLogger } from "../../apps/api/src/log";
import { startServer } from "../../apps/api/src/server";

type ServeOptions = Parameters<typeof honoServe>[0];

const fakeServe = () => {
  const calls: ServeOptions[] = [];
  const serve = ((options: ServeOptions, listener?: (info: { address: string; family: string; port: number }) => void) => {
    calls.push(options);
    listener?.({ address: options.hostname ?? "::", family: "IPv4", port: options.port ?? 0 });
    return { close: () => undefined };
  }) as unknown as typeof honoServe;
  return { serve, calls };
};

describe("deployment rules", () => {
  it("defaults HOST to loopback and accepts loopback binds without a token", () => {
    expect(loadConfig({}).HOST).toBe("127.0.0.1");
    expect(loadConfig({ HOST: "" }).HOST).toBe("127.0.0.1");
    for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(isLoopbackHost(host)).toBe(true);
      expect(() => validateDeployment({ HOST: host, NOVA_DEV_TOKEN: undefined })).not.toThrow();
    }
  });

  it("refuses a public HOST without NOVA_DEV_TOKEN", () => {
    for (const host of ["0.0.0.0", "::", "10.0.0.5", "192.168.1.20", "nova.example", "127.0.0.1.evil.example"]) {
      expect(isLoopbackHost(host)).toBe(false);
      expect(() => validateDeployment({ HOST: host, NOVA_DEV_TOKEN: undefined })).toThrow(/NOVA_DEV_TOKEN/);
      expect(() => validateDeployment(loadConfig({ HOST: host, NOVA_DEV_TOKEN: "" }))).toThrow(/NOVA_DEV_TOKEN/);
    }
  });

  it("allows a public HOST once a token is set", () => {
    expect(() => validateDeployment({ HOST: "0.0.0.0", NOVA_DEV_TOKEN: "secret" })).not.toThrow();
    expect(() => validateDeployment(loadConfig({ HOST: "0.0.0.0", NOVA_DEV_TOKEN: "secret" }))).not.toThrow();
  });
});

describe("startServer", () => {
  it("binds to the configured host and port and logs the bound address", () => {
    const { serve, calls } = fakeServe();
    const lines: string[] = [];
    startServer({ config: loadConfig({}), model: null, logger: createLogger((line) => lines.push(line)), serve });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ hostname: "127.0.0.1", port: 8787 });
    const listening = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.event === "api.listening");
    expect(listening).toMatchObject({ host: "127.0.0.1", port: 8787, tokenRequired: false, configured: false });
  });

  it("never binds a public host without a token", () => {
    const { serve, calls } = fakeServe();
    expect(() => startServer({ config: loadConfig({ HOST: "0.0.0.0" }), model: null, logger: createLogger(() => undefined), serve })).toThrow(/NOVA_DEV_TOKEN/);
    expect(calls).toHaveLength(0);
    const withToken = fakeServe();
    const lines: string[] = [];
    startServer({ config: loadConfig({ HOST: "0.0.0.0", NOVA_DEV_TOKEN: "secret" }), model: null, logger: createLogger((line) => lines.push(line)), serve: withToken.serve });
    expect(withToken.calls[0]).toMatchObject({ hostname: "0.0.0.0" });
    expect(lines.join("\n")).toContain('"tokenRequired":true');
    expect(lines.join("\n")).not.toContain("secret");
  });
});
