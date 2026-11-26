import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment } from "@tiptap/pm/model";
import { useEditorState } from "@tiptap/react";
import { Icon } from "../components/icons.tsx";

// Moving a section or a picture with a button (PLAN.md v0.2): nothing in the writing can be
// dragged, and on a phone dragging is hard anyway. A block swaps places with the one before or
// after it, inside whatever holds it.

export type Direction = "up" | "down";

/** The block that's there to swap with, if there is one worth swapping with. */
function neighbour(editor: Editor, position: number, direction: Direction) {
  const { doc } = editor.state;
  if (position < 0 || position > doc.content.size) return null;
  const node = doc.nodeAt(position);
  if (!node) return null;
  const $at = doc.resolve(position);
  const parent = $at.parent;
  const index = $at.index();
  const otherIndex = index + (direction === "up" ? -1 : 1);
  if (otherIndex < 0 || otherIndex >= parent.childCount) return null;
  const other = parent.child(otherIndex);
  // The empty line the editor keeps at the end, to type after the last block, isn't one.
  const keptAtEnd =
    $at.depth === 0 &&
    otherIndex === parent.childCount - 1 &&
    other.type.name === "paragraph" &&
    other.content.size === 0;
  if (keptAtEnd) return null;
  // Only where the two may stand the other way round: a list item starts with its words, say.
  // Any order will do at the top of a page, which can be long, so that isn't checked.
  const swapped = Fragment.from(direction === "up" ? [node, other] : [other, node]);
  const first = Math.min(index, otherIndex);
  if ($at.depth > 0 && !parent.canReplace(first, first + 2, swapped)) return null;
  return { node, other, swapped };
}

export function canMove(editor: Editor, position: number, direction: Direction): boolean {
  return neighbour(editor, position, direction) !== null;
}

/**
 * Swaps the block at `position` with the one before or after it, as a step of its own for Undo.
 * Returns where it starts now, or null if there's nothing to swap with.
 */
export function moveBlock(editor: Editor, position: number, direction: Direction): number | null {
  const found = neighbour(editor, position, direction);
  if (!found) return null;
  const { node, other, swapped } = found;
  // Both at once, in one step, so the writing is never without either of them in between.
  const from = direction === "up" ? position - other.nodeSize : position;
  const tr = editor.state.tr.replaceWith(from, from + node.nodeSize + other.nodeSize, swapped);
  const moved = direction === "up" ? from : position + other.nodeSize;
  // Its own step: Undo takes back the move, and not the typing before it as well.
  editor.view.dispatch(closeHistory(tr).scrollIntoView());
  return moved;
}

/** Up and down, for a block that can be moved, each saying what it moves to a screen reader. */
export function MoveButtons({
  editor,
  getPos,
  labels,
  className,
}: {
  editor: Editor;
  getPos: () => number | undefined;
  labels: Record<Direction, string>;
  className: string;
}) {
  const can = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const at = getPos();
      return {
        up: typeof at === "number" && canMove(current, at, "up"),
        down: typeof at === "number" && canMove(current, at, "down"),
      };
    },
  });
  return (
    <span className="flex shrink-0">
      {(["up", "down"] as const).map((direction) => (
        <button
          key={direction}
          type="button"
          data-move={direction}
          aria-label={labels[direction]}
          title={labels[direction]}
          // Still there to reach with the keyboard, saying it can't move that way.
          aria-disabled={!can[direction]}
          onClick={() => {
            const at = getPos();
            if (typeof at !== "number" || !can[direction]) return;
            const moved = moveBlock(editor, at, direction);
            if (moved !== null) focusMoved(editor, moved, direction);
          }}
          className={`${className} aria-disabled:opacity-40`}
        >
          <Icon name={direction === "up" ? "moveUp" : "moveDown"} className="size-4.5" />
        </button>
      ))}
    </span>
  );
}

/**
 * Keeps the keyboard on the button that was pressed, in the block where it went, so it can be
 * pressed again. A block that's drawn afresh only has its buttons a moment later.
 */
export function focusMoved(editor: Editor, position: number, direction: Direction): void {
  const button = () => {
    const dom = editor.view.nodeDOM(position);
    return dom instanceof HTMLElement
      ? dom.querySelector<HTMLElement>(`[data-move="${direction}"]`)
      : null;
  };
  const now = button();
  if (now) {
    now.focus({ preventScroll: true });
    return;
  }
  requestAnimationFrame(() => {
    if (editor.isDestroyed) return;
    const later = button();
    if (later) later.focus({ preventScroll: true });
    else editor.commands.focus();
  });
}
