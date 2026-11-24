import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import {
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { MediaPicker } from "../components/MediaPicker.tsx";
import { showToast } from "../components/Toast.tsx";
import { Waiting } from "../components/Waiting.tsx";
import { PreviewDialog } from "../editor/PreviewDialog.tsx";
import { api, errorText } from "../lib/api.ts";
import { useMediaItems } from "../lib/media.ts";
import type { Me } from "../lib/queries.ts";
import { settleScreenDraft, useScreenDraft } from "../lib/screen-drafts.ts";
import {
  DESIGN_KEY,
  type Design,
  type DesignReply,
  hardToReadOn,
  readableOn,
  SOCIAL_NETWORKS,
  type SocialNetwork,
  type ThemeChoice,
  type ThemeSetting,
  themeValue,
} from "../lib/site.ts";

const smallButtonClass = `${secondaryButtonClass} aria-disabled:opacity-60`;
const inputClass =
  "min-h-11 w-full rounded-lg border border-muted bg-white px-3 text-lg text-[#1d2420] placeholder:text-[#5b655f] focus-visible:outline-3 focus-visible:outline-brand";
const SOCIAL_NAMES: Record<SocialNetwork, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  youtube: "YouTube",
  x: "X",
  linkedin: "LinkedIn",
  pinterest: "Pinterest",
  threads: "Threads",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  whatsapp: "WhatsApp",
  other: "Other",
};
/** How a theme of one's own is started, where there's a terminal to do it in. */
const COPY_COMMANDS: Partial<Record<DesignReply["platform"], string>> = {
  local: "npx tendcms theme copy meadow my-theme",
  docker: "docker exec tend tendcms theme copy meadow my-theme",
};
/** The warning for each of Meadow's backgrounds, so it names where to look. */
const HARD_TO_READ: Record<string, string> = {
  "#ffffff": "design.lowContrast",
  "#f1f2f2": "design.lowContrastSoft",
};

/** A picture from Media for the logo or icon, with a way to change or remove it. */
function PictureChoice({
  label,
  hint,
  empty,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  empty: string;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const intl = useIntl();
  const [picking, setPicking] = useState(false);
  const { found, isPending, isError } = useMediaItems(value ? [value] : []);
  const item = value ? found.get(value) : undefined;
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 font-medium">{label}</legend>
      <p className="text-sm text-muted">{hint}</p>
      {value === null ? (
        <p className="text-sm">{empty}</p>
      ) : item ? (
        <img
          src={item.previewUrl ?? item.thumbUrl ?? undefined}
          alt={item.alt ?? ""}
          className="max-h-24 w-fit max-w-full rounded border border-ink/10 bg-white object-contain p-2"
        />
      ) : (
        <p className="text-sm text-muted">
          <FormattedMessage
            id={isPending ? "common.loading" : isError ? "image.cantLoad" : "design.pictureGone"}
          />
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => setPicking(true)} className={smallButtonClass}>
          <FormattedMessage id={value ? "design.change" : "design.choose"} />
        </button>
        {value && (
          <button type="button" onClick={() => onChange(null)} className={smallButtonClass}>
            <FormattedMessage id="design.remove" />
          </button>
        )}
      </div>
      {picking && (
        <MediaPicker
          heading={intl.formatMessage({ id: "design.pickHeading" }, { what: label })}
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

function ColorChoice({
  setting,
  value,
  onChange,
}: {
  setting: Extract<ThemeSetting, { type: "color" }>;
  value: string;
  onChange: (value: string) => void;
}) {
  const intl = useIntl();
  const inputId = useId();
  const hintId = useId();
  const [typed, setTyped] = useState(value);
  // The colour can change from outside this box too: Undo, or "Use it".
  useEffect(() => {
    setTyped((current) => (current.toLowerCase() === value ? current : value));
  }, [value]);
  // Checked against every background the theme says it goes on, not only white: a colour that
  // only just reads on white is too light in a section with a Soft background.
  const backgrounds = setting.contrastAgainst ?? [];
  const hardToRead = hardToReadOn(value, backgrounds);
  const suggestion = readableOn(value, backgrounds);
  return (
    <div className="grid gap-2">
      <label htmlFor={inputId} className="font-medium">
        {setting.label}
      </label>
      {setting.hint && (
        <p id={hintId} className="text-sm text-muted">
          {setting.hint}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="color"
          value={value}
          aria-label={intl.formatMessage({ id: "design.pickColor" }, { name: setting.label })}
          onChange={(event) => {
            setTyped(event.target.value);
            onChange(event.target.value);
          }}
          className="h-11 w-16 cursor-pointer rounded border border-muted bg-white p-1"
        />
        <input
          id={inputId}
          value={typed}
          aria-describedby={setting.hint ? hintId : undefined}
          maxLength={7}
          spellCheck={false}
          onChange={(event) => {
            const next = event.target.value.trim();
            setTyped(next);
            const full = next.startsWith("#") ? next : `#${next}`;
            if (/^#[0-9a-f]{6}$/i.test(full)) onChange(full.toLowerCase());
          }}
          className={`${inputClass.replace("w-full", "w-36")} font-mono`}
        />
        <button
          type="button"
          onClick={() => {
            setTyped(setting.default);
            onChange(setting.default);
          }}
          className={textLinkClass}
        >
          <FormattedMessage id="design.useDefault" />
        </button>
      </div>
      {/* Always mounted, so the warning is announced as soon as it appears. */}
      <div role="status" className="empty:sr-only">
        {hardToRead && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-danger p-3">
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-6 w-6 rounded border border-ink/20"
                style={{ background: suggestion }}
              />
              <FormattedMessage
                id={HARD_TO_READ[hardToRead] ?? "design.lowContrastOn"}
                values={{ color: suggestion, background: hardToRead }}
              />
            </span>
            <button
              type="button"
              onClick={() => {
                setTyped(suggestion);
                onChange(suggestion);
              }}
              className={smallButtonClass}
            >
              <FormattedMessage id="design.apply" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function SelectChoice({
  setting,
  value,
  onChange,
}: {
  setting: Extract<ThemeSetting, { type: "select" }>;
  value: string;
  onChange: (value: string) => void;
}) {
  const name = useId();
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 font-medium">{setting.label}</legend>
      {setting.options.map((option) => (
        <label
          key={option.value}
          className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 ${value === option.value ? "border-brand" : "border-muted"}`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="mt-1 h-5 w-5 accent-brand"
          />
          <span className="grid">
            <span className="font-medium">{option.label}</span>
            {option.hint && <span className="text-sm text-muted">{option.hint}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Which theme the site uses, once there's more than the one Tend comes with. */
function ThemePicker({
  themes,
  value,
  onChange,
}: {
  themes: DesignReply["themes"];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const name = useId();
  const [bundled] = themes;
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 font-medium">
        <FormattedMessage id="design.theme" />
      </legend>
      {themes.map((theme) => (
        <label
          key={theme.id ?? ""}
          className={`flex min-h-11 items-start gap-3 rounded-lg border p-3 [overflow-wrap:anywhere] ${theme.usable ? "cursor-pointer" : ""} ${value === theme.id ? "border-brand" : "border-muted"}`}
        >
          <input
            type="radio"
            name={name}
            checked={value === theme.id}
            disabled={!theme.usable}
            onChange={() => onChange(theme.id)}
            className="mt-1 h-5 w-5 shrink-0 accent-brand"
          />
          <span className="grid">
            <span className="font-medium">{theme.name}</span>
            <span className="text-sm text-muted">
              <FormattedMessage id={theme.id === null ? "design.themeTends" : "design.themeOwn"} />
            </span>
            {theme.problem && (
              <span className="text-sm font-medium text-danger">
                {theme.usable ? (
                  <FormattedMessage
                    id="design.themeMistake"
                    values={{ bundled: bundled.name, problem: theme.problem }}
                  />
                ) : (
                  theme.problem
                )}
              </span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function DesignForm({ me, reply }: { me: Me; reply: DesignReply }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  // Unsaved changes wait here if someone goes to another screen, and come back with them.
  const draft = useScreenDraft<Design>("design", reply.value);
  const design = draft.value ?? reply.value;
  const { changed } = draft;
  const [bundled] = reply.themes;
  const copyCommand = COPY_COMMANDS[reply.platform];
  // A theme that's gone is drawn with Tend's own, so its choices are the ones to show.
  const theme: ThemeChoice = reply.themes.find(({ id }) => id === design.themeId) ?? bundled;
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const footerId = useId();
  const cssId = useId();
  const cssHintId = useId();

  function change(patch: Partial<Design>) {
    draft.set((current) => ({ ...current, ...patch }));
  }

  function setTheme(id: string, value: string) {
    draft.set((current) => ({ ...current, theme: { ...current.theme, [id]: value } }));
  }

  const save = useMutation({
    mutationFn: (sent: Design) => api<DesignReply>("/admin/design", { method: "PUT", body: sent }),
    onSuccess: (answer, sent) => {
      queryClient.setQueryData(DESIGN_KEY, answer);
      // Anything changed while this was on its way stays, still to be saved.
      draft.saved(sent);
      settleScreenDraft("design", sent);
      if (!answer.saved) {
        showToast({ message: intl.formatMessage({ id: "settings.nothingChanged" }) });
        return;
      }
      showToast({
        message: intl.formatMessage({ id: "design.saved" }),
        action: {
          label: intl.formatMessage({ id: "list.undo" }),
          run: () => {
            void api<DesignReply>("/admin/design/undo", {
              method: "POST",
              body: { undoId: answer.undoId },
            })
              .then((undone) => {
                queryClient.setQueryData(DESIGN_KEY, undone);
                showToast({ message: intl.formatMessage({ id: "design.undone" }) });
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

  const preview = useMutation({
    mutationFn: () =>
      api<{ html: string }>("/admin/design/preview", { method: "POST", body: design }),
    onSuccess: ({ html }) => setPreviewHtml(html),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (changed && !save.isPending) save.mutate(design);
  }

  const error = save.error ?? preview.error;

  return (
    <form onSubmit={onSubmit} className="mt-6 grid gap-8">
      {reply.missing !== null && (
        <p className="rounded-lg border border-danger p-3 [overflow-wrap:anywhere]">
          <FormattedMessage
            id="design.themeMissing"
            values={{ name: reply.missing, bundled: bundled.name }}
          />
        </p>
      )}
      {(reply.themes.length > 1 || reply.missing !== null) && (
        <ThemePicker
          themes={reply.themes}
          value={design.themeId}
          onChange={(themeId) => change({ themeId })}
        />
      )}
      <PictureChoice
        label={intl.formatMessage({ id: "design.logo" })}
        hint={intl.formatMessage({ id: "design.logoHint" })}
        empty={intl.formatMessage({ id: "design.noLogo" })}
        value={design.logoId}
        onChange={(logoId) => change({ logoId })}
      />
      <PictureChoice
        label={intl.formatMessage({ id: "design.icon" })}
        hint={intl.formatMessage({ id: "design.iconHint" })}
        empty={intl.formatMessage({ id: design.logoId ? "design.iconFromLogo" : "design.noIcon" })}
        value={design.iconId}
        onChange={(iconId) => change({ iconId })}
      />
      {theme.settings.map((setting) =>
        setting.type === "color" ? (
          <ColorChoice
            key={`${theme.id}:${setting.id}`}
            setting={setting}
            value={themeValue(setting, design.theme)}
            onChange={(value) => setTheme(setting.id, value)}
          />
        ) : (
          <SelectChoice
            key={`${theme.id}:${setting.id}`}
            setting={setting}
            value={themeValue(setting, design.theme)}
            onChange={(value) => setTheme(setting.id, value)}
          />
        ),
      )}
      <div className="grid gap-2">
        <label htmlFor={footerId} className="font-medium">
          <FormattedMessage id="design.footer" />
        </label>
        <textarea
          id={footerId}
          rows={2}
          maxLength={500}
          value={design.footerText ?? ""}
          placeholder={`© ${me.site.name}`}
          onChange={(event) => change({ footerText: event.target.value || null })}
          className={`${inputClass} py-2`}
        />
      </div>
      <fieldset className="grid gap-3">
        <legend className="mb-1 font-medium">
          <FormattedMessage id="design.social" />
        </legend>
        <p className="text-sm text-muted">
          <FormattedMessage id="design.socialHint" />
        </p>
        {design.social.map((link, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows are only ever added or removed at the end
          <div key={index} className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-sm">
              <FormattedMessage id="design.network" />
              <select
                value={link.network}
                onChange={(event) => {
                  const social = [...design.social];
                  social[index] = { ...link, network: event.target.value as SocialNetwork };
                  change({ social });
                }}
                className="min-h-11 rounded-lg border border-muted bg-white px-2 text-[#1d2420] focus-visible:outline-3 focus-visible:outline-brand"
              >
                {SOCIAL_NETWORKS.map((network) => (
                  <option key={network} value={network}>
                    {SOCIAL_NAMES[network]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 flex-1 gap-1 text-sm">
              <FormattedMessage id="design.socialAddress" />
              <input
                value={link.url ?? ""}
                inputMode="url"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="https://"
                onChange={(event) => {
                  const social = [...design.social];
                  social[index] = { ...link, url: event.target.value || null };
                  change({ social });
                }}
                className={inputClass}
              />
            </label>
            <button
              type="button"
              onClick={() =>
                change({ social: design.social.filter((_, other) => other !== index) })
              }
              className={smallButtonClass}
            >
              <FormattedMessage id="design.remove" />
            </button>
          </div>
        ))}
        {design.social.length < 12 && (
          <div>
            <button
              type="button"
              onClick={() =>
                change({ social: [...design.social, { network: "instagram", url: null }] })
              }
              className={smallButtonClass}
            >
              <FormattedMessage id="design.addSocial" />
            </button>
          </div>
        )}
      </fieldset>
      <details className="rounded-lg border border-muted">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 font-medium focus-visible:outline-3 focus-visible:outline-brand">
          <FormattedMessage id="design.advanced" />
        </summary>
        <div className="grid gap-2 border-t border-muted p-3">
          <label htmlFor={cssId} className="font-medium">
            <FormattedMessage id="design.css" />
          </label>
          <p id={cssHintId} className="text-sm text-muted">
            <FormattedMessage id="design.cssHint" />
          </p>
          <textarea
            id={cssId}
            rows={8}
            spellCheck={false}
            aria-describedby={cssHintId}
            value={design.customCss ?? ""}
            onChange={(event) => change({ customCss: event.target.value || null })}
            className={`${inputClass} py-2 font-mono text-base`}
          />
        </div>
      </details>
      {copyCommand && (
        <details className="rounded-lg border border-muted">
          <summary className="flex min-h-11 cursor-pointer items-center px-3 font-medium focus-visible:outline-3 focus-visible:outline-brand">
            <FormattedMessage id="design.ownTheme" />
          </summary>
          <div className="grid gap-2 border-t border-muted p-3">
            <p>
              <FormattedMessage id={`design.ownThemeHint.${reply.platform}`} />
            </p>
            <pre className="rounded-lg border border-muted/50 bg-white/60 p-3 text-sm break-all whitespace-pre-wrap dark:bg-white/5">
              <code>{copyCommand}</code>
            </pre>
            <p className="text-sm text-muted">
              <FormattedMessage id="design.ownThemeNote" />
            </p>
          </div>
        </details>
      )}

      <p role="alert" className="font-medium text-danger empty:sr-only">
        {error && errorText(error, intl.formatMessage({ id: "offline.body" }))}
      </p>
      <div className="sticky bottom-(--tend-bar) -mx-4 flex flex-wrap items-center gap-3 border-t border-ink/10 bg-paper px-4 py-3">
        <button
          type="submit"
          aria-disabled={!changed || save.isPending}
          className={`${primaryButtonClass} aria-disabled:opacity-60`}
        >
          <FormattedMessage id={save.isPending ? "design.saving" : "design.save"} />
        </button>
        <button
          type="button"
          aria-disabled={preview.isPending}
          onClick={() => {
            if (!preview.isPending) preview.mutate();
          }}
          className={smallButtonClass}
        >
          <FormattedMessage id="design.preview" />
        </button>
        {changed && (
          <span className="text-sm text-muted">
            <FormattedMessage id="design.unsaved" />
          </span>
        )}
      </div>
      {previewHtml !== null && (
        <PreviewDialog html={previewHtml} onClose={() => setPreviewHtml(null)} />
      )}
    </form>
  );
}

function DesignScreen({ me }: { me: Me }) {
  const design = useQuery({
    queryKey: DESIGN_KEY,
    queryFn: () => api<DesignReply>("/admin/design"),
    // What's on screen is someone's work in progress, so it isn't swapped under them.
    refetchOnWindowFocus: false,
  });
  return (
    <AdminLayout me={me} screen="design">
      <p className="mt-2 text-muted">
        <FormattedMessage id="design.hint" />
      </p>
      {design.data ? <DesignForm me={me} reply={design.data} /> : <Waiting query={design} />}
    </AdminLayout>
  );
}

export function DesignPage() {
  return <SignedIn roles={["admin"]}>{(me) => <DesignScreen me={me} />}</SignedIn>;
}
