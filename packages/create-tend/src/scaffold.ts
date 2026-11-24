import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// What `npm create tend@latest my-site` writes (PLAN.md §13). Everything here is plain
// Node, so create-tend has no dependencies of its own.

export const MIN_NODE = 24;

/** Why this Node can't run Tend, or undefined if it can. */
export function nodeProblem(version: string): string | undefined {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  if (Number.isInteger(major) && major >= MIN_NODE) return undefined;
  return `Tend needs Node.js ${MIN_NODE} or newer, and this computer has ${version}.\nInstall the LTS version, then run this again: https://tendcms.dev/install-node`;
}

/** A package name npm accepts, made from the folder's name. */
export function packageName(folder: string): string {
  const name = basename(resolve(folder))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return name.slice(0, 214) || "my-site";
}

/** Why this folder can't hold a new site, or undefined if it can: only a new or empty one. */
export function folderProblem(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const name = basename(dir);
  if (!statSync(dir).isDirectory()) {
    return `There's already a file called ${name} here. Choose another name for your site's folder.`;
  }
  if (readdirSync(dir).length > 0) {
    return `The folder ${name} already has files in it, and Tend won't change them. Choose another name for your site's folder.`;
  }
  return undefined;
}

function siteReadme(name: string): string {
  return `# ${name}

A website made with [Tend CMS](https://tendcms.dev).

## Where can this run?

- **Works:** your computer, Railway, Render, or a server with Docker.
- **Doesn't work:** Vercel, Netlify and other serverless hosts. They don't keep files, so
  everything you added would be lost.

## Start your site

\`\`\`
npm start
\`\`\`

Tend prints a link to your site's admin. Keep the window open: Tend stops when you close it.

## Put it online

See https://tendcms.dev/online

## Back it up

\`npm run backup\` saves everything in one zip file. Keep it private: it holds everyone's
sign-in details. In the admin, Settings → Backups does the same.

## If something's wrong

\`npx tendcms doctor\` checks what Tend needs to run here, and says how to fix what's wrong.
It changes nothing.
`;
}

const THEMES_README = `# Themes

Your site uses Meadow, the theme that comes with Tend. You can choose its colours, fonts and
logo in the admin, under Design.

To make a theme of your own, start from a copy of Meadow, in your site's folder:

\`\`\`
npx tendcms theme copy meadow my-theme
\`\`\`

Choose it in the admin, under Design. Then change its files here, in \`my-theme\`, and reload the
page to see what they do:

- \`theme.json\`: its name, and the choices it adds to the Design screen.
- \`templates\`: one for each kind of page, in Liquid. They share \`layout.liquid\`.
- \`partials\`: the pieces templates share, such as the header and footer.
- \`assets\`: its stylesheet and pictures.

A file you delete from your copy comes from Meadow instead, so keep only what you change. An
update of Tend never changes your theme.
`;

/** The files of a new site, by path. `tendcms` is the exact version it depends on. */
export function projectFiles(input: { name: string; tendcms: string }): Record<string, string> {
  const pkg = {
    name: input.name,
    private: true,
    description: "A website made with Tend CMS",
    scripts: { start: "tendcms start", backup: "tendcms backup" },
    dependencies: { tendcms: input.tendcms },
    engines: { node: `>=${MIN_NODE}` },
  };
  return {
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
    // Only this: no release-age gate is written into people's projects (PLAN.md §12). The
    // tendcms they install pins everything under it.
    ".npmrc": "save-exact=true\n",
    ".gitignore": "data/\nnode_modules/\n.env\n",
    "README.md": siteReadme(input.name),
    "themes/README.md": THEMES_README,
  };
}

/** Writes the files, never over one that's there. */
export function writeProject(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, { flag: "wx" });
  }
}

/** npm's min-release-age, if the person set one, in days: 0 if they didn't. */
export function releaseAgeDays(configured: string): number {
  const days = Number(configured.trim());
  return Number.isFinite(days) && days > 0 ? days : 0;
}
