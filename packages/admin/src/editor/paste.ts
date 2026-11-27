// What's pasted from somewhere else, made into what Tend can keep (PLAN.md §5, Editor). What
// can't be kept is said, so that nothing vanishes without a word. Parsing this way loads
// nothing and runs nothing.

export interface Pasted {
  html: string;
  /** Messages about what was changed or left out. */
  notices: string[];
}

const EMBEDS = "iframe, video, audio, object, embed";
const PICTURES = "img, picture, svg, canvas";
/** Elements that make a line of their own, so a line break beside one is only spacing. */
const BLOCKS = new Set([
  "P",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "TABLE",
  "BLOCKQUOTE",
  "PRE",
  "HR",
  "FIGURE",
]);

export function tidyPasted(html: string): Pasted {
  const notices: string[] = [];
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const { body } = parsed;

  // Google Docs wraps everything in bold that isn't, and the spaces between its paragraphs
  // would be lines of their own in there.
  for (const wrapper of body.querySelectorAll('b[style*="font-weight:normal" i]')) {
    wrapper.replaceWith(...wrapper.childNodes);
  }
  // It draws the box of each checklist line as a picture, too.
  for (const box of body.querySelectorAll('img[aria-roledescription="checkbox"]')) box.remove();
  // Word's empty pieces, which would be lines with nothing in them.
  for (const empty of body.querySelectorAll("o\\:p")) empty.replaceWith(...empty.childNodes);
  wordLists(parsed);

  // A table's cells hold words, so one inside another becomes lines of text.
  const nested = [...body.querySelectorAll("table")].filter((table) =>
    table.parentElement?.closest("table"),
  );
  if (nested.length > 0) notices.push("paste.table");
  if (body.querySelector(PICTURES)) notices.push("paste.image");
  if (body.querySelector(EMBEDS)) notices.push("paste.embed");
  for (const dropped of body.querySelectorAll(`${PICTURES}, ${EMBEDS}`)) drop(dropped);
  // From the innermost out, so each is gone before the one around it is looked at.
  for (const table of nested.reverse()) tableAsLines(table, parsed);
  for (const cell of body.querySelectorAll("td, th")) cellAsParagraphs(cell, parsed);

  headings(parsed);
  spacingBreaks(body);
  return { html: body.innerHTML, notices };
}

/** Takes something out, and the lines that only held it. */
function drop(element: Element): void {
  let parent: Element | null = element.parentElement;
  element.remove();
  while (parent && parent.tagName !== "BODY" && !parent.textContent?.trim()) {
    if (parent.childElementCount > 0) return;
    const above: Element | null = parent.parentElement;
    parent.remove();
    parent = above;
  }
}

/** The title is the page's only top-level heading, and three levels go below it. */
function headings(parsed: Document): void {
  const become = (element: Element, tag: string) => {
    const made = parsed.createElement(tag);
    made.append(...element.childNodes);
    element.replaceWith(made);
  };
  for (const title of parsed.body.querySelectorAll("h1, p.MsoTitle")) become(title, "h2");
  for (const small of parsed.body.querySelectorAll("h5, h6")) become(small, "h4");
}

/** Elements that hold lines of their own, rather than words within a line. */
const HOLDS_LINES =
  /^(P|DIV|LI|UL|OL|DL|DT|DD|H[1-6]|BLOCKQUOTE|PRE|FIGURE|SECTION|ARTICLE|HEADER|FOOTER)$/;

/** What's inside, a line at a time: the words between blocks, and each block's own lines. */
function linesIn(element: Element): Node[][] {
  const lines: Node[][] = [];
  let line: Node[] = [];
  for (const child of [...element.childNodes]) {
    if (child instanceof Element && HOLDS_LINES.test(child.tagName)) {
      if (line.length > 0) lines.push(line);
      line = [];
      lines.push(...linesIn(child));
    } else {
      line.push(child);
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/**
 * A cell holds words: a list or a heading in one becomes a paragraph for each of its lines.
 * Left as it was, the editor would put it after the table, cutting the table in two.
 */
function cellAsParagraphs(cell: Element, parsed: Document): void {
  if (![...cell.children].some((child) => HOLDS_LINES.test(child.tagName))) return;
  const paragraphs = linesIn(cell)
    .filter((line) => line.some((node) => node.textContent?.trim()))
    .map((line) => {
      const paragraph = parsed.createElement("p");
      paragraph.append(...line);
      return paragraph;
    });
  cell.replaceChildren(...paragraphs);
}

/**
 * A table inside a table becomes a line per row, with its cells kept apart, so opening hours
 * stay readable ("Mon · 9–5") rather than running together.
 */
function tableAsLines(table: Element, parsed: Document): void {
  const lines = [...table.querySelectorAll("tr")]
    .map((row) =>
      [...row.querySelectorAll("th, td")]
        .map((cell) => cell.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .filter(Boolean)
        .join(" · "),
    )
    .filter(Boolean);
  const replacement = parsed.createDocumentFragment();
  for (const line of lines) {
    const paragraph = parsed.createElement("p");
    paragraph.textContent = line;
    replacement.append(paragraph);
  }
  table.replaceWith(replacement);
}

/** "mso-list:l0 level2 lfo1", as Word marks a line of a list, and how deep it is. */
const WORD_LIST = /mso-list:\s*\S+\s+level(\d+)/i;
/** Word's own marker, which a real list draws by itself. One that counts starts with 1., a) ... */
const WORD_MARKER = /^\s*(?:\(?[0-9]{1,3}[.)]|\(?[a-z]{1,4}[.)])/i;

function wordList(element: Element | null): { depth: number } | null {
  if (element?.tagName !== "P") return null;
  const depth = WORD_LIST.exec(element.getAttribute("style") ?? "")?.[1];
  return depth ? { depth: Number(depth) } : null;
}

/** Word copies a list as paragraphs that only look like one. They're made into one. */
function wordLists(parsed: Document): void {
  for (const first of [...parsed.body.querySelectorAll("p")]) {
    if (!first.isConnected || !wordList(first)) continue;
    const lines: { element: Element; depth: number; counts: boolean }[] = [];
    for (let line: Element | null = first; line; line = line.nextElementSibling) {
      const list = wordList(line);
      if (!list) break;
      const marker = line.querySelector(
        '[style*="mso-list:Ignore" i], [style*="mso-list: Ignore" i]',
      );
      const counts = WORD_MARKER.test(marker?.textContent ?? line.textContent ?? "");
      marker?.remove();
      lines.push({ element: line, depth: list.depth, counts });
    }
    const newList = (counts: boolean) => parsed.createElement(counts ? "ol" : "ul");
    const root = newList(lines[0]?.counts ?? false);
    first.before(root);
    const open = [{ list: root, depth: lines[0]?.depth ?? 1 }];
    for (const { element, depth, counts } of lines) {
      while (open.length > 1 && (open.at(-1)?.depth ?? 0) > depth) open.pop();
      const current = open.at(-1);
      if (current && depth > current.depth) {
        const inner = newList(counts);
        (current.list.lastElementChild ?? current.list).append(inner);
        open.push({ list: inner, depth });
      }
      const item = parsed.createElement("li");
      const words = parsed.createElement("p");
      words.append(...element.childNodes);
      item.append(words);
      open.at(-1)?.list.append(item);
      element.remove();
    }
  }
}

/**
 * Line breaks that are only spacing: between paragraphs, where Google Docs puts one for an
 * empty line, and after the last words of a line, where email programs do.
 */
function spacingBreaks(root: Element): void {
  // From the end, so that each of several in a row is the last one when it's looked at.
  for (const line of [...root.querySelectorAll("br")].reverse()) {
    let next = line.nextSibling;
    while (next?.nodeType === Node.TEXT_NODE && !next.textContent?.trim()) next = next.nextSibling;
    const atEnd = next === null || (next instanceof Element && BLOCKS.has(next.tagName));
    // One alone in a line is an empty line, and the editor has its own way to show those.
    const alone = !line.parentElement?.textContent?.trim();
    const inLine = line.parentElement !== null && BLOCKS.has(line.parentElement.tagName);
    if (atEnd && !(alone && inLine)) line.remove();
  }
}
