import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer, type ServerType } from "@hono/node-server";
import { ConfigError } from "./config.ts";

type Fetch = Parameters<typeof createAdaptorServer>[0]["fetch"];

export interface Listening {
  port: number;
  close(): void;
  /** Takes nothing new, and gives what's being answered this long before ending it. */
  stop(drainMs: number): Promise<void>;
}

/** How often connections that have nothing left to say are looked for, while stopping. */
const IDLE_CHECK_MS = 50;

async function stopServers(servers: ServerType[], drainMs: number): Promise<void> {
  const open = servers as Server[];
  const closed = Promise.all(
    open.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  // One kept open for a next request would hold the server up after its answer is sent.
  const closeIdle = () => {
    for (const server of open) server.closeIdleConnections();
  };
  closeIdle();
  const checking = setInterval(closeIdle, IDLE_CHECK_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tooLong = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, drainMs);
  });
  await Promise.race([closed, tooLong]);
  clearTimeout(timer);
  clearInterval(checking);
  for (const server of open) server.closeAllConnections();
}

/** The address to print: one that actually reaches Tend from this computer. */
export function localUrl(hosts: string[], port: number): string {
  const [host] = hosts;
  const anyAddress = host === "0.0.0.0" || host === "::";
  // More than one host is the default pair, which covers everything "localhost" can mean.
  if (host === undefined || hosts.length > 1 || anyAddress) return `http://localhost:${port}`;
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function bind(server: ServerType, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function friendlyError(error: unknown, ports: number[], port: number, host: string): unknown {
  switch (errorCode(error)) {
    case "EADDRINUSE":
      return new ConfigError(
        ports.length > 1 && ports[0] !== 0
          ? `Ports ${ports[0]}–${ports.at(-1)} are all in use. Close the programs using them, or set PORT to a free port.`
          : `Port ${port} is already in use. Close the program using it, or set PORT to a free port.`,
      );
    case "EACCES":
      return new ConfigError(
        `Port ${port} needs administrator rights. Use a port above 1024, for example PORT=3000.`,
      );
    case "EADDRNOTAVAIL":
    case "ENOTFOUND":
      return new ConfigError(
        `TEND_HOST is set to ${host}, which isn't an address on this computer. Remove TEND_HOST or use 0.0.0.0.`,
      );
    default:
      return error;
  }
}

/**
 * Listens on every host at the first port that's free on all of them. A failure
 * on any host other than the first is only forgiven when that address doesn't
 * exist here (a machine without IPv6).
 */
export async function listen(fetch: Fetch, ports: number[], hosts: string[]): Promise<Listening> {
  const [firstHost, ...otherHosts] = hosts;
  if (firstHost === undefined) throw new Error("listen() needs at least one host");

  for (const [index, requested] of ports.entries()) {
    const servers: ServerType[] = [];
    let host = firstHost;
    try {
      const first = createAdaptorServer({ fetch });
      await bind(first, requested, host);
      servers.push(first);
      const port = (first.address() as AddressInfo).port;

      for (host of otherHosts) {
        const server = createAdaptorServer({ fetch });
        try {
          await bind(server, port, host);
          servers.push(server);
        } catch (error) {
          const code = errorCode(error);
          if (code !== "EADDRNOTAVAIL" && code !== "EAFNOSUPPORT") throw error;
        }
      }

      return {
        port,
        close() {
          for (const server of servers) server.close();
        },
        stop: (drainMs) => stopServers(servers, drainMs),
      };
    } catch (error) {
      for (const server of servers) server.close();
      if (errorCode(error) === "EADDRINUSE" && index < ports.length - 1) continue;
      throw friendlyError(error, ports, requested, host);
    }
  }
  throw new Error("listen() needs at least one port");
}
