import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Liquid } from "liquidjs";

export interface ThemeOptions {
  themeDir: string;
  /** Off for local sites, so edits to a template show on refresh. */
  cache: boolean;
  timezone: () => string;
  locale: () => string;
}

export interface Theme {
  name: string;
  render(template: string, context: Record<string, unknown>): Promise<string>;
  assetHash(file: string): string;
  assetsDir: string;
}

const RENDER_LIMIT_MS = 500;
const PARSE_LIMIT_BYTES = 1_000_000;
const MEMORY_LIMIT_BYTES = 100_000_000;

/** A theme's templates, run with the plan's limits (§10). Themes can't run server code. */
export function createTheme(options: ThemeOptions): Theme {
  const { themeDir } = options;
  const name = basename(themeDir);
  const assetsDir = join(themeDir, "assets");
  const hashes = new Map<string, string>();

  function assetHash(file: string): string {
    const known = options.cache ? hashes.get(file) : undefined;
    if (known) return known;
    const hash = createHash("sha256")
      .update(readFileSync(join(assetsDir, file)))
      .digest("hex")
      .slice(0, 12);
    hashes.set(file, hash);
    return hash;
  }

  const engine = new Liquid({
    root: join(themeDir, "templates"),
    partials: join(themeDir, "partials"),
    layouts: join(themeDir, "templates"),
    extname: ".liquid",
    cache: options.cache,
    relativeReference: false,
    outputEscape: "escape",
    ownPropertyOnly: true,
    strictFilters: true,
    parseLimit: PARSE_LIMIT_BYTES,
    renderLimit: RENDER_LIMIT_MS,
    memoryLimit: MEMORY_LIMIT_BYTES,
  });

  engine.registerFilter(
    "asset_url",
    (file: string) => `/assets/${name}/${assetHash(file)}/${file}`,
  );
  engine.registerFilter("iso_date", (value: number | null) =>
    value === null || value === undefined ? "" : new Date(value).toISOString(),
  );
  engine.registerFilter("date", (value: number | null, style: "medium" | "long" = "medium") => {
    if (value === null || value === undefined) return "";
    return new Intl.DateTimeFormat(options.locale(), {
      dateStyle: style,
      timeZone: options.timezone(),
    }).format(value);
  });

  return {
    name,
    assetsDir,
    assetHash,
    render: (template, context) => engine.renderFile(template, context),
  };
}
