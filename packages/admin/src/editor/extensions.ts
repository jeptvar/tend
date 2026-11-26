import { type Extensions, textblockTypeInputRule } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Heading } from "@tiptap/extension-heading";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import { isAllowedHref } from "../lib/doc.ts";
import { ImageNode, type ImageOptions } from "./ImageNode.tsx";
import { ButtonNode, type ButtonOptions, SectionNode, type SectionOptions } from "./nodes.tsx";
import { SlashMenu, type SlashOptions } from "./slash.ts";

const LEVELS = [2, 3, 4] as const;

// The page's title is the only top-level heading, so "# " makes the biggest one there can be.
const TendHeading = Heading.extend({
  addInputRules() {
    return [
      ...(this.parent?.() ?? []),
      textblockTypeInputRule({
        find: /^#\s$/,
        type: this.type,
        getAttributes: { level: LEVELS[0] },
      }),
    ];
  },
});

/**
 * A table holds words, a paragraph or more to a cell: prices, or a week's hours (PLAN.md v0.2).
 * A list or a picture in a cell would be a page inside a page.
 */
const TendTableCell = TableCell.extend({ content: "paragraph+" });
const TendTableHeader = TableHeader.extend({ content: "paragraph+" });

/** Exactly what the server allows, and nothing else: it can't be typed or pasted in here. */
export function editorExtensions(options: {
  allowSections: boolean;
  placeholder: string;
  onEditButton: ButtonOptions["onEdit"];
  onDescribeImage: ImageOptions["onDescribe"];
  onPickImage: ImageOptions["onPick"];
  onUploaded: ImageOptions["onUploaded"];
  onSectionRemoved: SectionOptions["onRemoved"];
  canEditBusiness: boolean;
  slash: SlashOptions;
}): Extensions {
  return [
    StarterKit.configure({
      document: false,
      heading: false,
      link: {
        openOnClick: false,
        // Clicking inside linked words places the cursor, so a typo in them can be fixed.
        enableClickSelection: false,
        isAllowedUri: (url) => isAllowedHref(url ?? ""),
        HTMLAttributes: { target: null, rel: null, class: null },
      },
    }),
    Document.extend({ content: options.allowSections ? "(block | section)+" : "block+" }),
    TendHeading.configure({ levels: [...LEVELS] }),
    Placeholder.configure({ placeholder: options.placeholder }),
    Table.configure({ resizable: false }),
    TableRow,
    TendTableHeader,
    TendTableCell,
    ButtonNode.configure({ onEdit: options.onEditButton }),
    ImageNode.configure({
      onDescribe: options.onDescribeImage,
      onPick: options.onPickImage,
      onUploaded: options.onUploaded,
    }),
    ...(options.allowSections
      ? [
          SectionNode.configure({
            onRemoved: options.onSectionRemoved,
            onPickImage: options.onPickImage,
            canEditBusiness: options.canEditBusiness,
          }),
        ]
      : []),
    SlashMenu.configure(options.slash),
  ];
}
