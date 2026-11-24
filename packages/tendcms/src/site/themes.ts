import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { createTheme, type Theme, type ThemeSetting } from "./theme.ts";

// The themes a site can use (PLAN.md §10): the one Tend comes with, and any in the folders
// themes of people's own go in. Folders are looked at afresh each time they're asked about, so
// a theme shows as soon as it's there.

export interface ThemesOptions {
  /** The theme Tend comes with, which every site has. */
  bundledDir: string;
  /** Where themes of people's own are, the first of a name counting. */
  folders: string[];
  /** Off for local sites, so edits to a template show on refresh. */
  cache: boolean;
  timezone: () => string;
  locale: () => string;
}

/** A theme as the Design screen offers it. */
export interface ThemeChoice {
  /** Null for the one Tend comes with. */
  id: string | null;
  name: string;
  settings: ThemeSetting[];
  /** What's wrong with it, if anything is. */
  problem: string | null;
  /** Whether it can be chosen at all. */
  usable: boolean;
}

export interface Themes {
  /** The theme Tend comes with. */
  readonly bundled: Theme;
  /** The theme that was chosen, or the one Tend comes with if that's gone. */
  chosen(id: string | null): Theme;
  /** Whether a theme chosen by this name can be used. */
  has(id: string | null): boolean;
  /** The theme whose files are at /assets/<id>/. */
  at(id: string): Theme | undefined;
  list(): ThemeChoice[];
  /**
   * Notes how drawing something with a theme went, for the Design screen. True if it's a
   * mistake that wasn't there before.
   */
  drew(theme: Theme, what: string, mistake: string | null): boolean;
  /** Forgets a theme's mistakes, once its files have changed. */
  forget(theme: Theme): void;
}

const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LONGEST_ID = 40;

/** Whether a folder's name can be a theme's, as part of its files' addresses. */
export function isThemeId(name: string): boolean {
  return name.length <= LONGEST_ID && THEME_ID.test(name);
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The folders in here that look like themes, by name. */
export function themesIn(folder: string): string[] {
  let names: string[];
  try {
    names = readdirSync(folder).sort();
  } catch {
    return [];
  }
  return names.filter(
    (name) => isFolder(join(folder, name)) && existsSync(join(folder, name, "theme.json")),
  );
}

/** Where a theme of someone's own is, if there's one by this name. */
export function findTheme(folders: string[], id: string): string | undefined {
  if (!isThemeId(id)) return undefined;
  return folders
    .map((folder) => join(folder, id))
    .find((dir) => existsSync(join(dir, "theme.json")));
}

/** What a template engine's error says, with files named from inside the theme. */
export function mistakeIn(theme: Theme, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(`${theme.dir}${sep}`, "").replace(/\s+/g, " ").trim().slice(0, 500);
}

export function createThemes(options: ThemesOptions): Themes {
  const { bundledDir, folders, cache, timezone, locale } = options;
  const bundled = createTheme({
    id: basename(bundledDir),
    dir: bundledDir,
    cache,
    timezone,
    locale,
  });
  const made = new Map<string, Theme>();
  /** By theme, then by what was being drawn. */
  const mistakes = new Map<Theme, Map<string, string>>();

  function own(id: string): Theme | undefined {
    // Tend's own name stays its own, so an update to it is never hidden by an old copy.
    if (id === bundled.id) return undefined;
    const dir = findTheme(folders, id);
    if (!dir) return undefined;
    let theme = made.get(dir);
    if (!theme) {
      theme = createTheme({ id, dir, fallback: bundled, cache, timezone, locale });
      made.set(dir, theme);
    }
    return theme;
  }

  function choice(theme: Theme): ThemeChoice {
    return {
      id: theme === bundled ? null : theme.id,
      name: theme.name,
      settings: theme.settings,
      problem: theme.problem ?? mistakes.get(theme)?.values().next().value ?? null,
      usable: true,
    };
  }

  function list(): ThemeChoice[] {
    const choices = [choice(bundled)];
    const seen = new Set<string>();
    for (const folder of folders) {
      for (const name of themesIn(folder)) {
        // Run from Tend's own source, the theme it comes with is in one of them.
        if (seen.has(name) || join(folder, name) === bundledDir) continue;
        seen.add(name);
        const theme = own(name);
        if (theme) {
          // Local sites read templates afresh, so theirs is too.
          if (!cache) theme.reload();
          choices.push(choice(theme));
          continue;
        }
        const problem =
          name === bundled.id
            ? `${bundled.name} is the theme Tend comes with, so a theme of your own needs another name.`
            : "A theme's folder is named with lowercase letters, digits and dashes, like my-theme.";
        choices.push({ id: name, name, settings: [], problem, usable: false });
      }
    }
    return choices;
  }

  return {
    bundled,
    chosen: (id) => (id === null ? bundled : (own(id) ?? bundled)),
    has: (id) => id === null || own(id) !== undefined,
    at: (id) => (id === bundled.id ? bundled : own(id)),
    list,
    drew(theme, what, mistake) {
      const known = mistakes.get(theme);
      if (mistake === null) {
        known?.delete(what);
        return false;
      }
      const isNew = known?.get(what) !== mistake;
      if (known) known.set(what, mistake);
      else mistakes.set(theme, new Map([[what, mistake]]));
      return isNew;
    },
    forget: (theme) => mistakes.delete(theme),
  };
}
