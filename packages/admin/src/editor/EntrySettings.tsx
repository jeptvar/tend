import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useId, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { secondaryButtonClass } from "../components/AuthLayout.tsx";
import { Field } from "../components/fields.tsx";
import { MediaPicker } from "../components/MediaPicker.tsx";
import { api, errorText } from "../lib/api.ts";
import { useMediaItems } from "../lib/media.ts";

const smallButtonClass = `${secondaryButtonClass} aria-disabled:opacity-60`;

/** The picture for cards, sharing and the top of a post. Automatic until one is chosen. */
export function FeaturedImageField({
  value,
  onChange,
  readOnly,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  readOnly: boolean;
}) {
  const intl = useIntl();
  const [picking, setPicking] = useState(false);
  const { found, isPending, isError } = useMediaItems(value ? [value] : []);
  const item = value ? found.get(value) : undefined;

  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 font-medium">
        <FormattedMessage id="featured.label" />
      </legend>
      {value === null ? (
        <p className="text-sm text-muted">
          <FormattedMessage id="featured.automatic" />
        </p>
      ) : item ? (
        <div className="flex flex-wrap items-center gap-3">
          <img
            src={item.thumbUrl ?? undefined}
            alt={item.alt ?? ""}
            style={{ backgroundColor: item.dominantColor ?? undefined }}
            className="h-20 w-28 rounded object-cover"
          />
          <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
            {item.trashedAt !== null ? (
              <span className="text-danger">
                <FormattedMessage id="featured.inTrash" />
              </span>
            ) : (
              item.alt || item.name
            )}
          </span>
        </div>
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
    if (event.key === "Enter" || event.key === ",") {
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
              className="inline-flex items-center gap-1 rounded-full border border-muted ps-3"
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
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full hover:bg-ink/10 focus-visible:outline-3 focus-visible:outline-brand"
                >
                  ×
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
            className="min-h-11 w-full rounded-lg border border-muted bg-white px-3 text-lg text-[#1d2420] focus-visible:outline-3 focus-visible:outline-brand"
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
        {create.error && errorText(create.error, intl.formatMessage({ id: "offline.body" }))}
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
  const headingId = useId();
  return (
    <fieldset className="grid gap-4" aria-labelledby={headingId}>
      <legend id={headingId} className="font-medium">
        <FormattedMessage id="search.legend" />
      </legend>
      <Field
        label={intl.formatMessage({ id: "search.title" })}
        hint={intl.formatMessage({ id: "search.titleHint" })}
        value={title}
        placeholder={automaticTitle}
        maxLength={200}
        readOnly={readOnly}
        onChange={(event) => onChange({ seoTitle: event.target.value })}
      />
      <Field
        label={intl.formatMessage({ id: "search.description" })}
        hint={intl.formatMessage({ id: "search.descriptionHint" })}
        value={description}
        placeholder={automaticDescription}
        maxLength={400}
        readOnly={readOnly}
        onChange={(event) => onChange({ seoDescription: event.target.value })}
      />
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          checked={noindex}
          disabled={readOnly}
          onChange={(event) => onChange({ noindex: event.target.checked })}
          className="h-5 w-5 accent-brand"
        />
        <FormattedMessage id="search.noindex" />
      </label>
    </fieldset>
  );
}
