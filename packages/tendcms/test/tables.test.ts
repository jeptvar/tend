import { describe, expect, test } from "vitest";
import { DocProblem, linkedEntryIds, parseDoc } from "../src/content/doc.ts";
import { renderDoc } from "../src/content/render-doc.ts";

// Simple tables (PLAN.md v0.2): prices or a week's hours, with a paragraph or more in each cell.

const text = (value: string) => ({ type: "text", text: value });
const paragraph = (value?: string) => ({
  type: "paragraph",
  ...(value ? { content: [text(value)] } : {}),
});
const cell = (value: string, type = "tableCell", attrs?: object) => ({
  type,
  ...(attrs ? { attrs } : {}),
  content: [paragraph(value)],
});
const heading = (value: string, attrs?: object) => cell(value, "tableHeader", attrs);
const row = (...cells: object[]) => ({ type: "tableRow", content: cells });
const table = (...rows: object[]) => ({ type: "table", content: rows });
const doc = (...content: object[]) => ({ type: "doc", content });
const parse = (value: object) => parseDoc(value, { allowSections: true });

describe("a table in a document", () => {
  test("keeps its rows, its cells and how far each spans, and nothing else", () => {
    const parsed = parse(
      doc(
        table(
          row(heading("Bread", { colwidth: [120], colspan: 1 }), heading("Price")),
          row(cell("Rye", "tableCell", { rowspan: 2 }), {
            type: "tableCell",
            attrs: { colspan: 99, background: "red" },
            content: [],
          }),
        ),
      ),
    );
    expect(parsed.content[0]).toEqual({
      type: "table",
      content: [
        { type: "tableRow", content: [heading("Bread"), heading("Price")] },
        {
          type: "tableRow",
          content: [
            cell("Rye", "tableCell", { rowspan: 2 }),
            // As far as it can span, and with the paragraph every cell has.
            { type: "tableCell", attrs: { colspan: 20 }, content: [{ type: "paragraph" }] },
          ],
        },
      ],
    });
  });

  test.each([
    ["no rows", table()],
    ["a row with no cells", table(row())],
    ["a row of more than 20 cells", table(row(...Array.from({ length: 21 }, () => cell("x"))))],
    ["a cell outside a row", table(cell("x"))],
    ["something else in a row", table(row(paragraph("x")))],
    [
      "a list in a cell",
      table(
        row({
          type: "tableCell",
          content: [
            { type: "bulletList", content: [{ type: "listItem", content: [paragraph("x")] }] },
          ],
        }),
      ),
    ],
    ["a table in a cell", table(row({ type: "tableCell", content: [table(row(cell("x")))] }))],
  ])("refuses %s", (_name, bad) => {
    expect(() => parse(doc(bad))).toThrow(DocProblem);
  });

  test("its links count, so a page it links to is followed when it moves", () => {
    const id = "0193a0a0-0000-7000-8000-000000000003";
    const linked = {
      type: "tableCell",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Our rye",
              marks: [{ type: "link", attrs: { href: `entry:${id}` } }],
            },
          ],
        },
      ],
    };
    expect(linkedEntryIds(parse(doc(table(row(linked)))))).toEqual([id]);
  });
});

describe("a table on the site", () => {
  test("a first row of headings heads the columns, and any other heading heads its row", () => {
    const { html, text: words } = renderDoc(
      parse(
        doc(
          table(
            row(heading("Day"), heading("Hours")),
            row(heading("Mon"), cell("9–5")),
            row(heading("Sun"), cell("Closed, <b>all day</b>", "tableCell", { colspan: 2 })),
          ),
        ),
      ),
    );
    expect(html).toBe(
      '<table class="t-table">' +
        '<thead><tr><th scope="col"><p>Day</p></th><th scope="col"><p>Hours</p></th></tr></thead>' +
        "<tbody>" +
        '<tr><th scope="row"><p>Mon</p></th><td><p>9–5</p></td></tr>' +
        '<tr><th scope="row"><p>Sun</p></th><td colspan="2"><p>Closed, &lt;b&gt;all day&lt;/b&gt;</p></td></tr>' +
        "</tbody></table>",
    );
    expect(words).toContain("Mon");
    expect(words).toContain("Closed");
  });

  test("without a row of headings it's all body, and one with nothing in it isn't drawn", () => {
    const { html } = renderDoc(parse(doc(table(row(cell("Loaf"), cell("4.50"))))));
    expect(html).toBe(
      '<table class="t-table"><tbody><tr><td><p>Loaf</p></td><td><p>4.50</p></td></tr></tbody></table>',
    );
    const empty = { type: "tableCell", content: [{ type: "paragraph" }] };
    expect(renderDoc(parse(doc(table(row(empty, empty)), paragraph("After")))).html).toBe(
      "<p>After</p>",
    );
  });
});
