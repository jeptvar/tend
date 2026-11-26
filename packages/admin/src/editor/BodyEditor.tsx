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
import { flushSync } from "react-dom";
import { FormattedMessage, useIntl } from "react-intl";
import { Icon, type IconName } from "../components/icons.tsx";
import { MediaPicker } from "../components/MediaPicker.tsx";
import { showToast } from "../components/Toast.tsx";
import type { Doc } from "../lib/doc.ts";
import { type MediaItem, uploadWords, useMediaItems } from "../lib/media.ts";
import type { EntryType } from "../lib/queries.ts";
import { AltDialog } from "./AltDialog.tsx";
import type { CheckTarget } from "./checks.ts";
import { INSERT_ITEMS, type InsertItem, matchingItems } from "./commands.ts";
import { editorExtensions } from "./extensions.ts";
import { UPLOAD_META } from "./ImageNode.tsx";
import { LinkDialog } from "./LinkDialog.tsx";
import type { RemovedSection } from "./nodes.tsx";
import { tidyPasted } from "./paste.ts";
import "./page.css";
import type { SlashState } from "./slash.ts";
import { forgetUpload, getUpload, isUploading, startUpload } from "./uploads.ts";

export interface BodyHandle {
  /** Replaces the words: a conflict resolved, or an older version brought back. */
  setDoc(doc: Doc): void;
  focusStart(): void;
  /** Goes to what a check is about. False if it isn't in the words. */
  goTo(target: CheckTarget): boolean;
}

/**
 * Closes a dialog and puts the keyboard back in the text, at once, before the text changes.
 * Otherwise focus comes back a moment after the dialog closes, with the cursor where it was
 * before the dialog opened, and the first letters typed in that moment don't end up where
 * the cursor then goes: "Next line" became "xt line". Until Tiptap 3.33, drawing an inserted
 * button or picture happened to close the dialog early enough. Only call this from an event,
 * like a click: React can't close anything while it's drawing.
 */
function backToText(editor: Editor, close: () => void): void {
  flushSync(close);
  editor.view.focus();
}

// A pressed button shows it with the whole background, because a faint tint can't be told
// apart at the 3:1 that WCAG asks of something that shows state.
const toolClass =
  "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl hover:bg-ink/6 focus-visible:outline-3 focus-visible:outline-brand aria-disabled:opacity-40 aria-pressed:bg-brand aria-pressed:text-on-brand";

function Tool({
  label,
  pressed,
  disabled,
  onClick,
  className = "",
  children,
}: {
  /** Said, and shown when it's pointed at. What's on it is a drawing, or a letter. */
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      // aria-disabled, so a button that's just been used keeps keyboard focus.
      aria-disabled={disabled}
      // The selection has to stay where it is, or there's nothing to format.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (!disabled) onClick();
      }}
      className={`${toolClass} ${className}`}
    >
      {children}
    </button>
  );
}

function Gap({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`mx-1 h-6 w-px shrink-0 bg-line ${className}`} />;
}

/** Links are for words: not code, where nothing's formatted, and not a whole button. */
function canLink(editor: Editor): boolean {
  return (
    editor.isEditable &&
    !editor.isActive("codeBlock") &&
    !(editor.state.selection instanceof NodeSelection)
  );
}

interface Choice {
  id: string;
  name: string;
  icon: IconName;
  /** For a menu that says which one it is now. */
  chosen?: boolean;
}

/** A button that shows what there is to choose from. */
function ToolMenu({
  label,
  choices,
  onChoose,
  disabled,
  className,
  atEnd = false,
  children,
}: {
  /** If it says more than what's on the button. */
  label?: string;
  choices: Choice[];
  onChoose: (id: string) => void;
  disabled: boolean;
  className: string;
  /** Lined up with the button's end, for one at the end of a row. */
  atEnd?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    (menu?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu?.querySelector("button"))
      // Where it already shows is where it's meant to be read.
      ?.focus({ preventScroll: true });
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
    <div className={`relative shrink-0 ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen(!open);
        }}
        className="inline-flex min-h-11 w-full min-w-11 items-center justify-center gap-2 rounded-xl px-3 font-semibold hover:bg-ink/6 focus-visible:outline-3 focus-visible:outline-brand aria-disabled:opacity-40"
      >
        {children}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={move}
          className={`absolute top-full z-30 mt-2 max-h-[min(38rem,66dvh)] w-64 overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 text-ink shadow-raised max-md:top-auto max-md:bottom-full max-md:mb-2 max-md:max-h-[50dvh] ${
            atEnd ? "end-0" : "start-0"
          }`}
        >
          {choices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              tabIndex={-1}
              {...(choice.chosen === undefined
                ? { role: "menuitem" }
                : { role: "menuitemradio", "aria-checked": choice.chosen })}
              onClick={() => {
                setOpen(false);
                onChoose(choice.id);
              }}
              className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 text-start hover:bg-ink/6 focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-brand"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-mint text-brand">
                <Icon name={choice.icon} className="size-4.5" />
              </span>
              <span className="min-w-0 flex-1">{choice.name}</span>
              {choice.chosen && <Icon name="done" className="size-4.5 text-brand" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** How a line of words looks, biggest first but for the usual one. */
const STYLES = ["text", "heading2", "heading3", "heading4"] as const;

function Toolbar({
  editor,
  items,
  nameOf,
  onInsert,
  onLink,
  onNotHere,
}: {
  editor: Editor;
  items: InsertItem[];
  nameOf: (id: string) => string;
  onInsert: (item: InsertItem) => void;
  onLink: () => void;
  /** Says that something can't go where the cursor is. */
  onNotHere: () => void;
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
      list: current.isActive("bulletList"),
      quote: current.isActive("blockquote"),
      code: current.isActive("codeBlock"),
      style: ([2, 3, 4] as const).find((level) => current.isActive("heading", { level })),
    }),
  });
  const locked = !state.editable;
  const style = state.style ? `heading${state.style}` : "text";
  const styleName = (id: string) =>
    id === "text" ? intl.formatMessage({ id: "editor.styleText" }) : nameOf(id);
  const styleNow = state.code ? nameOf("code") : styleName(style);
  const insert = (id: string) => {
    const item = items.find((other) => other.id === id);
    if (item) onInsert(item);
  };
  // Back in the text as the menu goes, not a frame later as Tiptap's focus() does. A key
  // pressed in between went to the page instead: Tab to the button after the menu, and words
  // typed nowhere at all.
  const fromMenu = (choose: (id: string) => void) => (id: string) => {
    editor.view.focus();
    choose(id);
  };
  return (
    <div className="tend-tools tend-sticky">
      <fieldset className="pointer-events-auto flex w-full min-w-0 items-center justify-between md:w-auto md:rounded-2xl md:border md:border-line md:bg-surface md:p-1 md:shadow-raised">
        <legend className="sr-only">{intl.formatMessage({ id: "editor.formatting" })}</legend>
        <Tool
          label={intl.formatMessage({ id: "editor.undo" })}
          disabled={locked || !state.canUndo}
          onClick={() => editor.chain().focus().undo().run()}
        >
          <Icon name="undo" />
        </Tool>
        <Tool
          label={intl.formatMessage({ id: "editor.redo" })}
          disabled={locked || !state.canRedo}
          onClick={() => editor.chain().focus().redo().run()}
        >
          <Icon name="redo" />
        </Tool>
        <Gap className="max-md:hidden" />
        <ToolMenu
          label={intl.formatMessage({ id: "editor.textStyle" }, { style: styleNow })}
          choices={STYLES.map((id) => ({
            id,
            name: styleName(id),
            icon: id,
            chosen: !state.code && id === style,
          }))}
          onChoose={fromMenu((id) => {
            const level = STYLES.indexOf(id as (typeof STYLES)[number]) + 1;
            const chain = editor.chain().focus();
            const worked =
              id === "text"
                ? chain.setParagraph().run()
                : chain.setHeading({ level: level as 2 | 3 | 4 }).run();
            if (!worked) onNotHere();
          })}
          disabled={locked}
          className="max-md:hidden"
        >
          <span className="max-w-32 truncate font-medium">{styleNow}</span>
          <Icon name="down" className="size-4" />
        </ToolMenu>
        <Gap className="max-md:hidden" />
        <Tool
          label={intl.formatMessage({ id: "editor.bold" })}
          pressed={state.bold}
          disabled={locked || !state.canBold}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Icon name="bold" />
        </Tool>
        <Tool
          label={intl.formatMessage({ id: "editor.italic" })}
          pressed={state.italic}
          disabled={locked || !state.canItalic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Icon name="italic" />
        </Tool>
        <Tool
          label={intl.formatMessage({ id: "editor.link" })}
          pressed={state.link}
          disabled={!state.canLink}
          onClick={onLink}
        >
          <Icon name="link" />
        </Tool>
        <Gap className="max-md:hidden" />
        <Tool
          label={nameOf("bulletList")}
          pressed={state.list}
          disabled={locked}
          onClick={() => insert("bulletList")}
        >
          <Icon name="bulletList" />
        </Tool>
        <Tool
          label={nameOf("quote")}
          pressed={state.quote}
          disabled={locked}
          onClick={() => insert("quote")}
          className="max-md:hidden"
        >
          <Icon name="quote" />
        </Tool>
        <Tool
          label={nameOf("image")}
          disabled={locked}
          onClick={() => insert("image")}
          className="max-md:hidden"
        >
          <Icon name="media" />
        </Tool>
        <Gap className="max-md:hidden" />
        <ToolMenu
          choices={items.map(({ id, icon }) => ({ id, icon, name: nameOf(id) }))}
          onChoose={fromMenu(insert)}
          disabled={locked}
          atEnd
          className="rounded-xl bg-mint text-brand-strong"
        >
          <Icon name="add" className="size-4.5" />
          <span className="max-[23rem]:sr-only">
            <FormattedMessage id="editor.insert" />
          </span>
        </ToolMenu>
      </fieldset>
    </div>
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
      className="z-20 flex flex-wrap items-center rounded-2xl border border-line bg-surface p-1 text-base shadow-raised"
    >
      <Tool
        label={intl.formatMessage({ id: "editor.bold" })}
        pressed={state.bold}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Icon name="bold" />
      </Tool>
      <Tool
        label={intl.formatMessage({ id: "editor.italic" })}
        pressed={state.italic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Icon name="italic" />
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
        <Icon name="code" />
      </Tool>
      <Tool label={intl.formatMessage({ id: "editor.link" })} pressed={state.link} onClick={onLink}>
        <Icon name="link" />
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

const SLASH_WIDTH_PX = 272;
const SLASH_ROOM_PX = 336;

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
      className="z-40 max-h-80 overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 shadow-raised"
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
          className="group flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-2.5 hover:bg-ink/6 aria-selected:bg-brand aria-selected:text-on-brand"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-mint text-brand">
            <Icon name={item.icon} className="size-4.5" />
          </span>
          {nameOf(item.id)}
        </div>
      ))}
    </div>
  );
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

/** Whether this part of the words is what a check is about. */
function isTarget(node: PmNode, target: CheckTarget, headingsBefore: number): boolean {
  const linksTo = (matches: (href: string) => boolean) =>
    node.marks.some((mark) => mark.type.name === "link" && matches(String(mark.attrs.href)));
  switch (target.kind) {
    case "describe":
    case "picture":
      return node.type.name === "image" && node.attrs.mediaId === target.mediaId;
    case "upload":
      return (
        node.type.name === "image" &&
        !node.attrs.mediaId &&
        Boolean(getUpload(String(node.attrs.uploadId))?.error)
      );
    case "link":
      return (
        linksTo((href) => href === target.href) ||
        (node.type.name === "button" && node.attrs.href === target.href)
      );
    case "words":
      return linksTo(() => true) && node.text?.trim() === target.words;
    case "heading":
      return node.type.name === "heading" && headingsBefore === target.index;
    case "button":
      return (
        node.type.name === "button" && !node.attrs.href && String(node.attrs.label) === target.label
      );
    default:
      return false;
  }
}

/**
 * Goes to what a check is about, and opens the dialog that fixes it where there's one: a
 * picture's description, or where a button goes.
 */
function goTo(
  editor: Editor,
  target: CheckTarget,
  setAsk: (ask: LinkAsk) => void,
  setDescribing: (mediaId: string) => void,
): boolean {
  if (target.kind === "start") return editor.commands.focus("start");
  let at: number | undefined;
  let found: PmNode | undefined;
  let headings = 0;
  editor.state.doc.descendants((node, position) => {
    if (found) return false;
    if (isTarget(node, target, headings)) {
      found = node;
      at = position;
    }
    if (node.type.name === "heading") headings++;
    return !found;
  });
  // A picture's description is the same wherever it's shown, so it needn't be in the words.
  if (target.kind === "describe") setDescribing(target.mediaId);
  if (!found || at === undefined) return target.kind === "describe";

  const chain = editor.chain();
  if (found.isText) chain.setTextSelection({ from: at, to: at + found.nodeSize });
  else if (found.type.name === "heading") chain.setTextSelection(at + 1);
  else chain.setNodeSelection(at);
  if (target.kind === "describe") chain.scrollIntoView().run();
  else chain.focus(undefined, { scrollIntoView: true }).run();
  if (target.kind === "button") {
    setAsk({
      kind: "editButton",
      position: at,
      href: String(found.attrs.href),
      label: String(found.attrs.label),
    });
  }
  return true;
}

type LinkAsk =
  | { kind: "link"; href: string; canRemove: boolean }
  | { kind: "newButton" }
  | { kind: "editButton"; position: number; href: string; label: string };

/** Whether pasted HTML holds words, not just a picture. Parsing it this way runs nothing. */
function htmlHasWords(html: string): boolean {
  if (!html) return false;
  return Boolean(new DOMParser().parseFromString(html, "text/html").body.textContent?.trim());
}

/**
 * Keeps how much of the window a phone's keyboard covers in `--tend-keyboard`, so the toolbar at
 * the bottom can stay above it. The window itself doesn't get smaller when the keyboard opens.
 */
function useKeyboardRoom(): void {
  useEffect(() => {
    const view = window.visualViewport;
    if (!view) return;
    const root = document.documentElement;
    const measure = () => {
      // Zoomed in, less of the page shows for another reason.
      const covered = view.scale > 1.01 ? 0 : window.innerHeight - view.height - view.offsetTop;
      root.style.setProperty("--tend-keyboard", `${Math.max(0, Math.round(covered))}px`);
    };
    measure();
    view.addEventListener("resize", measure);
    view.addEventListener("scroll", measure);
    return () => {
      view.removeEventListener("resize", measure);
      view.removeEventListener("scroll", measure);
      root.style.removeProperty("--tend-keyboard");
    };
  }, []);
}

/** The description dialog, once the picture it's about is known. */
function DescribeImage({ mediaId, onClose }: { mediaId: string; onClose: () => void }) {
  const { found, isPending } = useMediaItems([mediaId]);
  const item = found.get(mediaId);
  useEffect(() => {
    if (!isPending && !item) onClose();
  }, [isPending, item, onClose]);
  return item ? <AltDialog item={item} onClose={onClose} /> : null;
}

export function BodyEditor({
  ref,
  initial,
  type,
  editable,
  canEditBusiness = false,
  labelledBy,
  title,
  onDocChange,
  onReady,
}: {
  ref: Ref<BodyHandle>;
  initial: Doc;
  type: EntryType;
  editable: boolean;
  /** Whether this person can change the business details, for Contact & hours. */
  canEditBusiness?: boolean;
  labelledBy: string;
  /** What's above the words, under the toolbar. */
  title: ReactNode;
  /** With an immutable snapshot, which is safe to read after this screen has gone. */
  onDocChange: (doc: PmNode) => void;
  onReady: (doc: PmNode) => void;
}) {
  const intl = useIntl();
  const slashListId = useId();
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [ask, setAsk] = useState<LinkAsk | null>(null);
  // Picking a picture, and what for: the text, or a Picture and text section.
  const [picking, setPicking] = useState<null | { use?: (mediaId: string) => void }>(null);
  const [describing, setDescribing] = useState<string | null>(null);
  const [startingDoc] = useState(() => toEditorDoc(initial));
  /** When someone last changed the words, as opposed to an upload arriving. */
  const lastTyped = useRef(0);
  /** Uploads started here, to say what happened to any still going when this closes. */
  const started = useRef(new Set<string>());

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
        onDescribeImage: (mediaId) => setDescribing(mediaId),
        onPickImage: (use) => setPicking({ use }),
        onUploaded: (item, startedAt) => uploadedRef.current(item, startedAt),
        onSectionRemoved: (removed) => sectionRemovedRef.current(removed),
        canEditBusiness,
        slash: {
          items: (query) =>
            matchingItems(items, query, (id) =>
              callbacks.current.intl.formatMessage({ id: `insert.${id}` }),
            ),
          onState: setSlash,
          runItem: (item) => runRef.current(item),
        },
      }),
    [type, items, canEditBusiness],
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
        class: "tend-prose outline-none",
      },
      // The bars at the top, or a phone's at the bottom, shouldn't cover the line being typed.
      // More than page.css asks for (scroll-padding), or Safari moves the page again: to it, a
      // cursor reaches up to the line above, so the space between two lines counts as well.
      scrollMargin: { top: 176, bottom: 96, left: 0, right: 0 },
      scrollThreshold: { top: 176, bottom: 96, left: 0, right: 0 },
      transformPastedHTML: (html) => {
        const tidied = tidyPasted(html);
        if (tidied.notices.length > 0) notifyMessages(tidied.notices);
        return tidied.html;
      },
      // A pasted or dropped file uploads where it lands, and shows how it's going there.
      handlePaste: (view, event) => {
        const data = event.clipboardData;
        const files = [...(data?.files ?? [])];
        // Word and others add a picture of what was copied alongside its words: the words
        // are what's wanted then. A copied photo, or a file from a folder, has none.
        if (files.length === 0 || htmlHasWords(data?.getData("text/html") ?? "")) return false;
        uploadsRef.current(files, view.state.selection.from);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
        if (moved || files.length === 0) return false;
        const { clientX: left, clientY: top } = event as DragEvent;
        uploadsRef.current(
          files,
          view.posAtCoords({ left, top })?.pos ?? view.state.selection.from,
        );
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
    onUpdate: ({ editor: changed, transaction }) => {
      if (!transaction.getMeta(UPLOAD_META)) lastTyped.current = Date.now();
      callbacks.current.onDocChange(changed.state.doc);
    },
  });

  function runItem(item: InsertItem) {
    const worked = item.run(editor, {
      askForButton: () => setAsk({ kind: "newButton" }),
      askForImage: (use) => setPicking(use ? { use } : {}),
    });
    if (!worked) notifyMessages(["editor.cantGoHere"]);
  }

  /** Puts a placeholder for each file where it was dropped, and starts sending them. */
  function insertUploads(files: File[], position: number) {
    if (!editor.isEditable) return;
    const words = { ...uploadWords(intl), tooBig: intl.formatMessage({ id: "media.tooBig" }) };
    const nodes = files.map((file) => {
      const uploadId = startUpload(file, words);
      started.current.add(uploadId);
      return { type: "image", attrs: { uploadId } };
    });
    const at = Math.min(position, editor.state.doc.content.size);
    editor.chain().focus().insertContentAt(at, nodes).setMeta(UPLOAD_META, true).run();
    leaveRoomToType(true);
  }

  /**
   * After a picture goes in, typing carries on after it. Left selected, the picture would
   * be replaced by the next key typed. If nothing follows it to type into, an empty line
   * does.
   */
  function leaveRoomToType(fromUpload: boolean) {
    const { selection, doc } = editor.state;
    const after =
      selection instanceof NodeSelection && selection.node.type.name === "image"
        ? selection.to
        : undefined;
    if (after === undefined) return;
    const next = doc.resolve(after).nodeAfter;
    const chain = editor.chain();
    if (next?.type.name !== "paragraph") chain.insertContentAt(after, { type: "paragraph" });
    chain.setTextSelection(after + 1);
    if (fromUpload) chain.setMeta(UPLOAD_META, true);
    chain.run();
  }

  /**
   * Asks for a description as soon as an upload arrives, but only if nothing's been typed
   * since it was dropped, and nothing else is open: otherwise the next keys would land in
   * the dialog. The picture says it has no description either way.
   */
  function uploaded(item: MediaItem, startedAt: number) {
    if (item.kind !== "image" || item.alt || item.decorative) return;
    if (lastTyped.current > startedAt || document.querySelector("dialog[open]")) return;
    setDescribing((current) => current ?? item.id);
  }
  const uploadedRef = useRef(uploaded);
  uploadedRef.current = uploaded;
  const uploadsRef = useRef(insertUploads);
  uploadsRef.current = insertUploads;

  function insertPicked(item: MediaItem) {
    const use = picking?.use;
    // A section's picture hands focus back to whatever chose it, as the picker does.
    if (use) setPicking(null);
    else backToText(editor, () => setPicking(null));
    if (!item.alt && !item.decorative) setDescribing((current) => current ?? item.id);
    if (use) {
      use(item.id);
      return;
    }
    editor
      .chain()
      .insertContent({ type: "image", attrs: { mediaId: item.id } })
      .run();
    leaveRoomToType(false);
  }

  // Leaving with an upload still going: it finishes into Media, but can't reach these
  // words any more, so that's said, with its name, rather than it quietly going missing.
  useEffect(() => {
    const mine = started.current;
    return () => {
      const going = [...mine].map(getUpload).filter(isUploading);
      const failed = [...mine].map(getUpload).filter((upload) => upload?.error);
      for (const id of mine) if (!isUploading(getUpload(id))) forgetUpload(id);
      const { intl: words } = callbacks.current;
      if (going.length > 0) {
        showToast({
          message: words.formatMessage(
            { id: "editor.uploadLeftBehind" },
            { names: going.map((upload) => `"${upload?.name}"`).join(", "), count: going.length },
          ),
          sticky: true,
        });
      } else if (failed.length > 0) {
        showToast({
          message: words.formatMessage(
            { id: "editor.uploadFailedLeft" },
            { names: failed.map((upload) => `"${upload?.name}"`).join(", "), count: failed.length },
          ),
          sticky: true,
        });
      }
    };
  }, []);

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
      goTo: (target) => goTo(editor, target, setAsk, setDescribing),
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
    backToText(editor, () => setAsk(null));
  }

  /** The dialog hands focus back to the Edit button, so the page stays where it is. */
  function closeButtonAsk() {
    setAsk(null);
  }

  useKeyboardRoom();

  return (
    <div className="min-w-0">
      <Toolbar
        editor={editor}
        items={items}
        nameOf={nameOf}
        onInsert={runItem}
        onLink={openLink}
        onNotHere={() => notifyMessages(["editor.cantGoHere"])}
      />
      {title}
      <EditorContent editor={editor} />
      {wideScreen && <SelectionToolbar editor={editor} onLink={openLink} />}
      {slash && <SlashList state={slash} listId={slashListId} nameOf={nameOf} />}
      {picking && (
        <MediaPicker
          heading={intl.formatMessage({ id: "picker.heading" })}
          onPick={insertPicked}
          // A section's picture uploads in the picker, since the section needs it first.
          {...(picking.use
            ? {}
            : {
                onFiles: (files: File[]) => {
                  backToText(editor, () => setPicking(null));
                  insertUploads(files, editor.state.selection.from);
                },
              })}
          onClose={() => backToText(editor, () => setPicking(null))}
        />
      )}
      {describing && (
        <DescribeImage
          key={describing}
          mediaId={describing}
          onClose={() => backToText(editor, () => setDescribing(null))}
        />
      )}
      {ask?.kind === "link" && (
        <LinkDialog
          heading={intl.formatMessage({ id: "link.heading" })}
          initialHref={ask.href}
          onClose={closeAsk}
          onRemove={
            ask.canRemove
              ? () => {
                  backToText(editor, () => setAsk(null));
                  editor.chain().extendMarkRange("link").unsetLink().run();
                }
              : undefined
          }
          onSubmit={({ href, title }) => {
            backToText(editor, () => setAsk(null));
            if (editor.state.selection.empty && !editor.isActive("link")) {
              // Nothing selected, so the link brings its own words. Never an internal ID.
              const words = href.startsWith("entry:")
                ? title || intl.formatMessage({ id: "list.untitled" })
                : href.replace(/^(?:mailto:|tel:|https?:\/\/)/, "");
              editor
                .chain()
                .insertContent({
                  type: "text",
                  text: words,
                  marks: [{ type: "link", attrs: { href } }],
                })
                .run();
            } else {
              editor.chain().extendMarkRange("link").setLink({ href }).run();
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
            backToText(editor, () => setAsk(null));
            // With a new line after it, so typing carries on rather than landing on the button.
            editor
              .chain()
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
            // The Edit button goes with the button, so the keyboard goes back to the text.
            backToText(editor, () => setAsk(null));
            const node = editor.state.doc.nodeAt(position);
            if (node) {
              editor
                .chain()
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
