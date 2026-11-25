import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import {
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Icon } from "../components/icons.tsx";
import { Problem } from "../components/Problem.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { dismissToast, showToast } from "../components/Toast.tsx";
import { Waiting } from "../components/Waiting.tsx";
import { api, errorText } from "../lib/api.ts";
import { toHref } from "../lib/href.ts";
import { linkTargets } from "../lib/link-targets.ts";
import type { Me } from "../lib/queries.ts";
import { type ScreenDraft, settleScreenDraft, useScreenDraft } from "../lib/screen-drafts.ts";
import {
  MENUS_KEY,
  type MenuItem,
  type MenuLeaf,
  type MenusReply,
  type MenuTarget,
  newLinkId,
} from "../lib/site.ts";

type MenuName = "main" | "footer";

const SEARCH_DELAY_MS = 200;
const smallButtonClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-line bg-surface px-3 text-sm hover:border-brand focus-visible:outline-3 focus-visible:outline-brand aria-disabled:opacity-40 aria-disabled:hover:border-line";

interface Known {
  title: string | null;
  url: string | null;
}

interface Tag {
  id: string;
  name: string;
  slug: string;
}

/** A copy without the bits only the server adds. */
function itemsOf(menu: { items: MenuItem[] }): MenuItem[] {
  return menu.items.map((item) => ({
    id: item.id,
    label: item.label,
    target: item.target,
    children: (item.children ?? []).map((child) => ({
      id: child.id,
      label: child.label,
      target: child.target,
    })),
  }));
}

/** Where a typed address points, as a menu link. */
function targetFromHref(href: string): MenuTarget {
  if (href.startsWith("entry:")) return { type: "entry", id: href.slice("entry:".length) };
  if (href === "/") return { type: "home" };
  if (href === "/blog") return { type: "blog" };
  return { type: "url", url: href };
}

function AddLinkDialog({
  onAdd,
  onClose,
}: {
  onAdd: (target: MenuTarget, known: Known) => void;
  onClose: () => void;
}) {
  const intl = useIntl();
  const headingId = useId();
  const searchId = useId();
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const found = useQuery(linkTargets(query));
  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: () => api<{ tags: Tag[] }>("/admin/tags"),
    staleTime: 60_000,
  });

  const words = query.toLowerCase();
  const matches = (name: string) => !words || name.toLowerCase().includes(words);
  const typedHref = toHref(typed);
  const looksLikeAddress = typedHref !== null && /^(https?:|mailto:|tel:|\/)/.test(typedHref);

  const options: {
    key: string;
    label: string;
    detail: string;
    target: MenuTarget;
    known: Known;
  }[] = [];
  if (looksLikeAddress && typedHref) {
    options.push({
      key: "typed",
      label: intl.formatMessage({ id: "menu.linkTo" }, { address: typedHref }),
      detail: "",
      target: targetFromHref(typedHref),
      known: { title: null, url: typedHref },
    });
  }
  const homepage = intl.formatMessage({ id: "menu.homepage" });
  if (matches(homepage)) {
    options.push({
      key: "home",
      label: homepage,
      detail: "/",
      target: { type: "home" },
      known: { title: homepage, url: "/" },
    });
  }
  if (matches("Blog")) {
    options.push({
      key: "blog",
      label: "Blog",
      detail: "/blog",
      target: { type: "blog" },
      known: { title: "Blog", url: "/blog" },
    });
  }
  for (const target of found.data ?? []) {
    options.push({
      key: target.id,
      label: target.title || intl.formatMessage({ id: "list.untitled" }),
      detail: target.url ?? intl.formatMessage({ id: "link.notOnSite" }),
      target: { type: "entry", id: target.id },
      known: { title: target.title, url: target.url },
    });
  }
  for (const tag of (tags.data?.tags ?? []).filter((tag) => matches(tag.name)).slice(0, 5)) {
    options.push({
      key: `tag-${tag.id}`,
      label: intl.formatMessage({ id: "menu.tag" }, { name: tag.name }),
      detail: `/tag/${tag.slug}`,
      target: { type: "tag", id: tag.id },
      known: { title: tag.name, url: `/tag/${tag.slug}` },
    });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const first = options[0];
    if (first) onAdd(first.target, first.known);
  }

  return (
    <Dialog labelledBy={headingId} onClose={onClose}>
      <form onSubmit={onSubmit} className="grid gap-4">
        <h2 id={headingId} className="text-xl font-bold">
          <FormattedMessage id="menu.addHeading" />
        </h2>
        <div className="grid gap-2">
          <label htmlFor={searchId} className="font-medium">
            <FormattedMessage id="menu.search" />
          </label>
          <input
            id={searchId}
            value={typed}
            autoFocus
            onChange={(event) => setTyped(event.target.value)}
            className="min-h-11 w-full rounded-xl border border-edge bg-field px-3 text-lg focus-visible:outline-3 focus-visible:outline-brand"
          />
        </div>
        <p role="status" className="sr-only">
          {!found.isPlaceholderData && (
            <FormattedMessage id="link.found" values={{ count: options.length }} />
          )}
        </p>
        <ul className="grid max-h-80 gap-1 overflow-y-auto">
          {options.map((option) => (
            <li key={option.key}>
              <button
                type="button"
                onClick={() => onAdd(option.target, option.known)}
                className="grid min-h-11 w-full gap-0.5 rounded-xl px-3 py-1 text-start hover:bg-ink/5 focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-brand"
              >
                <span className="font-medium [overflow-wrap:anywhere]">{option.label}</span>
                {option.detail && (
                  <span className="text-sm text-muted [overflow-wrap:anywhere]">
                    {option.detail}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div>
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            <FormattedMessage id="common.cancel" />
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Puts focus back on a control once its row has moved, so keyboard users keep their place. */
function focusControl(id: string, control: string): void {
  const row = document.querySelector(`[data-item="${CSS.escape(id)}"]`);
  row?.querySelector<HTMLElement>(`[data-control="${control}"]`)?.focus();
}

/** What added links go to, kept with their screen's unsaved changes. */
const knownLinks = new Map<string, Known>();

function MenuRow({
  item,
  known,
  position,
  onMove,
  onIndent,
  onRename,
  onRemove,
}: {
  item: MenuLeaf;
  known: Known | undefined;
  position: { first: boolean; last: boolean; nested: boolean; canIndent: boolean };
  onMove: (direction: -1 | 1) => void;
  onIndent: () => void;
  onRename: (label: string | null) => void;
  onRemove: () => void;
}) {
  const intl = useIntl();
  const inputId = useId();
  const [renaming, setRenaming] = useState(false);
  const [words, setWords] = useState(item.label ?? "");
  const title =
    item.label ??
    known?.title ??
    (item.target.type === "url" ? item.target.url : intl.formatMessage({ id: "list.untitled" }));
  const shown = known?.url !== null && known !== undefined;

  // aria-disabled rather than disabled, so a button that's just been used keeps focus.
  const canIndent = position.nested || position.canIndent;
  return (
    <div
      data-item={item.id}
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5 ${position.nested ? "ms-6 sm:ms-10" : ""}`}
    >
      {position.nested && (
        <span aria-hidden="true" className="-ms-6 h-px w-4 bg-edge max-sm:hidden" />
      )}
      <div className="min-w-0 flex-1 basis-52">
        <p className="font-medium [overflow-wrap:anywhere]">{title}</p>
        <p className={`text-sm [overflow-wrap:anywhere] ${shown ? "text-muted" : "text-danger"}`}>
          {shown ? (
            <FormattedMessage id="menu.goesTo" values={{ address: known?.url }} />
          ) : (
            <FormattedMessage id="menu.notShown" />
          )}
        </p>
      </div>
      {renaming ? (
        <form
          className="flex min-w-0 flex-1 basis-64 flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onRename(words.trim() || null);
            setRenaming(false);
            requestAnimationFrame(() => focusControl(item.id, "rename"));
          }}
        >
          <div className="grid min-w-0 flex-1 gap-1">
            <label htmlFor={inputId} className="text-sm font-medium">
              <FormattedMessage id="menu.words" />
            </label>
            <input
              id={inputId}
              value={words}
              maxLength={80}
              placeholder={known?.title ?? ""}
              // biome-ignore lint/a11y/noAutofocus: they've just asked to rename it
              autoFocus
              onChange={(event) => setWords(event.target.value)}
              className="min-h-11 w-full rounded-xl border border-edge bg-field px-3 focus-visible:outline-3 focus-visible:outline-brand"
            />
          </div>
          <button type="submit" className={smallButtonClass}>
            <FormattedMessage id="link.apply" />
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-control="up"
            aria-disabled={position.first}
            onClick={() => {
              if (!position.first) onMove(-1);
            }}
            aria-label={intl.formatMessage({ id: "menu.moveUp" }, { title })}
            className={`${smallButtonClass} px-0! min-w-11`}
          >
            <Icon name="up" />
          </button>
          <button
            type="button"
            data-control="down"
            aria-disabled={position.last}
            onClick={() => {
              if (!position.last) onMove(1);
            }}
            aria-label={intl.formatMessage({ id: "menu.moveDown" }, { title })}
            className={`${smallButtonClass} px-0! min-w-11`}
          >
            <Icon name="down" />
          </button>
          <button
            type="button"
            data-control="indent"
            aria-disabled={!canIndent}
            onClick={() => {
              if (canIndent) onIndent();
            }}
            className={smallButtonClass}
          >
            <FormattedMessage id={position.nested ? "menu.outdent" : "menu.indent"} />
          </button>
          <button
            type="button"
            data-control="rename"
            aria-label={intl.formatMessage({ id: "menu.renameNamed" }, { title })}
            onClick={() => setRenaming(true)}
            className={smallButtonClass}
          >
            <FormattedMessage id="menu.rename" />
          </button>
          <button
            type="button"
            aria-label={intl.formatMessage({ id: "menu.removeNamed" }, { title })}
            onClick={onRemove}
            className={smallButtonClass}
          >
            <FormattedMessage id="menu.remove" />
          </button>
        </div>
      )}
    </div>
  );
}

function SiteMenuScreen({ me }: { me: Me }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [which, setWhich] = useState<MenuName>("main");
  const [, setKnownVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  /** Its Undo only works here, so it goes when this screen does. */
  const removedToast = useRef(0);
  useEffect(() => () => dismissToast(removedToast.current), []);
  /** The control to put focus back on once a moved row has been drawn again. */
  const refocus = useRef<{ id: string; control: string } | null>(null);

  const menus = useQuery({
    queryKey: MENUS_KEY,
    queryFn: () => api<MenusReply>("/admin/menus"),
    // What's on screen is someone's work in progress, so it isn't swapped under them.
    refetchOnWindowFocus: false,
  });
  // Unsaved changes to each menu wait here if someone goes to another screen.
  const drafts: Record<MenuName, ScreenDraft<MenuItem[]>> = {
    main: useScreenDraft("menu:main", menus.data ? itemsOf(menus.data.main) : undefined),
    footer: useScreenDraft("menu:footer", menus.data ? itemsOf(menus.data.footer) : undefined),
  };
  const stored = menus.data?.[which];
  const draft = drafts[which];
  const items = draft.value ?? [];
  const { changed } = draft;
  const links = { ...menus.data?.links, ...Object.fromEntries(knownLinks) };

  useEffect(() => {
    const target = refocus.current;
    if (!target) return;
    refocus.current = null;
    focusControl(target.id, target.control);
  });

  function setItems(next: MenuItem[], message?: string, focus?: { id: string; control: string }) {
    draft.set(next);
    if (message) setAnnouncement(message);
    refocus.current = focus ?? null;
  }

  function titleOf(item: MenuLeaf): string {
    return (
      item.label ??
      links[item.id]?.title ??
      (item.target.type === "url" ? item.target.url : intl.formatMessage({ id: "list.untitled" }))
    );
  }

  function move(index: number, child: number | null, direction: -1 | 1) {
    const next = structuredClone(items);
    const control = direction < 0 ? "up" : "down";
    if (child === null) {
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(index + direction, 0, moved);
      setItems(
        next,
        intl.formatMessage(
          { id: direction < 0 ? "menu.movedUp" : "menu.movedDown" },
          { title: moved ? titleOf(moved) : "" },
        ),
        moved && { id: moved.id, control },
      );
    } else {
      const children = next[index]?.children ?? [];
      const [moved] = children.splice(child, 1);
      if (moved) children.splice(child + direction, 0, moved);
      setItems(
        next,
        intl.formatMessage(
          { id: direction < 0 ? "menu.movedUp" : "menu.movedDown" },
          { title: moved ? titleOf(moved) : "" },
        ),
        moved && { id: moved.id, control },
      );
    }
  }

  /** Indent: under the link above. Out again: back to the top, after its parent. */
  function indent(index: number, child: number | null) {
    const next = structuredClone(items);
    if (child === null) {
      const item = next[index];
      const parent = next[index - 1];
      if (!item || !parent) return;
      next.splice(index, 1);
      // Only one level, so anything under it comes along beside it.
      parent.children.push(
        { id: item.id, label: item.label, target: item.target },
        ...item.children,
      );
      setItems(
        next,
        intl.formatMessage(
          { id: "menu.indented" },
          { title: titleOf(item), parent: titleOf(parent) },
        ),
        { id: item.id, control: "indent" },
      );
    } else {
      const parent = next[index];
      const moved = parent?.children.splice(child, 1)[0];
      if (!parent || !moved) return;
      next.splice(index + 1, 0, { ...moved, children: [] });
      setItems(next, intl.formatMessage({ id: "menu.outdented" }, { title: titleOf(moved) }), {
        id: moved.id,
        control: "indent",
      });
    }
  }

  function rename(index: number, child: number | null, label: string | null) {
    const next = structuredClone(items);
    const item = child === null ? next[index] : next[index]?.children[child];
    if (item) item.label = label;
    setItems(next);
  }

  function remove(index: number, child: number | null) {
    const next = structuredClone(items);
    const parentId = child === null ? null : next[index]?.id;
    const removed =
      child === null ? next.splice(index, 1)[0] : next[index]?.children.splice(child, 1)[0];
    if (!removed) return;
    setItems(next);
    // The row and its buttons have gone, so focus goes to the list's heading.
    requestAnimationFrame(() => document.querySelector<HTMLElement>("main h1")?.focus());

    // Back where it was, in the menu as it is by then.
    function putBack(current: MenuItem[]): MenuItem[] {
      const back = structuredClone(current);
      const siblings = back.find((item) => item.id === parentId)?.children;
      const item = removed as MenuItem;
      if (siblings) siblings.splice(Math.min(child ?? 0, siblings.length), 0, item);
      else back.splice(Math.min(index, back.length), 0, { ...item, children: item.children ?? [] });
      return back;
    }
    const title = titleOf(removed);
    removedToast.current = showToast({
      message: intl.formatMessage({ id: "menu.removed" }, { title }),
      action: {
        label: intl.formatMessage({ id: "list.undo" }),
        run: () => {
          draft.set(putBack);
          setAnnouncement(intl.formatMessage({ id: "menu.removedUndone" }, { title }));
        },
      },
    });
  }

  // The menu's name travels with the save, so switching tabs meanwhile can't confuse them.
  const save = useMutation({
    mutationFn: (sent: { name: MenuName; items: MenuItem[] }) =>
      api<MenusReply>(`/admin/menus/${sent.name}`, { method: "PUT", body: { items: sent.items } }),
    onSuccess: (reply, sent) => {
      queryClient.setQueryData(MENUS_KEY, reply);
      // Anything changed while this was on its way stays, still to be saved.
      drafts[sent.name].saved(sent.items);
      settleScreenDraft(`menu:${sent.name}`, sent.items);
      if (reply.saved === false) {
        showToast({ message: intl.formatMessage({ id: "settings.nothingChanged" }) });
        return;
      }
      showToast({
        message: intl.formatMessage({ id: "menu.saved" }),
        action: {
          label: intl.formatMessage({ id: "list.undo" }),
          run: () => {
            void api<MenusReply>(`/admin/menus/${sent.name}/undo`, {
              method: "POST",
              body: { undoId: reply[sent.name].undoId },
            })
              .then((undone) => {
                queryClient.setQueryData(MENUS_KEY, undone);
                showToast({ message: intl.formatMessage({ id: "menu.undone" }) });
              })
              .catch((error: unknown) =>
                showToast({
                  message: errorText(error, intl.formatMessage({ id: "offline.body" })),
                  sticky: true,
                }),
              );
          },
        },
      });
    },
  });

  return (
    <AdminLayout
      me={me}
      screen="menu"
      intro={<FormattedMessage id="menu.hint" />}
      actions={
        stored && (
          <button type="button" onClick={() => setAdding(true)} className={secondaryButtonClass}>
            <Icon name="add" className="size-4.5" />
            <FormattedMessage id="menu.add" />
          </button>
        )
      }
    >
      <div className="mt-6 flex">
        <Tabs>
          {(["main", "footer"] as const).map((option) => (
            <Tabs.Tab key={option} chosen={which === option} onChoose={() => setWhich(option)}>
              <FormattedMessage id={option === "main" ? "menu.main" : "menu.footer"} />
            </Tabs.Tab>
          ))}
        </Tabs>
      </div>

      <p role="alert" className="mt-4 font-medium text-danger empty:sr-only">
        {save.error && <Problem error={save.error} />}
      </p>
      <p role="status" className="sr-only">
        {announcement}
      </p>

      {!menus.data && <Waiting query={menus} />}
      {stored?.automatic && !changed && (
        <p className="mt-5 rounded-2xl bg-mint p-4">
          <FormattedMessage id={which === "main" ? "menu.automatic" : "menu.footerEmpty"} />
        </p>
      )}
      {stored && items.length === 0 && !stored.automatic && (
        <p className="dashed mt-5 px-6 py-10 text-center text-muted">
          <FormattedMessage id="menu.empty" />
        </p>
      )}

      <ol ref={listRef} className="card mt-5 divide-y divide-line px-5 empty:hidden sm:px-6">
        {items.map((item, index) => (
          <li key={item.id}>
            <MenuRow
              item={item}
              known={links[item.id]}
              position={{
                first: index === 0,
                last: index === items.length - 1,
                nested: false,
                canIndent: index > 0,
              }}
              onMove={(direction) => move(index, null, direction)}
              onIndent={() => indent(index, null)}
              onRename={(label) => rename(index, null, label)}
              onRemove={() => remove(index, null)}
            />
            {item.children.length > 0 && (
              <ol className="divide-y divide-line border-t border-line">
                {item.children.map((child, childIndex) => (
                  <li key={child.id}>
                    <MenuRow
                      item={child}
                      known={links[child.id]}
                      position={{
                        first: childIndex === 0,
                        last: childIndex === item.children.length - 1,
                        nested: true,
                        canIndent: false,
                      }}
                      onMove={(direction) => move(index, childIndex, direction)}
                      onIndent={() => indent(index, childIndex)}
                      onRename={(label) => rename(index, childIndex, label)}
                      onRemove={() => remove(index, childIndex)}
                    />
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ol>

      {stored && (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            aria-disabled={!changed || save.isPending}
            onClick={() => {
              if (changed && !save.isPending) save.mutate({ name: which, items });
            }}
            className={`${primaryButtonClass} aria-disabled:opacity-60`}
          >
            <FormattedMessage id={save.isPending ? "menu.saving" : "menu.save"} />
          </button>
          {changed && (
            <button type="button" onClick={() => draft.discard()} className={textLinkClass}>
              <FormattedMessage id="menu.discard" />
            </button>
          )}
        </div>
      )}
      {changed && (
        <p className="mt-2 text-sm text-muted">
          <FormattedMessage id="menu.unsaved" />
        </p>
      )}

      {adding && (
        <AddLinkDialog
          onClose={() => setAdding(false)}
          onAdd={(target, info) => {
            const id = newLinkId();
            knownLinks.set(id, info);
            setKnownVersion((version) => version + 1);
            setItems(
              [...items, { id, label: null, target, children: [] }],
              intl.formatMessage({ id: "menu.added" }, { title: info.title ?? info.url ?? "" }),
            );
            setAdding(false);
          }}
        />
      )}
    </AdminLayout>
  );
}

export function SiteMenu() {
  return <SignedIn roles={["admin", "editor"]}>{(me) => <SiteMenuScreen me={me} />}</SignedIn>;
}
