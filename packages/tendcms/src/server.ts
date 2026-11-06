import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { Hono } from "hono";

export interface AppOptions {
  version: string;
  adminDir: string;
  adminDevUrl: string | undefined;
}

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

  app.get("/healthz", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, version: options.version });
  });

  // There is no public site yet (M1), so the only useful place to go is setup.
  app.get("/", (c) => c.redirect("/admin/setup"));

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
      "X-Content-Type-Options": "nosniff",
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
      "X-Content-Type-Options": "nosniff",
    },
  });
}
