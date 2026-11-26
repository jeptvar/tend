import type { Page } from "@playwright/test";
import { createEntry, expect, test } from "./fixtures.ts";

// What people paste (PLAN.md §5, Editor): how each program writes it, cut down to what matters,
// and what's kept of it. Nothing may go missing without a notice saying so.

interface Sample {
  name: string;
  html: string;
  /** What's in the editor afterwards, a line for each block. */
  becomes: string[];
  notices?: string[];
}

const TABLE = "A table inside another table was turned into lines of text";
const PICTURE = "Pictures from another website were left out";
const EMBED = "A video or something else from another website was left out";

const SAMPLES: Sample[] = [
  {
    name: "Google Docs: headings, emphasis, links and empty lines between paragraphs",
    html: `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-7f3a">
<h1 dir="ltr"><span style="font-size:20pt;font-weight:400;">Our bread</span></h1>
<p dir="ltr"><span style="font-weight:400;">We use </span><span style="font-weight:700;">rye</span><span style="font-weight:400;"> and </span><span style="font-style:italic;font-weight:400;">spelt</span><span style="font-weight:400;">.</span></p>
<br />
<p dir="ltr"><span style="font-weight:400;">See the </span><a href="https://example.com/menu" style="text-decoration:none;"><span style="color:#1155cc;text-decoration:underline;">menu</span></a></p>
<h5 dir="ltr"><span>Small print</span></h5>
</b><br class="Apple-interchange-newline">`,
    becomes: [
      "h2 Our bread",
      "p We use **rye** and _spelt_.",
      "p See the [menu](https://example.com/menu)",
      "h4 Small print",
    ],
  },
  {
    name: "Google Docs: lists, one inside another",
    html: `<b style="font-weight:normal;" id="docs-internal-guid-1"><ul style="margin-top:0;">
<li dir="ltr" aria-level="1"><p dir="ltr" role="presentation"><span>Flour</span></p></li>
<ul><li dir="ltr" aria-level="2"><p dir="ltr" role="presentation"><span>Rye</span></p></li></ul>
<li dir="ltr" aria-level="1"><p dir="ltr" role="presentation"><span>Salt</span></p></li></ul>
<ol><li dir="ltr"><p dir="ltr" role="presentation"><span>Mix</span></p></li><li dir="ltr"><p dir="ltr" role="presentation"><span>Wait</span></p></li></ol></b>`,
    becomes: ["ul - Flour", "ul   - Rye", "ul - Salt", "ol - Mix", "ol - Wait"],
  },
  {
    name: "Google Docs: a checklist, whose boxes are pictures",
    html: `<b style="font-weight:normal;"><ul><li dir="ltr" role="checkbox" aria-checked="false"><img src="data:image/png;base64,iVBORw0KGgo=" alt="unchecked" aria-roledescription="checkbox"><p dir="ltr" style="display:inline-block;" role="presentation"><span>Feed the starter</span></p></li></ul></b>`,
    becomes: ["ul - Feed the starter"],
  },
  {
    name: "Google Docs: a table and a picture",
    html: `<b style="font-weight:normal;"><div dir="ltr"><table><tbody><tr><td><p><span>Mon</span></p></td><td><p><span>9–5</span></p></td></tr><tr><td><p><span>Tue</span></p></td><td><p><span>Closed</span></p></td></tr></tbody></table></div><br /><p><span><span><img src="https://lh7-rt.googleusercontent.com/docsz/x" width="602" height="401"></span></span></p><p><span>After</span></p></b>`,
    becomes: ["table Mon | 9–5 / Tue | Closed", "p After"],
    notices: [PICTURE],
  },
  {
    name: "a table with a table, and a list, in its cells",
    html: `<table><tr><td><p>Hours</p><table><tr><td>Mon</td><td>9–5</td></tr></table></td><td><ul><li>Rye</li><li>Spelt</li></ul></td></tr></table><p>After</p>`,
    becomes: ["table Hours ; Mon · 9–5 | Rye ; Spelt", "p After"],
    notices: [TABLE],
  },
  {
    name: "Google Sheets: cells",
    html: `<google-sheets-html-origin><table xmlns="http://www.w3.org/1999/xhtml" dir="ltr"><tbody><tr><td data-sheets-value="x">Loaf</td><td>4.50</td></tr></tbody></table></google-sheets-html-origin>`,
    becomes: ["table Loaf | 4.50"],
  },
  {
    name: "Word: a title, and lists it writes as paragraphs",
    html: `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal {margin:0}</style></head><body><!--StartFragment-->
<p class=MsoTitle>Opening hours<o:p></o:p></p>
<p class=MsoNormal>We are <b>open</b>:<o:p></o:p></p>
<p class=MsoListParagraphCxSpFirst style='text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol'><span style='mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>Monday<o:p></o:p></p>
<p class=MsoListParagraphCxSpMiddle style='text-indent:-.25in;mso-list:l0 level2 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>o<span>&nbsp;&nbsp; </span></span><![endif]>From nine<o:p></o:p></p>
<p class=MsoListParagraphCxSpLast style='text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>·<span>&nbsp;&nbsp; </span></span><![endif]>Tuesday<o:p></o:p></p>
<p class=MsoNormal>In this order:</p>
<p class=MsoListParagraph style='mso-list:l1 level1 lfo2'><![if !supportLists]><span style='mso-list:Ignore'>1.<span>&nbsp; </span></span><![endif]>Knock</p>
<p class=MsoListParagraph style='mso-list:l1 level1 lfo2'><![if !supportLists]><span style='mso-list:Ignore'>2.<span>&nbsp; </span></span><![endif]>Wait</p>
<!--EndFragment--></body></html>`,
    becomes: [
      "h2 Opening hours",
      "p We are **open**:",
      "ul - Monday",
      "ul   - From nine",
      "ul - Tuesday",
      "p In this order:",
      "ol - Knock",
      "ol - Wait",
    ],
  },
  {
    name: "Apple Notes and Pages: lines that are only divisions",
    html: `<div>First line</div><div><br></div><div><b>Second</b> line</div>`,
    becomes: ["p First line", "p **Second** line"],
  },
  {
    name: "Gmail: a quoted message",
    html: `<div dir="ltr">Thanks!<br><br><blockquote class="gmail_quote"><div>See you on <i>Monday</i></div></blockquote></div>`,
    becomes: ["p Thanks!", "quote See you on _Monday_"],
  },
  {
    name: "a web page: code, a rule, strikethrough, and a video",
    html: `<article><h3>Recipe</h3><pre><code>250 g flour</code></pre><hr><p><s>Old</s> <code>new</code></p><iframe src="https://www.youtube.com/embed/x"></iframe><p>End</p></article>`,
    becomes: ["h3 Recipe", "code 250 g flour", "rule", "p ~~Old~~ `new`", "p End"],
    notices: [EMBED],
  },
  {
    name: "a web page that tries to run something",
    html: `<p onclick="window.pwned=1">Click <a href="javascript:alert(1)">me</a></p><script>window.pwned=1</script><style>body{display:none}</style><svg onload="window.pwned=1"></svg>`,
    becomes: ["p Click me"],
    notices: [PICTURE],
  },
  {
    name: "a chat: plain words with line breaks",
    html: `<span>One<br>two</span>`,
    becomes: ["p One / two"],
  },
];

/** What's in the editor, a line for each block, with its marks written out. */
function outline(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const words = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      const inner = [...node.childNodes].map(words).join("");
      switch ((node as Element).tagName) {
        case "STRONG":
          return `**${inner}**`;
        case "EM":
          return `_${inner}_`;
        case "S":
          return `~~${inner}~~`;
        case "CODE":
          return `\`${inner}\``;
        case "A":
          return `[${inner}](${(node as Element).getAttribute("href")})`;
        case "BR":
          return (node as Element).classList.contains("ProseMirror-trailingBreak") ? "" : " / ";
        default:
          return inner;
      }
    };
    const lines: string[] = [];
    const list = (element: Element, depth: number) => {
      for (const item of element.children) {
        const own = [...item.children].filter((child) => !/^(UL|OL)$/.test(child.tagName));
        const name = element.tagName.toLowerCase();
        lines.push(`${name} ${"  ".repeat(depth)}- ${own.map(words).join(" ").trim()}`);
        for (const child of item.children)
          if (/^(UL|OL)$/.test(child.tagName)) list(child, depth + 1);
      }
    };
    const body = document.querySelector('[role="textbox"][contenteditable]');
    for (const block of body?.children ?? []) {
      const tag = block.tagName.toLowerCase();
      if (tag === "ul" || tag === "ol") list(block, 0);
      else if (block.querySelector("table") || tag === "table") {
        // A row at a time, a cell at a time, its paragraphs apart, and # for a heading.
        const rows = [...block.querySelectorAll("tr")].map((row) =>
          [...row.children]
            .map((cell) => {
              const paragraphs = [...cell.children].map(words).join(" ; ");
              return cell.tagName === "TH" ? `# ${paragraphs}` : paragraphs;
            })
            .join(" | "),
        );
        lines.push(`table ${rows.join(" / ")}`);
      } else if (tag === "pre") lines.push(`code ${block.textContent}`);
      else if (tag === "blockquote") lines.push(`quote ${words(block)}`.trim());
      else if (block.querySelector("hr") || tag === "hr") lines.push("rule");
      else lines.push(`${tag} ${words(block)}`.trim());
    }
    // The line the editor keeps at the end for the cursor.
    if (lines.at(-1) === "p") lines.pop();
    return lines;
  });
}

for (const sample of SAMPLES) {
  test(`pasted from ${sample.name}`, async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Pasted", body: "" });
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    const body = page.getByRole("textbox", { name: "Text" });
    await body.click();
    await page.evaluate((html) => {
      const data = new DataTransfer();
      data.setData("text/html", html);
      document
        .querySelector('[role="textbox"][contenteditable]')
        ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    }, sample.html);
    await expect.poll(() => outline(page)).toEqual(sample.becomes);
    for (const notice of [TABLE, PICTURE, EMBED]) {
      const shown = page.getByText(notice);
      if (sample.notices?.includes(notice)) await expect(shown).toBeVisible();
      else await expect(shown).toHaveCount(0);
    }
    expect(await page.evaluate(() => "pwned" in window)).toBe(false);
    // And the server takes it as it is.
    await expect(page.getByTestId("save-status")).toHaveText("Saved", { timeout: 5000 });
  });
}
