import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { FormattedDate, FormattedMessage, useIntl } from "react-intl";
import { Link, Redirect, useParams } from "wouter";
import { AddressChoice } from "../components/AddressChoice.tsx";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import {
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Field, optionClass, PasswordField, radioClass } from "../components/fields.tsx";
import { Icon, type IconName } from "../components/icons.tsx";
import { MediaPicker } from "../components/MediaPicker.tsx";
import { Problem } from "../components/Problem.tsx";
import { showToast } from "../components/Toast.tsx";
import { Waiting } from "../components/Waiting.tsx";
import { ApiError, api, errorText } from "../lib/api.ts";
import {
  checkOwnerPassword,
  looksLikeABackup,
  OWNER_PARTS,
  restoreAsOwner,
  sendBackup,
} from "../lib/backup-upload.ts";
import { bytesText } from "../lib/bytes.ts";
import { onThisComputer } from "../lib/hosts.ts";
import { siteLanguages } from "../lib/languages.ts";
import { useMediaItems } from "../lib/media.ts";
import { ME_KEY, type Me, SETUP_STATUS_KEY } from "../lib/queries.ts";
import { settleScreenDraft, useScreenDraft } from "../lib/screen-drafts.ts";
import { useSetup } from "../lib/setup-state.tsx";
import {
  BACKUP_DOWNLOAD_URL,
  BACKUPS_KEY,
  type BackupsInfo,
  type Business,
  type CodeSettings,
  copyDownloadUrl,
  DAYS,
  type DayHours,
  type General,
  type Redirect as RedirectRow,
  type SearchSettings,
  type Stored,
  settingKey,
  type Visibility,
} from "../lib/site.ts";

const SECTIONS = ["general", "business", "search", "advanced", "backups"] as const;
type Section = (typeof SECTIONS)[number];

const inputClass =
  "min-h-11 w-full rounded-xl border border-edge bg-field px-3 text-lg placeholder:text-muted focus-visible:outline-3 focus-visible:outline-brand";
const smallButtonClass = `${secondaryButtonClass} aria-disabled:opacity-60`;
const cardClass = "card grid grid-cols-1 gap-4 p-5 sm:p-7";
const formClass = "card grid grid-cols-1 gap-6 p-5 sm:p-7";
const warningClass = "rounded-2xl border border-wait-line bg-wait-soft p-4";

/** Loads one setting, and saves it with an Undo toast, like every other site-wide change. */
function useSetting<T>(name: string) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: settingKey(name),
    queryFn: () => api<Stored<T>>(`/admin/settings/${name}`),
    // What's on screen is someone's work in progress, so it isn't swapped under them.
    refetchOnWindowFocus: false,
  });
  const save = useMutation({
    mutationFn: (value: T) =>
      api<Stored<T> & { saved: boolean }>(`/admin/settings/${name}`, {
        method: "PUT",
        body: value,
      }),
    onSuccess: (answer, sent) => {
      queryClient.setQueryData(settingKey(name), answer);
      settleScreenDraft(`settings:${name}`, sent);
      // The site's name shows in the admin too.
      if (name === "general") void queryClient.invalidateQueries({ queryKey: ME_KEY });
      if (!answer.saved) {
        showToast({ message: intl.formatMessage({ id: "settings.nothingChanged" }) });
        return;
      }
      showToast({
        message: intl.formatMessage({ id: "settings.saved" }),
        action: {
          label: intl.formatMessage({ id: "list.undo" }),
          run: () => {
            void api<Stored<T>>(`/admin/settings/${name}/undo`, {
              method: "POST",
              body: { undoId: answer.undoId },
            })
              .then((undone) => {
                queryClient.setQueryData(settingKey(name), undone);
                if (name === "general") void queryClient.invalidateQueries({ queryKey: ME_KEY });
                showToast({ message: intl.formatMessage({ id: "settings.undone" }) });
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
  return { query, save };
}

/** What a refusal about this field says, to sit under it. */
function fieldError(error: unknown, field: string): string | undefined {
  return error instanceof ApiError && error.field === field ? errorText(error, "") : undefined;
}

function SaveRow({
  busy,
  changed,
  error,
  fields = [],
}: {
  busy: boolean;
  changed: boolean;
  error: unknown;
  /** The fields that show a refusal about them themselves. Any other is shown here. */
  fields?: string[];
}) {
  const general =
    error instanceof ApiError && error.field && fields.includes(error.field) ? null : error;
  return (
    <div className="grid gap-2 border-t border-line pt-5 sm:col-span-full">
      <p role="alert" className="font-medium text-danger empty:sr-only">
        {general ? <Problem error={general} /> : null}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          aria-disabled={!changed || busy}
          className={`${primaryButtonClass} aria-disabled:opacity-60`}
        >
          <FormattedMessage id={busy ? "settings.saving" : "settings.save"} />
        </button>
        {changed && (
          <span className="text-sm text-muted">
            <FormattedMessage id="settings.unsaved" />
          </span>
        )}
      </div>
    </div>
  );
}

function GeneralForm({
  value,
  onSave,
  busy,
  error,
}: {
  value: General;
  onSave: (value: General, done: () => void) => void;
  busy: boolean;
  error: unknown;
}) {
  const intl = useIntl();
  const draft = useScreenDraft<General>("settings:general", value);
  const form = draft.value ?? value;
  const setForm = draft.set;
  const { changed } = draft;
  const zones = Intl.supportedValuesOf?.("timeZone") ?? [form.timezone];
  const languages = siteLanguages(intl.locale, form.locale);
  return (
    <form
      className={`${formClass} items-end sm:grid-cols-2 sm:*:first:col-span-full`}
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !busy) onSave(form, () => draft.saved(form));
      }}
    >
      <Field
        label={intl.formatMessage({ id: "settings.siteName" })}
        value={form.name}
        maxLength={100}
        required
        error={fieldError(error, "name")}
        onChange={(event) => setForm({ ...form, name: event.target.value })}
      />
      <div className="sm:col-span-full">
        <Field
          label={intl.formatMessage({ id: "settings.tagline" })}
          hint={intl.formatMessage({ id: "settings.taglineHint" })}
          value={form.tagline}
          maxLength={200}
          error={fieldError(error, "tagline")}
          onChange={(event) => setForm({ ...form, tagline: event.target.value })}
        />
      </div>
      <label className="grid gap-2">
        <span className="font-medium">
          <FormattedMessage id="settings.language" />
        </span>
        <span className="text-sm text-muted">
          <FormattedMessage id="settings.languageHint" />
        </span>
        <select
          value={form.locale}
          onChange={(event) => setForm({ ...form, locale: event.target.value })}
          className={inputClass}
        >
          {languages.map(({ tag, name }) => (
            <option key={tag} value={tag}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-2">
        <span className="font-medium">
          <FormattedMessage id="settings.timezone" />
        </span>
        <select
          value={form.timezone}
          onChange={(event) => setForm({ ...form, timezone: event.target.value })}
          className={inputClass}
        >
          {(zones.includes(form.timezone) ? zones : [form.timezone, ...zones]).map((zone) => (
            <option key={zone} value={zone}>
              {zone.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>
      <SaveRow busy={busy} changed={changed} error={error} fields={["name", "tagline"]} />
    </form>
  );
}

const VISIBILITIES = [
  { option: "public", icon: "world" },
  { option: "coming_soon", icon: "clock" },
  { option: "private", icon: "lock" },
] as const satisfies { option: Visibility["mode"]; icon: IconName }[];

function VisibilityForm({
  value,
  onSave,
  busy,
  error,
}: {
  value: Visibility;
  onSave: (value: Visibility, done: () => void) => void;
  busy: boolean;
  error: unknown;
}) {
  const intl = useIntl();
  const name = useId();
  const draft = useScreenDraft<Visibility>("settings:visibility", value);
  const mode = (draft.value ?? value).mode;
  const setMode = (next: Visibility["mode"]) => draft.set({ mode: next });
  const { changed } = draft;
  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !busy) onSave({ mode }, () => draft.saved({ mode }));
      }}
    >
      <fieldset>
        <legend className="mb-4 text-xl font-bold">
          <FormattedMessage id="settings.visibility" />
        </legend>
        <div className="grid gap-3 md:grid-cols-3">
          {VISIBILITIES.map(({ option, icon }) => (
            <label key={option} className={optionClass}>
              <input
                type="radio"
                name={name}
                checked={mode === option}
                onChange={() => setMode(option)}
                className={radioClass}
              />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="flex items-center justify-between gap-2 font-semibold">
                  {intl.formatMessage({ id: `settings.visibility.${option}` })}
                  <Icon name={icon} className="size-5 text-muted" />
                </span>
                <span className="text-sm text-muted">
                  {intl.formatMessage({ id: `settings.visibility.${option}Hint` })}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <SaveRow busy={busy} changed={changed} error={error} />
    </form>
  );
}

function AddressSection({ me }: { me: Me }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cardClass}>
      <h2 id={id} className="text-xl font-bold">
        <FormattedMessage id="address.heading" />
      </h2>
      <AddressChoice me={me} />
      <div>
        <Link href={onThisComputer() ? "/online" : "/domain"} className={textLinkClass}>
          <FormattedMessage id={onThisComputer() ? "steps.online" : "steps.domain"} />
        </Link>
      </div>
    </section>
  );
}

function GeneralSection({ me }: { me: Me }) {
  const general = useSetting<General>("general");
  const visibility = useSetting<Visibility>("visibility");
  return (
    <div className="grid grid-cols-1 gap-5">
      {general.query.data ? (
        <GeneralForm
          value={general.query.data.value}
          onSave={(value, done) => general.save.mutate(value, { onSuccess: done })}
          busy={general.save.isPending}
          error={general.save.error}
        />
      ) : (
        <Waiting query={general.query} />
      )}
      <AddressSection me={me} />
      {visibility.query.data ? (
        <VisibilityForm
          value={visibility.query.data.value}
          onSave={(value, done) => visibility.save.mutate(value, { onSuccess: done })}
          busy={visibility.save.isPending}
          error={visibility.save.error}
        />
      ) : (
        // One of the two is enough to say that it's loading.
        visibility.query.error && <Waiting query={visibility.query} />
      )}
      <p className="text-sm text-muted">
        <FormattedMessage id="settings.signedInAs" values={{ email: me.user.email }} />
      </p>
    </div>
  );
}

const DEFAULT_HOURS: DayHours[] = DAYS.map((day) => ({
  day,
  closed: day === "sun",
  opens: "09:00",
  closes: "17:00",
}));

function BusinessForm({
  value,
  onSave,
  busy,
  error,
}: {
  value: Business;
  onSave: (value: Business, done: () => void) => void;
  busy: boolean;
  error: unknown;
}) {
  const intl = useIntl();
  const addressId = useId();
  const noteId = useId();
  const draft = useScreenDraft<Business>("settings:business", value);
  const form = draft.value ?? value;
  const setForm = draft.set;
  const { changed } = draft;
  const dayName = (index: number) =>
    new Intl.DateTimeFormat(intl.locale, { weekday: "long", timeZone: "UTC" }).format(
      Date.UTC(1970, 0, 5 + index),
    );

  function setDay(index: number, patch: Partial<DayHours>) {
    const hours = [...(form.hours ?? DEFAULT_HOURS)];
    hours[index] = { ...(hours[index] as DayHours), ...patch };
    setForm({ ...form, hours });
  }

  return (
    <form
      className={`${formClass} items-start sm:grid-cols-2`}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (changed && !busy) onSave(form, () => draft.saved(form));
      }}
    >
      <p className="text-muted sm:col-span-full">
        <FormattedMessage id="business.hint" />
      </p>
      <div className="grid gap-2 sm:col-span-full">
        <label htmlFor={addressId} className="font-medium">
          <FormattedMessage id="business.address" />
        </label>
        <textarea
          id={addressId}
          rows={3}
          maxLength={500}
          value={form.address ?? ""}
          onChange={(event) => setForm({ ...form, address: event.target.value || null })}
          className={`${inputClass} py-2`}
        />
      </div>
      <Field
        label={intl.formatMessage({ id: "business.phone" })}
        type="tel"
        autoComplete="tel"
        value={form.phone ?? ""}
        error={fieldError(error, "phone")}
        onChange={(event) => setForm({ ...form, phone: event.target.value || null })}
      />
      <Field
        label={intl.formatMessage({ id: "business.email" })}
        type="email"
        autoComplete="email"
        value={form.email ?? ""}
        error={fieldError(error, "email")}
        onChange={(event) => setForm({ ...form, email: event.target.value || null })}
      />
      <div className="sm:col-span-full">
        <Field
          label={intl.formatMessage({ id: "business.map" })}
          hint={intl.formatMessage({ id: "business.mapHint" })}
          inputMode="url"
          autoCapitalize="none"
          value={form.mapUrl ?? ""}
          error={fieldError(error, "mapUrl")}
          onChange={(event) => setForm({ ...form, mapUrl: event.target.value || null })}
        />
      </div>
      <fieldset className="min-w-0 sm:col-span-full">
        <legend className="mb-2 font-medium">
          <FormattedMessage id="business.hours" />
        </legend>
        {form.hours === null ? (
          <div>
            <button
              type="button"
              onClick={() => setForm({ ...form, hours: DEFAULT_HOURS })}
              className={smallButtonClass}
            >
              <FormattedMessage id="business.addHours" />
            </button>
          </div>
        ) : (
          <>
            <div className="divide-y divide-line rounded-2xl border border-line">
              {form.hours.map((day, index) => (
                <div
                  key={day.day}
                  className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2 sm:min-h-16"
                >
                  <span className="w-28 font-semibold">{dayName(index)}</span>
                  <label className="flex min-h-11 items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={intl.formatMessage(
                        { id: "business.closedOn" },
                        { day: dayName(index) },
                      )}
                      checked={day.closed}
                      onChange={(event) => setDay(index, { closed: event.target.checked })}
                      className="h-5 w-5 accent-brand"
                    />
                    <FormattedMessage id="business.closed" />
                  </label>
                  {!day.closed && (
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <input
                        type="time"
                        value={day.opens}
                        aria-label={intl.formatMessage(
                          { id: "business.opens" },
                          { day: dayName(index) },
                        )}
                        onChange={(event) => setDay(index, { opens: event.target.value })}
                        className={inputClass
                          .replace("w-full", "w-36 min-w-0")
                          .replace("text-lg", "text-base")}
                      />
                      <span aria-hidden="true">–</span>
                      <input
                        type="time"
                        value={day.closes}
                        aria-label={intl.formatMessage(
                          { id: "business.closes" },
                          { day: dayName(index) },
                        )}
                        onChange={(event) => setDay(index, { closes: event.target.value })}
                        className={inputClass
                          .replace("w-full", "w-36 min-w-0")
                          .replace("text-lg", "text-base")}
                      />
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setForm({ ...form, hours: null })}
                className={textLinkClass}
              >
                <FormattedMessage id="business.removeHours" />
              </button>
            </div>
          </>
        )}
      </fieldset>
      <div className="grid gap-2 sm:col-span-full">
        <label htmlFor={noteId} className="font-medium">
          <FormattedMessage id="business.note" />
        </label>
        <input
          id={noteId}
          value={form.hoursNote ?? ""}
          maxLength={300}
          placeholder={intl.formatMessage({ id: "business.noteExample" })}
          onChange={(event) => setForm({ ...form, hoursNote: event.target.value || null })}
          className={inputClass}
        />
      </div>
      <SaveRow busy={busy} changed={changed} error={error} fields={["phone", "email", "mapUrl"]} />
    </form>
  );
}

function BusinessSection() {
  const business = useSetting<Business>("business");
  if (!business.query.data) return <Waiting query={business.query} />;
  return (
    <BusinessForm
      value={business.query.data.value}
      onSave={(value, done) => business.save.mutate(value, { onSuccess: done })}
      busy={business.save.isPending}
      error={business.save.error}
    />
  );
}

function SearchForm({
  value,
  onSave,
  busy,
  error,
}: {
  value: SearchSettings;
  onSave: (value: SearchSettings, done: () => void) => void;
  busy: boolean;
  error: unknown;
}) {
  const intl = useIntl();
  const draft = useScreenDraft<SearchSettings>("settings:seo", value);
  const form = draft.value ?? value;
  const setForm = draft.set;
  const { changed } = draft;
  const [picking, setPicking] = useState(false);
  const lookup = useMediaItems(form.imageId ? [form.imageId] : []);
  const image = form.imageId ? lookup.found.get(form.imageId) : undefined;
  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !busy) onSave(form, () => draft.saved(form));
      }}
    >
      <Field
        label={intl.formatMessage({ id: "seo.homeDescription" })}
        hint={intl.formatMessage({ id: "seo.homeDescriptionHint" })}
        value={form.description ?? ""}
        maxLength={400}
        error={fieldError(error, "description")}
        onChange={(event) => setForm({ ...form, description: event.target.value || null })}
      />
      <div className="grid gap-2">
        <span className="font-medium">
          <FormattedMessage id="seo.image" />
        </span>
        <p className="text-sm text-muted">
          <FormattedMessage id="seo.imageHint" />
        </p>
        {image && (
          <img
            src={image.thumbUrl ?? undefined}
            alt={image.alt ?? ""}
            className="aspect-[1.91] w-full max-w-72 rounded-xl object-cover"
          />
        )}
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => setPicking(true)} className={smallButtonClass}>
            <FormattedMessage id={form.imageId ? "design.change" : "design.choose"} />
          </button>
          {form.imageId && (
            <button
              type="button"
              onClick={() => setForm({ ...form, imageId: null })}
              className={smallButtonClass}
            >
              <FormattedMessage id="design.remove" />
            </button>
          )}
        </div>
      </div>
      {picking && (
        <MediaPicker
          heading={intl.formatMessage({ id: "seo.imageHeading" })}
          onPick={(item) => {
            setPicking(false);
            setForm((current) => ({ ...current, imageId: item.id }));
          }}
          onClose={() => setPicking(false)}
        />
      )}
      <SaveRow busy={busy} changed={changed} error={error} fields={["description"]} />
    </form>
  );
}

function Redirects() {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const list = useQuery({
    queryKey: ["redirects"],
    queryFn: () => api<{ redirects: RedirectRow[] }>("/admin/redirects"),
  });
  const add = useMutation({
    mutationFn: () =>
      api<{ redirects: RedirectRow[] }>("/admin/redirects", { method: "POST", body: { from, to } }),
    onSuccess: (reply) => {
      queryClient.setQueryData(["redirects"], reply);
      setFrom("");
      setTo("");
      showToast({ message: intl.formatMessage({ id: "redirects.added" }) });
    },
  });
  const remove = useMutation({
    mutationFn: (fromPath: string) =>
      api<{ redirects: RedirectRow[] }>("/admin/redirects", {
        method: "DELETE",
        body: { from: fromPath },
      }),
    onSuccess: (reply, fromPath) => {
      queryClient.setQueryData(["redirects"], reply);
      const removed = list.data?.redirects.find((redirect) => redirect.fromPath === fromPath);
      showToast({
        message: intl.formatMessage({ id: "redirects.removed" }),
        ...(removed
          ? {
              action: {
                label: intl.formatMessage({ id: "list.undo" }),
                run: () => {
                  void api<{ redirects: RedirectRow[] }>("/admin/redirects", {
                    method: "POST",
                    body: { from: removed.fromPath, to: removed.toPath },
                  })
                    .then((again) => queryClient.setQueryData(["redirects"], again))
                    .catch((error: unknown) =>
                      showToast({
                        message: errorText(error, intl.formatMessage({ id: "offline.body" })),
                        sticky: true,
                      }),
                    );
                },
              },
            }
          : {}),
      });
    },
  });
  const rows = list.data?.redirects;
  return (
    <section aria-labelledby="redirects-heading" className={cardClass}>
      <h2 id="redirects-heading" className="text-xl font-bold">
        <FormattedMessage id="redirects.heading" />
      </h2>
      <p className="text-muted">
        <FormattedMessage id="redirects.hint" />
      </p>
      <p role="alert" className="font-medium text-danger empty:sr-only">
        {remove.error && <Problem error={remove.error} />}
      </p>
      {!rows ? (
        <Waiting query={list} />
      ) : rows.length === 0 ? (
        <p className="text-muted">
          <FormattedMessage id="redirects.none" />
        </p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {rows.map((redirect) => (
            <li
              key={redirect.fromPath}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {redirect.fromPath} → {redirect.toPath}
                <span className="block text-sm text-muted">
                  <FormattedMessage
                    id={redirect.source === "auto" ? "redirects.auto" : "redirects.manual"}
                    values={{ hits: redirect.hits }}
                  />
                </span>
              </span>
              <button
                type="button"
                aria-label={intl.formatMessage(
                  { id: "redirects.remove" },
                  { from: redirect.fromPath },
                )}
                onClick={() => remove.mutate(redirect.fromPath)}
                className={smallButtonClass}
              >
                <FormattedMessage id="design.remove" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-4 rounded-2xl bg-sunken/60 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (from.trim() && to.trim() && !add.isPending) add.mutate();
        }}
      >
        <Field
          label={intl.formatMessage({ id: "redirects.from" })}
          hint={intl.formatMessage({ id: "redirects.fromHint" })}
          value={from}
          autoCapitalize="none"
          spellCheck={false}
          error={fieldError(add.error, "from")}
          onChange={(event) => setFrom(event.target.value)}
        />
        <Field
          label={intl.formatMessage({ id: "redirects.to" })}
          hint={intl.formatMessage({ id: "redirects.toHint" })}
          value={to}
          autoCapitalize="none"
          spellCheck={false}
          error={fieldError(add.error, "to")}
          onChange={(event) => setTo(event.target.value)}
        />
        <p role="alert" className="font-medium text-danger empty:sr-only">
          {add.error && !(add.error instanceof ApiError && add.error.field) ? (
            <Problem error={add.error} />
          ) : null}
        </p>
        <div>
          <button type="submit" aria-disabled={add.isPending} className={smallButtonClass}>
            <FormattedMessage id="redirects.add" />
          </button>
        </div>
      </form>
    </section>
  );
}

function SearchSection() {
  const seo = useSetting<SearchSettings>("seo");
  return (
    <div className="grid grid-cols-1 gap-5">
      {seo.query.data ? (
        <SearchForm
          value={seo.query.data.value}
          onSave={(value, done) => seo.save.mutate(value, { onSuccess: done })}
          busy={seo.save.isPending}
          error={seo.save.error}
        />
      ) : (
        <Waiting query={seo.query} />
      )}
      <Redirects />
    </div>
  );
}

function CodeForm({
  value,
  onSave,
  busy,
  error,
}: {
  value: CodeSettings;
  onSave: (value: CodeSettings, done: () => void) => void;
  busy: boolean;
  error: unknown;
}) {
  const headId = useId();
  const endId = useId();
  const draft = useScreenDraft<CodeSettings>("settings:code", value);
  const form = draft.value ?? value;
  const setForm = draft.set;
  const { changed } = draft;
  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !busy) onSave(form, () => draft.saved(form));
      }}
    >
      <h2 className="text-xl font-bold">
        <FormattedMessage id="code.heading" />
      </h2>
      <p className={warningClass}>
        <FormattedMessage id="code.warning" />
      </p>
      <div className="grid gap-2">
        <label htmlFor={headId} className="font-medium">
          <FormattedMessage id="code.head" />
        </label>
        <textarea
          id={headId}
          rows={6}
          spellCheck={false}
          value={form.head ?? ""}
          onChange={(event) => setForm({ ...form, head: event.target.value || null })}
          className={`${inputClass} py-2 font-mono text-base`}
        />
      </div>
      <div className="grid gap-2">
        <label htmlFor={endId} className="font-medium">
          <FormattedMessage id="code.bodyEnd" />
        </label>
        <textarea
          id={endId}
          rows={6}
          spellCheck={false}
          value={form.bodyEnd ?? ""}
          onChange={(event) => setForm({ ...form, bodyEnd: event.target.value || null })}
          className={`${inputClass} py-2 font-mono text-base`}
        />
      </div>
      <SaveRow busy={busy} changed={changed} error={error} />
    </form>
  );
}

function AdvancedSection() {
  const code = useSetting<CodeSettings>("code");
  if (!code.query.data) return <Waiting query={code.query} />;
  return (
    <CodeForm
      value={code.query.data.value}
      onSave={(value, done) => code.save.mutate(value, { onSuccess: done })}
      busy={code.save.isPending}
      error={code.save.error}
    />
  );
}

const COPY_TIMEOUT_MS = 5 * 60 * 1000;

/** Space used before the disk counts as running low, then as nearly full (PLAN.md §13). */
const LOW_DISK = 0.8;
const VERY_LOW_DISK = 0.9;

/**
 * Settings → Backups (PLAN.md §13): the whole site as one private download, the copies Tend
 * keeps on this server, and how much space is left on it.
 */
function BackupsSection({ me }: { me: Me }) {
  const intl = useIntl();
  const downloadId = useId();
  const diskId = useId();
  const copiesId = useId();
  const queryClient = useQueryClient();
  const [restoring, setRestoring] = useState<RestoreSource | null>(null);
  const query = useQuery({
    queryKey: BACKUPS_KEY,
    queryFn: () => api<BackupsInfo>("/admin/backups"),
  });
  const save = useMutation({
    // A big site's copy takes longer than most requests do.
    mutationFn: () =>
      api<BackupsInfo>("/admin/backups", { method: "POST", timeoutMs: COPY_TIMEOUT_MS }),
    onSuccess: (info) => {
      queryClient.setQueryData(BACKUPS_KEY, info);
      showToast({ message: intl.formatMessage({ id: "backups.copies.saved" }) });
    },
  });
  if (!query.data) return <Waiting query={query} />;
  const { snapshots, disk, lastDownloadAt } = query.data;
  const used = Math.max(0, disk.total - disk.free);
  const share = disk.total > 0 ? used / disk.total : 0;
  return (
    <div className="grid grid-cols-1 gap-5">
      <section aria-labelledby={downloadId} className={cardClass}>
        <h2 id={downloadId} className="text-xl font-bold">
          <FormattedMessage id="backups.download.heading" />
        </h2>
        <p>
          <FormattedMessage id="backups.download.body" />
        </p>
        <p className={warningClass}>
          <FormattedMessage id="backups.download.private" />
        </p>
        {me.user.isOwner ? (
          <div>
            <a href={BACKUP_DOWNLOAD_URL} download className={primaryButtonClass}>
              <Icon name="download" className="size-4.5" />
              <FormattedMessage id="backups.download.button" />
            </a>
          </div>
        ) : (
          <p className="text-muted">
            <FormattedMessage id="backups.download.ownerOnly" />
          </p>
        )}
        <p className="text-muted">
          {lastDownloadAt === null ? (
            <FormattedMessage id="backups.download.never" />
          ) : (
            <FormattedMessage
              id="backups.download.last"
              values={{ date: <FormattedDate value={lastDownloadAt} dateStyle="long" /> }}
            />
          )}
        </p>
      </section>

      <section aria-labelledby={diskId} className={cardClass}>
        <h2 id={diskId} className="text-xl font-bold">
          <FormattedMessage id="backups.disk.heading" />
        </h2>
        {/* The sentence below says the same, so the bar is only for the eye. */}
        <div aria-hidden="true" className="h-3 w-full overflow-hidden rounded-full bg-sunken">
          <div
            className={`h-full rounded-full ${share >= LOW_DISK ? "bg-danger" : "bg-brand"}`}
            style={{ width: `${Math.round(share * 100)}%` }}
          />
        </div>
        <p>
          <FormattedMessage
            id="backups.disk.used"
            values={{
              used: bytesText(intl, used),
              total: bytesText(intl, disk.total),
              percent: intl.formatNumber(share, { style: "percent" }),
            }}
          />
        </p>
        {share >= LOW_DISK && (
          <p className="font-medium text-danger">
            <FormattedMessage
              id={share >= VERY_LOW_DISK ? "backups.disk.veryLow" : "backups.disk.low"}
            />
          </p>
        )}
      </section>

      <section aria-labelledby={copiesId} className={cardClass}>
        <h2 id={copiesId} className="text-xl font-bold">
          <FormattedMessage id="backups.copies.heading" />
        </h2>
        <p>
          <FormattedMessage id="backups.copies.body" />
        </p>
        <div>
          <button
            type="button"
            aria-disabled={save.isPending}
            onClick={() => {
              if (!save.isPending) save.mutate();
            }}
            className={smallButtonClass}
          >
            <FormattedMessage id={save.isPending ? "settings.saving" : "backups.copies.save"} />
          </button>
        </div>
        <p role="alert" className="font-medium text-danger empty:sr-only">
          {save.error && <Problem error={save.error} />}
        </p>
        {snapshots.length === 0 ? (
          <p className="text-muted">
            <FormattedMessage id="backups.copies.none" />
          </p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {snapshots.map((snapshot) => {
              const when = intl.formatDate(snapshot.takenAt, {
                dateStyle: "medium",
                timeStyle: "short",
              });
              return (
                <li
                  key={snapshot.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 py-1"
                >
                  <span className="py-2">
                    <FormattedMessage
                      id={`backups.copies.${snapshot.kind}`}
                      values={{ date: when, size: bytesText(intl, snapshot.bytes) }}
                    />
                  </span>
                  {me.user.isOwner && (
                    <span className="flex flex-wrap gap-x-4">
                      <a
                        href={copyDownloadUrl(snapshot.id)}
                        download
                        aria-label={intl.formatMessage(
                          { id: "backups.copies.downloadNamed" },
                          { date: when },
                        )}
                        className={textLinkClass}
                      >
                        <FormattedMessage id="backups.copies.download" />
                      </a>
                      <button
                        type="button"
                        aria-label={intl.formatMessage(
                          { id: "backups.copies.restoreNamed" },
                          { date: when },
                        )}
                        onClick={() => setRestoring({ copy: snapshot })}
                        className={textLinkClass}
                      >
                        <FormattedMessage id="backups.copies.restoreThis" />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {me.user.isOwner && <RestoreFile onChoose={(file) => setRestoring({ file })} />}
      {restoring && <RestoreDialog source={restoring} onClose={() => setRestoring(null)} />}
    </div>
  );
}

type Copy = BackupsInfo["snapshots"][number];
type RestoreSource = { file: File } | { copy: Copy };

/** A backup that was downloaded, chosen to put the site back as it was. Only for the Owner. */
function RestoreFile({ onChoose }: { onChoose: (file: File) => void }) {
  const intl = useIntl();
  const headingId = useId();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string>();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const found = !file
      ? "backups.restore.fileRequired"
      : (await looksLikeABackup(file))
        ? null
        : "backups.restore.notABackup";
    setProblem(found ? intl.formatMessage({ id: found }) : undefined);
    if (found || !file) inputRef.current?.focus();
    else onChoose(file);
  }

  return (
    <section aria-labelledby={headingId} className={cardClass}>
      <h2 id={headingId} className="text-xl font-bold">
        <FormattedMessage id="backups.restore.heading" />
      </h2>
      <p>
        <FormattedMessage id="backups.restore.body" />
      </p>
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        <div className="grid gap-2">
          <label htmlFor={inputId} className="font-medium">
            <FormattedMessage id="backups.restore.file" />
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept=".zip,application/zip"
            aria-describedby={`${hintId} ${errorId}`}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setProblem(undefined);
            }}
            className="dashed w-full p-4 file:mr-4 file:min-h-11 file:cursor-pointer file:rounded-xl file:border file:border-line file:bg-surface file:px-4 file:font-semibold file:text-ink hover:file:border-brand focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand"
          />
          <p id={hintId} className="text-sm text-muted">
            <FormattedMessage id="backups.restore.fileHint" />
          </p>
          {/* Always mounted: screen readers can miss a live region added along with its text. */}
          <p id={errorId} role="alert" className="text-sm font-medium text-danger empty:sr-only">
            {problem}
          </p>
        </div>
        <div>
          <button type="submit" className={smallButtonClass}>
            <FormattedMessage id="backups.restore.choose" />
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * Puts the whole site back as it was (PLAN.md v0.2), from a downloaded backup or a copy kept
 * here. Everyone's accounts go back too, so the Owner says their password again. Once it's
 * done everyone is signed out, and sign-in says why.
 */
function RestoreDialog({ source, onClose }: { source: RestoreSource; onClose: () => void }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const setup = useSetup();
  const headingId = useId();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [missing, setMissing] = useState(false);
  // How much of the file has been sent, or null while nothing is being sent.
  const [sent, setSent] = useState<number | null>(null);
  const stopRef = useRef<AbortController | null>(null);

  // Closing stops sending. Once Tend has all of it, the restore goes on without this page.
  useEffect(() => () => stopRef.current?.abort(), []);

  const restore = useMutation({
    mutationFn: async () => {
      const stop = new AbortController();
      stopRef.current = stop;
      if ("copy" in source) return restoreAsOwner({ password, copy: source.copy.id }, stop.signal);
      await checkOwnerPassword(password);
      setSent(0);
      await sendBackup(source.file, OWNER_PARTS, setSent, stop.signal);
      setSent(null);
      return restoreAsOwner({ password, bytes: source.file.size }, stop.signal);
    },
    onSuccess: (restored) => {
      setup.setRestored(restored);
      // Everyone is signed out now. What was on screen belongs to the site as it was.
      queryClient.removeQueries({
        predicate: ({ queryKey }) =>
          queryKey[0] !== ME_KEY[0] && queryKey[0] !== SETUP_STATUS_KEY[0],
      });
      queryClient.setQueryData(ME_KEY, null);
    },
    onError: () => {
      setSent(null);
      passwordRef.current?.focus();
    },
  });

  const aboutPassword =
    restore.error instanceof ApiError && restore.error.field === "password"
      ? errorText(restore.error, "")
      : undefined;
  const failed =
    restore.isError && !aboutPassword && !(restore.error instanceof DOMException)
      ? restore.error
      : null;
  const when =
    "copy" in source
      ? intl.formatDate(source.copy.takenAt, { dateStyle: "long", timeStyle: "short" })
      : "";
  const working = sent === null ? "backups.restore.restoring" : "backups.restore.sending";

  return (
    <Dialog
      labelledBy={headingId}
      // Once it's started, the site is changing: the dialog stays until it's done.
      onClose={() => {
        if (!restore.isPending) onClose();
      }}
    >
      <form
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (restore.isPending) return;
          setMissing(password === "");
          if (password === "") passwordRef.current?.focus();
          else restore.mutate();
        }}
      >
        <h2 id={headingId} className="text-xl font-bold [overflow-wrap:anywhere]">
          {"copy" in source ? (
            <FormattedMessage id="backups.restore.confirmCopy" values={{ date: when }} />
          ) : (
            <FormattedMessage
              id="backups.restore.confirmFile"
              values={{ name: source.file.name }}
            />
          )}
        </h2>
        <ul className="grid list-disc gap-2 pl-5">
          <li>
            <FormattedMessage
              id={"copy" in source ? "backups.restore.whatCopy" : "backups.restore.whatFile"}
            />
          </li>
          <li>
            <FormattedMessage id="backups.restore.signedOut" />
          </li>
          <li>
            <FormattedMessage id="backups.restore.undo" />
          </li>
        </ul>
        <PasswordField
          ref={passwordRef}
          label={intl.formatMessage({ id: "kit.password" })}
          value={password}
          error={missing ? intl.formatMessage({ id: "kit.passwordRequired" }) : aboutPassword}
          autoComplete="current-password"
          disabled={restore.isPending}
          onChange={(event) => {
            setPassword(event.target.value);
            setMissing(false);
            restore.reset();
          }}
        />
        {restore.isPending && (
          <div className="grid gap-2">
            <progress
              className="h-2 w-full accent-brand"
              max={1}
              // Without a value, it shows something happening without saying how much.
              value={sent ?? undefined}
              aria-label={intl.formatMessage({ id: working })}
            />
            <p className="text-muted">
              {sent === null ? (
                <FormattedMessage id="backups.restore.restoringBody" />
              ) : (
                <FormattedMessage
                  id="backups.restore.sendingBody"
                  values={{ percent: intl.formatNumber(sent, { style: "percent" }) }}
                />
              )}
            </p>
          </div>
        )}
        {/* Always mounted: screen readers can miss a live region added along with its text. */}
        <p role="status" className="sr-only">
          {restore.isPending && <FormattedMessage id={working} />}
        </p>
        <p role="alert" className="font-medium text-danger empty:sr-only">
          {failed && <Problem error={failed} />}
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={restore.isPending}
            className={primaryButtonClass}
            onClick={onClose}
          >
            <FormattedMessage id="backups.restore.keep" />
          </button>
          <button type="submit" disabled={restore.isPending} className={secondaryButtonClass}>
            <FormattedMessage
              id={restore.isPending ? "backups.restore.working" : "backups.restore.submit"}
            />
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function SettingsScreen({ me, section }: { me: Me; section: Section }) {
  const intl = useIntl();
  return (
    <AdminLayout
      me={me}
      screen="settings"
      title={intl.formatMessage({ id: `settings.${section}` })}
    >
      <nav aria-label={intl.formatMessage({ id: "settings.sections" })} className="mt-5">
        <ul className="flex w-fit max-w-full flex-wrap gap-1 rounded-2xl bg-sunken p-1">
          {SECTIONS.map((name) => (
            <li key={name}>
              <Link
                href={`/settings/${name}`}
                aria-current={name === section ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-xl px-4 focus-visible:outline-3 focus-visible:outline-brand ${
                  name === section
                    ? "bg-surface font-semibold shadow-xs ring-1 ring-line"
                    : "font-medium text-muted hover:text-ink"
                }`}
              >
                <FormattedMessage id={`settings.${name}`} />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="mt-5">
        {section === "general" && <GeneralSection me={me} />}
        {section === "business" && <BusinessSection />}
        {section === "search" && <SearchSection />}
        {section === "advanced" && <AdvancedSection />}
        {section === "backups" && <BackupsSection me={me} />}
      </div>
    </AdminLayout>
  );
}

export function SettingsPage() {
  const params = useParams<{ section?: string }>();
  const section = SECTIONS.find((name) => name === params.section);
  if (!section) return <Redirect to="/settings/general" replace />;
  return (
    <SignedIn roles={["admin"]}>{(me) => <SettingsScreen me={me} section={section} />}</SignedIn>
  );
}
