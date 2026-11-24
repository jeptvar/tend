import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, release, type } from "node:os";
import { dirname, join, parse, sep } from "node:path";
import { COMPONENTS, componentError } from "./components.ts";
import {
  type Config,
  ConfigError,
  dataFolderError,
  dataFolderFix,
  isLocalAddress,
  loadConfig,
  type Platform,
} from "./config.ts";
import { type DiskSpace, diskSpace, isNearlyFull, isRunningLow } from "./disk.ts";
import type { SiteReport } from "./doctor-site.ts";
import { appVersion } from "./paths.ts";
import {
  type DataRiskDetails,
  dataRiskReason,
  dataRiskSteps,
  findDataFate,
  findNetworkDrive,
} from "./volume.ts";

// `tendcms doctor` (PLAN.md §13): looks at what Tend needs to run here, changes nothing, and
// says how to fix what's wrong. It has to work when Tend doesn't. So each thing is looked at
// on its own, and what needs the database component is only loaded once that has.
//
// What it prints gets pasted into bug reports. So it has no name, email, password or key in it,
// and the home folder, whose name is usually a person's, is written as ~.

export interface Finding {
  kind: "OK" | "LOOK" | "FIX";
  text: string;
}

export interface Surroundings {
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  now: number;
}

export const ok = (text: string): Finding => ({ kind: "OK", text });
export const look = (text: string): Finding => ({ kind: "LOOK", text });
export const fix = (text: string): Finding => ({ kind: "FIX", text });

/** One check failing in a way nobody foresaw is no reason to skip the others. */
async function attempt(
  what: string,
  check: () => Finding[] | Promise<Finding[]>,
): Promise<Finding[]> {
  try {
    return await check();
  } catch (error) {
    return [look(`Tend couldn't check ${what} (${(error as Error).message}).`)];
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** When each Node.js line stops getting fixes: nodejs/Release's schedule on 24 November 2026. */
const NODE_ENDS: Record<string, string> = {
  "24": "2028-04-30",
  "25": "2026-06-01",
  "26": "2029-04-30",
  "27": "2030-04-30",
};
/** About a release ahead, which is when PLAN.md §13 has people told. */
const NODE_WARNING_MS = 180 * DAY_MS;

export function formatDay(at: number): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" }).format(at);
}

export function nodeFinding(version: string, now: number, platform: Platform): Finding {
  const ends = NODE_ENDS[version.split(".")[0] ?? ""];
  if (ends === undefined) return ok(`Node.js ${version} is newer than the ones this Tend knows.`);
  const endsAt = Date.parse(ends);
  const day = formatDay(endsAt);
  const update =
    platform === "local"
      ? "Install the newest LTS version: https://tendcms.dev/install-node"
      : "Update Tend: a newer image of it has a newer Node.js.";
  if (now >= endsAt + DAY_MS) {
    return look(`Node.js ${version} stopped getting security fixes on ${day}. ${update}`);
  }
  if (now >= endsAt - NODE_WARNING_MS) {
    return look(
      `Node.js ${version} stops getting security fixes on ${day}, and the Tend after that won't run on it. ${update}`,
    );
  }
  return ok(`Node.js ${version} gets security fixes until ${day}.`);
}

async function lookAtComponents(): Promise<{ findings: Finding[]; database: boolean }> {
  const findings: Finding[] = [];
  let database = true;
  for (const component of COMPONENTS) {
    try {
      await component.load();
    } catch (error) {
      findings.push(fix(componentError(component, error).message));
      if (component.name === "database") database = false;
    }
  }
  if (findings.length === 0) {
    findings.push(ok("The database, picture and password components work."));
  }
  return { findings, database };
}

/** Settings that stop Tend when they're wrong, and that nothing else it looks at needs. */
const CHECKED_SETTINGS = [
  "PORT",
  "TEND_PUBLIC_URL",
  "TEND_TRUST_PROXY",
  "TEND_SETUP_CODE",
  "TEND_CACHE_MB",
];

function readSettings(env: NodeJS.ProcessEnv): { config?: Config; findings: Finding[] } {
  const read = (from: NodeJS.ProcessEnv) => {
    try {
      return { config: loadConfig(from) };
    } catch (error) {
      if (error instanceof ConfigError) return { problem: error.message };
      throw error;
    }
  };
  const { config, problem } = read(env);
  if (config) return { config, findings: [] };
  // The rest can still be looked at, as if those settings weren't there. On a host Tend can't
  // run on at all, that fails too, and there's nothing more to say.
  const without = Object.fromEntries(
    Object.entries(env).filter(([name]) => !CHECKED_SETTINGS.includes(name.toUpperCase())),
  );
  const rest = read(without).config;
  return { ...(rest ? { config: rest } : {}), findings: [fix(problem)] };
}

/** Throws unless a file can be made in a folder. It's removed again. */
function tryFolder(folder: string): void {
  const file = join(folder, `.tend-doctor-${process.pid}`);
  try {
    writeFileSync(file, "Tend can write here.", { flag: "wx" });
  } finally {
    rmSync(file, { force: true });
  }
}

/** Throws unless a file can be changed. It isn't. */
function tryFile(file: string): void {
  closeSync(openSync(file, "r+"));
}

/** Why Tend can't write to the site's files, if it can't. */
function writingProblem(config: Config): string | undefined {
  const { dataDir, dbPath, platform } = config;
  try {
    tryFolder(dataDir);
  } catch (error) {
    return dataFolderError(dataDir, error, platform).message;
  }
  const folders = [config.uploadsDir, config.backupsDir];
  // A file can belong to someone else than its folder, if a command was once run as them.
  const files = [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    config.secretKeyPath,
    join(dataDir, ".lock.db"),
  ];
  for (const path of [...folders, ...files]) {
    if (!existsSync(path)) continue;
    try {
      if (folders.includes(path)) tryFolder(path);
      else tryFile(path);
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
      return `Tend can't write to ${path}, in its data folder (${reason}). ${dataFolderFix(reason, platform)}`;
    }
  }
  return undefined;
}

/** A data folder that isn't there yet, and whether Tend could make it. */
function notThereYet({ dataDir, platform }: Config): Finding {
  let parent = dirname(dataDir);
  while (!existsSync(parent) && parent !== dirname(parent)) parent = dirname(parent);
  try {
    accessSync(parent, constants.W_OK);
  } catch (error) {
    return fix(dataFolderError(dataDir, error, platform).message);
  }
  return look(noSite(dataDir));
}

function noSite(dataDir: string): string {
  return `There's no site in ${dataDir} yet. Tend makes one there when it starts. If yours is somewhere else, run this in your site's folder.`;
}

const SIZES = ["B", "kB", "MB", "GB", "TB"];

function size(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < SIZES.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(unit > 0 && value < 10 ? 1 : 0)} ${SIZES[unit]}`;
}

export function diskFinding(space: DiskSpace): Finding {
  const left = `${size(space.free)} free of ${size(space.total)}`;
  const room =
    "Remove photos and files you no longer need from Media, or ask your host for more space.";
  if (isNearlyFull(space)) {
    return fix(
      `The disk has nearly run out of space, with ${left}. When it does, changes can't be saved. ${room}`,
    );
  }
  if (isRunningLow(space)) return look(`The disk is running low on space, with ${left}. ${room}`);
  return ok(`The disk has ${left}.`);
}

/** What can be told from where the data folder is. */
function placeFindings(config: Config, needsSetup: boolean): Finding[] {
  const { dataDir, platform } = config;
  const findings: Finding[] = [];
  const fate = findDataFate(config);
  if (fate === "kept") {
    findings.push(ok("The site is kept when its container is replaced: its data is on a volume."));
  } else if (fate) {
    const risk: DataRiskDetails = { why: fate, path: dataDir, platform };
    findings.push(fix([dataRiskReason(risk), ...dataRiskSteps(risk, needsSetup)].join(" ")));
  }
  const drive = findNetworkDrive(dataDir);
  if (drive) {
    findings.push(
      fix(
        `${dataDir} is on a network or shared drive (${drive}). The site's database can be damaged there, so close Tend and move it to a disk of this computer's own.`,
      ),
    );
  }
  return findings;
}

export function addressFindings({
  publicUrl,
  trustProxy,
}: Pick<Config, "publicUrl" | "trustProxy">): Finding[] {
  if (!publicUrl || isLocalAddress(publicUrl)) return [];
  if (publicUrl.startsWith("http:")) {
    return [
      look(
        "TEND_PUBLIC_URL starts with http:, so passwords can be read on their way to the site. Give the site https, and then change it to start with https:.",
      ),
    ];
  }
  if (trustProxy > 0) return [];
  return [
    look(
      "TEND_PUBLIC_URL starts with https:, so something in front of Tend answers for it, but TEND_TRUST_PROXY is 0. Tend then counts everyone's tries at signing in together. If it's one proxy, such as Caddy, set TEND_TRUST_PROXY=1.",
    ),
  ];
}

/** Everything there is to say, in the order it's worth reading. */
export async function examine({ env, nodeVersion, now }: Surroundings): Promise<Finding[]> {
  const settings = readSettings(env);
  const { config } = settings;
  const components = await lookAtComponents();
  const findings = [
    nodeFinding(nodeVersion, now, config?.platform ?? "local"),
    ...components.findings,
    ...settings.findings,
  ];
  if (!config) return findings;

  const { dataDir } = config;
  if (!existsSync(dataDir)) {
    return [...findings, notThereYet(config), ...addressFindings(config)];
  }
  const problem = writingProblem(config);
  findings.push(problem ? fix(problem) : ok(`Tend can write to its data folder, ${dataDir}.`));

  // What's inside can't be trusted to read if it can't be written.
  let site: SiteReport | undefined;
  let aboutSite: Finding[] = [];
  if (!existsSync(config.dbPath)) {
    if (!problem) aboutSite = [look(noSite(dataDir))];
  } else if (!problem && components.database) {
    aboutSite = await attempt("the site", async () => {
      const { lookAtSite } = await import("./doctor-site.ts");
      site = lookAtSite(config, now);
      return site.findings;
    });
  }
  return [
    ...findings,
    ...(await attempt("where the site is kept", () =>
      placeFindings(config, site ? !site.isSetUp : !existsSync(config.dbPath)),
    )),
    ...(await attempt("the disk", () => [diskFinding(diskSpace(dataDir))])),
    ...aboutSite,
    ...addressFindings(config),
  ];
}

/** Takes the home folder's name out, because it's usually a person's. */
export function withoutHome(text: string, home: string): string {
  // In a container, it can be the top of the disk, which is in every path.
  return home === "" || parse(home).root === home
    ? text
    : text.replaceAll(`${home}${sep}`, `~${sep}`);
}

function count(amount: number, what: string): string {
  return `${amount} ${amount === 1 ? "thing" : "things"} ${what}`;
}

export function summary(findings: Finding[]): string {
  const of = (kind: Finding["kind"]) => findings.filter((each) => each.kind === kind).length;
  const toFix = of("FIX");
  const toLook = of("LOOK");
  if (toFix === 0 && toLook === 0) return "Nothing to fix.";
  if (toFix === 0) return `Nothing to fix, and ${count(toLook, "to look at")}.`;
  return toLook === 0
    ? `${count(toFix, "to fix")}.`
    : `${count(toFix, "to fix")}, and ${count(toLook, "to look at")}.`;
}

/** The command: prints what it found, and fails if anything has to be fixed. */
export async function doctor(): Promise<void> {
  const findings = await examine({
    env: process.env,
    nodeVersion: process.versions.node,
    now: Date.now(),
  });
  console.log(
    `Tend ${appVersion} on Node.js ${process.versions.node}, ${type()} ${release()} ${arch()}\n`,
  );
  for (const { kind, text } of findings) {
    console.log(`${kind.padEnd(4)}  ${withoutHome(text, homedir())}`);
  }
  console.log(`\n${summary(findings)}`);
  if (findings.some(({ kind }) => kind === "FIX")) process.exitCode = 1;
}
