import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useId, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { secondaryButtonClass } from "../components/AuthLayout.tsx";
import { Field, SentenceField } from "../components/fields.tsx";
import { Icon } from "../components/icons.tsx";
import { MediaPicker } from "../components/MediaPicker.tsx";
import { Problem } from "../components/Problem.tsx";
import { api } from "../lib/api.ts";
import { isComposing } from "../lib/keys.ts";
import { useMediaItems } from "../lib/media.ts";

const smallButtonClass = `${secondaryButtonClass} aria-disabled:opacity-60`;

/** The picture for cards, sharing and the top of a post. Automatic until one is chosen. */
export function FeaturedImageField({
  value,
  automatic,
  onChange,
  readOnly,
}: {
  value: string | null;
  /** The one that's used until one is chosen. */
  automatic: string | null;
  onChange: (id: string | null) => void;
  readOnly: boolean;
}) {
  const intl = useIntl();
  const [picking, setPicking] = useState(false);
  const shown = value ?? automatic;
  const { found, isPending, isError } = useMediaItems(shown ? [shown] : []);
  const item = shown ? found.get(shown) : undefined;

  return (
    <fieldset className="grid grid-cols-1 gap-2">
      <legend className="mb-2 font-medium">
        <FormattedMessage id="featured.label" />
      </legend>
      {item && item.trashedAt === null && (
        <img
          src={item.thumbUrl ?? undefined}
          alt={item.alt ?? ""}
          style={{ backgroundColor: item.dominantColor ?? undefined }}
          className="aspect-[16/9] w-full rounded-xl object-cover"
        />
      )}
      {value === null ? (
        <p className="text-sm text-muted">
          <FormattedMessage id="featured.automatic" />
        </p>
      ) : item ? (
        item.trashedAt !== null && (
          <p className="text-sm text-danger">
            <FormattedMessage id="featured.inTrash" />
          </p>
        )
      ) : (
        <p className="text-sm text-muted">
          <FormattedMessage
            id={isPending ? "common.loading" : isError ? "image.cantLoad" : "featured.gone"}
          />
        </p>
      )}
      {!readOnly && (
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => setPicking(true)} className={smallButtonClass}>
            <FormattedMessage id={value ? "featured.change" : "featured.choose"} />
          </button>
          {value && (
            <button type="button" onClick={() => onChange(null)} className={smallButtonClass}>
              <FormattedMessage id="featured.useAutomatic" />
            </button>
          )}
        </div>
      )}
      {picking && (
        <MediaPicker
          heading={intl.formatMessage({ id: "featured.heading" })}
          onPick={(picked) => {
            setPicking(false);
            onChange(picked.id);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </fieldset>
  );
}

interface Tag {
  id: string;
  name: string;
  slug: string;
}

const TAGS_KEY = ["tags"];

/** Tags group posts on the site, each at its own address. Typing a new one makes it. */
export function TagsField({
  value,
  onChange,
  readOnly,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  readOnly: boolean;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const inputId = useId();
  const hintId = useId();
  const listId = useId();
  const [typed, setTyped] = useState("");
  const tags = useQuery({
    queryKey: TAGS_KEY,
    queryFn: () => api<{ tags: Tag[] }>("/admin/tags"),
    staleTime: 60_000,
  });
  const byId = new Map((tags.data?.tags ?? []).map((tag) => [tag.id, tag]));

  const create = useMutation({
    mutationFn: (name: string) => api<Tag>("/admin/tags", { method: "POST", body: { name } }),
    onSuccess: (tag) => {
      queryClient.setQueryData<{ tags: Tag[] }>(TAGS_KEY, (data) => ({
        tags: [...(data?.tags ?? []).filter((known) => known.id !== tag.id), tag].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      }));
      if (!value.includes(tag.id)) onChange([...value, tag.id]);
      setTyped("");
    },
  });

  function add() {
    const name = typed.trim();
    if (!name) return;
    const existing = tags.data?.tags.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (!value.includes(existing.id)) onChange([...value, existing.id]);
      setTyped("");
      return;
    }
    create.mutate(name);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if ((event.key === "Enter" || event.key === ",") && !isComposing(event)) {
      event.preventDefault();
      add();
    }
  }

  return (
    <div className="grid gap-2">
      <label htmlFor={inputId} className="font-medium">
        <FormattedMessage id="tags.label" />
      </label>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {value.map((id) => (
            <li
              key={id}
              className="inline-flex items-center gap-1 rounded-full bg-mint ps-4 font-medium text-brand-strong"
            >
              <span>{byId.get(id)?.name ?? intl.formatMessage({ id: "common.loading" })}</span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => onChange(value.filter((other) => other !== id))}
                  aria-label={intl.formatMessage(
                    { id: "tags.remove" },
                    { name: byId.get(id)?.name ?? "" },
                  )}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full hover:bg-ink/8 focus-visible:outline-3 focus-visible:outline-brand"
                >
                  <Icon name="close" className="size-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="flex gap-2">
          <input
            id={inputId}
            value={typed}
            list={listId}
            aria-describedby={hintId}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={onKeyDown}
            maxLength={60}
            className="min-h-11 w-full rounded-xl border border-edge bg-field px-3 text-lg focus-visible:outline-3 focus-visible:outline-brand"
          />
          <datalist id={listId}>
            {(tags.data?.tags ?? [])
              .filter((tag) => !value.includes(tag.id))
              .map((tag) => (
                <option key={tag.id} value={tag.name} />
              ))}
          </datalist>
          <button
            type="button"
            aria-disabled={create.isPending}
            onClick={add}
            className={`${smallButtonClass} shrink-0`}
          >
            <FormattedMessage id="tags.add" />
          </button>
        </div>
      )}
      <p id={hintId} className="text-sm text-muted">
        <FormattedMessage id="tags.hint" />
      </p>
      {tags.isError && (
        <p className="text-sm font-medium text-danger">
          <FormattedMessage id="tags.cantLoad" />
        </p>
      )}
      <p role="alert" className="text-sm font-medium text-danger empty:sr-only">
        {create.error && <Problem error={create.error} />}
      </p>
    </div>
  );
}

/** How it shows in search results and when shared. Blank means filled in automatically. */
export function SearchFields({
  title,
  description,
  noindex,
  automaticTitle,
  automaticDescription,
  onChange,
  readOnly,
}: {
  title: string;
  description: string;
  noindex: boolean;
  automaticTitle: string;
  automaticDescription: string;
  onChange: (change: { seoTitle?: string; seoDescription?: string; noindex?: boolean }) => void;
  readOnly: boolean;
}) {
  const intl = useIntl();
  return (
    <details className="group border-y border-line">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 font-medium focus-visible:outline-3 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
        <FormattedMessage id="search.legend" />
        <Icon name="right" className="size-5 text-muted group-open:rotate-90" />
      </summary>
      <div className="grid gap-5 pb-5">
        <Field
          label={intl.formatMessage({ id: "search.title" })}
          hint={intl.formatMessage({ id: "search.titleHint" })}
          value={title}
          placeholder={automaticTitle}
          maxLength={200}
          readOnly={readOnly}
          onChange={(event) => onChange({ seoTitle: event.target.value })}
        />
        <SentenceField
          label={intl.formatMessage({ id: "search.description" })}
          hint={intl.formatMessage({ id: "search.descriptionHint" })}
          value={description}
          placeholder={automaticDescription}
          maxLength={400}
          readOnly={readOnly}
          onChange={(value) => onChange({ seoDescription: value })}
        />
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            checked={noindex}
            disabled={readOnly}
            onChange={(event) => onChange({ noindex: event.target.checked })}
            className="h-5 w-5 shrink-0 accent-brand"
          />
          <FormattedMessage id="search.noindex" />
        </label>
      </div>
    </details>
  );
}
