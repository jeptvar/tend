import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Context, Hono, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createAdminRoutes } from "./api/admin/index.ts";
import { notSignedIn } from "./api/admin/routing.ts";
import { type AuthOptions, createAuthRoutes } from "./api/auth.ts";
import { ApiError } from "./api/errors.ts";
import { BACKUP_PART_BYTES, BACKUP_PART_PATH } from "./api/setup-backup.ts";
import { isForeignRequest } from "./auth/csrf.ts";
import { currentUser } from "./auth/current-user.ts";
import { MAX_UPLOAD_BYTES } from "./media/process.ts";
import { MediaStore } from "./media/store.ts";
import { createSite } from "./site/router.ts";
import { SiteAddress } from "./site-address.ts";
import { contentTypeFor, resolveInside } from "./static-files.ts";

export interface AppOptions extends Omit<AuthOptions, "onSiteChanged" | "themeDir" | "address"> {
  version: string;
  adminDir: string;
  adminDevUrl: string | undefined;
  /** TEND_PUBLIC_URL. */
  publicUrl: string | undefined;
  /** The address the hosting platform gave the site, if it said. */
  platformUrl?: string | undefined;
  /** Whether the site is reached over https, until an Admin confirms its address. */
  secureCookies: boolean;
  themeDir: string;
  /** Where themes of people's own are. */
  themeFolders?: string[] | undefined;
  showThemeMistakes?: boolean | undefined;
  uploadsDir: string;
  /** Where Tend keeps copies of the site, for Settings → Backups. */
  backupsDir?: string | undefined;
  pageCacheBytes: number;
  watchTheme?: boolean;
  /** How long an upload can send nothing before Tend gives up on it. Tests make it short. */
  uploadIdleMs?: number;
  /** See SiteOptions.onBackgroundWork: tests wait for it rather than for a guessed time. */
  onBackgroundWork?: ((work: Promise<unknown>) => void) | undefined;
}

const AUTH_BODY_LIMIT_BYTES = 64 * 1024;
// Far more than any page should need, but small enough that it can't exhaust memory.
const ADMIN_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// A little over the file limit, for the request around it.
const UPLOAD_BODY_LIMIT_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;
const UPLOAD_ROUTE = /^\/api\/admin\/media(?:\/[0-9a-f-]{36}\/replace)?$/;
// Each upload is held whole while it waits its turn to be made ready, and can be 20 MB, so
// only a few at once: enough for a busy afternoon, too few to fill a small server's memory.
const UPLOADS_AT_ONCE = 4;
// One account never holds every place, so one person's dropped connection or busy tabs
// always leave room for someone else's upload.
const UPLOADS_PER_ACCOUNT = UPLOADS_AT_ONCE - 1;
const UPLOAD_RETRY_SECONDS = 2;
// An upload that sends nothing for this long is given up on, and its place freed. A connection
// that drops without closing would otherwise hold it until Node's own timeout, minutes later.
const UPLOAD_IDLE_MS = 30_000;

/** The routes that take a file as it is, rather than JSON. */
function isUpload(method: string, path: string): boolean {
  return method === "POST" && UPLOAD_ROUTE.test(path);
}

/** A part of a backup sent at setup, which is a file as it is too. */
function isBackupPart(method: string, path: string): boolean {
  return method === "POST" && path === BACKUP_PART_PATH;
}

function needsLength(): ApiError {
  return new ApiError(
    411,
    "needs_length",
    "Tend needs to know how big a file is before it arrives.",
    { fix: "Send its size in a Content-Length header, or upload it from Media instead." },
  );
}

function uploadsBusy(): ApiError {
  return new ApiError(503, "uploads_busy", "Tend is busy with other uploads right now.", {
    fix: "Wait a moment, then try again.",
    retryAfterSeconds: UPLOAD_RETRY_SECONDS,
  });
}

function uploadStalled(): ApiError {
  return new ApiError(
    408,
    "upload_stalled",
    "That file stopped arriving partway through, so it wasn't uploaded.",
    { fix: "Check your connection, then try again." },
  );
}

/** The places for uploads being received, and how many of them each account holds. */
function uploadPlaces(total: number, perAccount: number) {
  let taken = 0;
  const byAccount = new Map<string, number>();
  return {
    /** A place for this account's upload and the way to give it back, or null if there's none. */
    take(accountId: string): (() => void) | null {
      const theirs = byAccount.get(accountId) ?? 0;
      if (taken >= total || theirs >= perAccount) return null;
      taken++;
      byAccount.set(accountId, theirs + 1);
      return () => {
        taken--;
        const left = (byAccount.get(accountId) ?? 1) - 1;
        if (left > 0) byAccount.set(accountId, left);
        else byAccount.delete(accountId);
      };
    },
  };
}

/**
 * Gives up on an upload once nothing more of it has arrived for a while, so that reading it
 * fails with a 408 that says so. Only time spent waiting for more of the file counts, not
 * time Tend spends on what has arrived.
 */
function giveUpWhenStalled(c: Context, idleMs: number) {
  const source = c.req.raw.body;
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (source) {
    const reader = source.getReader();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          timer = setTimeout(() => {
            stalled = true;
            controller.error(uploadStalled());
          }, idleMs);
          try {
            const { done, value } = await reader.read();
            if (stalled) return;
            if (done) controller.close();
            else controller.enqueue(value);
          } catch (error) {
            if (!stalled) controller.error(error);
          } finally {
            clearTimeout(timer);
          }
        },
        cancel: (reason) => reader.cancel(reason),
      },
      // Nothing is asked for until the route reads the file, so the wait starts then.
      { highWaterMark: 0 },
    );
    c.req.raw = new Request(c.req.raw, { body, duplex: "half" });
  }
  return { stalled: () => stalled, stop: () => clearTimeout(timer) };
}

// PLAN.md §12. The admin loads nothing from anywhere else, and no other site can frame it.
const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "frame-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

// Shown when the admin hasn't been built yet (e.g. running the server alone from source).
const ADMIN_NOT_BUILT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tend</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">
<h1>Tend is running</h1>
<p>The admin screens haven't been built yet. Run <code>pnpm dev</code> or <code>pnpm build</code> from the project folder.</p>
</body></html>`;

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const now = options.now ?? Date.now;
  const address = new SiteAddress(options.orm, options);

  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    if (address.secure) {
      c.res.headers.set("Strict-Transport-Security", "max-age=31536000");
    }
    if (c.req.path === "/admin" || c.req.path.startsWith("/admin/")) {
      c.res.headers.set("Content-Security-Policy", ADMIN_CSP);
      c.res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
      c.res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    } else if (!c.req.path.startsWith("/api/")) {
      c.res.headers.set("Content-Security-Policy", "frame-ancestors 'self'");
    }
  });

  let warnedAboutProxy = false;

  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (options.trustProxy === 0 && !warnedAboutProxy && c.req.header("x-forwarded-for")) {
      warnedAboutProxy = true;
      console.warn(
        "Tend seems to be behind a proxy, so all visitors currently share one sign-in limit. " +
          "Set TEND_TRUST_PROXY=1 to fix that: https://tendcms.dev/docs/proxies",
      );
    }
    if (UNSAFE_METHODS.has(c.req.method)) {
      const foreign = isForeignRequest({
        secFetchSite: c.req.header("sec-fetch-site"),
        origin: c.req.header("origin"),
        host: c.req.header("host"),
        publicUrl: options.publicUrl,
      });
      if (foreign) {
        throw new ApiError(403, "foreign_request", "That request came from another website.", {
          fix: "If Tend is behind a proxy, set TEND_PUBLIC_URL to your site's address.",
        });
      }
      // HTML forms can send neither JSON nor a bare file, and another site's script can't
      // either without asking first, which Tend never allows. So this also stops most
      // cross-site tricks by itself.
      const type = c.req.header("content-type")?.toLowerCase() ?? "";
      if (isUpload(c.req.method, c.req.path) || isBackupPart(c.req.method, c.req.path)) {
        if (!type.startsWith("application/octet-stream")) {
          throw new ApiError(415, "needs_file", "Tend expected a file here.");
        }
      } else if (!type.startsWith("application/json")) {
        throw new ApiError(415, "needs_json", "Tend only accepts JSON here.");
      }
    }
    await next();
  });

  function limitBody(maxSize: number, tooLarge?: () => ApiError) {
    return bodyLimit({
      maxSize,
      onError: () => {
        throw (
          tooLarge?.() ??
          new ApiError(413, "too_large", "That's more than Tend can save in one go.", {
            fix: "Split it into two.",
          })
        );
      },
    });
  }
  const adminLimit = limitBody(ADMIN_BODY_LIMIT_BYTES);
  const uploadLimit = limitBody(
    UPLOAD_BODY_LIMIT_BYTES,
    () =>
      new ApiError(
        413,
        "file_too_large",
        "That file is bigger than 20 MB, which is the most Tend can take.",
        {
          fix: "Make it smaller first. For a photo, export it at a smaller size or as a JPEG.",
        },
      ),
  );
  const authLimit = limitBody(AUTH_BODY_LIMIT_BYTES);
  const backupPartLimit = limitBody(BACKUP_PART_BYTES + 64 * 1024);
  app.use("/api/auth/*", (c, next) =>
    isBackupPart(c.req.method, c.req.path) ? backupPartLimit(c, next) : authLimit(c, next),
  );

  const places = uploadPlaces(UPLOADS_AT_ONCE, UPLOADS_PER_ACCOUNT);
  const uploadIdleMs = options.uploadIdleMs ?? UPLOAD_IDLE_MS;

  /** Lets an upload in when there's a place for it, and frees the place once it's answered. */
  async function receiveUpload(c: Context, accountId: string, next: Next): Promise<void> {
    // An upload has to say how big it is before it's sent. Over HTTP/1.1, a body without a
    // Content-Length comes in chunks, and its size is only known once all of it is held.
    if (c.req.header("transfer-encoding") !== undefined) throw needsLength();
    const giveBack = places.take(accountId);
    if (!giveBack) throw uploadsBusy();
    const watch = giveUpWhenStalled(c, uploadIdleMs);
    try {
      await next();
    } finally {
      watch.stop();
      giveBack();
    }
    // The rest of that file is never read, so the connection is closed rather than kept open.
    if (watch.stalled()) c.res.headers.set("Connection", "close");
  }

  // Nothing sent to the admin is read until it's known who sent it. A body can be 20 MB, so
  // reading first would let anyone at all fill the server's memory. Each route checks again.
  app.use("/api/admin/*", async (c, next) => {
    const user = await currentUser(c, options.orm, address.secure, now());
    if (!user) throw notSignedIn();
    if (isUpload(c.req.method, c.req.path)) await receiveUpload(c, user.id, next);
    else await next();
  });

  app.use("/api/admin/*", (c, next) =>
    isUpload(c.req.method, c.req.path) ? uploadLimit(c, next) : adminLimit(c, next),
  );

  const store = new MediaStore(options.uploadsDir, options.backupsDir);
  const site = createSite({
    orm: options.orm,
    store,
    themeDir: options.themeDir,
    themeFolders: options.themeFolders,
    showThemeMistakes: options.showThemeMistakes,
    pageCacheBytes: options.pageCacheBytes,
    address,
    trustProxy: options.trustProxy,
    now: options.now,
    version: options.version,
    watchTheme: options.watchTheme ?? false,
    onBackgroundWork: options.onBackgroundWork,
  });
  const onSiteChanged = (path?: string) => {
    address.refresh();
    site.changed(path);
  };

  app.route("/api/auth", createAuthRoutes({ ...options, address, onSiteChanged }));
  app.route(
    "/api/admin",
    createAdminRoutes({
      orm: options.orm,
      store,
      address,
      now: options.now,
      onSiteChanged,
      preview: (input) => site.preview(input),
      themes: site.themes,
      platform: options.platform,
      previewDesign: (design) => site.previewDesign(design),
      backupsDir: options.backupsDir,
      uploadsDir: options.uploadsDir,
      dbPath: options.dataFolder?.dbPath,
      secretKey: options.secretKey,
      version: options.version,
      trustProxy: options.trustProxy,
      dataRisk: options.dataRisk,
    }).app,
  );

  app.all("/api/*", () => {
    throw new ApiError(404, "not_found", "There's nothing at this address.");
  });

  app.onError((error, c) => {
    // The visitor hung up mid-request, so nobody will read this answer, and it's not
    // worth a stack trace in the window Tend asks people to keep open.
    if ((error as NodeJS.ErrnoException).code === "ECONNRESET") return c.body(null, 400);
    if (error instanceof ApiError) {
      if (error.details.retryAfterSeconds) {
        c.header("Retry-After", String(error.details.retryAfterSeconds));
      }
      return c.json(error.toJSON(), error.status);
    }
    console.error("Tend hit an unexpected error:", error);
    const unexpected = new ApiError(500, "unexpected", "Something went wrong on the server.", {
      fix: "Try again. If it keeps happening, Tend's log has the details.",
    });
    return c.json(unexpected.toJSON(), 500);
  });

  app.get("/healthz", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, version: options.version });
  });

  app.get("/admin", (c) => c.redirect("/admin/"));
  app.get("/admin/*", (c) => {
    if (options.adminDevUrl) {
      const { pathname, search } = new URL(c.req.url);
      return c.redirect(new URL(pathname + search, options.adminDevUrl).toString());
    }
    return serveAdmin(options.adminDir, c.req.path);
  });

  // Last, because the public site answers every address nothing above has claimed.
  app.route("/", site.app);

  return app;
}

/** Serves the built admin SPA: real files when they exist, index.html for client routes. */
function serveAdmin(adminDir: string, requestPath: string): Response {
  const indexPath = join(adminDir, "index.html");
  if (!existsSync(indexPath)) return html(ADMIN_NOT_BUILT);

  const encoded = requestPath.slice("/admin/".length);
  let relative: string;
  try {
    relative = decodeURIComponent(encoded);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const filePath = resolveInside(adminDir, encoded);

  if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
    return new Response(readFileSync(filePath), {
      headers: {
        "Content-Type": contentTypeFor(filePath),
        // Vite puts content hashes in everything under assets/.
        "Cache-Control": relative.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      },
    });
  }
  if (relative.startsWith("assets/")) return new Response("Not found", { status: 404 });
  return html(readFileSync(indexPath, "utf8"));
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
