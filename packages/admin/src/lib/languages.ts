// Languages people write sites in. A site in one that isn't here keeps the one it was set up
// with, which came from its Owner's browser.
const TAGS = [
  "af",
  "ar",
  "bg",
  "bn",
  "ca",
  "cs",
  "cy",
  "da",
  "de",
  "de-AT",
  "de-CH",
  "el",
  "en",
  "en-AU",
  "en-CA",
  "en-GB",
  "en-IE",
  "en-IN",
  "en-NZ",
  "en-PH",
  "en-SG",
  "en-US",
  "en-ZA",
  "es",
  "es-AR",
  "es-CL",
  "es-CO",
  "es-ES",
  "es-MX",
  "es-US",
  "et",
  "eu",
  "fa",
  "fi",
  "fil",
  "fr",
  "fr-BE",
  "fr-CA",
  "fr-CH",
  "ga",
  "gl",
  "gu",
  "he",
  "hi",
  "hr",
  "hu",
  "hy",
  "id",
  "is",
  "it",
  "it-CH",
  "ja",
  "ka",
  "kk",
  "kn",
  "ko",
  "lt",
  "lv",
  "mk",
  "ml",
  "mr",
  "ms",
  "nb",
  "ne",
  "nl",
  "nl-BE",
  "nn",
  "pa",
  "pl",
  "pt-BR",
  "pt-PT",
  "ro",
  "ru",
  "si",
  "sk",
  "sl",
  "sq",
  "sr",
  "sv",
  "sw",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "ur",
  "uz",
  "vi",
  "zh-Hans",
  "zh-Hant",
  "zu",
];

function nameIn(locale: string, tag: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** Languages to choose from, by name, with whichever the site has now. */
export function siteLanguages(locale: string, current: string): { tag: string; name: string }[] {
  const tags = TAGS.includes(current) ? TAGS : [current, ...TAGS];
  return tags
    .map((tag) => {
      const name = nameIn(locale, tag);
      const own = nameIn(tag, tag);
      return { tag, name: own.toLowerCase() === name.toLowerCase() ? name : `${name} (${own})` };
    })
    .sort((a, b) => a.name.localeCompare(b.name, locale));
}
