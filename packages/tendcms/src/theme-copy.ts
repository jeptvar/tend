import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ConfigError } from "./config.ts";
import { findTheme, isThemeId, themesIn } from "./site/themes.ts";

export interface ThemeCopy {
  /** What the theme that was copied calls itself. */
  from: string;
  dir: string;
}

/** my-theme, as people would write it: My theme. */
function nameOf(id: string): string {
  const words = id.replaceAll("-", " ");
  return `${words[0]?.toUpperCase()}${words.slice(1)}`;
}

/**
 * Copies a theme, so it can be changed without the next update of Tend putting it back
 * (PLAN.md §10). It goes in the first of the folders. Never over something that's there.
 */
export function copyTheme(options: {
  from: string | undefined;
  to: string | undefined;
  bundledDir: string;
  folders: string[];
}): ThemeCopy {
  const { from, to, bundledDir, folders } = options;
  const bundled = basename(bundledDir);
  if (!from || !to) {
    throw new ConfigError(
      `Say which theme to copy and what to call the copy, for example: tendcms theme copy ${bundled} my-theme`,
    );
  }
  const source = from === bundled ? bundledDir : findTheme(folders, from);
  if (!source) {
    const names = [bundled, ...folders.flatMap(themesIn)].filter(isThemeId);
    throw new ConfigError(
      `There's no theme called ${from}. You have: ${[...new Set(names)].join(", ")}`,
    );
  }
  if (!isThemeId(to)) {
    throw new ConfigError(
      "A theme's name is made of lowercase letters, digits and dashes, up to 40 of them, like my-theme.",
    );
  }
  if (to === bundled || findTheme(folders, to)) {
    throw new ConfigError(`There's already a theme called ${to}. Choose another name.`);
  }
  const dir = join(folders[0] as string, to);
  if (existsSync(dir)) throw new ConfigError(`There's already something at ${dir}.`);

  // Readable by everyone, unlike the site's data: an image made with these files runs as
  // another user than the one who copied them in.
  const umask = process.umask(0o022);
  try {
    // A starting point is only used at setup, and that's always the bundled theme's.
    cpSync(source, dir, {
      recursive: true,
      filter: (path) => path !== join(source, "starters"),
    });
    const file = join(dir, "theme.json");
    const theme = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const called = typeof theme.name === "string" ? theme.name : from;
    writeFileSync(
      file,
      `${JSON.stringify({ ...theme, name: nameOf(to), version: "1.0.0" }, null, 2)}\n`,
    );
    return { from: called, dir };
  } finally {
    process.umask(umask);
  }
}
