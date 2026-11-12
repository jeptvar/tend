import { mergeAttributes, Node } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Selection } from "@tiptap/pm/state";
import {
  NodeViewContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
} from "@tiptap/react";
import { FormattedMessage, useIntl } from "react-intl";

const controlClass =
  "min-h-11 min-w-11 rounded border border-muted bg-paper px-2 text-sm focus-visible:outline-3 focus-visible:outline-brand";

export interface ButtonOptions {
  /** Asks for the words and address of a button, through the link dialog. */
  onEdit: (position: number, attrs: { href: string; label: string }) => void;
}

function useIsEditable(editor: NodeViewProps["editor"]): boolean {
  return useEditorState({ editor, selector: ({ editor: current }) => current.isEditable });
}

function ButtonView({ node, getPos, extension, editor }: NodeViewProps) {
  const { href, label } = node.attrs as { href: string; label: string };
  const editable = useIsEditable(editor);
  return (
    <NodeViewWrapper data-button-view="" className="my-4 flex flex-wrap items-center gap-3">
      <span className="inline-flex min-h-11 max-w-full min-w-0 items-center rounded-lg bg-brand px-4 font-medium [overflow-wrap:anywhere] text-paper">
        {label}
      </span>
      {!href && (
        <span className="text-sm text-danger">
          <FormattedMessage id="editor.buttonNoAddress" />
        </span>
      )}
      {editable && (
        <button
          type="button"
          className={controlClass}
          onClick={() => {
            const position = getPos();
            if (typeof position === "number") {
              (extension.options as ButtonOptions).onEdit(position, { href, label });
            }
          }}
        >
          <FormattedMessage id="editor.buttonEdit" values={{ label }} />
        </button>
      )}
    </NodeViewWrapper>
  );
}

/** A link that looks like a button. Its words and address come from the link dialog. */
export const ButtonNode = Node.create<ButtonOptions>({
  name: "button",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { onEdit: () => {} };
  },

  addAttributes() {
    return { href: { default: "" }, label: { default: "" } };
  },

  parseHTML() {
    return [
      {
        tag: "a.t-button",
        // Ahead of the rule that would read any <a> as ordinary linked words.
        priority: 60,
        getAttrs: (element) => ({
          href: element.getAttribute("href") ?? "",
          label: element.textContent ?? "",
        }),
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "a",
      mergeAttributes({ class: "t-button", href: HTMLAttributes.href }),
      node.attrs.label as string,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ButtonView);
  },
});

export interface RemovedSection {
  node: Record<string, unknown>;
  position: number;
}

export interface SectionOptions {
  /** Says it's gone and offers Undo, since this can take a lot of words with it. */
  onRemoved: (removed: RemovedSection) => void;
}

function SectionView({
  node,
  updateAttributes,
  deleteNode,
  editor,
  extension,
  getPos,
}: NodeViewProps) {
  const intl = useIntl();
  const { tone, align } = node.attrs as { tone: string; align: string };
  const editable = useIsEditable(editor);
  return (
    <NodeViewWrapper
      className={`my-4 rounded-lg border border-dashed border-muted p-4 ${
        tone === "muted" ? "bg-ink/5" : tone === "accent" ? "bg-brand/15" : ""
      }`}
    >
      <div contentEditable={false} className="mb-3 flex flex-wrap items-center gap-2">
        <span className="me-auto text-sm font-medium text-muted">
          <FormattedMessage id="editor.sectionIntro" />
        </span>
        {editable && (
          <>
            <label className="flex items-center gap-1 text-sm">
              <FormattedMessage id="editor.sectionTone" />
              <select
                className={controlClass}
                value={tone}
                onChange={(event) => updateAttributes({ tone: event.target.value })}
              >
                <option value="none">{intl.formatMessage({ id: "editor.toneNone" })}</option>
                <option value="muted">{intl.formatMessage({ id: "editor.toneMuted" })}</option>
                <option value="accent">{intl.formatMessage({ id: "editor.toneAccent" })}</option>
              </select>
            </label>
            <label className="flex items-center gap-1 text-sm">
              <FormattedMessage id="editor.sectionAlign" />
              <select
                className={controlClass}
                value={align}
                onChange={(event) => updateAttributes({ align: event.target.value })}
              >
                <option value="left">{intl.formatMessage({ id: "editor.alignLeft" })}</option>
                <option value="center">{intl.formatMessage({ id: "editor.alignCenter" })}</option>
              </select>
            </label>
            <button
              type="button"
              className={controlClass}
              onClick={() => {
                const position = getPos();
                const removed = node.toJSON() as Record<string, unknown>;
                // A step of its own, so Undo brings back this and not the typing before it.
                editor.view.dispatch(closeHistory(editor.state.tr));
                deleteNode();
                // This button has just gone, so focus goes back to the writing.
                editor.commands.focus();
                (extension.options as SectionOptions).onRemoved({
                  node: removed,
                  position: typeof position === "number" ? position : 0,
                });
              }}
            >
              <FormattedMessage id="editor.sectionRemove" />
            </button>
          </>
        )}
      </div>
      <NodeViewContent className={align === "center" ? "text-center" : ""} />
    </NodeViewWrapper>
  );
}

/** A page's sections. Only "Big intro" can be added for now: the others need photos. */
export const SectionNode = Node.create<SectionOptions>({
  name: "section",
  // Ahead of the usual Backspace and Delete, which don't know about it. See below.
  priority: 1000,
  // Its own group, so it can only sit at the top level of a page. The server checks that too.
  group: "section",
  content: "block+",
  defining: true,
  isolating: true,
  // Not as one lump: Backspace below it would select the lot, and the next key would replace it.
  selectable: false,

  addOptions() {
    return { onRemoved: () => {} };
  },

  // A section is a box of its own, so Backspace and Delete at its edge don't pull the words on
  // the other side in or out of it. Left to itself, the browser would do just that.
  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.depth !== 1 || $from.parentOffset !== 0) return false;
        if ($from.parent.content.size === 0) return false;
        const before = $from.before(1);
        if (editor.state.doc.resolve(before).nodeBefore?.type.name !== this.name) return false;
        // Into the end of the section, as the cursor would go on any other line.
        return editor.commands.command(({ tr, state }) => {
          tr.setSelection(Selection.near(state.doc.resolve(before - 1), -1));
          return true;
        });
      },
      Delete: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parentOffset !== $from.parent.content.size) return false;
        if ($from.depth === 1) {
          // An empty line goes, as usual. Only words stay put.
          if ($from.parent.content.size === 0) return false;
          const after = editor.state.doc.resolve($from.after(1)).nodeAfter;
          return after?.type.name === this.name;
        }
        // At the very end of a section's last line, there's nothing inside it left to delete.
        const atSectionEnd =
          $from.node(1).type.name === this.name && $from.end(1) === $from.after($from.depth);
        return atSectionEnd;
      },
    };
  },

  addAttributes() {
    return {
      kind: { default: "intro" },
      preset: { default: "1" },
      tone: { default: "none" },
      align: { default: "left" },
    };
  },

  parseHTML() {
    return [{ tag: "section[data-tend-section]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["section", mergeAttributes(HTMLAttributes, { "data-tend-section": "" }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(SectionView);
  },
});
