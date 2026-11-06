import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fsyncDir, fsyncFile } from "./durable.ts";

export type Platform = "railway" | "render" | "fly" | "docker" | "local";

export interface Config {
  dataDir: string;
  dbPath: string;
  uploadsDir: string;
  backupsDir: string;
  secretKeyPath: string;
  platform: Platform;
  /** Undefined means "PORT was not set". */
  port: number | undefined;
  /** Every address Tend listens on. */
  hosts: string[];
  /** Set by scripts/dev.mjs so /admin/* goes to the Vite dev server. */
  adminDevUrl: string | undefined;
}

/** A problem the person running Tend has to fix; `message` is shown as-is. */
export class ConfigError extends Error {}

const DOCS = "https://tendcms.dev/docs";
const MIN_NODE_MAJOR = 24;
const DEFAULT_PORT = 3000;
const FALLBACK_PORTS = 10;
const SECRET_KEY_FORMAT = /^[0-9a-f]{64}\n?$/;

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
  if (existsSync("/.dockerenv")) return "docker";
  return "local";
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

function resolveHosts(env: NodeJS.ProcessEnv, platform: Platform): string[] {
  if (env.TEND_HOST) return [env.TEND_HOST];
  // Until setup is protected by a setup code (M1), a local install only listens on
  // this computer. Both addresses, because browsers try ::1 first for "localhost":
  // holding only 127.0.0.1 would let another app on ::1 answer Tend's printed link.
  return platform === "local" ? ["127.0.0.1", "::1"] : ["0.0.0.0"];
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
  return {
    dataDir,
    dbPath: join(dataDir, "tend.db"),
    uploadsDir: join(dataDir, "uploads"),
    backupsDir: join(dataDir, "backups"),
    secretKeyPath: join(dataDir, "secret.key"),
    platform,
    port: parsePort(env.PORT),
    hosts: resolveHosts(env, platform),
    adminDevUrl: env.TEND_ADMIN_DEV_URL || undefined,
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

export function dataFolderError(dataDir: string, cause: unknown): ConfigError {
  const reason = (cause as NodeJS.ErrnoException).code ?? (cause as Error).message;
  return new ConfigError(
    `Tend can't write to its data folder, ${dataDir} (${reason}). ` +
      "Give your user write access to it, or choose another folder with TEND_DATA_DIR. " +
      "Fix: https://tendcms.dev/errors/data_not_writable",
  );
}

// Failures a person can fix by sorting out the folder. Anything else isn't a
// permissions problem, and blaming permissions would send them the wrong way.
const FOLDER_FAILURE =
  /^(EACCES|EPERM|EROFS|ENOSPC|EISDIR|ENOTDIR|SQLITE_CANTOPEN|SQLITE_READONLY|SQLITE_FULL|SQLITE_IOERR)/;

/** Turns a failure while taking over the data folder into something that tells the truth. */
export function explainDataFolderFailure(dataDir: string, error: unknown): unknown {
  const code = String((error as NodeJS.ErrnoException).code);
  if (FOLDER_FAILURE.test(code)) return dataFolderError(dataDir, error);
  // The lock is the first thing to open a database, so this is where a broken
  // install or a computer with no prebuilt database component shows up.
  if (code === "ERR_DLOPEN_FAILED" || code === "MODULE_NOT_FOUND") {
    return new ConfigError(
      `Tend's database component couldn't load on this computer (${(error as Error).message}). ` +
        "Install Tend again, or use the Docker version: https://tendcms.dev/errors/database_component",
    );
  }
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
    throw dataFolderError(config.dataDir, error);
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
    if (!SECRET_KEY_FORMAT.test(readFileSync(path, "utf8"))) {
      throw new ConfigError(
        `The key file ${path} is damaged, so Tend won't start. Restore it from a backup. ` +
          "Fix: https://tendcms.dev/errors/secret_key_damaged",
      );
    }
    return;
  }
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  fsyncFile(tmpPath);
  renameSync(tmpPath, path);
  fsyncDir(config.dataDir);
}
