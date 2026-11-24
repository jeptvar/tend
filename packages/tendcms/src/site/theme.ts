import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Context,
  Hash,
  Liquid,
  Tag,
  type TagToken,
  type Template,
  type TopLevelToken,
  Value,
} from "liquidjs";
import { isMediaId } from "../content/doc.ts";
import { imagePlaceholder, imageSrcset, imageUrl } from "./placeholders.ts";
import { madeFor } from "./theme-range.ts";

export interface ThemeOptions {
  /** Its folder's name, which is part of its files' addresses. */
  id: string;
  dir: string;
  /** Where to find what this theme doesn't have: the theme Tend comes with. */
  fallback?: Theme | undefined;
  /** Off for local sites, so edits to a template show on refresh. */
  cache: boolean;
  timezone: () => string;
  locale: () => string;
  /** Which Tend this is, for the versions a theme says it's made for. */
  version?: string | undefined;
}

/** One choice on the Design screen, from the theme's theme.json. */
export type ThemeSetting =
  | {
      id: string;
      type: "color";
      label: string;
      hint?: string;
      default: string;
      /** The backgrounds words in this colour go on, so the form can say when they're hard to read. */
      contrastAgainst?: string[];
    }
  | {
      id: string;
      type: "select";
      label: string;
      hint?: string;
      default: string;
      options: { value: string; label: string; hint?: string }[];
    };

export interface Theme {
  readonly id: string;
  readonly dir: string;
  /** What it calls itself, in its theme.json. */
  readonly name: string;
  /** What's wrong with its theme.json, if anything is. */
  readonly problem: string | null;
  /** The choices the theme offers, which make up most of the Design form. */
  readonly settings: ThemeSetting[];
  /** The choices made, checked against what the theme offers, with its defaults for the rest. */
  designValues(chosen: Record<string, string>): Record<string, string>;
  /** The choices that aren't the theme's own, as CSS for the page's head. Empty if none. */
  styleFor(values: Record<string, string>): string;
  /** The theme's words for something, in the site's language. */
  words(key: string, values?: Record<string, string>): string;
  /** Its own words for something in one language, if it has any. */
  ownWords(key: string, locale: string): string | undefined;
  /** Reads its words again when they're next needed. */
  forgetWords(): void;
  /** Forgets everything read from the theme's folder, after a file in it changed. */
  reload(): void;
  render(template: string, context: Record<string, unknown>): Promise<string>;
  /** One partial on its own, for pieces filled in after the page is done. */
  renderPartial(name: string, context: Record<string, unknown>): Promise<string>;
  assetHash(file: string): string;
  assetUrl(file: string): string;
  readonly assetsDir: string;
}

const COLOR = /^#[0-9a-f]{6}$/i;
const LONGEST_NAME = 60;

interface ThemeFile {
  name: string;
  problem: string | null;
  settings: ThemeSetting[];
}

/** Reads theme.json. A theme without a name of its own goes by its folder's. */
function readThemeFile(dir: string, id: string, version: string | undefined): ThemeFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, "theme.json"), "utf8"));
  } catch (error) {
    return { name: id, problem: `theme.json: ${(error as Error).message}`, settings: [] };
  }
  const { name, settings, tend } = (parsed ?? {}) as Record<string, unknown>;
  const called = typeof name === "string" ? name.trim().slice(0, LONGEST_NAME) : "";
  return {
    name: called || id,
    problem: madeFor(tend, version),
    settings: readSettings(settings),
  };
}

/** Colours in six digits, from one or a list of them. */
function colors(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((color) =>
    typeof color === "string" && COLOR.test(color) ? [color.toLowerCase()] : [],
  );
}

/** The settings in theme.json, keeping only what Tend knows how to show. */
function readSettings(list: unknown): ThemeSetting[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): ThemeSetting[] => {
    if (typeof item !== "object" || item === null) return [];
    const {
      type,
      label,
      hint,
      default: fallback,
      options,
      contrastAgainst,
    } = item as Record<string, unknown>;
    const { id = (item as Record<string, unknown>).key } = item as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(id) || typeof label !== "string")
      return [];
    const hintText = typeof hint === "string" ? { hint } : {};
    if (type === "color" && typeof fallback === "string" && COLOR.test(fallback)) {
      const backgrounds = colors(contrastAgainst);
      return [
        {
          id,
          type,
          label,
          ...hintText,
          default: fallback.toLowerCase(),
          ...(backgrounds.length > 0 ? { contrastAgainst: backgrounds } : {}),
        },
      ];
    }
    if (type === "select" && Array.isArray(options) && typeof fallback === "string") {
      const choices = options.flatMap((option) => {
        // A word on its own is what's stored and what's shown.
        if (typeof option === "string") return [{ value: option, label: option }];
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

const DATE_STYLES = ["short", "medium", "long", "full"] as const;
const GLOBALS = ["site", "design", "menus", "request", "tend"];
/** How long a theme of someone's own gets to draw something... */
const RENDER_LIMIT_MS = 500;
/** ...and once more, in case it was the computer that was busy. */
const SECOND_TRY_MS = 2000;
/** There's nothing to draw a page with instead of the theme Tend comes with, so it isn't rushed. */
const BUNDLED_LIMIT_MS = 10_000;
const TOO_SLOW = /template render limit exceeded/;
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
 * Media unless given `alt: "..."`, or `decorative: true` beside words that say it all. `sizes: "..."`
 * says how wide it's shown, where a theme's own layout differs from the size it named, and
 * `priority: true` fetches it first (`false` waits until it's nearly on screen). It writes a
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
      imagePlaceholder({
        id: picture.id,
        size,
        alt,
        decorative: options.decorative === true,
        sizes: typeof options.sizes === "string" ? options.sizes : null,
        priority: typeof options.priority === "boolean" ? options.priority : null,
      }),
    );
  }
}

/** {% menu "main" %}: one of the site's menus, drawn with the theme's menu partial. */
class MenuTag extends Tag {
  readonly #templates: Template[];

  constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
    super(token, remainTokens, liquid);
    const name = this.tokenizer.readValue()?.getText() ?? "";
    if (!/^["'](main|footer)["']$/.test(name)) {
      throw new Error('{% menu %} needs a menu, {% menu "main" %} or {% menu "footer" %}');
    }
    this.#templates = liquid.parse(
      `{% render "menu", name: ${name}, items: menus[${name}], request: request %}`,
    );
  }

  *render(context: Context, emitter: Writer): Generator<unknown, void, unknown> {
    // biome-ignore lint/suspicious/noExplicitAny: the engine's own type for it isn't exported
    yield this.liquid.renderer.renderTemplates(this.#templates, context, emitter as any);
  }
}

/** A tag that writes something Tend made for the page, which is safe to write as it is. */
function writes(name: "head" | "body_end") {
  return class extends Tag {
    render(context: Context, emitter: Writer): void {
      const { tend } = context.globals as { tend?: Record<string, unknown> };
      emitter.write(tend?.[name] ?? "");
    }
  };
}

/** A language's own words, then the same language elsewhere, then English. */
function localeChain(locale: string): string[] {
  const base = locale.split("-")[0] ?? locale;
  return [...new Set([locale, base, "en"])];
}

/** What a choice is called in CSS: fonts is --tend-fonts. */
function customProperty(id: string): string {
  return `--tend-${id.replaceAll("_", "-")}`;
}

/** Only what can't end the rule it's written in. */
const CSS_VALUE = /^[\w #%.,-]{1,100}$/;

/** A theme's templates, run with the plan's limits (§10). Themes can't run server code. */
export function createTheme(options: ThemeOptions): Theme {
  const { id, dir, fallback, version } = options;
  const assetsDir = join(dir, "assets");
  const hashes = new Map<string, string>();
  const locales = new Map<string, Record<string, string>>();
  let file = readThemeFile(dir, id, version);

  function designValues(chosen: Record<string, string>): Record<string, string> {
    const values: Record<string, string> = {};
    for (const setting of file.settings) {
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

  function assetUrl(file: string): string {
    if (fallback && !existsSync(join(assetsDir, file))) return fallback.assetUrl(file);
    return `/assets/${id}/${assetHash(file)}/${file}`;
  }

  /** The theme's words in one language, from locales/<language>.json. Empty if it has none. */
  function wordsIn(locale: string): Record<string, string> {
    const known = locales.get(locale);
    if (known) return known;
    let found: Record<string, string> = {};
    const path = join(dir, "locales", `${locale}.json`);
    if (/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(locale) && existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      found = Object.fromEntries(
        Object.entries((parsed ?? {}) as object).filter(([, words]) => typeof words === "string"),
      );
    }
    locales.set(locale, found);
    return found;
  }

  function ownWords(key: string, locale: string): string | undefined {
    const words = wordsIn(locale);
    return Object.hasOwn(words, key) ? words[key] : undefined;
  }

  function words(key: string, values: Record<string, string> = {}): string {
    let found: string | undefined;
    for (const locale of localeChain(options.locale())) {
      found = ownWords(key, locale) ?? fallback?.ownWords(key, locale);
      if (found !== undefined) break;
    }
    // A key nobody has words for shows as itself, which says what's missing.
    return (found ?? key).replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
  }

  // Its own files first, then the ones of the theme Tend comes with. So a theme can change
  // only what it wants to, and one made today has what later versions of Tend add.
  const within = (folder: string) =>
    [dir, ...(fallback ? [fallback.dir] : [])].map((each) => join(each, folder));

  const engine = new Liquid({
    root: within("templates"),
    partials: within("partials"),
    layouts: within("templates"),
    extname: ".liquid",
    cache: options.cache,
    relativeReference: false,
    outputEscape: "escape",
    ownPropertyOnly: true,
    strictFilters: true,
    parseLimit: PARSE_LIMIT_BYTES,
    memoryLimit: MEMORY_LIMIT_BYTES,
  });

  engine.registerFilter("asset_url", assetUrl);
  engine.registerTag("image", ImageTag);
  engine.registerTag("menu", MenuTag);
  engine.registerTag("seo", writes("head"));
  engine.registerTag("body_end", writes("body_end"));
  engine.registerFilter("img_url", (value: unknown, width: unknown) => {
    const picture = pictureOf(value);
    return picture ? imageUrl(picture.id, Number(width) || 960) : "";
  });
  engine.registerFilter("srcset", (value: unknown) => {
    const picture = pictureOf(value);
    return picture ? imageSrcset(picture.id) : "";
  });
  // {{ "call" | t: phone: business.phone }}: each named value arrives as a pair.
  engine.registerFilter("t", (key: unknown, ...values: unknown[]) =>
    words(
      String(key),
      Object.fromEntries(
        values.flatMap((pair) => (Array.isArray(pair) ? [[pair[0], String(pair[1] ?? "")]] : [])),
      ),
    ),
  );
  engine.registerFilter("iso_date", (value: number | null) =>
    value === null || value === undefined ? "" : new Date(value).toISOString(),
  );
  engine.registerFilter("date", (value: number | null, style: unknown = "medium") => {
    if (value === null || value === undefined) return "";
    return new Intl.DateTimeFormat(options.locale(), {
      dateStyle: DATE_STYLES.find((known) => known === style) ?? "medium",
      timeZone: options.timezone(),
    }).format(value);
  });

  /** What has been too slow even the second time, which it isn't given again until it isn't. */
  const tooSlow = new Set<string>();

  /**
   * Draws something within the time it has. The limit is on the clock, which goes on while
   * the computer does something else, like preparing a photo on its only processor. Stopped
   * for that, a page would be drawn with another theme, and kept like it until the next change.
   */
  async function inTime(
    what: string,
    draw: (renderLimit: number) => Promise<string>,
  ): Promise<string> {
    if (!fallback) return draw(BUNDLED_LIMIT_MS);
    const isTooSlow = (error: unknown) => TOO_SLOW.test((error as Error).message);
    try {
      const html = await draw(RENDER_LIMIT_MS);
      tooSlow.delete(what);
      return html;
    } catch (error) {
      if (!isTooSlow(error) || tooSlow.has(what)) throw error;
    }
    try {
      return await draw(SECOND_TRY_MS);
    } catch (error) {
      if (isTooSlow(error)) tooSlow.add(what);
      throw error;
    }
  }

  /** On a local site, edits show on refresh, so each page starts from the files as they are. */
  function startAfresh(): void {
    if (options.cache) return;
    locales.clear();
    fallback?.forgetWords();
  }

  /** What every partial can use without being handed it. */
  function globalsOf(context: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(GLOBALS.map((name) => [name, context[name]]));
  }

  return {
    id,
    dir,
    get name() {
      return file.name;
    },
    get problem() {
      return file.problem;
    },
    get settings() {
      return file.settings;
    },
    designValues,
    styleFor(values) {
      return file.settings
        .filter(({ id: setting, default: own }) => {
          const value = values[setting];
          return value !== undefined && value !== own && CSS_VALUE.test(value);
        })
        .map(({ id: setting }) => `${customProperty(setting)}: ${values[setting]};`)
        .join(" ");
    },
    words,
    ownWords,
    forgetWords: () => locales.clear(),
    reload() {
      hashes.clear();
      locales.clear();
      tooSlow.clear();
      file = readThemeFile(dir, id, version);
      (engine.options.cache as { clear?: () => void } | undefined)?.clear?.();
    },
    assetsDir,
    assetHash,
    assetUrl,
    render: (template, context) => {
      startAfresh();
      const globals = globalsOf(context);
      return inTime(`templates/${template}`, (renderLimit) =>
        engine.renderFile(template, context, { globals, renderLimit }),
      );
    },
    // A rendered partial sees only what it's handed, so everything given is passed along.
    renderPartial: (name, context) => {
      const passed = Object.keys(context)
        .filter((key) => /^[a-z_][a-z0-9_]*$/.test(key))
        .map((key) => `, ${key}: ${key}`)
        .join("");
      const partial = name.replace(/[^a-z0-9-]/g, "");
      const globals = globalsOf(context);
      return inTime(`partials/${partial}`, (renderLimit) =>
        engine.parseAndRender(`{% render "${partial}"${passed} %}`, context, {
          globals,
          renderLimit,
        }),
      );
    },
  };
}
