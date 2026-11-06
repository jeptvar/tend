import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { acquireLock, LockError } from "../src/db/lock.ts";
import { tempDir } from "./helpers.ts";

const lockModule = pathToFileURL(join(import.meta.dirname, "..", "src", "db", "lock.ts")).href;

/**
 * A separate process that tries to take the lock, prints the outcome, then holds it
 * until its stdin closes, so holders stay put until every contender has answered.
 */
function contender(
  dataDir: string,
  options: { startAt?: number; dropReferenceAndCollect?: boolean } = {},
): {
  child: ChildProcess;
  answer: Promise<string>;
  exited: Promise<void>;
} {
  const script = `
    import { acquireLock } from ${JSON.stringify(lockModule)};
    while (Date.now() < ${options.startAt ?? 0});
    let lock;
    try { lock = acquireLock(${JSON.stringify(dataDir)}); }
    catch (error) { console.log("refused: " + error.message); process.exit(1); }
    ${
      options.dropReferenceAndCollect
        ? "lock = undefined; for (let i = 0; i < 5; i++) { globalThis.gc(); await new Promise(setImmediate); }"
        : ""
    }
    console.log("acquired");
    process.stdin.resume();
    process.stdin.on("end", () => { lock?.release(); process.exit(0); });
  `;
  const flags = options.dropReferenceAndCollect ? ["--expose-gc"] : [];
  const child = spawn(process.execPath, [...flags, "--input-type=module", "-e", script], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const answer = new Promise<string>((resolve) => {
    child.stdout?.once("data", (chunk) => resolve(String(chunk)));
  });
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return { child, answer, exited };
}

async function finish(...contenders: ReturnType<typeof contender>[]): Promise<void> {
  for (const { child } of contenders) child.stdin?.end();
  await Promise.all(contenders.map(({ exited }) => exited));
}

describe("data folder lock", () => {
  test("a second process can't take the lock", async () => {
    const dataDir = tempDir();
    const lock = acquireLock(dataDir);
    try {
      const second = contender(dataDir);
      expect(await second.answer).toContain(`refused: Tend is already running`);
      expect(await second.answer).toContain(`process ${process.pid}`);
      await second.exited;
    } finally {
      lock.release();
    }
    expect(existsSync(join(dataDir, ".lock"))).toBe(false);

    const third = contender(dataDir);
    expect(await third.answer).toContain("acquired");
    await finish(third);
  });

  test.each([
    { contenders: 2, rounds: 6 },
    { contenders: 8, rounds: 2 },
  ])(
    "$contenders processes starting at once end with exactly one holder",
    async ({ contenders: count, rounds }) => {
      for (let round = 0; round < rounds; round++) {
        const dataDir = tempDir();
        // Left behind by a crash: racing past this is what a PID-based lock gets wrong.
        writeFileSync(join(dataDir, ".lock"), JSON.stringify({ pid: 999_999, startedAt: 1 }));
        // Landing in the same instant is the hard case. Without retries, a pair doing this
        // usually makes each other fail, leaving no holder at all.
        const startAt = Date.now() + 500;
        const contenders = Array.from({ length: count }, () => contender(dataDir, { startAt }));
        const answers = await Promise.all(contenders.map(({ answer }) => answer));
        await finish(...contenders);
        expect(answers.filter((answer) => answer.startsWith("acquired"))).toHaveLength(1);
      }
    },
    60_000,
  );

  test("the lock goes away when its holder is killed", async () => {
    const dataDir = tempDir();
    const holder = contender(dataDir);
    expect(await holder.answer).toContain("acquired");
    holder.child.kill("SIGKILL");
    await holder.exited;

    const lock = acquireLock(dataDir);
    expect(JSON.parse(readFileSync(join(dataDir, ".lock"), "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  test.each([
    ["a process that's alive", { pid: process.pid, startedAt: 1 }],
    ["this very process", { pid: process.pid, startedAt: Date.now() }],
    ["garbage", "{not json"],
  ])("a leftover info file naming %s doesn't block anyone", (_, content) => {
    const dataDir = tempDir();
    writeFileSync(
      join(dataDir, ".lock"),
      typeof content === "string" ? content : JSON.stringify(content),
    );
    const lock = acquireLock(dataDir);
    lock.release();
  });

  test("the same process can't take the lock twice", () => {
    const dataDir = tempDir();
    const lock = acquireLock(dataDir);
    try {
      expect(() => acquireLock(dataDir)).toThrow(LockError);
    } finally {
      lock.release();
    }
  });

  test("releasing twice is safe, and the lock can be taken again", () => {
    const dataDir = tempDir();
    const lock = acquireLock(dataDir);
    lock.release();
    lock.release();
    const again = acquireLock(dataDir);
    again.release();
  });

  test("the lock survives garbage collection when nothing else refers to it", async () => {
    const dataDir = tempDir();
    const holder = contender(dataDir, { dropReferenceAndCollect: true });
    expect(await holder.answer).toContain("acquired");

    const second = contender(dataDir);
    expect(await second.answer).toContain("refused");
    await second.exited;
    await finish(holder);
  });
});
