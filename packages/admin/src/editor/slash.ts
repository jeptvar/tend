import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { exitSuggestion, Suggestion, type SuggestionProps } from "@tiptap/suggestion";
import type { InsertItem } from "./commands.ts";

/** What's showing in the "/" menu, for the React component that draws it. */
export interface SlashState {
  items: InsertItem[];
  selected: number;
  /** A function, because the place it belongs moves when the page scrolls. */
  getRect: () => DOMRect | null;
  choose: (item: InsertItem) => void;
}

export interface SlashOptions {
  items: (query: string) => InsertItem[];
  onState: (state: SlashState | null) => void;
  runItem: (item: InsertItem) => void;
}

const slashKey = new PluginKey("tendSlash");

/** The "/" menu: type a slash to see what can be added, and keep typing to narrow it down. */
export const SlashMenu = Extension.create<SlashOptions>({
  name: "tendSlash",

  addOptions() {
    return { items: () => [], onState: () => {}, runItem: () => {} };
  },

  // Clicking somewhere else mustn't leave the menu behind, still acting on the document.
  onBlur() {
    exitSuggestion(this.editor.view, slashKey);
  },

  addProseMirrorPlugins() {
    const { onState, items, runItem } = this.options;
    let selected = 0;
    let latest: SuggestionProps<InsertItem, InsertItem> | null = null;

    function draw(): void {
      if (!latest) {
        onState(null);
        return;
      }
      const props = latest;
      onState({
        items: props.items,
        selected,
        getRect: () => props.clientRect?.() ?? null,
        choose: (item) => props.command(item),
      });
    }

    return [
      Suggestion<InsertItem, InsertItem>({
        editor: this.editor,
        pluginKey: slashKey,
        char: "/",
        allowedPrefixes: [" "],
        // Names can have spaces in them, like "Small heading".
        allowSpaces: true,
        allow: ({ state, range }) => {
          // No slash menu inside code, where a slash is just a slash.
          if (state.doc.resolve(range.from).parent.type.name === "codeBlock") return false;
          // Words after a slash that don't match anything are just someone writing.
          const query = state.doc.textBetween(range.from + 1, range.to);
          return !query.includes(" ") || items(query).length > 0;
        },
        items: ({ query }) => items(query),
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).run();
          runItem(props);
        },
        render: () => ({
          onStart: (props) => {
            selected = 0;
            latest = props;
            draw();
          },
          onUpdate: (props) => {
            selected = 0;
            latest = props;
            draw();
          },
          onExit: () => {
            latest = null;
            draw();
          },
          onKeyDown: ({ event, view }) => {
            const count = latest?.items.length ?? 0;
            if (event.key === "Escape") {
              exitSuggestion(view, slashKey);
              return true;
            }
            if (count === 0) return false;
            if (event.key === "ArrowDown") {
              selected = (selected + 1) % count;
              draw();
              return true;
            }
            if (event.key === "ArrowUp") {
              selected = (selected - 1 + count) % count;
              draw();
              return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              const item = latest?.items[selected];
              if (item) latest?.command(item);
              return true;
            }
            return false;
          },
        }),
      }),
    ];
  },
});
