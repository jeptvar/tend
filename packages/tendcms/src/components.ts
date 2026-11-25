import { PlainError } from "./plain-error.ts";

// The parts of Tend that are machine code, so there's one for each kind of computer. Each is
// loaded on its own before anything else needs it. Otherwise one that can't load here ends
// every command, even --version, with a stack trace before Tend has said a word.

export interface Component {
  /** What it's for, as messages call it. */
  name: string;
  /** How the site is without it. Tend doesn't start without one that has none. */
  without?: string;
  load: () => Promise<unknown>;
}

/** Only needed to add pictures, so the site goes on without it (media/process.ts). */
export const PICTURES: Component = {
  name: "picture",
  without: "Your site works and shows the pictures it has, but none can be added.",
  load: () => import("sharp"),
};

export const COMPONENTS: Component[] = [
  {
    name: "database",
    load: async () => {
      const { default: Database } = await import("better-sqlite3");
      // Its machine code is only loaded for the first database that's opened.
      new Database(":memory:").close();
    },
  },
  PICTURES,
  { name: "password", load: () => import("@node-rs/argon2") },
];

// Where the packages' own errors turn to advice. Theirs is for whoever installed them one by
// one: deleting a lockfile, or adding packages by hand.
const THEIR_ADVICE = /\n\s*Possible solutions:|\n\s*Require stack:|\. npm has a bug/;

/** Says which component couldn't load, why, and what to do about it. */
export function componentError(
  { name, without }: Pick<Component, "name" | "without">,
  error: unknown,
): PlainError {
  const message = error instanceof Error ? error.message : String(error);
  const [why = ""] = message.split(THEIR_ADVICE);
  const reason = (why.trim() || message).replace(/\s*\n\s*/g, ": ");
  // Prebuilt sharp needs a processor from about 2009 on, and the one a virtual machine says
  // it has can be older than the real one.
  const fix = /v2 microarchitecture/.test(message)
    ? "This computer's processor is too old for it. If it's a virtual machine, choose a newer type of processor for it, such as host."
    : "Install Tend again, or use the Docker version: https://tendcms.dev/errors/component";
  const what = `Tend's ${name} component couldn't load on this computer (${reason}).`;
  return new PlainError([what, without, fix].filter(Boolean).join(" "));
}

/** Loads the ones Tend can't start without, or says which couldn't be. */
export async function loadComponents(): Promise<void> {
  for (const component of COMPONENTS) {
    if (component.without !== undefined) continue;
    try {
      await component.load();
    } catch (error) {
      throw componentError(component, error);
    }
  }
}
