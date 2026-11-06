export interface RequestOrigin {
  secFetchSite: string | undefined;
  origin: string | undefined;
  host: string | undefined;
  publicUrl: string | undefined;
}

/**
 * Decides whether a state-changing request came from another site (PLAN.md §12).
 * This also refuses same-site requests, which is stricter than the plan: on a shared
 * parent domain, a "same-site" neighbour can be someone else's site.
 */
export function isForeignRequest(request: RequestOrigin): boolean {
  if (request.secFetchSite) {
    return request.secFetchSite !== "same-origin" && request.secFetchSite !== "none";
  }
  // Browsers leave Sec-Fetch-Site out on plain http, so fall back to Origin.
  if (!request.origin) return false;
  let origin: URL;
  try {
    origin = new URL(request.origin);
  } catch {
    // Includes "Origin: null", which sandboxed frames send and is never trusted.
    return true;
  }
  if (request.publicUrl && origin.origin === new URL(request.publicUrl).origin) return false;
  return origin.host !== request.host;
}
