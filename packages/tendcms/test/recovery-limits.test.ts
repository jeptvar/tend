import { describe, expect, test } from "vitest";
import { browser, makeApp, OWNER_EMAIL, setUp, setupBody, signedInAs } from "./auth-helpers.ts";

// How often links and codes that get someone in without a password can be tried (PLAN.md §9).

type Client = ReturnType<typeof browser>;

describe("limits on getting in without a password", () => {
  test("three reset links an hour that don't work, and ones that do aren't counted", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const ed = await signedInAs(made, "editor");
    const { token } = await (await owner.post(`/api/admin/people/${ed.id}/reset-link`)).json();
    const check = async (link: string) =>
      (await browser(made.app).post("/api/auth/reset/check", { token: link })).status;

    for (let tries = 0; tries < 6; tries++) expect(await check(token)).toBe(200);
    for (let tries = 0; tries < 3; tries++) expect(await check("x".repeat(43))).toBe(404);
    expect(await check("x".repeat(43))).toBe(429);
    expect(await check(token)).toBe(429);
    made.clock.time += 20 * 60 * 1000;
    expect(await check(token)).toBe(200);
  });

  test("ten recovery codes an hour for an account, except from a device that knows it", async () => {
    const made = await makeApp();
    const owner = browser(made.app);
    const reply = await owner.post("/api/auth/setup", { code: made.code, ...setupBody() });
    const { recoveryCodes } = await reply.json();
    const recover = (client: Client, code: string) =>
      client.post("/api/auth/recover", { email: OWNER_EMAIL, code });

    const stranger = browser(made.app);
    for (let tries = 0; tries < 10; tries++) {
      expect((await recover(stranger, "AAAAA-AAAAA")).status).toBe(401);
      // No faster than five a minute from one address.
      made.clock.time += 12_000;
    }
    const locked = await recover(stranger, recoveryCodes[0]);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(60);
    // Whoever is guessing can't keep the Owner from their own codes.
    made.clock.time += 60_000;
    expect((await recover(owner, recoveryCodes[0])).status).toBe(200);
    made.clock.time += 6 * 60_000;
    expect((await recover(stranger, recoveryCodes[1])).status).toBe(200);
  });

  test("five a minute from one address, whoever's account it is", async () => {
    const made = await makeApp();
    await setUp(made);
    const stranger = browser(made.app);
    const recover = (email: string) =>
      stranger.post("/api/auth/recover", { email, code: "AAAAA-AAAAA" });
    for (let tries = 0; tries < 5; tries++) {
      expect((await recover(`someone${tries}@example.com`)).status).toBe(401);
    }
    expect((await recover("someone-else@example.com")).status).toBe(429);
  });
});
