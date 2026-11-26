import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Link, Redirect, useLocation } from "wouter";
import {
  AuthLayout,
  CannotReachTend,
  Leaf,
  Loading,
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { Field, PasswordField } from "../components/fields.tsx";
import { Icon } from "../components/icons.tsx";
import { Problem } from "../components/Problem.tsx";
import { ApiError, api, errorText } from "../lib/api.ts";
import { looksLikeABackup, restoreBackup, sendBackup, setupParts } from "../lib/backup-upload.ts";
import { suggestPassphrase } from "../lib/passphrase.ts";
import {
  confirmSignedIn,
  SETUP_STATUS_KEY,
  type SetupStatus,
  useSetupStatus,
} from "../lib/queries.ts";
import { holdFreshKit } from "../lib/recovery-kit.ts";
import { type Starter, useSetup } from "../lib/setup-state.tsx";
import coffee from "./setup/coffee.webp";
import table from "./setup/table.webp";

const MIN_PASSWORD_LENGTH = 12;

/**
 * Saves what's typed on a step when leaving it by any route, including the browser's
 * Back button, so coming back doesn't mean typing it all again.
 */
function useSaveOnLeave(save: () => void): void {
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => () => latest.current(), []);
}

/** Sends people to the right place until they've done what a step depends on. */
function SetupGate({
  needsSite = false,
  needsOwner = false,
  children,
}: {
  needsSite?: boolean;
  needsOwner?: boolean;
  children: ReactNode;
}) {
  const status = useSetupStatus();
  const setup = useSetup();

  if (status.isPending) return <Loading />;
  if (status.isError && !status.data) {
    return (
      <CannotReachTend
        error={status.error}
        retrying={status.isFetching}
        onRetry={() => status.refetch()}
      />
    );
  }
  if (!status.data?.needsSetup) return <Redirect to="/login" replace />;
  if (setup.codeState === "checking") return <Loading />;
  if (setup.codeState !== "ok") return <Redirect to="/setup/code" replace />;
  if (needsSite && !setup.site.name) return <Redirect to="/setup/name" replace />;
  if (needsOwner && !setup.owner.password) return <Redirect to="/setup/account" replace />;
  return children;
}

const choiceClass =
  "card flex items-center gap-4 p-5 hover:border-brand focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand sm:p-6";

export function SetupWelcome() {
  return (
    <SetupGate>
      <AuthLayout screen="setup.welcome">
        <p className="mt-3 text-lg text-muted">
          <FormattedMessage id="setup.welcome.intro" />
        </p>
        <ul className="mt-8 grid gap-4">
          <li>
            <Link href="/setup/name" className={choiceClass}>
              <span className="grid size-13 shrink-0 place-items-center rounded-2xl bg-mint">
                <Leaf className="size-7 fill-brand" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-semibold">
                  <FormattedMessage id="setup.welcome.new" />
                </span>
                <span className="mt-0.5 block text-muted">
                  <FormattedMessage id="setup.welcome.newHint" />
                </span>
              </span>
              <Icon name="right" className="size-5 text-muted" />
            </Link>
          </li>
          <li>
            <Link href="/setup/backup" className={choiceClass}>
              <span className="grid size-13 shrink-0 place-items-center rounded-2xl bg-sunken text-muted">
                <Icon name="upload" className="size-6" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-semibold">
                  <FormattedMessage id="setup.welcome.backup" />
                </span>
                <span className="mt-0.5 block text-muted">
                  <FormattedMessage id="setup.welcome.backupHint" />
                </span>
              </span>
              <Icon name="right" className="size-5 text-muted" />
            </Link>
          </li>
        </ul>
      </AuthLayout>
    </SetupGate>
  );
}

export function SetupCode() {
  const intl = useIntl();
  const status = useSetupStatus();
  const setup = useSetup();
  const inputRef = useRef<HTMLInputElement>(null);
  // A code that couldn't be checked (Tend was restarting, say) is still filled in.
  const [value, setValue] = useState(setup.code ?? "");
  const [emptyError, setEmptyError] = useState(false);

  if (status.isPending) return <Loading />;
  if (status.isError && !status.data) {
    return (
      <CannotReachTend
        error={status.error}
        retrying={status.isFetching}
        onRetry={() => status.refetch()}
      />
    );
  }
  if (!status.data?.needsSetup) return <Redirect to="/login" replace />;
  if (setup.codeState === "ok") return <Redirect to="/setup" replace />;

  const kind = status.data.codeKind;
  const offlineText = intl.formatMessage({ id: "offline.body" });
  const error = emptyError
    ? intl.formatMessage({ id: `setup.${kind}.required` })
    : setup.codeError
      ? errorText(setup.codeError, offlineText)
      : undefined;

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    setValue(event.target.value);
    setEmptyError(false);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (value.trim() === "") {
      setEmptyError(true);
      inputRef.current?.focus();
      return;
    }
    setEmptyError(false);
    // Passwords are exact. Only the generated code forgives spaces.
    await setup.submitCode(kind === "code" ? value.trim() : value);
    inputRef.current?.focus();
  }

  return (
    <AuthLayout screen={`setup.${kind}`} focusHeading={false}>
      <p className="mt-3 text-lg text-muted">
        <FormattedMessage id={`setup.${kind}.intro`} />
      </p>
      <form onSubmit={onSubmit} noValidate className="mt-8 grid gap-6">
        {kind === "password" ? (
          <PasswordField
            ref={inputRef}
            label={intl.formatMessage({ id: "setup.password.label" })}
            value={value}
            onChange={onChange}
            error={error}
            autoComplete="off"
            required
            autoFocus
          />
        ) : (
          <Field
            ref={inputRef}
            label={intl.formatMessage({ id: "setup.code.label" })}
            value={value}
            onChange={onChange}
            error={error}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            required
            autoFocus
          />
        )}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={setup.codeState === "checking"}
            className={primaryButtonClass}
          >
            <FormattedMessage id="common.continue" />
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}

export function SetupName() {
  const intl = useIntl();
  const setup = useSetup();
  const [, navigate] = useLocation();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(setup.site.name);
  const [tagline, setTagline] = useState(setup.site.tagline);
  const [showRequired, setShowRequired] = useState(false);

  const serverError = setup.fieldError?.field.startsWith("site.") ? setup.fieldError : null;
  const nameError = showRequired
    ? intl.formatMessage({ id: "setup.name.required" })
    : serverError?.field === "site.name"
      ? serverError.message
      : undefined;
  const taglineError = serverError?.field === "site.tagline" ? serverError.message : undefined;

  useSaveOnLeave(() => setup.setSite({ name: name.trim(), tagline: tagline.trim() }));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") {
      setShowRequired(true);
      nameRef.current?.focus();
      return;
    }
    setup.setSite({ name: name.trim(), tagline: tagline.trim() });
    setup.setFieldError(null);
    navigate("/setup/account");
  }

  return (
    <SetupGate>
      <AuthLayout screen="setup.name" step={1} focusHeading={false}>
        <form onSubmit={onSubmit} noValidate className="mt-8 grid gap-6">
          <Field
            ref={nameRef}
            label={intl.formatMessage({ id: "setup.name.label" })}
            hint={<FormattedMessage id="setup.name.hint" />}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setShowRequired(false);
            }}
            error={nameError}
            placeholder={intl.formatMessage({ id: "setup.name.placeholder" })}
            maxLength={100}
            required
            autoFocus
          />
          <Field
            label={intl.formatMessage({ id: "setup.tagline.label" })}
            hint={<FormattedMessage id="setup.tagline.hint" />}
            value={tagline}
            onChange={(event) => setTagline(event.target.value)}
            error={taglineError}
            maxLength={200}
          />
          <div className="flex items-center justify-between">
            <Link href="/setup" className={textLinkClass}>
              <FormattedMessage id="common.back" />
            </Link>
            <button type="submit" className={primaryButtonClass}>
              <FormattedMessage id="common.continue" />
            </button>
          </div>
        </form>
      </AuthLayout>
    </SetupGate>
  );
}

export function SetupAccount() {
  const intl = useIntl();
  const setup = useSetup();
  const [, navigate] = useLocation();
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(setup.owner.name);
  const [email, setEmail] = useState(setup.owner.email);
  const [password, setPassword] = useState(setup.owner.password);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [suggested, setSuggested] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string }>({});

  // A problem only the server can spot, like a very common password, brings people back here.
  const serverError = setup.fieldError?.field.startsWith("owner.") ? setup.fieldError : null;
  const serverErrorField = serverError?.field;

  useSaveOnLeave(() => setup.setOwner({ name: name.trim(), email: email.trim(), password }));

  // Coming back for that reason, the keyboard goes straight to the field that needs fixing.
  useEffect(() => {
    const failed: Record<string, HTMLInputElement | null> = {
      "owner.name": nameRef.current,
      "owner.email": emailRef.current,
      "owner.password": passwordRef.current,
    };
    if (serverErrorField) failed[serverErrorField]?.focus();
  }, [serverErrorField]);
  const shown = {
    name: errors.name ?? (serverError?.field === "owner.name" ? serverError.message : undefined),
    email: errors.email ?? (serverError?.field === "owner.email" ? serverError.message : undefined),
    password:
      errors.password ??
      (serverError?.field === "owner.password" ? serverError.message : undefined),
  };

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const found = {
      ...(name.trim() === ""
        ? { name: intl.formatMessage({ id: "setup.account.nameRequired" }) }
        : {}),
      ...(/^\S+@\S+\.\S+$/.test(email.trim())
        ? {}
        : { email: intl.formatMessage({ id: "setup.account.emailRequired" }) }),
      ...([...password].length < MIN_PASSWORD_LENGTH
        ? {
            password: intl.formatMessage(
              { id: "setup.account.passwordShort" },
              { min: MIN_PASSWORD_LENGTH },
            ),
          }
        : {}),
    };
    setErrors(found);
    setup.setFieldError(null);
    if (found.name) nameRef.current?.focus();
    else if (found.email) emailRef.current?.focus();
    else if (found.password) passwordRef.current?.focus();
    else {
      setup.setOwner({ name: name.trim(), email: email.trim(), password });
      navigate("/setup/start");
    }
  }

  function suggest() {
    setPassword(suggestPassphrase());
    setPasswordVisible(true);
    setSuggested(true);
    setErrors((current) => ({ ...current, password: undefined }));
    if (serverError?.field === "owner.password") setup.setFieldError(null);
    passwordRef.current?.focus();
  }

  return (
    <SetupGate needsSite>
      <AuthLayout screen="setup.account" step={2} focusHeading={false}>
        <p className="mt-3 text-lg text-muted">
          <FormattedMessage id="setup.account.intro" />
        </p>
        <form onSubmit={onSubmit} noValidate className="mt-8 grid gap-6">
          <Field
            ref={nameRef}
            label={intl.formatMessage({ id: "setup.account.name" })}
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={shown.name}
            autoComplete="name"
            maxLength={100}
            required
            autoFocus={!serverError}
          />
          <Field
            ref={emailRef}
            label={intl.formatMessage({ id: "setup.account.email" })}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={shown.email}
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            maxLength={254}
            required
          />
          <div className="grid gap-3">
            <PasswordField
              ref={passwordRef}
              label={intl.formatMessage({ id: "setup.account.password" })}
              hint={
                <FormattedMessage
                  id="setup.account.passwordHint"
                  values={{ min: MIN_PASSWORD_LENGTH }}
                />
              }
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setSuggested(false);
                setErrors((current) => ({ ...current, password: undefined }));
              }}
              error={shown.password}
              visible={passwordVisible}
              onVisibleChange={setPasswordVisible}
              autoComplete="new-password"
              required
            />
            <div>
              <button type="button" onClick={suggest} className={secondaryButtonClass}>
                <FormattedMessage id="setup.account.suggest" />
              </button>
            </div>
            {/* Always mounted: screen readers can miss a live region added along with its text. */}
            <p role="status" className="text-sm text-muted empty:sr-only">
              {suggested && <FormattedMessage id="setup.account.suggested" />}
            </p>
          </div>
          <div className="flex items-center justify-between">
            <Link href="/setup/name" className={textLinkClass}>
              <FormattedMessage id="common.back" />
            </Link>
            <button type="submit" className={primaryButtonClass}>
              <FormattedMessage id="common.continue" />
            </button>
          </div>
        </form>
      </AuthLayout>
    </SetupGate>
  );
}

const STARTERS: Starter[] = ["blog", "business", "blank"];

/**
 * A small picture of the starting point, with the person's own site name on it, and the photo it
 * comes with (scripts/pictures). Sizes are shares of the picture's width, so it's the same at any.
 */
function StarterPreview({ starter, siteName }: { starter: Starter; siteName: string }) {
  const line = "h-[2cqw] rounded-full bg-[#2b2117]/15";
  return (
    <div aria-hidden="true" className="@container">
      <div className="flex aspect-[4/3] flex-col overflow-hidden rounded-xl border border-[#2b2117]/12 bg-[#fffefc] text-left text-[#221a12]">
        <div className="flex items-center justify-between gap-[4cqw] px-[6cqw] py-[3.5cqw]">
          <span className="truncate text-[5.5cqw] font-bold">{siteName}</span>
          <span className="flex shrink-0 gap-[2.5cqw]">
            <span className={`${line} w-[8cqw]`} />
            <span className={`${line} w-[8cqw]`} />
          </span>
        </div>
        {starter === "business" && (
          <>
            <div
              className="flex min-h-0 flex-1 flex-col justify-center gap-[3cqw] bg-cover bg-center px-[6cqw]"
              style={{
                backgroundImage: `linear-gradient(90deg, #fffefcee 10%, #fffefc99 50%, #fffefc00 85%), url("${table}")`,
              }}
            >
              <span className="line-clamp-2 max-w-[62%] text-[8cqw] leading-[1.08] font-bold">
                {siteName}
              </span>
              <span className={`${line} w-[42cqw]`} />
              <span className="h-[7cqw] w-[24cqw] rounded-full bg-[#1f6f4a]" />
            </div>
            <div className="grid grid-cols-3 gap-[4cqw] px-[6cqw] py-[4cqw]">
              <span className={line} />
              <span className={line} />
              <span className={line} />
            </div>
          </>
        )}
        {starter === "blog" && (
          <div className="flex min-h-0 flex-1 flex-col gap-[3cqw] px-[6cqw] pb-[5cqw]">
            <div
              className="min-h-0 flex-1 rounded-[3cqw] bg-cover bg-center"
              style={{ backgroundImage: `url("${coffee}")` }}
            />
            <span className="h-[4cqw] w-[58cqw] rounded-full bg-[#2b2117]/70" />
            <span className={`${line} w-[78cqw]`} />
            <span className={`${line} w-[64cqw]`} />
          </div>
        )}
        {starter === "blank" && (
          <div className="grid min-h-0 flex-1 place-items-center">
            <Leaf className="size-[22cqw] fill-[#1f6f4a]/20" />
          </div>
        )}
      </div>
    </div>
  );
}

export function SetupStart() {
  const intl = useIntl();
  const setup = useSetup();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const { starter, setStarter } = setup;

  const finish = useMutation({
    mutationFn: async () => {
      const { recoveryCodes } = await api<{ recoveryCodes: string[] }>("/auth/setup", {
        method: "POST",
        body: {
          code: setup.code,
          site: {
            ...setup.site,
            locale: navigator.language,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          owner: setup.owner,
          starter,
        },
      });
      await confirmSignedIn(queryClient, intl.formatMessage({ id: "auth.cookieRefused" }));
      return recoveryCodes;
    },
    onSuccess: (recoveryCodes) => {
      // The Owner's recovery kit comes first, shown this once (J7), then Overview.
      holdFreshKit(recoveryCodes, "/");
      // Navigate first: updating this would otherwise send the gate above elsewhere.
      navigate("/account", { replace: true });
      queryClient.setQueryData<SetupStatus>(SETUP_STATUS_KEY, (status) =>
        status ? { ...status, needsSetup: false } : status,
      );
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.code === "setup_code_wrong") {
        setup.rejectCode(error);
        navigate("/setup/code");
      } else if (error.code === "setup_closed") {
        setup.setClosedElsewhere(true);
        void queryClient.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
      } else if (error.field?.startsWith("owner.")) {
        setup.setFieldError({ field: error.field, message: error.message });
        navigate("/setup/account");
      } else if (error.field?.startsWith("site.")) {
        setup.setFieldError({ field: error.field, message: error.message });
        navigate("/setup/name");
      }
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!finish.isPending) finish.mutate();
  }

  return (
    <SetupGate needsSite needsOwner>
      <AuthLayout screen="setup.start" step={3} wide>
        <p className="mt-3 text-lg text-muted">
          <FormattedMessage id="setup.start.intro" />
        </p>
        <form onSubmit={onSubmit} className="mt-8 grid gap-6">
          <fieldset className="grid gap-4 sm:grid-cols-3 lg:gap-5">
            <legend className="sr-only">
              <FormattedMessage id="setup.start.title" />
            </legend>
            {STARTERS.map((option) => (
              <label
                key={option}
                className="card relative flex cursor-pointer flex-col gap-4 p-4 hover:border-brand has-checked:border-brand has-checked:ring-2 has-checked:ring-brand has-focus-visible:outline-3 has-focus-visible:outline-offset-4 has-focus-visible:outline-brand"
              >
                <StarterPreview starter={option} siteName={setup.site.name} />
                <span>
                  <span className="flex items-center gap-2.5 text-lg font-semibold">
                    <input
                      type="radio"
                      name="starter"
                      value={option}
                      checked={starter === option}
                      onChange={() => {
                        setStarter(option);
                        finish.reset();
                      }}
                      className="size-5 accent-brand outline-none"
                    />
                    <FormattedMessage id={`setup.start.${option}`} />
                  </span>
                  <span className="mt-1 block text-sm text-muted">
                    <FormattedMessage id={`setup.start.${option}Hint`} />
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {/* Always mounted: screen readers can miss a live region added along with its text. */}
          <p role="alert" className="font-medium text-danger empty:sr-only">
            {finish.isError && <Problem error={finish.error} />}
          </p>
          <div className="flex items-center justify-between">
            <Link href="/setup/account" className={textLinkClass}>
              <FormattedMessage id="common.back" />
            </Link>
            <button type="submit" disabled={finish.isPending} className={primaryButtonClass}>
              <FormattedMessage
                id={finish.isPending ? "setup.start.finishing" : "setup.start.finish"}
              />
            </button>
          </div>
        </form>
      </AuthLayout>
    </SetupGate>
  );
}

export function SetupBackup() {
  const intl = useIntl();
  const setup = useSetup();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string>();
  // How much has been sent, or null once Tend has it all and is restoring it.
  const [sent, setSent] = useState<number | null>(null);
  const stopRef = useRef<AbortController | null>(null);

  // Leaving the screen stops the upload. Tend starts again from the first part next time.
  useEffect(() => () => stopRef.current?.abort(), []);

  const restore = useMutation({
    mutationFn: async (chosen: File) => {
      const stop = new AbortController();
      stopRef.current = stop;
      setSent(0);
      await sendBackup(chosen, setupParts(setup.code ?? ""), setSent, stop.signal);
      setSent(null);
      return restoreBackup(setup.code ?? "", chosen.size, stop.signal);
    },
    onSuccess: (site) => {
      setup.setRestored({ site });
      // Navigate first: updating this would otherwise send the gate above elsewhere.
      navigate("/login", { replace: true });
      queryClient.setQueryData<SetupStatus>(SETUP_STATUS_KEY, (status) =>
        status ? { ...status, needsSetup: false } : status,
      );
    },
    onError: (error) => {
      setSent(null);
      if (!(error instanceof ApiError)) return;
      if (error.code === "setup_code_wrong") {
        setup.rejectCode(error);
        navigate("/setup/code");
      } else if (error.code === "setup_closed") {
        setup.setClosedElsewhere(true);
        void queryClient.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
      }
    },
  });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (restore.isPending) return;
    const problem = !file
      ? "setup.backup.fileRequired"
      : (await looksLikeABackup(file))
        ? null
        : "setup.backup.notABackup";
    setFileError(problem ? intl.formatMessage({ id: problem }) : undefined);
    if (problem || !file) {
      inputRef.current?.focus();
      return;
    }
    restore.mutate(file);
  }

  const failed =
    restore.isError && !(restore.error instanceof DOMException)
      ? errorText(restore.error, intl.formatMessage({ id: "offline.body" }))
      : null;

  return (
    <SetupGate>
      <AuthLayout screen="setup.backup">
        <p className="mt-3 text-lg text-muted">
          <FormattedMessage id="setup.backup.intro" />
        </p>
        <form onSubmit={onSubmit} noValidate className="mt-8 grid gap-6">
          <div className="grid gap-2">
            <label htmlFor={inputId} className="font-medium">
              <FormattedMessage id="setup.backup.file" />
            </label>
            <input
              ref={inputRef}
              id={inputId}
              type="file"
              accept=".zip,application/zip"
              aria-describedby={`${hintId} ${errorId}`}
              aria-invalid={fileError ? true : undefined}
              disabled={restore.isPending}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setFileError(undefined);
                restore.reset();
              }}
              className="dashed w-full p-4 file:mr-4 file:min-h-11 file:cursor-pointer file:rounded-xl file:border file:border-line file:bg-surface file:px-4 file:font-semibold file:text-ink hover:file:border-brand focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60"
            />
            <p id={hintId} className="text-sm text-muted">
              <FormattedMessage id="setup.backup.fileHint" />
            </p>
            {/* Always mounted: screen readers can miss a live region added along with its text. */}
            <p id={errorId} role="alert" className="text-sm font-medium text-danger empty:sr-only">
              {fileError}
            </p>
          </div>
          {restore.isPending && (
            <div className="grid gap-2">
              <progress
                className="h-2 w-full accent-brand"
                max={1}
                // Without a value, it shows something happening without saying how much.
                value={sent ?? undefined}
                aria-label={intl.formatMessage({
                  id: sent === null ? "setup.backup.restoring" : "setup.backup.sending",
                })}
              />
              <p className="text-muted">
                {sent === null ? (
                  <FormattedMessage id="setup.backup.restoringBody" />
                ) : (
                  <FormattedMessage
                    id="setup.backup.sendingBody"
                    values={{ percent: intl.formatNumber(sent, { style: "percent" }) }}
                  />
                )}
              </p>
            </div>
          )}
          {/* Always mounted: screen readers can miss a live region added along with its text. */}
          <p role="status" className="sr-only">
            {restore.isPending && (
              <FormattedMessage
                id={sent === null ? "setup.backup.restoring" : "setup.backup.sending"}
              />
            )}
          </p>
          <p role="alert" className="font-medium text-danger empty:sr-only">
            {failed}
          </p>
          <div className="flex items-center justify-between">
            <Link href="/setup" className={textLinkClass}>
              <FormattedMessage id="common.back" />
            </Link>
            <button type="submit" disabled={restore.isPending} className={primaryButtonClass}>
              <FormattedMessage
                id={restore.isPending ? "setup.backup.working" : "setup.backup.submit"}
              />
            </button>
          </div>
        </form>
      </AuthLayout>
    </SetupGate>
  );
}
