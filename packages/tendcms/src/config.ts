import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fsyncDir, fsyncFile } from "./durable.ts";
import { PlainError } from "./plain-error.ts";

export type Platform = "railway" | "render" | "fly" | "docker" | "local";

export interface Config {
  dataDir: string;
  dbPath: string;
  uploadsDir: string;
  backupsDir: string;
  secretKeyPath: string;
  /** Where themes of people's own are. The first is where a copy of one goes. */
  themeFolders: string[];
  platform: Platform;
  /** Undefined means "PORT was not set". */
  port: number | undefined;
  /** Every address Tend listens on. */
  hosts: string[];
  /** Set by scripts/dev.mjs so /admin/* goes to the Vite dev server. */
  adminDevUrl: string | undefined;
  /** TEND_PUBLIC_URL: the site's real address, when it's known up front. */
  publicUrl: string | undefined;
  /** The address the hosting platform gave the site, if it said. See site-address.ts. */
  platformUrl: string | undefined;
  /** How many proxies sit in front of Tend (TEND_TRUST_PROXY). */
  trustProxy: number;
  /** Whether the site is reached over https, which decides the cookie mode. */
  secureCookies: boolean;
  /** TEND_SETUP_CODE: a setup password chosen in a hosting template, replacing the code. */
  setupPassword: string | undefined;
  /** Whether the site has a real public address, so "online" is a true thing to say. */
  isPublic: boolean;
  /** Off on a local site, so edits to a template show on refresh. */
  pageCacheBytes: number;
}

/** A problem the person running Tend has to fix. */
export class ConfigError extends PlainError {}

const DOCS = "https://tendcms.dev/docs";
const MIN_NODE_MAJOR = 24;
const DEFAULT_PORT = 3000;
const FALLBACK_PORTS = 10;
export const SECRET_KEY_BYTES = 32;
const SECRET_KEY_FORMAT = /^[0-9a-f]{64}\n?$/;
const MIN_SETUP_PASSWORD_LENGTH = 8;
const DEFAULT_PAGE_CACHE_MB = 32;
// These hosts always terminate TLS in front of the app.
const HTTPS_PLATFORMS: Platform[] = ["railway", "render", "fly"];

/** Older Nodes crash without a message when the database addon loads, so check first. */
export function checkNodeVersion(version: string = process.versions.node): void {
  if (Number(version.split(".")[0]) < MIN_NODE_MAJOR) {
    throw new ConfigError(
      `Tend needs Node.js ${MIN_NODE_MAJOR} or newer, and this computer has ${version}. ` +
        "Install the LTS version: https://tendcms.dev/install-node",
    );
  }
}

export function detectPlatform(env: NodeJS.ProcessEnv): Platform {
  if (env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID) return "railway";
  if (env.RENDER) return "render";
  if (env.FLY_APP_NAME) return "fly";
  // The image sets TEND_PLATFORM, because only Docker itself creates /.dockerenv: Podman
  // and Kubernetes don't, and there Tend would listen only on its own loopback.
  if (env.TEND_PLATFORM === "docker" || existsSync("/.dockerenv")) return "docker";
  return "local";
}

/** The address a hosting platform gave the site, from what it tells every app it runs. */
export function platformUrl(env: NodeJS.ProcessEnv): string | undefined {
  const parse = (value: string) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.origin : undefined;
    } catch {
      return undefined;
    }
  };
  if (env.RAILWAY_PUBLIC_DOMAIN) return parse(`https://${env.RAILWAY_PUBLIC_DOMAIN}`);
  if (env.RENDER_EXTERNAL_URL) return parse(env.RENDER_EXTERNAL_URL);
  if (env.FLY_APP_NAME) return parse(`https://${env.FLY_APP_NAME}.fly.dev`);
  return undefined;
}

/** Hosts that run code per request and throw the disk away, which Tend can't work with. */
export function detectServerless(env: NodeJS.ProcessEnv): string | undefined {
  if (env.VERCEL) return "Vercel";
  if (env.NETLIFY) return "Netlify";
  if (env.AWS_LAMBDA_FUNCTION_NAME) return "AWS Lambda";
  return undefined;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(
      `PORT is set to "${value}", which isn't a port number. Use a number from 1 to 65535, or remove PORT to use ${DEFAULT_PORT}.`,
    );
  }
  return port;
}

function parsePublicUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(
      `TEND_PUBLIC_URL is set to "${value}", which isn't a web address. Use something like https://example.com.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(
      `TEND_PUBLIC_URL is set to "${value}". It needs to start with https://, for example https://example.com.`,
    );
  }
  return url.origin;
}

function parseTrustProxy(value: string | undefined, platform: Platform): number {
  if (value === undefined || value === "") return HTTPS_PLATFORMS.includes(platform) ? 1 : 0;
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
    throw new ConfigError(
      `TEND_TRUST_PROXY is set to "${value}". It should be how many proxies are in front of Tend, usually 0 or 1.`,
    );
  }
  return hops;
}

/** Whether an address only reaches this computer. */
export function isLocalAddress(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parsePageCacheBytes(
  value: string | undefined,
  publicUrl: string | undefined,
  platform: Platform,
): number {
  const local = publicUrl ? isLocalAddress(publicUrl) : platform === "local";
  if (local) return 0;
  if (value === undefined || value === "") return DEFAULT_PAGE_CACHE_MB * 1024 * 1024;
  const megabytes = Number(value);
  if (!Number.isFinite(megabytes) || megabytes < 0) {
    throw new ConfigError(
      `TEND_CACHE_MB is set to "${value}". It should be a number of megabytes, like ${DEFAULT_PAGE_CACHE_MB}, or 0 to turn the page cache off.`,
    );
  }
  return Math.floor(megabytes * 1024 * 1024);
}

function parseSetupPassword(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if ([...value].length < MIN_SETUP_PASSWORD_LENGTH) {
    throw new ConfigError(
      `TEND_SETUP_CODE is too short. Choose a setup password of at least ${MIN_SETUP_PASSWORD_LENGTH} characters.`,
    );
  }
  return value;
}

function resolveHosts(env: NodeJS.ProcessEnv, platform: Platform): string[] {
  if (env.TEND_HOST) return [env.TEND_HOST];
  // Until setup is protected by a setup code (M1), a local install only listens on
  // this computer. Both addresses, because browsers try ::1 first for "localhost":
  // holding only 127.0.0.1 would let another app on ::1 answer Tend's printed link.
  return platform === "local" ? ["127.0.0.1", "::1"] : ["0.0.0.0"];
}

/**
 * Beside the data folder in a site someone made with npm, where it can go in their own
 * repository. In a container it's on the volume, or built into an image made from Tend's.
 */
function themeFolders(dataDir: string, platform: Platform): string[] {
  const beside = resolve("themes");
  const inData = join(dataDir, "themes");
  const folders =
    platform === "local" ? [beside, inData] : [inData, resolve("/opt/tend/themes"), beside];
  return [...new Set(folders)];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const serverless = detectServerless(env);
  if (serverless) {
    throw new ConfigError(
      `Tend can't run on ${serverless}. It needs a server that keeps running and a disk that keeps your files. ` +
        `Use Railway, Docker or a VPS instead: ${DOCS}/where-can-tend-run`,
    );
  }

  const platform = detectPlatform(env);
  const dataDir = resolve(env.TEND_DATA_DIR || "./data");
  const publicUrl = parsePublicUrl(env.TEND_PUBLIC_URL);
  return {
    dataDir,
    dbPath: join(dataDir, "tend.db"),
    uploadsDir: join(dataDir, "uploads"),
    backupsDir: join(dataDir, "backups"),
    secretKeyPath: join(dataDir, "secret.key"),
    themeFolders: themeFolders(dataDir, platform),
    platform,
    port: parsePort(env.PORT),
    hosts: resolveHosts(env, platform),
    adminDevUrl: env.TEND_ADMIN_DEV_URL || undefined,
    publicUrl,
    platformUrl: platformUrl(env),
    trustProxy: parseTrustProxy(env.TEND_TRUST_PROXY, platform),
    // Follows the site's address, never request headers, which a client could fake.
    secureCookies: publicUrl ? publicUrl.startsWith("https:") : HTTPS_PLATFORMS.includes(platform),
    setupPassword: parseSetupPassword(env.TEND_SETUP_CODE),
    pageCacheBytes: parsePageCacheBytes(env.TEND_CACHE_MB, publicUrl, platform),
    isPublic: publicUrl ? !isLocalAddress(publicUrl) : HTTPS_PLATFORMS.includes(platform),
  };
}

/** The ports to try in order: PORT if set, otherwise 3000, plus 3001–3010 when running locally. */
export function portsToTry(config: Pick<Config, "port" | "platform">): number[] {
  // Port 0 asks the system for any free port. Each address is bound separately, so
  // the port it picks for one can occasionally be taken on another: just ask again.
  if (config.port === 0) return [0, 0, 0];
  if (config.port !== undefined) return [config.port];
  if (config.platform !== "local") return [DEFAULT_PORT];
  return Array.from({ length: FALLBACK_PORTS + 1 }, (_, i) => DEFAULT_PORT + i);
}

/** What to do about a data folder Tend can't write to, for this reason, where it's running. */
export function dataFolderFix(reason: string, platform: Platform | undefined): string {
  if (/^(ENOSPC|EDQUOT|SQLITE_FULL)$/.test(reason)) {
    return "Its disk is full, so make room on it, then start Tend again.";
  }
  if (reason === "EROFS") {
    return "It's on a disk that can only be read, so mount it to be written to as well.";
  }
  // The image runs as node (user 1000), and a folder from the server, or a volume some
  // hosts make, belongs to root.
  if (platform === "railway") {
    return "Railway's volumes belong to root, so set RAILWAY_RUN_UID=0 in this service's variables, then deploy again.";
  }
  if (platform === "docker") {
    return "Tend runs as the node user (1000), so whatever is mounted at /data has to belong to it. For a folder on the server, run: sudo chown -R 1000:1000 <that folder>";
  }
  return "Give your user write access to it, or choose another folder with TEND_DATA_DIR.";
}

export function dataFolderError(dataDir: string, cause: unknown, platform?: Platform): ConfigError {
  const reason = (cause as NodeJS.ErrnoException).code ?? (cause as Error).message;
  return new ConfigError(
    `Tend can't write to its data folder, ${dataDir} (${reason}). ${dataFolderFix(reason, platform)} ` +
      "Fix: https://tendcms.dev/errors/data_not_writable",
  );
}

// Failures a person can fix by sorting out the folder. Anything else isn't a
// permissions problem, and blaming permissions would send them the wrong way.
const FOLDER_FAILURE =
  /^(EACCES|EPERM|EROFS|ENOSPC|EDQUOT|EISDIR|ENOTDIR|SQLITE_CANTOPEN|SQLITE_READONLY|SQLITE_FULL|SQLITE_IOERR)/;

/** Turns a failure while taking over the data folder into something that tells the truth. */
export function explainDataFolderFailure(
  dataDir: string,
  error: unknown,
  platform?: Platform,
): unknown {
  const code = String((error as NodeJS.ErrnoException).code);
  if (FOLDER_FAILURE.test(code)) return dataFolderError(dataDir, error, platform);
  if (code === "SQLITE_NOTADB") {
    return new ConfigError(
      `The lock file ${join(dataDir, ".lock.db")} is damaged. It holds nothing you need: ` +
        "if no other Tend is using this folder, delete it and start Tend again.",
    );
  }
  return error;
}

/** Creates the data folder layout on first boot. Safe to call on every boot. */
export function prepareDataDir(config: Config): void {
  try {
    for (const dir of [config.uploadsDir, config.backupsDir]) {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
    }
    accessSync(config.dataDir, constants.W_OK);
  } catch (error) {
    throw dataFolderError(config.dataDir, error, config.platform);
  }
}

/**
 * Keeps other accounts on this computer out of the site's private files, including
 * ones that were loosened by being copied or restored from an archive.
 */
export function tightenPrivateFiles(config: Config): void {
  if (process.platform === "win32") return;
  const files = [
    config.secretKeyPath,
    config.dbPath,
    `${config.dbPath}-wal`,
    `${config.dbPath}-shm`,
  ];
  for (const file of files) {
    try {
      chmodSync(file, 0o600);
    } catch {
      // It doesn't exist yet, or this account doesn't own it: nothing to do either way.
    }
  }
}

/**
 * Creates secret.key the first time, atomically, and checks it on every boot. A
 * damaged key is never replaced silently, because anything signed or encrypted
 * with the old one would stop working. Call this while holding the data folder lock.
 */
export function ensureSecretKey(config: Config): void {
  const path = config.secretKeyPath;
  if (existsSync(path)) {
    readSecretKey(config);
    return;
  }
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, secretKeyText(randomBytes(SECRET_KEY_BYTES)), { mode: 0o600 });
  fsyncFile(tmpPath);
  renameSync(tmpPath, path);
  fsyncDir(config.dataDir);
}

/** The key in the key file, which has to be there. Throws if it's damaged. */
export function readSecretKey({ secretKeyPath }: Pick<Config, "secretKeyPath">): Buffer {
  const key = parseSecretKey(readFileSync(secretKeyPath));
  if (key) return key;
  throw new ConfigError(
    `The key file ${secretKeyPath} is damaged, so Tend won't start. Restore it from a backup. ` +
      "Fix: https://tendcms.dev/errors/secret_key_damaged",
  );
}

/** A key as its file holds it. Backups hold the same, so one can also be put back by hand. */
export function secretKeyText(key: Buffer): string {
  return `${key.toString("hex")}\n`;
}

/** The key that a key file's contents are, or undefined if they aren't one. */
export function parseSecretKey(contents: Buffer): Buffer | undefined {
  const text = contents.toString("latin1");
  return SECRET_KEY_FORMAT.test(text) ? Buffer.from(text.trim(), "hex") : undefined;
}
