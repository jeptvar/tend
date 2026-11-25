import { readFileSync, realpathSync } from "node:fs";
import type { Config, Platform } from "./config.ts";

// A container's own files are thrown away when it's replaced, at the next update for example.
// Only what's on a volume is kept, so a site whose data folder isn't on one, or is on one that
// can go with the container, is a site about to be lost (PLAN.md §13).

/** Why a site's data would be lost when its container is replaced. */
export type DataRisk = "unmounted" | "unnamed";

/** What it takes to explain it, and to say how to fix it. */
export interface DataRiskDetails {
  why: DataRisk;
  path: string;
  platform: Platform;
}

/**
 * Where a container engine keeps a volume it made itself, because the image asks for one: under
 * a random 64-digit name. Docker and Podman keep the files in its _data folder, while containerd,
 * under Kubernetes, has none.
 */
const UNNAMED_VOLUME = /\/volumes\/[0-9a-f]{64}(\/_data)?$/;
/** Kept in memory, so it goes when the container stops, whatever it's mounted as. */
const IN_MEMORY = new Set(["tmpfs", "ramfs"]);
/** Shared from another computer, or another system on this one. */
const NETWORK_DRIVES = new Set(["nfs", "nfs4", "cifs", "smb3", "9p", "fuse.sshfs"]);

interface Mount {
  /** The folder of the source that's mounted, such as a volume's own folder. */
  root: string;
  point: string;
  type: string;
}

/** Spaces, tabs, newlines and backslashes are written as \040 and so on. */
function decode(path: string): string {
  return path.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

/** The mounts in /proc/self/mountinfo, described in proc(5). */
function parseMounts(mountinfo: string): Mount[] {
  const mounts: Mount[] = [];
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    const [, , , root, point] = fields;
    // After a lone "-", the filesystem's type. How many fields come before it varies.
    const dash = fields.indexOf("-");
    const type = dash < 0 ? undefined : fields[dash + 1];
    if (root === undefined || point === undefined || type === undefined) continue;
    mounts.push({ root: decode(root), point: decode(point), type });
  }
  return mounts;
}

/**
 * The mount a folder is on, other than the container's own files: the closest one above it,
 * and of several in the same place the last, which covers the others.
 */
function mountOf(folder: string, mountinfo: string): Mount | undefined {
  let closest: Mount | undefined;
  for (const mount of parseMounts(mountinfo)) {
    const { point } = mount;
    if (point === "/" || (folder !== point && !folder.startsWith(`${point}/`))) continue;
    if (!closest || point.length >= closest.point.length) closest = mount;
  }
  return closest;
}

/**
 * Whether the site's data is kept when its container is replaced, or why it wouldn't be.
 * Undefined if it isn't in a container, or its mounts can't be read.
 */
export function dataFate(options: {
  platform: Platform;
  dataDir: string;
  /** What /proc/self/mountinfo says. Undefined where there's no such file. */
  mountinfo: string | undefined;
}): "kept" | DataRisk | undefined {
  // On a computer of your own, the folder is kept like any other.
  if (options.platform === "local" || options.mountinfo === undefined) return undefined;
  const mount = mountOf(options.dataDir, options.mountinfo);
  if (!mount || IN_MEMORY.has(mount.type)) return "unmounted";
  return UNNAMED_VOLUME.test(mount.root) ? "unnamed" : "kept";
}

/**
 * The kind of network drive a folder is on, if it's on one. The database's file locks aren't
 * reliable there (PLAN.md §13).
 */
export function networkDrive(folder: string, mountinfo: string | undefined): string | undefined {
  // Windows gives a drive that's another computer's as \\computer\share, whatever its letter.
  if (folder.startsWith("\\\\")) return "Windows share";
  const type = mountinfo && mountOf(folder, mountinfo)?.type;
  return type && NETWORK_DRIVES.has(type) ? type : undefined;
}

/** What this system says is mounted, or undefined if it can't say. */
function readMountinfo(): string | undefined {
  try {
    return readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return undefined;
  }
}

/** The same, for the data folder Tend uses here, which has to exist. */
export function findDataFate({ dataDir, platform }: Pick<Config, "dataDir" | "platform">) {
  // A link to a folder on a volume is on that volume.
  return dataFate({ platform, dataDir: realpathSync(dataDir), mountinfo: readMountinfo() });
}

export function findDataRisk(
  config: Pick<Config, "dataDir" | "platform">,
): DataRiskDetails | undefined {
  const fate = findDataFate(config);
  if (fate === undefined || fate === "kept") return undefined;
  return { why: fate, path: config.dataDir, platform: config.platform };
}

export function findNetworkDrive(dataDir: string): string | undefined {
  // The system's own answer: Node's keeps a mapped drive's letter.
  return networkDrive(realpathSync.native(dataDir), readMountinfo());
}

/** What's wrong, in a sentence. */
export function dataRiskReason({ why, path }: DataRiskDetails): string {
  return why === "unmounted"
    ? `${path} isn't on a volume, so this site is lost when its container is replaced, at the next update for example.`
    : `${path} is on a volume with no name. When this container is replaced, at the next update for example, the new one can start empty and this volume can be deleted.`;
}

/** How to keep the data folder on a volume that lasts, as an instruction. */
function dataRiskFix({ path, platform }: DataRiskDetails): string {
  switch (platform) {
    case "railway":
      return `attach a volume mounted at ${path} to this service, and deploy again.`;
    case "docker":
      return `start Tend with a volume that has a name, for example: --volume tend-data:${path}`;
    default:
      return `attach a disk mounted at ${path}, and deploy again.`;
  }
}

/**
 * What to do about it, in order. Until the site is set up there's nothing to lose, so there's
 * no backup to make first.
 */
export function dataRiskSteps(risk: DataRiskDetails, needsSetup: boolean): string[] {
  const fix = dataRiskFix(risk);
  if (needsSetup) return [`Before you set up your site, ${fix}`];
  return [
    "1. Download a backup in Settings → Backups.",
    `2. Then ${fix}`,
    "3. A new volume starts empty, so choose Start from a backup to put your site back.",
  ];
}

/** Printed at start-up, loud enough not to be missed in a hosting service's log. */
export function dataRiskWarning(
  risk: DataRiskDetails,
  { needsSetup }: { needsSetup: boolean },
): string {
  const frame = "!".repeat(72);
  const lines = [
    `WARNING: ${dataRiskReason(risk)}`,
    ...dataRiskSteps(risk, needsSetup),
    "More about this: https://tendcms.dev/errors/no_volume",
  ];
  return ["", frame, ...lines.map((line) => `!! ${line}`), frame, ""].join("\n");
}
