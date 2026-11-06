import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];
const running = new Set<ChildProcess>();

/** A fresh temporary folder, removed after the current test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tend-test-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  // Whatever a failed test left running goes first, while its folder still exists.
  await Promise.all(
    [...running].map(
      (child) =>
        new Promise((resolve) => {
          child.once("exit", resolve);
          child.kill("SIGKILL");
        }),
    ),
  );
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// afterEach doesn't run if the whole test run is interrupted.
process.on("exit", () => {
  for (const child of running) child.kill("SIGKILL");
});

export const cliPath = join(import.meta.dirname, "..", "src", "cli.ts");

// Variables that would change what Tend does, so a test run behaves the same
// inside a Dev Container or on a host that happens to set them.
const HOST_VARIABLES = [
  "RAILWAY_ENVIRONMENT",
  "RAILWAY_PROJECT_ID",
  "RENDER",
  "FLY_APP_NAME",
  "VERCEL",
  "NETLIFY",
  "AWS_LAMBDA_FUNCTION_NAME",
  "PORT",
  "TEND_DATA_DIR",
  "TEND_HOST",
  "TEND_ADMIN_DEV_URL",
];

export function cleanEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const clean = { ...process.env };
  for (const name of HOST_VARIABLES) delete clean[name];
  return { ...clean, ...env };
}

export interface RunningCli {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
  /** Stops the process if it's still running and waits for it. */
  stop: () => Promise<number | null>;
}

/** Spawns `node src/cli.ts <args>` with a clean Tend environment. */
export function runCli(args: string[], env: Record<string, string>): RunningCli {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: cleanEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.add(child);
  child.once("exit", () => running.delete(child));
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code, signal) => resolve(signal ? null : code)),
  );
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    return exited;
  };
  return { child, output: () => output, exited, stop };
}

/** Resolves with the admin setup URL once the CLI says it's listening. */
export async function waitForRunning(cli: RunningCli, timeoutMs = 15_000): Promise<URL> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = cli.output().match(/is running: (http:\/\/\S+)/);
    if (running?.[1]) return new URL(running[1]);
    // What it prints on Docker and hosting platforms instead.
    const listening = cli.output().match(/is listening on port (\d+)/);
    if (listening?.[1]) return new URL(`http://127.0.0.1:${listening[1]}/admin/setup`);
    if (cli.child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Tend did not start. Output:\n${cli.output()}`);
}

/** Fails with the process's output rather than hanging until the test times out. */
export function exitedWithin(cli: RunningCli, timeoutMs = 10_000): Promise<number | null> {
  return Promise.race([
    cli.exited,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Still running after ${timeoutMs} ms. Output:\n${cli.output()}`)),
        timeoutMs,
      ),
    ),
  ]);
}
