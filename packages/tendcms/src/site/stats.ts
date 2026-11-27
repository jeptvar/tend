import { escapeHtml } from "../content/render-doc.ts";
import { type StatsSettings, UMAMI_CLOUD_SCRIPT } from "../content/stats.ts";

/**
 * The script tag the chosen service asks for on every page, as its own docs give it. Each goes
 * in <head>, which every theme has: a deferred script runs once the page is read, wherever it
 * sits, so Cloudflare's, which its docs put before </body>, works the same there.
 */
export function statsTag(stats: StatsSettings): string | null {
  switch (stats.service) {
    case "plausible":
      return `<script defer data-domain="${escapeHtml(stats.id)}" src="https://plausible.io/js/script.js"></script>`;
    case "fathom":
      return `<script src="https://cdn.usefathom.com/script.js" data-site="${escapeHtml(stats.id)}" defer></script>`;
    case "umami":
      return `<script defer src="${escapeHtml(stats.script ?? UMAMI_CLOUD_SCRIPT)}" data-website-id="${escapeHtml(stats.id)}"></script>`;
    case "cloudflare":
      return `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon="${escapeHtml(JSON.stringify({ token: stats.id }))}"></script>`;
    default:
      return null;
  }
}
