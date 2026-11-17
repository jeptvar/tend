import type { Context } from "hono";
import { z } from "zod";
import { isLivePath } from "../../content/entries.ts";
import {
  addManualRedirect,
  cleanFrom,
  cleanTo,
  isTendsOwnAddress,
  listRedirects,
  removeRedirect,
} from "../../content/redirects.ts";
import {
  businessSchema,
  codeSchema,
  DEFAULTS,
  designSchema,
  generalSchema,
  menuSchema,
  readSetting,
  type SettingKey,
  type SettingTypes,
  type StoredSetting,
  seoSchema,
  undoSetting,
  visibilitySchema,
  writeSetting,
} from "../../content/settings.ts";
import { countLivePostsWithTag, createTag, findTag, listTags } from "../../content/tags.ts";
import { getSetting, type SiteSettings } from "../../db/repo/settings.ts";
import { describeMenuItems, type MenuName, menuSetting } from "../../site/menus.ts";
import type { ThemeSetting } from "../../site/theme.ts";
import { ApiError } from "../errors.ts";
import { type AdminOptions, parseBody, type Routing, readJson } from "./routing.ts";

export interface SiteRouteOptions extends AdminOptions {
  /** TEND_PUBLIC_URL, when it's known, so a redirect to the site's own address stays a path. */
  publicUrl?: string | undefined;
  /** The theme's design choices, for the Design form. */
  themeSettings?: () => ThemeSetting[];
  /** Checks the theme's choices, keeping only ones it offers. */
  designValues?: (chosen: Record<string, string>) => Record<string, string>;
  /** The homepage as it would look with a design that isn't saved yet. */
  previewDesign?: (design: SettingTypes["design"]) => Promise<string>;
}

/** The settings behind Settings: each is checked by its own schema. */
const SETTINGS = {
  general: generalSchema,
  business: businessSchema,
  visibility: visibilitySchema,
  seo: seoSchema,
  code: codeSchema,
} as const;
type SettingsName = keyof typeof SETTINGS;
const STORED_AS: Record<SettingsName, SettingKey> = {
  general: "site",
  business: "business",
  visibility: "visibility",
  seo: "seo",
  code: "code_injection",
};

const tagSchema = z.object({
  name: z.string().max(60, "Use 60 characters or fewer for a tag."),
});

/** Names the change being taken back, as the save that made it reported. */
const undoSchema = z.object({
  undoId: z.string().max(64, "Tend couldn't tell which change to undo."),
});

const redirectSchema = z.object({
  from: z.string().max(2048, "That address is too long: use only the page's own address."),
  to: z.string().max(2048, "That address is too long: use a shorter one."),
});

/** The address the admin is open at, as the browser names it: scheme, host and port. */
const addressSchema = z.object({
  address: z.string().max(2048, "That address is too long."),
});

function unknownSetting(): ApiError {
  return new ApiError(404, "not_found", "There's no setting by that name.");
}

function settingsName(c: Context): SettingsName {
  const name = c.req.param("key") ?? "";
  if (!(name in SETTINGS)) throw unknownSetting();
  return name as SettingsName;
}

function menuName(c: Context): MenuName {
  const name = c.req.param("name");
  if (name !== "main" && name !== "footer") {
    throw new ApiError(404, "not_found", "There's no menu by that name.");
  }
  return name;
}

/** The routes behind Site menu, Design and Settings, plus tags. */
export function registerSiteRoutes(routing: Routing, options: SiteRouteOptions): void {
  const { orm } = options;
  const { now, route } = routing;

  // Tags

  route("get", "/tags", "tag:list", async (c) => c.json({ tags: await listTags(orm) }));

  route("post", "/tags", "tag:create", async (c) => {
    const { name } = parseBody(tagSchema, await readJson(c));
    return c.json(await createTag(orm, { name, now: now() }), 201);
  });

  // Settings

  /** Which version this is, and the change Undo would take back, if any. */
  function versionJson(stored: StoredSetting<unknown> | undefined) {
    return {
      updatedAt: stored?.updatedAt ?? null,
      undoId: stored?.undoId ?? null,
      canUndo: stored?.canUndo ?? false,
    };
  }

  async function settingJson(name: SettingsName) {
    const key = STORED_AS[name];
    const stored = await readSetting(orm, key);
    if (name === "general") {
      const site = (stored?.value ?? (await getSetting(orm, "site"))) as SiteSettings;
      return {
        value: {
          name: site.name,
          tagline: site.tagline,
          locale: site.locale,
          timezone: site.timezone,
        },
        ...versionJson(stored),
      };
    }
    const fallback = DEFAULTS[key as Exclude<SettingKey, "site">];
    return {
      value: { ...fallback, ...(stored?.value as object) },
      ...versionJson(stored),
    };
  }

  route("get", "/settings/:key", "settings:manage", async (c) =>
    c.json(await settingJson(settingsName(c))),
  );

  route("put", "/settings/:key", "settings:manage", async (c, user) => {
    const name = settingsName(c);
    const value = parseBody(SETTINGS[name] as z.ZodType<unknown>, await readJson(c));
    const key = STORED_AS[name];
    // The site's address lives alongside its name, and isn't changed from here.
    const stored =
      name === "general"
        ? { ...((await getSetting(orm, "site")) as SiteSettings), ...(value as object) }
        : value;
    const { saved } = await writeSetting(orm, {
      key,
      value: stored as never,
      userId: user.id,
      now: now(),
    });
    if (saved) options.onSiteChanged();
    return c.json({ ...(await settingJson(name)), saved });
  });

  // The site's address (PLAN.md J10). Until it's known, links follow the address each page
  // was asked for. Overview asks whether the one the admin is open at is the site's, and
  // only that one can be confirmed: the browser names it in Origin, which reached Tend
  // through Host, so it's an address that leads here.
  route("post", "/address", "settings:manage", async (c, user) => {
    const { address } = parseBody(addressSchema, await readJson(c));
    if (options.publicUrl) {
      throw new ApiError(409, "address_set", "This site's address is already set.", {
        fix: `It's ${options.publicUrl}, set where Tend runs.`,
      });
    }
    const origin = c.req.header("origin");
    const host = c.req.header("host");
    let opened: URL | undefined;
    try {
      opened = origin ? new URL(origin) : undefined;
    } catch {
      opened = undefined;
    }
    if (
      !opened ||
      opened.origin !== address ||
      opened.host !== host ||
      !["http:", "https:"].includes(opened.protocol)
    ) {
      throw new ApiError(400, "address_mismatch", "That isn't the address this page is open at.", {
        fix: "Open Overview at your site's address, then try again. If Tend is behind a proxy, set TEND_PUBLIC_URL instead.",
      });
    }
    const site = (await getSetting(orm, "site")) as SiteSettings;
    await writeSetting(orm, {
      key: "site",
      value: { ...site, address: opened.origin, address_confirmed: true },
      userId: user.id,
      now: now(),
    });
    options.onSiteChanged();
    return c.json({ address: opened.origin });
  });

  route("post", "/settings/:key/undo", "settings:manage", async (c, user) => {
    const name = settingsName(c);
    const { undoId } = parseBody(undoSchema, await readJson(c));
    await undoSetting(orm, { key: STORED_AS[name], undoId, userId: user.id, now: now() });
    options.onSiteChanged();
    return c.json(await settingJson(name));
  });

  // Site menu

  async function menusJson() {
    const main = await menuSetting(orm, "main");
    const footer = await menuSetting(orm, "footer");
    const info = await describeMenuItems(orm, [main.menu, footer.menu]);
    const stored = {
      main: await readSetting(orm, "menu:main"),
      footer: await readSetting(orm, "menu:footer"),
    };
    return {
      main: { ...main.menu, automatic: main.automatic, ...versionJson(stored.main) },
      footer: { ...footer.menu, automatic: footer.automatic, ...versionJson(stored.footer) },
      links: Object.fromEntries(info),
    };
  }

  route("get", "/menus", "menu:manage", async (c) => c.json(await menusJson()));

  route("put", "/menus/:name", "menu:manage", async (c, user) => {
    const name = menuName(c);
    const value = parseBody(menuSchema, await readJson(c));
    // Every link has its own name, so moving one can't be mistaken for another.
    const ids = value.items.flatMap((item) => [item.id, ...item.children.map((child) => child.id)]);
    if (new Set(ids).size !== ids.length) {
      throw new ApiError(
        400,
        "needs_fixing",
        "Tend couldn't save the menu: two links got mixed up.",
        {
          fix: "Reload this page, then make the change again.",
        },
      );
    }
    const { saved } = await writeSetting(orm, {
      key: `menu:${name}`,
      value,
      userId: user.id,
      now: now(),
    });
    if (saved) options.onSiteChanged();
    return c.json({ ...(await menusJson()), saved });
  });

  route("post", "/menus/:name/undo", "menu:manage", async (c, user) => {
    const name = menuName(c);
    const { undoId } = parseBody(undoSchema, await readJson(c));
    await undoSetting(orm, { key: `menu:${name}`, undoId, userId: user.id, now: now() });
    options.onSiteChanged();
    return c.json(await menusJson());
  });

  // Design

  async function designJson() {
    const stored = await readSetting(orm, "design");
    const value = { ...DEFAULTS.design, ...(stored?.value ?? {}) };
    return {
      value: { ...value, theme: options.designValues?.(value.theme) ?? value.theme },
      schema: options.themeSettings?.() ?? [],
      ...versionJson(stored),
    };
  }

  function checkedDesign(body: unknown): SettingTypes["design"] {
    const design = parseBody(designSchema, body);
    return { ...design, theme: options.designValues?.(design.theme) ?? {} };
  }

  route("get", "/design", "design:manage", async (c) => c.json(await designJson()));

  route("put", "/design", "design:manage", async (c, user) => {
    const design = checkedDesign(await readJson(c));
    const { saved } = await writeSetting(orm, {
      key: "design",
      value: design,
      userId: user.id,
      now: now(),
    });
    if (saved) options.onSiteChanged();
    return c.json({ ...(await designJson()), saved });
  });

  route("post", "/design/undo", "design:manage", async (c, user) => {
    const { undoId } = parseBody(undoSchema, await readJson(c));
    await undoSetting(orm, { key: "design", undoId, userId: user.id, now: now() });
    options.onSiteChanged();
    return c.json(await designJson());
  });

  route("post", "/design/preview", "design:manage", async (c) => {
    const design = checkedDesign(await readJson(c));
    if (!options.previewDesign) throw new Error("Previews aren't available here.");
    c.header("Cache-Control", "no-store");
    // JSON rather than a page of its own, so this can only be shown in the sandboxed frame.
    return c.json({ html: await options.previewDesign(design) });
  });

  // Redirects

  route("get", "/redirects", "settings:manage", async (c) =>
    c.json({ redirects: await listRedirects(orm) }),
  );

  route("post", "/redirects", "settings:manage", async (c) => {
    const body = parseBody(redirectSchema, await readJson(c));
    const from = cleanFrom(body.from);
    // An address on this site itself is kept as just its path, so it moves with the site.
    const ownHosts = [
      c.req.header("host"),
      new URL(c.req.url).host,
      options.publicUrl && new URL(options.publicUrl).host,
    ]
      .filter((host): host is string => Boolean(host))
      .map((host) => host.toLowerCase());
    const to = cleanTo(body.to, ownHosts);
    if (isTendsOwnAddress(from)) {
      throw new ApiError(
        400,
        "needs_fixing",
        `Tend uses ${from} itself, so nobody would be sent on from it.`,
        {
          field: "from",
          fix: "Use the old page's own address, like /old-page.",
        },
      );
    }
    // A tag with published posts has its page there now, and pages always win over redirects.
    const tagSlug = from.match(/^\/tag\/([^/]+)$/)?.[1];
    const tag = tagSlug ? await findTag(orm, tagSlug) : undefined;
    if (tag && (await countLivePostsWithTag(orm, tag.id)) > 0) {
      throw new ApiError(409, "address_taken", `Your posts tagged ${tag.name} are at ${from}.`, {
        field: "from",
        fix: "Use the old page's own address, like /old-page.",
      });
    }
    if (await isLivePath(orm, from)) {
      throw new ApiError(409, "address_taken", `Something on your site is already at ${from}.`, {
        field: "from",
        fix: "Change that page's address first, and Tend will lead the old one to it by itself.",
      });
    }
    await addManualRedirect(orm, { from, to, now: now() });
    options.onSiteChanged();
    return c.json({ redirects: await listRedirects(orm) }, 201);
  });

  route("delete", "/redirects", "settings:manage", async (c) => {
    const { from } = parseBody(z.object({ from: z.string().max(2048) }), await readJson(c));
    await removeRedirect(orm, from);
    options.onSiteChanged();
    return c.json({ redirects: await listRedirects(orm) });
  });
}
