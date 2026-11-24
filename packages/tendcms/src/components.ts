import { PlainError } from "./plain-error.ts";

// The parts of Tend that are machine code, so there's one for each kind of computer. Each is
// loaded on its own before anything else needs it. Otherwise one that can't load here ends
// every command, even --version, with a stack trace before Tend has said a word.

export interface Component {
  /** What it's for, as messages call it. */
  name: string;
  load: () => Promise<unknown>;
}

export const COMPONENTS: Component[] = [
  {
    name: "database",
    load: async () => {
      const { default: Database } = await import("better-sqlite3");
      // Its machine code is only loaded for the first database that's opened.
      new Database(":memory:").close();
    },
  },
  { name: "picture", load: () => import("sharp") },
  { name: "password", load: () => import("@node-rs/argon2") },
];

// Where the packages' own errors turn to advice. Theirs is for whoever installed them one by
// one: deleting a lockfile, or adding packages by hand.
const THEIR_ADVICE = /\n\s*Possible solutions:|\n\s*Require stack:|\. npm has a bug/;

/** Says which component couldn't load, why, and what to do about it. */
export function componentError({ name }: Pick<Component, "name">, error: unknown): PlainError {
  const message = error instanceof Error ? error.message : String(error);
  const [why = ""] = message.split(THEIR_ADVICE);
  const reason = (why.trim() || message).replace(/\s*\n\s*/g, ": ");
  // Prebuilt sharp needs a processor from about 2009 on, and the one a virtual machine says
  // it has can be older than the real one.
  const fix = /v2 microarchitecture/.test(message)
    ? "This computer's processor is too old for it. If it's a virtual machine, choose a newer type of processor for it, such as host."
    : "Install Tend again, or use the Docker version: https://tendcms.dev/errors/component";
  return new PlainError(
    `Tend's ${name} component couldn't load on this computer (${reason}). ${fix}`,
  );
}

/** Loads them all, or says which one couldn't be. */
export async function loadComponents(): Promise<void> {
  for (const component of COMPONENTS) {
    try {
      await component.load();
    } catch (error) {
      throw componentError(component, error);
    }
  }
}
