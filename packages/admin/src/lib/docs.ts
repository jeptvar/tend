/** A page of Tend's guide. docs/ in the repository holds one Markdown file for each. */
export function guide(page: string): string {
  return `https://tendcms.dev/docs/${page}`;
}

/** Puts a new Tend on Railway, with a volume and a setup password. */
export const RAILWAY_URL = "https://tendcms.dev/railway";

/** Where problems are reported. */
export const ISSUES_URL = "https://github.com/tendcms/tend/issues/new/choose";
