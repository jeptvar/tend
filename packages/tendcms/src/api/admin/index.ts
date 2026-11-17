import type { Hono } from "hono";
import { type BackupRouteOptions, registerBackupRoutes } from "./backups.ts";
import { registerEntryRoutes } from "./entries.ts";
import { registerMediaRoutes } from "./media.ts";
import { createRouting, type RoutePolicy } from "./routing.ts";
import { registerSiteRoutes, type SiteRouteOptions } from "./site.ts";

export type { AdminOptions, RoutePolicy } from "./routing.ts";

/** Everything under /api/admin. Each route has to state the action that guards it. */
export function createAdminRoutes(options: SiteRouteOptions & BackupRouteOptions): {
  app: Hono;
  policies: RoutePolicy[];
} {
  const routing = createRouting(options);
  registerEntryRoutes(routing, options);
  registerMediaRoutes(routing, options);
  registerSiteRoutes(routing, options);
  registerBackupRoutes(routing, options);
  return { app: routing.app, policies: routing.policies };
}
