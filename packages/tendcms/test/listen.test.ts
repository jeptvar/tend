import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { ConfigError } from "../src/config.ts";
import { type Listening, listen, localUrl } from "../src/listen.ts";

const fetchHandler = () => new Response("tend");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function occupy(port: number, host: string): Promise<Server & { port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, host, () => {
      cleanups.push(() => server.close());
      const { port: actual } = server.address() as { port: number };
      resolve(Object.assign(server, { port: actual }));
    });
  });
}

async function started(listening: Promise<Listening>): Promise<Listening> {
  const result = await listening;
  cleanups.push(() => result.close());
  return result;
}

const ipv6Available = await occupy(0, "::1").then(
  (server) => {
    server.close();
    return true;
  },
  () => false,
);

describe("localUrl", () => {
  test.each([
    [["127.0.0.1", "::1"], "http://localhost:3000"],
    [["0.0.0.0"], "http://localhost:3000"],
    [["::"], "http://localhost:3000"],
    [["127.0.0.1"], "http://127.0.0.1:3000"],
    [["192.168.1.20"], "http://192.168.1.20:3000"],
    [["::1"], "http://[::1]:3000"],
    [["tend.lan"], "http://tend.lan:3000"],
  ])("%j is reached at %s", (hosts, url) => {
    expect(localUrl(hosts, 3000)).toBe(url);
  });
});

describe("listen", () => {
  test("listens on every address at one port", async () => {
    const hosts = ipv6Available ? ["127.0.0.1", "::1"] : ["127.0.0.1"];
    const { port } = await started(listen(fetchHandler, [0], hosts));
    for (const host of hosts) {
      const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}/`;
      expect(await (await fetch(url)).text()).toBe("tend");
    }
  });

  test("moves to the next port when the first is busy", async () => {
    const busy = await occupy(0, "127.0.0.1");
    const { port } = await started(listen(fetchHandler, [busy.port, 0], ["127.0.0.1"]));
    expect(port).not.toBe(busy.port);
  });

  test.runIf(ipv6Available)("a port taken only on ::1 counts as busy", async () => {
    const busy = await occupy(0, "::1");
    const { port } = await started(listen(fetchHandler, [busy.port, 0], ["127.0.0.1", "::1"]));
    expect(port).not.toBe(busy.port);
    // Nothing is left half-bound on the busy port's IPv4 address.
    const again = await occupy(busy.port, "127.0.0.1");
    expect(again.port).toBe(busy.port);
  });

  test("says which ports are busy when all of them are", async () => {
    const a = await occupy(0, "127.0.0.1");
    const b = await occupy(0, "127.0.0.1");
    await expect(listen(fetchHandler, [a.port, b.port], ["127.0.0.1"])).rejects.toThrow(
      new RegExp(`Ports ${a.port}–${b.port} are all in use`),
    );
    await expect(listen(fetchHandler, [a.port], ["127.0.0.1"])).rejects.toThrow(
      new RegExp(`Port ${a.port} is already in use`),
    );
  });

  test("forgives an extra address that doesn't exist on this machine", async () => {
    const { port } = await started(listen(fetchHandler, [0], ["127.0.0.1", "192.0.2.1"]));
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("tend");
  });

  test("explains a TEND_HOST that isn't on this computer", async () => {
    await expect(listen(fetchHandler, [0], ["192.0.2.1"])).rejects.toThrow(ConfigError);
    await expect(listen(fetchHandler, [0], ["192.0.2.1"])).rejects.toThrow(
      /TEND_HOST is set to 192\.0\.2\.1/,
    );
  });
});
