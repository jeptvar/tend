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
import { Icon, type IconName } from "../components/icons.tsx";

const choiceClass =
  "min-h-11 min-w-11 rounded-xl border border-edge bg-field px-2 text-sm focus-visible:outline-3 focus-visible:outline-brand";
const sectionButtonClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 rounded-xl px-3 text-sm font-medium hover:bg-ink/6 focus-visible:outline-3 focus-visible:outline-brand";

export interface ButtonOptions {
  /** Asks for the words and address of a button, through the link dialog. */
  onEdit: (position: number, attrs: { href: string; label: string }) => void;
}

function useIsEditable(editor: NodeViewProps["editor"]): boolean {
  return useEditorState({ editor, selector: ({ editor: current }) => current.isEditable });
}

function ButtonView({ node, getPos, extension, editor }: NodeViewProps) {
  const intl = useIntl();
  const { href, label } = node.attrs as { href: string; label: string };
  const editable = useIsEditable(editor);
  return (
    <NodeViewWrapper data-button-view="">
      {editable ? (
        <button
          type="button"
          className="tend-button"
          aria-label={intl.formatMessage({ id: "editor.buttonEdit" }, { label })}
          onClick={() => {
            const position = getPos();
            if (typeof position === "number") {
              (extension.options as ButtonOptions).onEdit(position, { href, label });
            }
          }}
        >
          {label}
          <Icon name="pencil" className="size-4 opacity-80" />
        </button>
      ) : (
        <span className="tend-button">{label}</span>
      )}
      {!href && (
        <span className="mt-2 block w-fit rounded-full bg-danger-soft px-3 py-1 font-sans text-sm text-danger">
          <FormattedMessage id="editor.buttonNoAddress" />
        </span>
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
  /** Asks for a picture, and hands it over. */
  onPickImage: (use: (mediaId: string) => void) => void;
  /** Whether this person can change the business details a Contact & hours section shows. */
  canEditBusiness: boolean;
}

interface Layouts {
  label: string;
  first: string;
  second: string;
}

/** The two ways each section can be laid out (PLAN.md §5), a Big intro's going by its photo. */
function layoutsOf(kind: string, hasPhoto: boolean): Layouts {
  switch (kind) {
    case "pictureText":
      return {
        label: "editor.sectionPicture",
        first: "editor.pictureLeft",
        second: "editor.pictureRight",
      };
    case "contact":
      return {
        label: "editor.sectionLayout",
        first: "editor.contactBelow",
        second: "editor.contactBeside",
      };
    default:
      return hasPhoto
        ? {
            label: "editor.sectionLayout",
            first: "editor.introBeside",
            second: "editor.introBehind",
          }
        : {
            label: "editor.sectionLayout",
            first: "editor.introStandard",
            second: "editor.introTall",
          };
  }
}

const SECTION_NAMES: Record<string, { name: string; icon: IconName }> = {
  pictureText: { name: "editor.sectionPictureText", icon: "pictureText" },
  contact: { name: "editor.sectionContact", icon: "contact" },
};
const INTRO = { name: "editor.sectionIntro", icon: "intro" } as const;

function Choice({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [value: string, name: string][];
}) {
  const intl = useIntl();
  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      <FormattedMessage id={label} />
      <select
        className={`${choiceClass} text-ink`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([option, name]) => (
          <option key={option} value={option}>
            {intl.formatMessage({ id: name })}
          </option>
        ))}
      </select>
    </label>
  );
}

function SectionView({
  node,
  updateAttributes,
  deleteNode,
  editor,
  extension,
  getPos,
}: NodeViewProps) {
  const { kind, tone, align, preset } = node.attrs as {
    kind: string;
    tone: string;
    align: string;
    preset: string;
  };
  const editable = useIsEditable(editor);
  const options = extension.options as SectionOptions;
  const { name, icon } = SECTION_NAMES[kind] ?? INTRO;
  const hasPhoto = node.children.some((child) => child.type.name === "image");
  const layouts = layoutsOf(kind, hasPhoto);
  const layout = preset === "2" ? "2" : "1";
  return (
    <NodeViewWrapper
      className="tend-section"
      data-kind={kind}
      data-tone={tone}
      data-align={align}
      data-layout={layout}
    >
      <div contentEditable={false} className="tend-section-bar">
        <span className="me-auto inline-flex min-h-11 items-center gap-2 text-sm font-semibold">
          <Icon name={icon} className="size-4.5 text-brand" />
          <FormattedMessage id={name} />
        </span>
        {editable && (
          <>
            {kind !== "contact" && !hasPhoto && (
              <button
                type="button"
                className={sectionButtonClass}
                onClick={() =>
                  options.onPickImage((mediaId) => {
                    const position = getPos();
                    if (typeof position !== "number") return;
                    // This button goes once there's a photo, so the keyboard goes to the writing.
                    editor
                      .chain()
                      .insertContentAt(position + 1, { type: "image", attrs: { mediaId } })
                      .setTextSelection(position + 4)
                      .focus()
                      .run();
                  })
                }
              >
                <Icon name="media" className="size-4.5" />
                <FormattedMessage id="editor.sectionAddPhoto" />
              </button>
            )}
            <Choice
              label={layouts.label}
              value={layout}
              onChange={(value) => updateAttributes({ preset: value })}
              options={[
                ["1", layouts.first],
                ["2", layouts.second],
              ]}
            />
            <Choice
              label="editor.sectionTone"
              value={tone}
              onChange={(value) => updateAttributes({ tone: value })}
              options={[
                ["none", "editor.toneNone"],
                ["muted", "editor.toneMuted"],
                ["accent", "editor.toneAccent"],
              ]}
            />
            <Choice
              label="editor.sectionAlign"
              value={align}
              onChange={(value) => updateAttributes({ align: value })}
              options={[
                ["left", "editor.alignLeft"],
                ["center", "editor.alignCenter"],
              ]}
            />
            <button
              type="button"
              className={sectionButtonClass}
              onClick={() => {
                const position = getPos();
                const removed = node.toJSON() as Record<string, unknown>;
                // A step of its own, so Undo brings back this and not the typing before it.
                editor.view.dispatch(closeHistory(editor.state.tr));
                deleteNode();
                // This button has just gone, so focus goes back to the writing.
                editor.commands.focus();
                options.onRemoved({
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
      <NodeViewContent className="tend-section-words" />
      {kind === "contact" && (
        <div contentEditable={false} className="tend-section-details">
          <div className="dashed flex gap-4 bg-surface p-5 text-left text-base text-ink">
            <Icon name="contact" className="size-6 text-brand" />
            <div className="min-w-0">
              <p>
                <FormattedMessage id="editor.contactDetails" />
              </p>
              {options.canEditBusiness && (
                <a
                  href="/admin/settings/business"
                  target="_blank"
                  rel="noopener"
                  className="mt-1 inline-flex min-h-11 items-center font-medium text-brand underline underline-offset-4"
                >
                  <FormattedMessage id="editor.contactEdit" />
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}

/** A page's sections: Big intro, Picture and text, and Contact & hours. */
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
    return { onRemoved: () => {}, onPickImage: () => {}, canEditBusiness: false };
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
