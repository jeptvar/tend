// The site for other programs: feed readers, search engines and their crawlers.

/** XML 1.0 can't carry most control characters at all, escaped or not, even in CDATA. */
function withoutControlCharacters(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");
}

function xml(text: string): string {
  return withoutControlCharacters(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** CDATA can't contain its own end, so that's split across two sections. */
function cdata(text: string): string {
  return `<![CDATA[${withoutControlCharacters(text).replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

export interface FeedItem {
  title: string;
  url: string;
  summary: string;
  html: string;
  publishedAt: number;
}

export function rss(input: {
  siteName: string;
  description: string;
  origin: string;
  locale: string;
  items: FeedItem[];
}): string {
  const items = input.items
    .map(
      (item) => `<item>
<title>${xml(item.title)}</title>
<link>${xml(item.url)}</link>
<guid isPermaLink="true">${xml(item.url)}</guid>
<pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate>
<description>${xml(item.summary)}</description>
<content:encoded>${cdata(item.html)}</content:encoded>
</item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${xml(input.siteName)}</title>
<link>${xml(`${input.origin}/`)}</link>
<atom:link href="${xml(`${input.origin}/rss.xml`)}" rel="self" type="application/rss+xml"/>
<description>${xml(input.description || input.siteName)}</description>
<language>${xml(input.locale)}</language>
${items}
</channel>
</rss>
`;
}

export interface SitemapEntry {
  url: string;
  modifiedAt: number | null;
}

export function sitemap(entries: SitemapEntry[]): string {
  const urls = entries
    .map(
      (entry) =>
        `<url><loc>${xml(entry.url)}</loc>${
          entry.modifiedAt ? `<lastmod>${new Date(entry.modifiedAt).toISOString()}</lastmod>` : ""
        }</url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export function robots(input: { origin: string; open: boolean }): string {
  return input.open
    ? `User-agent: *\nAllow: /\n\nSitemap: ${input.origin}/sitemap.xml\n`
    : "User-agent: *\nDisallow: /\n";
}
