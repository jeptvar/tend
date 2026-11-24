import { describe, expect, test } from "vitest";
import type { Platform } from "../src/config.ts";
import { type DataRisk, type DataRiskDetails, dataRisk, dataRiskWarning } from "../src/volume.ts";
import { browser, makeApp, setUp, signedInAs } from "./auth-helpers.ts";

// Written by hand, in the format proc(5) describes, so they can say anything. CI's Docker job
// checks what a real container's say.
const CONTAINER = [
  "1036 965 0:127 / / rw,relatime master:411 - overlay overlay rw,lowerdir=/l/A:/l/B,upperdir=/d",
  "1037 1036 0:130 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
  "1038 1036 0:131 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755",
  "1042 1036 8:1 /var/lib/docker/containers/7c/hosts /etc/hosts rw,relatime - ext4 /dev/sda1 rw",
];
const ID = "3fa9".repeat(16);

function mounted(root: string, point: string, type = "ext4"): string {
  return `1048 1036 8:1 ${root} ${point} rw,relatime master:1 - ${type} /dev/sda1 rw`;
}

/** Why the data folder is at risk in a container with these mounts, besides its own. */
function risk(mounts: string[], dataDir = "/data", platform: Platform = "docker") {
  const mountinfo = `${[...CONTAINER, ...mounts].join("\n")}\n`;
  return dataRisk({ platform, dataDir, mountinfo });
}

describe("whether a site is kept when its container is replaced", () => {
  test("not if its data folder is among the container's own files", () => {
    expect(risk([])).toBe("unmounted");
    expect(risk([mounted("/var/lib/docker/volumes/other/_data", "/media")])).toBe("unmounted");
    // Near a volume isn't on it.
    expect(risk([mounted("/srv/tend", "/data")], "/database")).toBe("unmounted");
    expect(risk([mounted("/srv/tend", "/data/site")])).toBe("unmounted");
  });

  test("not if it's only in memory", () => {
    expect(risk([mounted("/", "/data", "tmpfs")])).toBe("unmounted");
    expect(risk([mounted("/", "/data", "ramfs")])).toBe("unmounted");
  });

  test.each([
    ["Docker", `/var/lib/docker/volumes/${ID}/_data`],
    ["Docker, when its folder is a disk of its own", `/volumes/${ID}/_data`],
    ["Docker, run without root", `/home/sam/.local/share/docker/volumes/${ID}/_data`],
    ["Podman", `/var/lib/containers/storage/volumes/${ID}/_data`],
    [
      "containerd, under Kubernetes",
      `/var/lib/containerd/io.containerd.grpc.v1.cri/containers/${ID}/volumes/${ID}`,
    ],
  ])("maybe not on a volume with no name: %s", (_engine, root) => {
    expect(risk([mounted(root, "/data")])).toBe("unnamed");
  });

  test.each([
    ["a volume with a name", "/var/lib/docker/volumes/tend-data/_data"],
    ["a volume Compose named", "/var/lib/docker/volumes/rise-bakery_tend-data/_data"],
    ["a volume whose name starts like an ID", `/var/lib/docker/volumes/${ID}-mine/_data`],
    ["a folder of the server's", "/srv/rise-bakery"],
    ["a whole disk, as hosting services attach them", "/"],
  ])("yes on %s", (_what, root) => {
    expect(risk([mounted(root, "/data")])).toBeUndefined();
  });

  test("going by the closest mount above the data folder", () => {
    const named = mounted("/var/lib/docker/volumes/tend-data/_data", "/data");
    expect(risk([named], "/data/site")).toBeUndefined();
    const inside = mounted(`/var/lib/docker/volumes/${ID}/_data`, "/data/site");
    expect(risk([named, inside], "/data/site")).toBe("unnamed");
    expect(risk([inside, named], "/data/site")).toBe("unnamed");
    expect(risk([named, inside])).toBeUndefined();
  });

  test("going by the last of several mounts in one place, which covers the others", () => {
    const named = mounted("/var/lib/docker/volumes/tend-data/_data", "/data");
    expect(risk([named, mounted("/", "/data", "tmpfs")])).toBe("unmounted");
    expect(risk([mounted("/", "/data", "tmpfs"), named])).toBeUndefined();
  });

  test("however the line is written", () => {
    // Spaces are written as \040, and how many fields come before the dash varies.
    const spaced = "1048 1036 8:1 /srv/my\\040site /my\\040data rw - ext4 /dev/sda1 rw";
    expect(risk([spaced], "/my data")).toBeUndefined();
    const several = `1048 1036 8:1 /v/volumes/${ID}/_data /data rw shared:2 master:1 - ext4 /dev/sda1 rw`;
    expect(risk([several])).toBe("unnamed");
    expect(risk(["", "not a mount", "1048 1036 8:1 /srv/tend /data rw"])).toBe("unmounted");
  });

  test("not asked on a computer of your own, or where mounts can't be read", () => {
    expect(risk([], "/home/sam/my-site/data", "local")).toBeUndefined();
    expect(
      dataRisk({ platform: "docker", dataDir: "/data", mountinfo: undefined }),
    ).toBeUndefined();
  });
});

describe("the warning at start-up", () => {
  function warning(why: DataRisk, platform: Platform, needsSetup: boolean): string {
    return dataRiskWarning({ why, path: "/data", platform }, { needsSetup });
  }

  test("says what could happen", () => {
    expect(warning("unmounted", "docker", false)).toContain(
      "!! WARNING: /data isn't on a volume, so this site is lost when its container is replaced",
    );
    expect(warning("unnamed", "docker", false)).toContain(
      "!! WARNING: /data is on a volume with no name.",
    );
  });

  test("puts the backup before the fix, because a new volume starts empty", () => {
    const steps = warning("unmounted", "docker", false).match(/^!! \d\. .*$/gm);
    expect(steps).toEqual([
      "!! 1. Download a backup in Settings → Backups.",
      "!! 2. Then start Tend with a volume that has a name, for example: --volume tend-data:/data",
      "!! 3. A new volume starts empty, so choose Start from a backup to put your site back.",
    ]);
  });

  test("has no backup to ask for until the site is set up", () => {
    const text = warning("unnamed", "docker", true);
    expect(text).toContain(
      "!! Before you set up your site, start Tend with a volume that has a name",
    );
    expect(text).not.toContain("backup");
  });

  test("says how to fix it where the site is running", () => {
    expect(warning("unmounted", "railway", false)).toContain(
      "attach a volume mounted at /data to this service, and deploy again.",
    );
    expect(warning("unmounted", "render", false)).toContain(
      "attach a disk mounted at /data, and deploy again.",
    );
  });
});

describe("who the admin tells", () => {
  const RISK: DataRiskDetails = { why: "unnamed", path: "/data", platform: "docker" };

  async function told(client: ReturnType<typeof browser>): Promise<unknown> {
    const reply = await client.get("/api/auth/me");
    expect(reply.status).toBe(200);
    return (await reply.json()).dataRisk;
  }

  test("every Admin, who can do something about it, and nobody else", async () => {
    const made = await makeApp({ dataRisk: RISK });
    expect(await told(await setUp(made))).toEqual(RISK);
    expect(await told((await signedInAs(made, "admin")).client)).toEqual(RISK);
    expect(await told((await signedInAs(made, "editor")).client)).toBeNull();
    expect(await told((await signedInAs(made, "writer")).client)).toBeNull();
    // Where a site keeps its files is nothing to tell a visitor.
    const status = await (await browser(made.app).get("/api/auth/setup/status")).json();
    expect(JSON.stringify(status)).not.toContain("/data");
  });

  test("nobody, when the site is kept", async () => {
    expect(await told(await setUp(await makeApp()))).toBeNull();
  });
});
