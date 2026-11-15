import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type Context,
  Hash,
  Liquid,
  Tag,
  type TagToken,
  type TopLevelToken,
  Value,
} from "liquidjs";
import { isMediaId } from "../content/doc.ts";
import { imagePlaceholder } from "./placeholders.ts";

export interface ThemeOptions {
  themeDir: string;
  /** Off for local sites, so edits to a template show on refresh. */
  cache: boolean;
  timezone: () => string;
  locale: () => string;
}

/** One choice on the Design screen, from the theme's theme.json. */
export type ThemeSetting =
  | { id: string; type: "color"; label: string; hint?: string; default: string }
  | {
      id: string;
      type: "select";
      label: string;
      hint?: string;
      default: string;
      options: { value: string; label: string; hint?: string }[];
    };

export interface Theme {
  name: string;
  /** The choices the theme offers, which make up most of the Design form. */
  settings: ThemeSetting[];
  /** The choices made, checked against what the theme offers, with its defaults for the rest. */
  designValues(chosen: Record<string, string>): Record<string, string>;
  /** Forgets everything read from the theme's folder, after a file in it changed. */
  reload(): void;
  render(template: string, context: Record<string, unknown>): Promise<string>;
  /** One partial on its own, for pieces filled in after the page is done. */
  renderPartial(name: string, context: Record<string, unknown>): Promise<string>;
  assetHash(file: string): string;
  assetsDir: string;
}

const COLOR = /^#[0-9a-f]{6}$/i;

/** Reads theme.json's settings, keeping only what Tend knows how to show. */
function readSettings(themeDir: string): ThemeSetting[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(themeDir, "theme.json"), "utf8"));
  } catch {
    return [];
  }
  const list = (parsed as { settings?: unknown }).settings;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): ThemeSetting[] => {
    if (typeof item !== "object" || item === null) return [];
    const { id, type, label, hint, default: fallback, options } = item as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(id) || typeof label !== "string")
      return [];
    const hintText = typeof hint === "string" ? { hint } : {};
    if (type === "color" && typeof fallback === "string" && COLOR.test(fallback)) {
      return [{ id, type, label, ...hintText, default: fallback.toLowerCase() }];
    }
    if (type === "select" && Array.isArray(options) && typeof fallback === "string") {
      const choices = options.flatMap((option) => {
        const { value, label: name, hint: about } = (option ?? {}) as Record<string, unknown>;
        return typeof value === "string" && typeof name === "string"
          ? [{ value, label: name, ...(typeof about === "string" ? { hint: about } : {}) }]
          : [];
      });
      if (!choices.some((choice) => choice.value === fallback)) return [];
      return [{ id, type, label, ...hintText, default: fallback, options: choices }];
    }
    return [];
  });
}

const RENDER_LIMIT_MS = 500;
const PARSE_LIMIT_BYTES = 1_000_000;
const MEMORY_LIMIT_BYTES = 100_000_000;

interface Writer {
  write(html: unknown): void;
}

/** The ID inside whatever a template passed: a picture from Tend, or an ID on its own. */
function pictureOf(value: unknown): { id: string; alt: string | null } | undefined {
  if (isMediaId(value)) return { id: value, alt: null };
  if (typeof value !== "object" || value === null) return undefined;
  const { id, alt } = value as { id?: unknown; alt?: unknown };
  return isMediaId(id)
    ? { id, alt: typeof alt === "string" && alt !== "" ? alt : null }
    : undefined;
}

/**
 * {% image post.image, size: "card" %}: a picture in the sizes Tend made of it, described in
 * Media unless given `alt: "..."`, or `decorative: true` beside words that say it all. It writes a
 * placeholder, which becomes the real picture once the page is done, with every picture on
 * the page looked up at once.
 */
class ImageTag extends Tag {
  readonly #picture: Value;
  readonly #options: Hash;

  constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
    super(token, remainTokens, liquid);
    // The picture first, then named options after a comma, as in {% render %}.
    const picture = this.tokenizer.readValue();
    if (!picture) throw new Error("{% image %} needs a picture, like {% image post.image %}");
    this.#picture = new Value(picture.getText(), liquid);
    this.#options = new Hash(this.tokenizer);
  }

  *render(context: Context, emitter: Writer): Generator<unknown, void, unknown> {
    const picture = pictureOf(yield this.#picture.value(context, false));
    if (!picture) return;
    const options = (yield this.#options.render(context)) as Record<string, unknown>;
    const size = typeof options.size === "string" ? options.size : "normal";
    const alt = typeof options.alt === "string" ? options.alt : picture.alt;
    emitter.write(
      imagePlaceholder({ id: picture.id, size, alt, decorative: options.decorative === true }),
    );
  }
}

/** A theme's templates, run with the plan's limits (§10). Themes can't run server code. */
export function createTheme(options: ThemeOptions): Theme {
  const { themeDir } = options;
  const name = basename(themeDir);
  const assetsDir = join(themeDir, "assets");
  const hashes = new Map<string, string>();
  let settings = readSettings(themeDir);

  function designValues(chosen: Record<string, string>): Record<string, string> {
    const values: Record<string, string> = {};
    for (const setting of settings) {
      const value = chosen[setting.id];
      const valid =
        typeof value === "string" &&
        (setting.type === "color"
          ? COLOR.test(value)
          : setting.options.some((option) => option.value === value));
      values[setting.id] = valid
        ? setting.type === "color"
          ? value.toLowerCase()
          : value
        : setting.default;
    }
    return values;
  }

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
  engine.registerTag("image", ImageTag);
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
    get settings() {
      return settings;
    },
    designValues,
    reload() {
      hashes.clear();
      settings = readSettings(themeDir);
      (engine.options.cache as { clear?: () => void } | undefined)?.clear?.();
    },
    assetsDir,
    assetHash,
    render: (template, context) => engine.renderFile(template, context),
    // A rendered partial sees only what it's handed, so everything given is passed along.
    renderPartial: (name, context) => {
      const passed = Object.keys(context)
        .filter((key) => /^[a-z_][a-z0-9_]*$/.test(key))
        .map((key) => `, ${key}: ${key}`)
        .join("");
      return engine.parseAndRender(
        `{% render "${name.replace(/[^a-z0-9-]/g, "")}"${passed} %}`,
        context,
      );
    },
  };
}
