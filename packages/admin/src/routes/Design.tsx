import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import {
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { optionClass, radioClass } from "../components/fields.tsx";
import { Icon } from "../components/icons.tsx";
import { LivePreview } from "../components/LivePreview.tsx";
import { MediaPicker } from "../components/MediaPicker.tsx";
import { Problem } from "../components/Problem.tsx";
import { showToast } from "../components/Toast.tsx";
import { Waiting } from "../components/Waiting.tsx";
import { PreviewDialog } from "../editor/PreviewDialog.tsx";
import { api, errorText } from "../lib/api.ts";
import { useMediaItems } from "../lib/media.ts";
import { useMediaQuery } from "../lib/media-query.ts";
import type { Me } from "../lib/queries.ts";
import { settleScreenDraft, useScreenDraft } from "../lib/screen-drafts.ts";
import {
  ACCENTS,
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
import { SITE_STYLE_KEY, SiteStyle } from "../lib/site-style.tsx";

/** Where there's room for the site beside the form. */
const ROOM_BESIDE = "(min-width: 80rem)";
const smallButtonClass = `${secondaryButtonClass} aria-disabled:opacity-60`;
const inputClass =
  "min-h-11 w-full rounded-xl border border-edge bg-field px-3 text-lg placeholder:text-muted focus-visible:outline-3 focus-visible:outline-brand";
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
const detailsClass = "group border-y border-line";
const summaryClass =
  "flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 font-medium focus-visible:outline-3 focus-visible:outline-brand [&::-webkit-details-marker]:hidden";
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
  instead,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  empty: string;
  /** What shows where the picture would be, until there is one. */
  instead?: ReactNode;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const intl = useIntl();
  const [picking, setPicking] = useState(false);
  const { found, isPending, isError } = useMediaItems(value ? [value] : []);
  const item = value ? found.get(value) : undefined;
  return (
    <fieldset>
      <legend className="mb-2 font-medium">{label}</legend>
      <div className="dashed flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
        <div className="min-w-0 flex-1 basis-32">
          {value === null ? (
            <>
              {instead}
              <p className="text-sm">{empty}</p>
            </>
          ) : item ? (
            <img
              src={item.previewUrl ?? item.thumbUrl ?? undefined}
              alt={item.alt ?? ""}
              className="max-h-20 w-fit max-w-full rounded-lg border border-line bg-white object-contain p-2"
            />
          ) : (
            <p className="text-sm text-muted">
              <FormattedMessage
                id={
                  isPending ? "common.loading" : isError ? "image.cantLoad" : "design.pictureGone"
                }
              />
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setPicking(true)} className={smallButtonClass}>
            <FormattedMessage id={value ? "design.change" : "design.choose"} />
          </button>
          {value && (
            <button type="button" onClick={() => onChange(null)} className={smallButtonClass}>
              <FormattedMessage id="design.remove" />
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 text-sm text-muted">{hint}</p>
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
      {setting.id === "accent" && (
        <fieldset className="flex flex-wrap gap-1">
          <legend className="sr-only">
            <FormattedMessage id="design.colors" />
          </legend>
          {ACCENTS.map((accent) => (
            <button
              key={accent.id}
              type="button"
              aria-label={intl.formatMessage({ id: `design.color.${accent.id}` })}
              title={intl.formatMessage({ id: `design.color.${accent.id}` })}
              aria-pressed={value === accent.value}
              onClick={() => {
                setTyped(accent.value);
                onChange(accent.value);
              }}
              className="grid size-11 place-items-center rounded-full border-2 border-transparent focus-visible:outline-3 focus-visible:outline-brand aria-pressed:border-ink"
            >
              <span
                aria-hidden="true"
                className="size-8.5 rounded-full"
                style={{ background: accent.value }}
              />
            </button>
          ))}
        </fieldset>
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
          className="h-11 w-14 cursor-pointer rounded-xl border border-edge bg-field p-1.5 focus-visible:outline-3 focus-visible:outline-brand"
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
          className={`${inputClass.replace("w-full", "w-32")} font-mono text-base`}
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
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-wait-line bg-wait-soft p-4">
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block size-6 shrink-0 rounded-full border border-ink/20"
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

/** Over all of what it's for, which shows whether it's chosen. */
const hiddenRadioClass = "absolute inset-0 size-full cursor-pointer opacity-0";

/** How a header is laid out, drawn small. */
function HeaderPicture({ centered }: { centered: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 120 44" className="mb-1 h-11 w-full max-w-36">
      <rect
        x={centered ? 42 : 4}
        y={centered ? 8 : 18}
        width="36"
        height="8"
        rx="3"
        className="fill-ink"
      />
      <rect
        x={centered ? 30 : 64}
        y={centered ? 26 : 19.5}
        width={centered ? 60 : 52}
        height="5"
        rx="2.5"
        className="fill-edge"
      />
    </svg>
  );
}

/** A choice as a picture of what it does, for the ones Tend knows. */
function pictureOf(
  settingId: string,
  value: string,
  fonts: Record<string, string> | undefined,
): ReactNode {
  if (settingId === "fonts" && fonts) {
    return (
      <span
        aria-hidden="true"
        data-font-choice={value}
        className="tend-font text-3xl leading-tight"
      >
        Aa
      </span>
    );
  }
  if (settingId === "header" && (value === "simple" || value === "centered")) {
    return <HeaderPicture centered={value === "centered"} />;
  }
  return null;
}

const FONT_VALUES = ["font-body", "font-heading", "heading-weight", "heading-tracking"]
  .map((name) => `--tend-${name}: initial;`)
  .join(" ");

/** Each choice of fonts, only where it's shown, so it's the same as it'd be on the site. */
function FontChoicesStyle({ fonts }: { fonts: Record<string, string> }) {
  const css = Object.entries(fonts).map(([value, own]) =>
    own.replaceAll(":root", `[data-font-choice="${CSS.escape(value)}"]`),
  );
  // Each starts from nothing, rather than from the fonts the site has now.
  return <style>{`[data-font-choice] { ${FONT_VALUES} }\n${css.join("\n")}`}</style>;
}

function SelectChoice({
  setting,
  value,
  fonts,
  onChange,
}: {
  setting: Extract<ThemeSetting, { type: "select" }>;
  value: string;
  /** What each choice of fonts is, once that's here. */
  fonts: Record<string, string> | undefined;
  onChange: (value: string) => void;
}) {
  const name = useId();
  const pictures = setting.options.map((option) => pictureOf(setting.id, option.value, fonts));
  // Side by side if each is drawn, and otherwise in a list, each with what it means.
  const drawn = pictures.every(Boolean);
  return (
    <fieldset>
      <legend className="mb-2 font-medium">{setting.label}</legend>
      <div
        className={`grid gap-2.5 ${drawn ? "grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))]" : ""}`}
      >
        {setting.options.map((option, index) => (
          <label key={option.value} className={optionClass}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className={drawn ? hiddenRadioClass : radioClass}
            />
            <span className="grid min-w-0 gap-1">
              {drawn && pictures[index]}
              <span className="font-semibold">{option.label}</span>
              {option.hint && (
                <span className={drawn ? "sr-only" : "text-sm text-muted"}>{option.hint}</span>
              )}
            </span>
          </label>
        ))}
      </div>
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
        <label key={theme.id ?? ""} className={optionClass}>
          <input
            type="radio"
            name={name}
            checked={value === theme.id}
            disabled={!theme.usable}
            onChange={() => onChange(theme.id)}
            className={radioClass}
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

function DesignForm({
  me,
  reply,
  beside,
  onDesign,
}: {
  me: Me;
  reply: DesignReply;
  /** Whether the site is beside it, so it needn't be asked for. */
  beside: boolean;
  /** The design as it is now, saved or not, for showing beside it. */
  onDesign: (design: Design) => void;
}) {
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
  const hasFonts = theme.settings.some(({ id, type }) => id === "fonts" && type === "select");
  const fonts = useQuery({
    queryKey: ["design-fonts", theme.id],
    queryFn: () =>
      api<{ fonts: Record<string, string> }>(
        `/admin/design/fonts${theme.id ? `?theme=${encodeURIComponent(theme.id)}` : ""}`,
      ),
    enabled: hasFonts,
    // The choices have their names without it.
    retry: false,
  }).data?.fonts;

  useEffect(() => onDesign(design), [design, onDesign]);

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
      void queryClient.invalidateQueries({ queryKey: SITE_STYLE_KEY });
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
                void queryClient.invalidateQueries({ queryKey: SITE_STYLE_KEY });
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
    <form
      onSubmit={onSubmit}
      className="mt-6 grid grid-cols-1 gap-8 max-xl:card max-xl:px-5 max-xl:pt-6 sm:max-xl:px-7"
    >
      <SiteStyle />
      {fonts && <FontChoicesStyle fonts={fonts} />}
      {reply.missing !== null && (
        <p className="rounded-2xl border border-danger bg-danger-soft p-4 [overflow-wrap:anywhere]">
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
        instead={
          <p className="tend-font mb-1 text-2xl leading-tight [overflow-wrap:anywhere]">
            {me.site.name}
          </p>
        }
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
            fonts={fonts}
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
                className="min-h-11 rounded-xl border border-edge bg-field px-2 focus-visible:outline-3 focus-visible:outline-brand"
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
      <details className={detailsClass}>
        <summary className={summaryClass}>
          <FormattedMessage id="design.advanced" />
          <Icon name="right" className="size-5 text-muted group-open:rotate-90" />
        </summary>
        <div className="grid gap-2 pb-5">
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
        <details className={`${detailsClass} -mt-8`}>
          <summary className={summaryClass}>
            <FormattedMessage id="design.ownTheme" />
            <Icon name="right" className="size-5 text-muted group-open:rotate-90" />
          </summary>
          <div className="grid gap-2 pb-5">
            <p>
              <FormattedMessage id={`design.ownThemeHint.${reply.platform}`} />
            </p>
            <pre className="rounded-xl bg-sunken p-3 text-sm break-all whitespace-pre-wrap">
              <code>{copyCommand}</code>
            </pre>
            <p className="text-sm text-muted">
              <FormattedMessage id="design.ownThemeNote" />
            </p>
          </div>
        </details>
      )}

      <p role="alert" className="font-medium text-danger empty:sr-only">
        {error && <Problem error={error} />}
      </p>
      <div className="sticky bottom-(--tend-bar) z-10 -mx-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-surface px-5 py-4 max-xl:rounded-b-[1.125rem] sm:-mx-7 sm:px-7">
        <button
          type="submit"
          aria-disabled={!changed || save.isPending}
          className={`${primaryButtonClass} aria-disabled:opacity-60 ${beside ? "flex-1" : ""}`}
        >
          <FormattedMessage id={save.isPending ? "design.saving" : "design.save"} />
        </button>
        {!beside && (
          <button
            type="button"
            aria-disabled={preview.isPending}
            onClick={() => {
              if (!preview.isPending) preview.mutate();
            }}
            className={smallButtonClass}
          >
            <Icon name="eye" />
            <FormattedMessage id="design.preview" />
          </button>
        )}
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
  const room = useMediaQuery(ROOM_BESIDE);
  const [now, setNow] = useState<Design | null>(null);
  return (
    <AdminLayout
      me={me}
      screen="design"
      intro={<FormattedMessage id="design.hint" />}
      // Its place is kept from the start, so nothing moves once there's something in it.
      beside={room && (now ? <LivePreview design={now} name={me.site.name} /> : <span />)}
    >
      {design.data ? (
        <DesignForm me={me} reply={design.data} beside={room} onDesign={setNow} />
      ) : (
        <Waiting query={design} />
      )}
    </AdminLayout>
  );
}

export function DesignPage() {
  return <SignedIn roles={["admin"]}>{(me) => <DesignScreen me={me} />}</SignedIn>;
}
