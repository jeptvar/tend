import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Link, Redirect, useParams } from "wouter";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import {
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { Field } from "../components/fields.tsx";
import { MediaPicker } from "../components/MediaPicker.tsx";
import { showToast } from "../components/Toast.tsx";
import { ApiError, api, errorText } from "../lib/api.ts";
import { useMediaItems } from "../lib/media.ts";
import { ME_KEY, type Me } from "../lib/queries.ts";
import { settleScreenDraft, useScreenDraft } from "../lib/screen-drafts.ts";
import {
  type Business,
  type CodeSettings,
  DAYS,
  type DayHours,
  type General,
  type Redirect as RedirectRow,
  type SearchSettings,
  type Stored,
  settingKey,
  type Visibility,
} from "../lib/site.ts";

const SECTIONS = ["general", "business", "search", "advanced"] as const;
type Section = (typeof SECTIONS)[number];

const inputClass =
  "min-h-11 w-full rounded-lg border border-muted bg-white px-3 text-lg text-[#1d2420] placeholder:text-[#5b655f] focus-visible:outline-3 focus-visible:outline-brand";
const smallButtonClass = `${secondaryButtonClass} aria-disabled:opacity-60`;

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

/** The field a refusal was about, so its message can sit under that field. */
function fieldError(error: unknown, field: string): string | undefined {
  return error instanceof ApiError && error.field === field ? error.message : undefined;
}

function SaveRow({ busy, changed, error }: { busy: boolean; changed: boolean; error: unknown }) {
  const intl = useIntl();
  const general = error instanceof ApiError && error.field ? null : error;
  return (
    <div className="grid gap-2">
      <p role="alert" className="font-medium text-danger empty:sr-only">
        {general ? errorText(general, intl.formatMessage({ id: "offline.body" })) : null}
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

function Loading({ children }: { children: ReactNode }) {
  return <p className="mt-6 text-muted">{children}</p>;
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
  return (
    <form
      className="grid gap-6"
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
      <Field
        label={intl.formatMessage({ id: "settings.tagline" })}
        hint={intl.formatMessage({ id: "settings.taglineHint" })}
        value={form.tagline}
        maxLength={200}
        error={fieldError(error, "tagline")}
        onChange={(event) => setForm({ ...form, tagline: event.target.value })}
      />
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
      <SaveRow busy={busy} changed={changed} error={error} />
    </form>
  );
}

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
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !busy) onSave({ mode }, () => draft.saved({ mode }));
      }}
    >
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-xl font-semibold">
          <FormattedMessage id="settings.visibility" />
        </legend>
        {(["public", "coming_soon", "private"] as const).map((option) => (
          <label
            key={option}
            className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 ${mode === option ? "border-brand" : "border-muted"}`}
          >
            <input
              type="radio"
              name={name}
              checked={mode === option}
              onChange={() => setMode(option)}
              className="mt-1 h-5 w-5 accent-brand"
            />
            <span className="grid">
              <span className="font-medium">
                {intl.formatMessage({ id: `settings.visibility.${option}` })}
              </span>
              <span className="text-sm text-muted">
                {intl.formatMessage({ id: `settings.visibility.${option}Hint` })}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <SaveRow busy={busy} changed={changed} error={error} />
    </form>
  );
}

function GeneralSection({ me }: { me: Me }) {
  const general = useSetting<General>("general");
  const visibility = useSetting<Visibility>("visibility");
  return (
    <div className="grid gap-10">
      {general.query.data ? (
        <GeneralForm
          value={general.query.data.value}
          onSave={(value, done) => general.save.mutate(value, { onSuccess: done })}
          busy={general.save.isPending}
          error={general.save.error}
        />
      ) : (
        <Loading>
          <FormattedMessage id="common.loading" />
        </Loading>
      )}
      {visibility.query.data && (
        <VisibilityForm
          value={visibility.query.data.value}
          onSave={(value, done) => visibility.save.mutate(value, { onSuccess: done })}
          busy={visibility.save.isPending}
          error={visibility.save.error}
        />
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
      className="grid gap-6"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (changed && !busy) onSave(form, () => draft.saved(form));
      }}
    >
      <p className="text-muted">
        <FormattedMessage id="business.hint" />
      </p>
      <div className="grid gap-2">
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
      <Field
        label={intl.formatMessage({ id: "business.map" })}
        hint={intl.formatMessage({ id: "business.mapHint" })}
        inputMode="url"
        autoCapitalize="none"
        value={form.mapUrl ?? ""}
        error={fieldError(error, "mapUrl")}
        onChange={(event) => setForm({ ...form, mapUrl: event.target.value || null })}
      />
      <fieldset className="grid gap-3">
        <legend className="mb-1 font-medium">
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
            {form.hours.map((day, index) => (
              <div key={day.day} className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="w-28 font-medium">{dayName(index)}</span>
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
                      className={inputClass.replace("w-full", "w-32 min-w-0")}
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
                      className={inputClass.replace("w-full", "w-32 min-w-0")}
                    />
                  </span>
                )}
              </div>
            ))}
            <div>
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
      <div className="grid gap-2">
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
      <SaveRow busy={busy} changed={changed} error={error} />
    </form>
  );
}

function BusinessSection() {
  const business = useSetting<Business>("business");
  if (!business.query.data) {
    return (
      <Loading>
        <FormattedMessage id="common.loading" />
      </Loading>
    );
  }
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
      className="grid gap-6"
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
            className="h-24 w-fit rounded object-cover"
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
      <SaveRow busy={busy} changed={changed} error={error} />
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
                  }).then((again) => queryClient.setQueryData(["redirects"], again));
                },
              },
            }
          : {}),
      });
    },
  });
  const rows = list.data?.redirects ?? [];
  return (
    <section aria-labelledby="redirects-heading" className="grid gap-4">
      <h2 id="redirects-heading" className="text-xl font-semibold">
        <FormattedMessage id="redirects.heading" />
      </h2>
      <p className="text-muted">
        <FormattedMessage id="redirects.hint" />
      </p>
      {rows.length === 0 ? (
        <p className="text-muted">
          <FormattedMessage id="redirects.none" />
        </p>
      ) : (
        <ul className="divide-y divide-ink/10 border-y border-ink/10">
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
        className="grid gap-4 rounded-lg border border-muted p-3"
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
          {add.error && !(add.error instanceof ApiError && add.error.field)
            ? errorText(add.error, intl.formatMessage({ id: "offline.body" }))
            : null}
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
    <div className="grid gap-10">
      {seo.query.data ? (
        <SearchForm
          value={seo.query.data.value}
          onSave={(value, done) => seo.save.mutate(value, { onSuccess: done })}
          busy={seo.save.isPending}
          error={seo.save.error}
        />
      ) : (
        <Loading>
          <FormattedMessage id="common.loading" />
        </Loading>
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
      className="grid gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !busy) onSave(form, () => draft.saved(form));
      }}
    >
      <h2 className="text-xl font-semibold">
        <FormattedMessage id="code.heading" />
      </h2>
      <p className="rounded-lg border border-danger p-3">
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
  if (!code.query.data) {
    return (
      <Loading>
        <FormattedMessage id="common.loading" />
      </Loading>
    );
  }
  return (
    <CodeForm
      value={code.query.data.value}
      onSave={(value, done) => code.save.mutate(value, { onSuccess: done })}
      busy={code.save.isPending}
      error={code.save.error}
    />
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
      <nav aria-label={intl.formatMessage({ id: "settings.sections" })} className="mt-4">
        <ul className="-ml-2 flex flex-wrap">
          {SECTIONS.map((name) => (
            <li key={name}>
              <Link
                href={`/settings/${name}`}
                aria-current={name === section ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded px-2 hover:underline focus-visible:outline-3 focus-visible:outline-brand ${name === section ? "font-semibold" : "text-muted"}`}
              >
                <FormattedMessage id={`settings.${name}`} />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="mt-6">
        {section === "general" && <GeneralSection me={me} />}
        {section === "business" && <BusinessSection />}
        {section === "search" && <SearchSection />}
        {section === "advanced" && <AdvancedSection />}
      </div>
    </AdminLayout>
  );
}

export function SettingsPage() {
  const params = useParams<{ section?: string }>();
  const section = SECTIONS.find((name) => name === params.section);
  if (!section) return <Redirect to="/settings/general" replace />;
  return (
    <SignedIn>
      {(me) =>
        me.user.role === "admin" ? (
          <SettingsScreen me={me} section={section} />
        ) : (
          <Redirect to="/" replace />
        )
      }
    </SignedIn>
  );
}
