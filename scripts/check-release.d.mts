/** What the changelog says about a version, or undefined if it doesn't mention it. */
export function changesIn(changelog: string, version: string): string | undefined;

/** Everything that's wrong with releasing this tag from this folder, and its notes. */
export function checkRelease(root: string, tag: string): { problems: string[]; notes: string };
