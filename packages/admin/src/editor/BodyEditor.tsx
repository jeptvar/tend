import type { Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, PluginKey } from "@tiptap/pm/state";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showToast } from "../components/Toast.tsx";
import type { Doc } from "../lib/doc.ts";
import type { EntryType } from "../lib/queries.ts";
import { INSERT_ITEMS, type InsertItem, matchingItems } from "./commands.ts";
import { editorExtensions } from "./extensions.ts";
import { LinkDialog } from "./LinkDialog.tsx";
import type { RemovedSection } from "./nodes.tsx";
import type { SlashState } from "./slash.ts";

export interface BodyHandle {
  /** Replaces the words: a conflict resolved, or an older version brought back. */
  setDoc(doc: Doc): void;
  focusStart(): void;
}

// A pressed button shows it with the whole background, because a faint tint can't be told
// apart at the 3:1 that WCAG asks of something that shows state.
const toolClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded px-2 hover:bg-ink/10 focus-visible:outline-3 focus-visible:outline-brand aria-disabled:opacity-40 aria-pressed:bg-ink aria-pressed:text-paper";

function Tool({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      // aria-disabled, so a button that's just been used keeps keyboard focus.
      aria-disabled={disabled}
      // The selection has to stay where it is, or there's nothing to format.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (!disabled) onClick();
      }}
      className={toolClass}
    >
      {children}
    </button>
  );
}

/** Links are for words: not code, where nothing's formatted, and not a whole button. */
function canLink(editor: Editor): boolean {
  return (
    editor.isEditable &&
    !editor.isActive("codeBlock") &&
    !(editor.state.selection instanceof NodeSelection)
  );
}

/** The same list as the "/" menu, for phones and anyone who hasn't discovered the slash. */
function InsertMenu({
  items,
  nameOf,
  onChoose,
  disabled,
}: {
  items: InsertItem[];
  nameOf: (id: string) => string;
  onChoose: (item: InsertItem) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector("button")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as globalThis.Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function move(event: React.KeyboardEvent) {
    const buttons = [...(menuRef.current?.querySelectorAll("button") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const go = (next: number) => {
      event.preventDefault();
      buttons[(next + buttons.length) % buttons.length]?.focus();
    };
    if (event.key === "ArrowDown") go(index + 1);
    else if (event.key === "ArrowUp") go(index - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(-1);
    // Tab carries on to the next thing on the page, and a menu doesn't stay behind.
    else if (event.key === "Tab") setOpen(false);
    else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    }
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen(!open);
        }}
        className={toolClass}
      >
        <FormattedMessage id="editor.insert" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={move}
          className="absolute start-0 top-full z-20 mt-1 max-h-80 w-56 overflow-y-auto rounded-lg border border-ink/20 bg-paper p-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setOpen(false);
                onChoose(item);
              }}
              className="flex min-h-11 w-full items-center rounded px-3 text-start hover:bg-ink/10 focus-visible:outline-3 focus-visible:outline-brand"
            >
              {nameOf(item.id)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Toolbar({
  editor,
  items,
  nameOf,
  onInsert,
  onLink,
}: {
  editor: Editor;
  items: InsertItem[];
  nameOf: (id: string) => string;
  onInsert: (item: InsertItem) => void;
  onLink: () => void;
}) {
  const intl = useIntl();
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      editable: current.isEditable,
      canUndo: current.can().undo(),
      canRedo: current.can().redo(),
      canBold: current.can().toggleBold(),
      canItalic: current.can().toggleItalic(),
      canLink: canLink(current),
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      link: current.isActive("link"),
    }),
  });
  const locked = !state.editable;
  return (
    <fieldset className="flex min-w-0 flex-wrap items-center gap-1 border-b border-muted p-1">
      <legend className="sr-only">{intl.formatMessage({ id: "editor.formatting" })}</legend>
      <Tool disabled={locked || !state.canUndo} onClick={() => editor.chain().focus().undo().run()}>
        <FormattedMessage id="editor.undo" />
      </Tool>
      <Tool disabled={locked || !state.canRedo} onClick={() => editor.chain().focus().redo().run()}>
        <FormattedMessage id="editor.redo" />
      </Tool>
      <span aria-hidden="true" className="mx-1 h-6 w-px bg-ink/20" />
      <Tool
        label={intl.formatMessage({ id: "editor.bold" })}
        pressed={state.bold}
        disabled={locked || !state.canBold}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <strong>B</strong>
      </Tool>
      <Tool
        label={intl.formatMessage({ id: "editor.italic" })}
        pressed={state.italic}
        disabled={locked || !state.canItalic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <em>I</em>
      </Tool>
      <Tool pressed={state.link} disabled={!state.canLink} onClick={onLink}>
        <FormattedMessage id="editor.link" />
      </Tool>
      <InsertMenu items={items} nameOf={nameOf} onChoose={onInsert} disabled={locked} />
    </fieldset>
  );
}

/** Appears over selected words on a computer. Phones have their own, from the system. */
function SelectionToolbar({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const intl = useIntl();
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      underline: current.isActive("underline"),
      strike: current.isActive("strike"),
      code: current.isActive("code"),
      link: current.isActive("link"),
      h2: current.isActive("heading", { level: 2 }),
      h3: current.isActive("heading", { level: 3 }),
    }),
  });
  // The wrapper only holds the buttons, so Tab shouldn't stop on it. That's set after the menu
  // has set itself up, because that makes it a stop whatever it's given.
  const menuRef = useRef<HTMLDivElement>(null);
  // Kept within the writing area, so it never covers the toolbar above it.
  const [boundary, setBoundary] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!editor.isDestroyed) setBoundary(editor.view.dom);
  }, [editor]);
  useEffect(() => {
    const element = menuRef.current;
    if (!element || !boundary) return;
    element.tabIndex = -1;
    // Tabbing on past the last button would leave it behind otherwise, over the text.
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as globalThis.Node | null;
      if (next && (element.contains(next) || boundary.contains(next))) return;
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, "hide"));
    };
    element.addEventListener("focusout", onFocusOut);
    return () => element.removeEventListener("focusout", onFocusOut);
  }, [editor, boundary]);
  // Only once the boundary is known: the menu ignores the first change to its options.
  if (!boundary) return null;
  return (
    <BubbleMenu
      ref={menuRef}
      editor={editor}
      pluginKey={bubbleKey}
      options={{ placement: "top", flip: { boundary } }}
      shouldShow={({ editor: current, state: pm, view, element }) =>
        // Using the toolbar itself moves focus into it, and that shouldn't make it vanish.
        (view.hasFocus() || element.contains(document.activeElement)) &&
        current.isEditable &&
        !pm.selection.empty &&
        // A whole button or divider has no words to format.
        !(pm.selection instanceof NodeSelection) &&
        !current.isActive("codeBlock")
      }
      className="z-20 flex flex-wrap items-center gap-1 rounded-lg border border-ink/20 bg-paper p-1 shadow-lg"
    >
      <Tool
        label={intl.formatMessage({ id: "editor.bold" })}
        pressed={state.bold}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <strong>B</strong>
      </Tool>
      <Tool
        label={intl.formatMessage({ id: "editor.italic" })}
        pressed={state.italic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <em>I</em>
      </Tool>
      <Tool
        label={intl.formatMessage({ id: "editor.underline" })}
        pressed={state.underline}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <span className="underline">U</span>
      </Tool>
      <Tool
        label={intl.formatMessage({ id: "editor.strike" })}
        pressed={state.strike}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <span className="line-through">S</span>
      </Tool>
      <Tool
        label={intl.formatMessage({ id: "editor.inlineCode" })}
        pressed={state.code}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <code>{"</>"}</code>
      </Tool>
      <Tool pressed={state.link} onClick={onLink}>
        <FormattedMessage id="editor.link" />
      </Tool>
      <Tool
        // Starts with what's on the button, for anyone using voice control.
        label={`H2: ${intl.formatMessage({ id: "insert.heading2" })}`}
        pressed={state.h2}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        H2
      </Tool>
      <Tool
        // Starts with what's on the button, for anyone using voice control.
        label={`H3: ${intl.formatMessage({ id: "insert.heading3" })}`}
        pressed={state.h3}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        H3
      </Tool>
    </BubbleMenu>
  );
}

const bubbleKey = new PluginKey("tendSelectionToolbar");

const SLASH_WIDTH_PX = 256;
const SLASH_ROOM_PX = 280;

function SlashList({
  state,
  listId,
  nameOf,
}: {
  state: SlashState;
  listId: string;
  nameOf: (id: string) => string;
}) {
  const intl = useIntl();
  const ref = useRef<HTMLDivElement>(null);
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  // It's placed beside the cursor, so it has to follow when the page moves under it.
  useEffect(() => {
    window.addEventListener("scroll", redraw, { passive: true, capture: true });
    window.addEventListener("resize", redraw);
    return () => {
      window.removeEventListener("scroll", redraw, { capture: true });
      window.removeEventListener("resize", redraw);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the highlighted item
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);

  const rect = state.getRect();
  if (!rect) return null;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - SLASH_WIDTH_PX - 8));
  const above = rect.bottom + SLASH_ROOM_PX > window.innerHeight && rect.top > SLASH_ROOM_PX;
  return (
    <div
      ref={ref}
      id={listId}
      role="listbox"
      aria-label={intl.formatMessage({ id: "editor.slashLabel" })}
      style={{
        position: "fixed",
        left,
        width: Math.min(SLASH_WIDTH_PX, window.innerWidth - 16),
        ...(above ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      }}
      className="z-30 max-h-64 overflow-y-auto rounded-lg border border-ink/20 bg-paper p-1 shadow-lg"
    >
      {state.items.length === 0 && (
        <p className="px-3 py-2 text-muted">
          <FormattedMessage id="editor.slashNothing" />
        </p>
      )}
      {state.items.map((item, index) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard works from the text itself
        <div
          key={item.id}
          id={`${listId}-${item.id}`}
          role="option"
          tabIndex={-1}
          aria-selected={index === state.selected}
          // Keeps the cursor in the text, where the menu is working from.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => state.choose(item)}
          className="flex min-h-11 cursor-pointer items-center rounded px-3 hover:bg-ink/10 aria-selected:bg-ink aria-selected:text-paper"
        >
          {nameOf(item.id)}
        </div>
      ))}
    </div>
  );
}

/** Tables and pictures can't be stored yet, so nothing should vanish without a word. */
function tidyPastedHtml(html: string, notify: (ids: string[]) => void): string {
  const hasTable = /<table[\s>]/i.test(html);
  const notices = [
    ...(hasTable ? ["paste.table"] : []),
    ...(/<img[\s>]/i.test(html) ? ["paste.image"] : []),
  ];
  if (notices.length > 0) notify(notices);
  // The title is the page's only top-level heading, and three levels go below it.
  const tidied = html
    .replace(/<(\/?)h1(?=[\s>])/gi, "<$1h2")
    .replace(/<(\/?)h[56](?=[\s>])/gi, "<$1h4");
  return hasTable ? tablesAsLines(tidied) : tidied;
}

/**
 * A table becomes a line per row, with its cells kept apart, so opening hours stay readable
 * ("Mon · 9–5") rather than running together. Parsing this way loads nothing and runs nothing.
 */
function tablesAsLines(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const table of parsed.querySelectorAll("table")) {
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
  return parsed.body.innerHTML;
}

/**
 * A document always ends with an empty line for the cursor, as the editor would add itself.
 * Adding it here means opening something isn't counted as a change to it.
 */
function toEditorDoc(doc: Doc): Doc {
  return doc.content.at(-1)?.type === "paragraph"
    ? doc
    : { type: "doc", content: [...doc.content, { type: "paragraph" }] };
}

type LinkAsk =
  | { kind: "link"; href: string; canRemove: boolean }
  | { kind: "newButton" }
  | { kind: "editButton"; position: number; href: string; label: string };

export function BodyEditor({
  ref,
  initial,
  type,
  editable,
  labelledBy,
  onDocChange,
  onReady,
}: {
  ref: Ref<BodyHandle>;
  initial: Doc;
  type: EntryType;
  editable: boolean;
  labelledBy: string;
  /** With an immutable snapshot, which is safe to read after this screen has gone. */
  onDocChange: (doc: PmNode) => void;
  onReady: (doc: PmNode) => void;
}) {
  const intl = useIntl();
  const slashListId = useId();
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [ask, setAsk] = useState<LinkAsk | null>(null);
  const [startingDoc] = useState(() => toEditorDoc(initial));

  const callbacks = useRef({ onDocChange, onReady, intl });
  callbacks.current = { onDocChange, onReady, intl };

  const nameOf = (id: string) => intl.formatMessage({ id: `insert.${id}` });
  const items = useMemo(
    () => INSERT_ITEMS.filter((item) => !item.pagesOnly || type === "page"),
    [type],
  );

  function notifyMessages(ids: string[]): void {
    const { intl: words } = callbacks.current;
    showToast({ message: ids.map((id) => words.formatMessage({ id })).join(" "), sticky: true });
  }

  const extensions = useMemo(
    () =>
      editorExtensions({
        allowSections: type === "page",
        placeholder: callbacks.current.intl.formatMessage({ id: "editor.placeholder" }),
        onEditButton: (position, attrs) => setAsk({ kind: "editButton", position, ...attrs }),
        onSectionRemoved: (removed) => sectionRemovedRef.current(removed),
        slash: {
          items: (query) =>
            matchingItems(items, query, (id) =>
              callbacks.current.intl.formatMessage({ id: `insert.${id}` }),
            ),
          onState: setSlash,
          runItem: (item) => runRef.current(item),
        },
      }),
    [type, items],
  );

  const editor = useEditor({
    extensions,
    content: startingDoc,
    editable,
    // Only the small parts that show formatting follow every change, not this whole screen.
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-labelledby": labelledBy,
        class: "tend-prose min-h-80 p-3 outline-none",
      },
      // The sticky bar shouldn't cover the line being typed.
      scrollMargin: { top: 120, bottom: 24, left: 0, right: 0 },
      scrollThreshold: { top: 120, bottom: 24, left: 0, right: 0 },
      transformPastedHTML: (html) => tidyPastedHtml(html, notifyMessages),
      handlePaste: (_view, event) => {
        const data = event.clipboardData;
        const onlyFiles = data && data.files.length > 0 && !data.getData("text/plain");
        if (!onlyFiles) return false;
        notifyMessages(["paste.image"]);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = (event as DragEvent).dataTransfer?.files;
        if (!files || files.length === 0) return false;
        notifyMessages(["paste.image"]);
        return true;
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
          event.preventDefault();
          openLinkRef.current();
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor: created }) => callbacks.current.onReady(created.state.doc),
    onUpdate: ({ editor: changed }) => callbacks.current.onDocChange(changed.state.doc),
  });

  function runItem(item: InsertItem) {
    const worked = item.run(editor, { askForButton: () => setAsk({ kind: "newButton" }) });
    if (!worked) notifyMessages(["editor.cantGoHere"]);
  }
  const runRef = useRef(runItem);
  runRef.current = runItem;

  function openLink() {
    if (!canLink(editor)) return;
    const href = editor.getAttributes("link").href as string | undefined;
    setAsk({ kind: "link", href: href ?? "", canRemove: href !== undefined });
  }
  const openLinkRef = useRef(openLink);
  openLinkRef.current = openLink;

  const sectionRemovedRef = useRef((_removed: RemovedSection) => {});
  sectionRemovedRef.current = (removed) => {
    showToast({
      message: intl.formatMessage({ id: "editor.sectionRemoved" }),
      action: {
        label: intl.formatMessage({ id: "list.undo" }),
        // Puts back that section, not whatever was typed last, which a plain Undo would take.
        run: () => {
          const { doc } = editor.state;
          let at = Math.min(removed.position, doc.content.size);
          const $at = doc.resolve(at);
          if ($at.depth > 0) at = $at.before(1);
          editor.chain().focus().insertContentAt(at, removed.node).run();
        },
      },
    });
  };

  useImperativeHandle(
    ref,
    () => ({
      setDoc: (doc) => {
        editor.commands.setContent(toEditorDoc(doc), { emitUpdate: false });
        callbacks.current.onReady(editor.state.doc);
      },
      focusStart: () => editor.commands.focus("start"),
    }),
    [editor],
  );

  // Tiptap replaces an editor if this screen takes too long to appear, as on a slow phone, and
  // the old one is already gone when these run. They run again for the new one.
  useEffect(() => {
    if (editor.isDestroyed) return;
    editor.setEditable(editable, false);
    editor.view.dom.setAttribute("aria-readonly", String(!editable));
    // Nothing changes in the text, but what shows editing controls needs to hear about it.
    editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
  }, [editor, editable]);

  // The cursor stays in the text, so this is how the menu's highlight reaches a screen reader.
  const highlighted = slash?.items[slash.selected]?.id;
  useEffect(() => {
    if (editor.isDestroyed) return;
    const element = editor.view.dom;
    if (!slash) {
      element.removeAttribute("aria-controls");
      element.removeAttribute("aria-activedescendant");
      element.removeAttribute("aria-autocomplete");
      return;
    }
    element.setAttribute("aria-autocomplete", "list");
    element.setAttribute("aria-controls", slashListId);
    if (highlighted) element.setAttribute("aria-activedescendant", `${slashListId}-${highlighted}`);
    else element.removeAttribute("aria-activedescendant");
  }, [editor, slash, highlighted, slashListId]);

  const [wideScreen] = useState(
    () => window.matchMedia("(min-width: 768px) and (pointer: fine)").matches,
  );

  function closeAsk() {
    setAsk(null);
    editor.commands.focus();
  }

  /** The dialog hands focus back to the Edit button, so the page stays where it is. */
  function closeButtonAsk() {
    setAsk(null);
  }

  return (
    <div className="min-w-0 rounded-lg border border-muted bg-surface focus-within:outline-3 focus-within:outline-brand">
      <Toolbar editor={editor} items={items} nameOf={nameOf} onInsert={runItem} onLink={openLink} />
      <EditorContent editor={editor} />
      {wideScreen && <SelectionToolbar editor={editor} onLink={openLink} />}
      {slash && <SlashList state={slash} listId={slashListId} nameOf={nameOf} />}
      {ask?.kind === "link" && (
        <LinkDialog
          heading={intl.formatMessage({ id: "link.heading" })}
          initialHref={ask.href}
          onClose={closeAsk}
          onRemove={
            ask.canRemove
              ? () => {
                  setAsk(null);
                  editor.chain().focus().extendMarkRange("link").unsetLink().run();
                }
              : undefined
          }
          onSubmit={({ href, title }) => {
            setAsk(null);
            if (editor.state.selection.empty && !editor.isActive("link")) {
              // Nothing selected, so the link brings its own words. Never an internal ID.
              const words = href.startsWith("entry:")
                ? title || intl.formatMessage({ id: "list.untitled" })
                : href.replace(/^(?:mailto:|tel:|https?:\/\/)/, "");
              editor
                .chain()
                .focus()
                .insertContent({
                  type: "text",
                  text: words,
                  marks: [{ type: "link", attrs: { href } }],
                })
                .run();
            } else {
              editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
            }
          }}
        />
      )}
      {ask?.kind === "newButton" && (
        <LinkDialog
          heading={intl.formatMessage({ id: "link.buttonHeading" })}
          initialHref=""
          label=""
          onClose={closeAsk}
          onSubmit={({ href, label }) => {
            setAsk(null);
            // With a new line after it, so typing carries on rather than landing on the button.
            editor
              .chain()
              .focus()
              .insertContent([{ type: "button", attrs: { href, label } }, { type: "paragraph" }])
              .run();
          }}
        />
      )}
      {ask?.kind === "editButton" && (
        <LinkDialog
          heading={intl.formatMessage({ id: "link.buttonHeading" })}
          initialHref={ask.href}
          label={ask.label}
          onClose={closeButtonAsk}
          onRemove={() => {
            const { position } = ask;
            setAsk(null);
            const node = editor.state.doc.nodeAt(position);
            if (node) {
              editor
                .chain()
                .focus()
                .deleteRange({ from: position, to: position + node.nodeSize })
                .run();
            }
          }}
          onSubmit={({ href, label }) => {
            const { position } = ask;
            setAsk(null);
            const { tr } = editor.state;
            editor.view.dispatch(tr.setNodeMarkup(position, undefined, { href, label }));
          }}
        />
      )}
    </div>
  );
}
