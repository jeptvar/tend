import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { encodeCrockford, normalizeCrockford } from "./crockford.ts";

const CODE_LENGTH = 8;

export interface SetupCodeSource {
  secretKey: Buffer;
  /** The password chosen in the hosting template (TEND_SETUP_CODE), which replaces the code. */
  setupPassword: string | undefined;
}

/**
 * The setup code is derived from secret.key instead of being stored. It stays the
 * same across restarts, so a tab left open keeps working, and `tendcms setup-code`
 * can show it again without touching the database.
 */
function deriveSetupCode(secretKey: Buffer): string {
  const digest = createHmac("sha256", secretKey).update("tend:setup-code").digest();
  return encodeCrockford(digest, CODE_LENGTH);
}

/** The code as people see it: XXXX-XXXX. */
export function displaySetupCode(secretKey: Buffer): string {
  const code = deriveSetupCode(secretKey);
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function setupCodeMatches(input: string, source: SetupCodeSource): boolean {
  if (source.setupPassword !== undefined) return constantTimeEqual(input, source.setupPassword);
  return constantTimeEqual(normalizeCrockford(input), deriveSetupCode(source.secretKey));
}
