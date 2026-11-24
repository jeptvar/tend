/** A Rolldown plugin, for tsdown, that writes THIRD_PARTY_NOTICES.md beside the bundle. */
export function thirdPartyNotices(): {
  name: string;
  generateBundle(options: unknown, bundle: unknown): void;
};

/** A package's part of the file: its name, and what it is with its licence in full. */
export function noticeFor(root: string): { name: string; text: string };

/** The folder of the package a bundled file came from, or undefined for the project's own. */
export function packageRoot(id: string): string | undefined;
