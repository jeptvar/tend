import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AuthOptions, createAuthRoutes } from "./api/auth.ts";
import { ApiError } from "./api/errors.ts";
import { isForeignRequest } from "./auth/csrf.ts";

export interface AppOptions extends AuthOptions {
  version: string;
  adminDir: string;
  adminDevUrl: string | undefined;
  publicUrl: string | undefined;
}

const API_BODY_LIMIT_BYTES = 64 * 1024;
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

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

  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    if (options.secureCookies) {
      c.res.headers.set("Strict-Transport-Security", "max-age=31536000");
    }
    if (c.req.path === "/admin" || c.req.path.startsWith("/admin/")) {
      c.res.headers.set("Content-Security-Policy", ADMIN_CSP);
      c.res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
      c.res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
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
      // HTML forms can't send JSON, so this also stops most cross-site tricks by itself.
      if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
        throw new ApiError(415, "needs_json", "Tend only accepts JSON here.");
      }
    }
    await next();
  });

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: API_BODY_LIMIT_BYTES,
      onError: () => {
        throw new ApiError(413, "too_large", "That request is too large.");
      },
    }),
  );

  app.route("/api/auth", createAuthRoutes(options));

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

  // There's no public site yet, so the admin is the only place to go. It works out
  // whether that means setup, signing in or the overview.
  app.get("/", (c) => c.redirect("/admin/"));

  app.get("/admin", (c) => c.redirect("/admin/"));
  app.get("/admin/*", (c) => {
    if (options.adminDevUrl) {
      const { pathname, search } = new URL(c.req.url);
      return c.redirect(new URL(pathname + search, options.adminDevUrl).toString());
    }
    return serveAdmin(options.adminDir, c.req.path);
  });

  return app;
}

/** Serves the built admin SPA: real files when they exist, index.html for client routes. */
function serveAdmin(adminDir: string, requestPath: string): Response {
  const indexPath = join(adminDir, "index.html");
  if (!existsSync(indexPath)) return html(ADMIN_NOT_BUILT);

  let relative: string;
  try {
    relative = decodeURIComponent(requestPath.slice("/admin/".length));
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const filePath = normalize(join(adminDir, relative));
  const insideAdmin = filePath.startsWith(adminDir + sep);

  if (insideAdmin && existsSync(filePath) && statSync(filePath).isFile()) {
    const headers: Record<string, string> = {
      "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      // Vite puts content hashes in everything under assets/.
      "Cache-Control": relative.startsWith("assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    };
    return new Response(readFileSync(filePath), { headers });
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
