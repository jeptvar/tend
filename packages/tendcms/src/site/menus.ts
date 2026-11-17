import { inArray } from "drizzle-orm";
import { countLivePosts, findLiveLinks, listMenuPages } from "../content/entries.ts";
import { hasSetting, type MenuItem, type MenuSettings, settingValue } from "../content/settings.ts";
import type { Orm } from "../db/client.ts";
import { tags } from "../db/schema.ts";

export type MenuName = "main" | "footer";

/** One link as the theme gets it. */
export interface MenuLink {
  title: string;
  url: string;
  children: MenuLink[];
}

/** A link as the Site menu screen shows it, including ones visitors can't see right now. */
export interface MenuItemInfo {
  /** What it's called on the site: its own words, or what it links to. */
  title: string | null;
  url: string | null;
}

/**
 * Until someone saves a menu of their own, the main menu is every published page, plus the
 * blog once it has posts (as in M1). The footer has nothing until it's set up.
 */
export async function automaticMenu(orm: Orm, name: MenuName): Promise<MenuSettings> {
  if (name === "footer") return { items: [] };
  const pages = await listMenuPages(orm);
  const hasPosts = (await countLivePosts(orm)) > 0;
  return {
    items: [
      ...(hasPosts
        ? [{ id: "blog", label: null, target: { type: "blog" as const }, children: [] }]
        : []),
      ...pages.map((page) => ({
        id: page.id,
        label: null,
        target: { type: "entry" as const, id: page.id },
        children: [],
      })),
    ],
  };
}

export async function menuSetting(
  orm: Orm,
  name: MenuName,
): Promise<{ menu: MenuSettings; automatic: boolean }> {
  const key = name === "main" ? "menu:main" : "menu:footer";
  if (!(await hasSetting(orm, key)))
    return { menu: await automaticMenu(orm, name), automatic: true };
  return { menu: await settingValue(orm, key), automatic: false };
}

function allItems(menu: MenuSettings): MenuItem[] {
  return menu.items.flatMap((item) => [item, ...(item.children as MenuItem[])]);
}

/**
 * Where each link in some menus goes now, looked up together. Something unpublished or
 * gone has no address, so it's left out for visitors and marked on the Site menu screen.
 */
export async function describeMenuItems(
  orm: Orm,
  menus: MenuSettings[],
): Promise<Map<string, MenuItemInfo>> {
  const items = menus.flatMap(allItems);
  const entryIds = items.flatMap((item) => (item.target.type === "entry" ? [item.target.id] : []));
  const tagIds = items.flatMap((item) => (item.target.type === "tag" ? [item.target.id] : []));
  const entries = await findLiveLinks(orm, entryIds);
  const tagRows =
    tagIds.length === 0
      ? []
      : orm
          .select()
          .from(tags)
          .where(inArray(tags.id, [...new Set(tagIds)]))
          .all();
  const tagById = new Map(tagRows.map((tag) => [tag.id, tag]));
  const info = new Map<string, MenuItemInfo>();
  for (const item of items) {
    const { target } = item;
    let found: MenuItemInfo;
    if (target.type === "entry") {
      const entry = entries.get(target.id);
      found = { title: entry?.title ?? null, url: entry?.path ?? null };
    } else if (target.type === "tag") {
      const tag = tagById.get(target.id);
      found = { title: tag?.name ?? null, url: tag ? `/tag/${tag.slug}` : null };
    } else if (target.type === "blog") {
      found = { title: "Blog", url: "/blog" };
    } else if (target.type === "home") {
      found = { title: "Home", url: "/" };
    } else {
      found = { title: null, url: target.url };
    }
    info.set(item.id, found);
  }
  return info;
}

/** The menus as visitors see them: only links that go somewhere, with their words. */
export async function siteMenus(orm: Orm): Promise<Record<MenuName, MenuLink[]>> {
  const main = (await menuSetting(orm, "main")).menu;
  const footer = (await menuSetting(orm, "footer")).menu;
  const info = await describeMenuItems(orm, [main, footer]);
  const link = (item: MenuItem): MenuLink | undefined => {
    const found = info.get(item.id);
    const title =
      item.label ?? found?.title ?? (item.target.type === "url" ? item.target.url : null);
    if (!found?.url || !title) return undefined;
    return { title, url: found.url, children: [] };
  };
  const build = (menu: MenuSettings): MenuLink[] =>
    menu.items.flatMap((item) => {
      const top = link(item);
      const children = (item.children as MenuItem[]).flatMap((child) => link(child) ?? []);
      // A link whose page isn't on the site leaves the ones under it in its place, rather
      // than taking pages that are on the site out of the menu with it.
      if (!top) return children;
      top.children = children;
      return [top];
    });
  return { main: build(main), footer: build(footer) };
}

/** Whether a menu already has a link to this page or post. */
export function menuLinksTo(menu: MenuSettings, entryId: string): boolean {
  return allItems(menu).some((item) => item.target.type === "entry" && item.target.id === entryId);
}
