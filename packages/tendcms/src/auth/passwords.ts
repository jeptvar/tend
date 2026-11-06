import { hash, parseOptions, verify } from "@node-rs/argon2";
import { randomCrockford } from "./crockford.ts";

// Argon2id at the OWASP minimum (PLAN.md §12). Argon2id is this library's default.
const HASH_PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const MIN_PASSWORD_LENGTH = 12;
// Generous, but hashing work shouldn't be unbounded.
export const MAX_PASSWORD_LENGTH = 1024;

// The same accented letter can arrive in two byte forms depending on the device,
// and that mustn't lock anyone out when they switch from a laptop to a phone.
function canonical(password: string): string {
  return password.normalize("NFC");
}

export function hashPassword(password: string): Promise<string> {
  return hash(canonical(password), HASH_PARAMS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, canonical(password));
  } catch {
    return false;
  }
}

/** True when a stored hash uses older settings, so it's replaced at the next sign-in. */
export function needsRehash(stored: string): boolean {
  try {
    const options = parseOptions(stored);
    return (
      options.memoryCost !== HASH_PARAMS.memoryCost ||
      options.timeCost !== HASH_PARAMS.timeCost ||
      options.parallelism !== HASH_PARAMS.parallelism
    );
  } catch {
    return true;
  }
}

let decoyHash: Promise<string> | undefined;

/** Takes as long as a real check, so response times don't reveal which emails have accounts. */
export async function spendVerifyTime(password: string): Promise<void> {
  decoyHash ??= hashPassword(randomCrockford(32));
  await verifyPassword(await decoyHash, password);
}

/** A strong password for `tendcms reset-password` to hand over once: about 80 bits. */
export function generatePassword(): string {
  return randomCrockford(16).replace(/(.{4})(?=.)/g, "$1-");
}

// Only passwords of 12 or more characters can get this far, so this covers the
// common ones that long. Trailing digits and symbols are ignored ("password1234"),
// and so are the usual letter swaps ("p@ssw0rd2024").
const COMMON_WORDS = new Set(
  `password passwords passphrase secret letmein welcome admin administrator login
  qwerty qwertyuiop asdfghjkl zxcvbnm iloveyou iloveu loveyou trustno monkey dragon
  sunshine princess football baseball basketball soccer hockey master shadow superman
  batman michael jordan charlie changeme changeit default computer internet starwars
  whatever freedom liverpool chelsea arsenal manchester samsung google facebook
  instagram microsoft testing testtest iloveyouforever correcthorsebatterystaple
  thequickbrownfox myspace mustang harley ashley jennifer pokemon minecraft
  blink senha contrasena motdepasse passwort`.split(/\s+/),
);

// Runs along the keyboard or the alphabet, in either direction.
const SEQUENCES = [
  "01234567890123456789",
  "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
  "qwertyuiopasdfghjklzxcvbnm",
  "qwertyuiopqwertyuiop",
  "asdfghjklasdfghjkl",
  "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p",
  "1q2w3e4r5t6y7u8i9o0p",
  "q1w2e3r4t5y6u7i8o9p0",
];

const LETTER_SWAPS: Record<string, string> = {
  "0": "o",
  "1": "l",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "!": "i",
};

function isSequence(lower: string): boolean {
  const reversed = [...lower].reverse().join("");
  return SEQUENCES.some((run) => run.includes(lower) || run.includes(reversed));
}

function commonCore(lower: string): string {
  const withoutEnding = lower.replace(/[^\p{L}]+$/u, "");
  return [...withoutEnding].map((character) => LETTER_SWAPS[character] ?? character).join("");
}

function lettersAndDigits(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export interface PasswordContext {
  email: string;
  name: string;
  siteName: string;
}

/** Explains what's wrong with a new password, or returns undefined when it's fine. */
export function passwordProblem(password: string, context: PasswordContext): string | undefined {
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters. A few random words work well.`;
  }
  if (length > MAX_PASSWORD_LENGTH) {
    return `Use ${MAX_PASSWORD_LENGTH} characters or fewer.`;
  }

  const lower = canonical(password).toLowerCase();
  const repeatsAShortPattern = /^(.{1,8})\1+$/su.test(lower);
  if (repeatsAShortPattern || isSequence(lower) || COMMON_WORDS.has(commonCore(lower))) {
    return "That password is too easy to guess. Try a few random words instead.";
  }

  // Your own name or email is the first thing an attacker would try.
  const compact = lettersAndDigits(password);
  const core = compact.replace(/\p{N}+$/u, "");
  const personal = [
    context.email,
    context.email.split("@")[0] ?? "",
    context.name,
    context.siteName,
  ]
    .map(lettersAndDigits)
    .filter((word) => word.length >= 4);
  if (personal.includes(compact) || personal.includes(core)) {
    return "Don't use your name, your email or your site's name as your password. Try a few random words instead.";
  }
  return undefined;
}
