// The recovery kit (PLAN.md J7): eight codes, each good once, for getting back in without
// email or a terminal. Tend keeps only a hash of each, so the codes are shown once, on the
// screen after they're made, and then forgotten here too.

export interface FreshKit {
  codes: string[];
  /** Where Continue goes once it's saved. */
  next: string;
}

// In memory only, never stored in the browser. Reloading the page loses them, and a new
// kit can be made from Account.
let fresh: FreshKit | null = null;

export function holdFreshKit(codes: string[], next = "/"): void {
  fresh = { codes, next };
}

export function freshKit(): FreshKit | null {
  return fresh;
}

export function forgetFreshKit(): void {
  fresh = null;
}

/** The kit as a text file: where to go, what to type, and the codes. */
export function kitText(input: {
  site: string;
  email: string;
  codes: string[];
  madeOn: string;
  origin: string;
}): string {
  return [
    `Recovery kit for ${input.site}`,
    `Account: ${input.email}`,
    `Made on ${input.madeOn}`,
    "",
    "If you can't sign in, open this address:",
    `${input.origin}/admin/recover`,
    "Type your email and one of these codes, then choose a new password.",
    "Each code works once.",
    "",
    ...input.codes,
    "",
    "Keep this somewhere safe, like a password manager or a printed copy at home.",
    "Making a new kit, in Account, stops these codes from working.",
    "",
  ].join("\n");
}

/** Offers the text as a file to save. */
export function downloadKit(text: string, site: string): void {
  const name = site
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name || "tend"}-recovery-kit.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  // Long enough for the browser to start saving it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
