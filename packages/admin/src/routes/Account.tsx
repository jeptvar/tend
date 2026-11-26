import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { FormattedDate, FormattedMessage, useIntl } from "react-intl";
import { useLocation } from "wouter";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import { primaryButtonClass, secondaryButtonClass } from "../components/AuthLayout.tsx";
import { Disclosure } from "../components/Disclosure.tsx";
import { Field, optionClass, PasswordField, radioClass } from "../components/fields.tsx";
import { NewPasswordField, tooShort } from "../components/NewPasswordField.tsx";
import { Problem } from "../components/Problem.tsx";
import { showToast } from "../components/Toast.tsx";
import { Waiting } from "../components/Waiting.tsx";
import { ApiError, api, errorText } from "../lib/api.ts";
import { type Appearance, appearance, setAppearance } from "../lib/appearance.ts";
import { ME_KEY, type Me } from "../lib/queries.ts";
import {
  downloadKit,
  type FreshKit,
  forgetFreshKit,
  freshKit,
  KIT_KEY,
  kitText,
} from "../lib/recovery-kit.ts";
import { useSignOut } from "../lib/sign-out.ts";

interface KitStatus {
  codesLeft: number;
  madeAt: number | null;
  saved: boolean;
}

/** What a refusal about this field says, to sit under it. */
function fieldError(error: unknown, field: string): string | undefined {
  return error instanceof ApiError && error.field === field ? errorText(error, "") : undefined;
}

/** What went wrong that isn't about one of these fields. */
function FormProblem({ error, fields }: { error: unknown; fields: string[] }) {
  const shown = error instanceof ApiError && error.field && fields.includes(error.field);
  return (
    <p role="alert" className="font-medium text-danger empty:sr-only">
      {error && !shown ? <Problem error={error} /> : null}
    </p>
  );
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="card mt-5 p-5 sm:p-7">
      <h2 id={id} className="text-xl font-bold">
        <FormattedMessage id={heading} />
      </h2>
      <div className="mt-4 grid max-w-xl grid-cols-1 gap-4">{children}</div>
    </section>
  );
}

/** A part of an account that's changed now and then, so its form waits behind its name. */
function Later({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <Disclosure summary={summary} className="rounded-2xl border border-line">
      {children}
    </Disclosure>
  );
}

function NameForm({ me }: { me: Me }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [name, setName] = useState(me.user.name);
  const save = useMutation({
    mutationFn: () => api("/auth/me", { method: "PATCH", body: { name } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      showToast({ message: intl.formatMessage({ id: "settings.saved" }) });
    },
  });
  const changed = name.trim() !== me.user.name;
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !save.isPending) save.mutate();
      }}
    >
      <Field
        label={intl.formatMessage({ id: "account.name" })}
        hint={intl.formatMessage({ id: "account.nameHint" })}
        value={name}
        maxLength={100}
        autoComplete="name"
        required
        error={fieldError(save.error, "name")}
        onChange={(event) => {
          setName(event.target.value);
          save.reset();
        }}
      />
      <FormProblem error={save.error} fields={["name"]} />
      <div>
        <button
          type="submit"
          aria-disabled={!changed || save.isPending}
          className={`${secondaryButtonClass} aria-disabled:opacity-60`}
        >
          <FormattedMessage id={save.isPending ? "settings.saving" : "account.saveName"} />
        </button>
      </div>
    </form>
  );
}

function EmailForm({ me }: { me: Me }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [missing, setMissing] = useState<{ email?: string; password?: string }>({});
  const save = useMutation({
    mutationFn: () => api("/auth/me/email", { method: "POST", body: { email, password } }),
    onSuccess: async () => {
      setEmail("");
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      showToast({ message: intl.formatMessage({ id: "account.emailChanged" }) });
    },
    onError: (error) => {
      if (fieldError(error, "email")) emailRef.current?.focus();
      else passwordRef.current?.focus();
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (save.isPending) return;
    const found: typeof missing = {};
    if (email.trim() === "") found.email = intl.formatMessage({ id: "login.emailRequired" });
    if (password === "") found.password = intl.formatMessage({ id: "kit.passwordRequired" });
    setMissing(found);
    if (found.email) emailRef.current?.focus();
    else if (found.password) passwordRef.current?.focus();
    else save.mutate();
  }

  return (
    <Later
      summary={
        <span className="[overflow-wrap:anywhere]">
          <FormattedMessage id="account.changeEmail" values={{ email: me.user.email }} />
        </span>
      }
    >
      <form noValidate className="grid gap-4" onSubmit={onSubmit}>
        <Field
          ref={emailRef}
          label={intl.formatMessage({ id: "account.newEmail" })}
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          maxLength={254}
          value={email}
          error={missing.email ?? fieldError(save.error, "email")}
          onChange={(event) => {
            setEmail(event.target.value);
            setMissing({});
            save.reset();
          }}
        />
        <PasswordField
          ref={passwordRef}
          label={intl.formatMessage({ id: "account.emailPassword" })}
          value={password}
          error={missing.password ?? fieldError(save.error, "password")}
          autoComplete="current-password"
          onChange={(event) => {
            setPassword(event.target.value);
            setMissing({});
            save.reset();
          }}
        />
        <FormProblem error={save.error} fields={["email", "password"]} />
        <div>
          <button type="submit" disabled={save.isPending} className={secondaryButtonClass}>
            <FormattedMessage id={save.isPending ? "settings.saving" : "account.saveEmail"} />
          </button>
        </div>
      </form>
    </Later>
  );
}

function PasswordForm() {
  const intl = useIntl();
  const passwordRef = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [chosen, setChosen] = useState("");
  const [errors, setErrors] = useState<{ password?: string; chosen?: string | undefined }>({});
  const save = useMutation({
    mutationFn: () =>
      api("/auth/me/password", { method: "POST", body: { password, newPassword: chosen } }),
    onSuccess: () => {
      setPassword("");
      setChosen("");
      showToast({ message: intl.formatMessage({ id: "account.passwordChanged" }) });
    },
    onError: (error) => {
      if (fieldError(error, "newPassword")) newRef.current?.focus();
      else passwordRef.current?.focus();
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (save.isPending) return;
    const found: typeof errors = { chosen: tooShort(chosen, intl) };
    if (password === "") found.password = intl.formatMessage({ id: "kit.passwordRequired" });
    setErrors(found);
    if (found.password) passwordRef.current?.focus();
    else if (found.chosen) newRef.current?.focus();
    else save.mutate();
  }

  return (
    <Later summary={<FormattedMessage id="account.changePassword" />}>
      <form noValidate className="grid gap-4" onSubmit={onSubmit}>
        <p>
          <FormattedMessage id="account.passwordAbout" />
        </p>
        <PasswordField
          ref={passwordRef}
          label={intl.formatMessage({ id: "account.oldPassword" })}
          value={password}
          error={errors.password ?? fieldError(save.error, "password")}
          autoComplete="current-password"
          onChange={(event) => {
            setPassword(event.target.value);
            setErrors({});
            save.reset();
          }}
        />
        <NewPasswordField
          inputRef={newRef}
          password={chosen}
          onChange={(value) => {
            setChosen(value);
            setErrors({});
            save.reset();
          }}
          error={errors.chosen ?? fieldError(save.error, "newPassword")}
          labelId="account.newPassword"
        />
        <FormProblem error={save.error} fields={["password", "newPassword"]} />
        <div>
          <button type="submit" disabled={save.isPending} className={secondaryButtonClass}>
            <FormattedMessage id={save.isPending ? "settings.saving" : "account.savePassword"} />
          </button>
        </div>
      </form>
    </Later>
  );
}

function DevicesSection() {
  const signOut = useSignOut(true);
  return (
    <Section heading="account.devices">
      <p>
        <FormattedMessage id="account.devicesAbout" />
      </p>
      <FormProblem error={signOut.error} fields={[]} />
      <div>
        <button
          type="button"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
          className={secondaryButtonClass}
        >
          <FormattedMessage id="account.signOutEverywhere" />
        </button>
      </div>
    </Section>
  );
}

function AppearanceSection() {
  const intl = useIntl();
  const name = useId();
  const [chosen, setChosen] = useState<Appearance>(appearance);
  return (
    <Section heading="account.appearance">
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="sr-only">
          <FormattedMessage id="account.appearance" />
        </legend>
        {(["system", "light", "dark"] as const).map((option) => (
          <label key={option} className={`${optionClass} font-semibold`}>
            <input
              type="radio"
              name={name}
              checked={chosen === option}
              onChange={() => {
                setChosen(option);
                setAppearance(option);
              }}
              className={radioClass}
            />
            {intl.formatMessage({ id: `account.appearance.${option}` })}
          </label>
        ))}
      </fieldset>
    </Section>
  );
}

/** The codes, shown this once, to save as a file, print or copy by hand. */
function KitCodes({
  me,
  kit,
  takeFocus,
  onDone,
}: {
  me: Me;
  kit: FreshKit;
  /** When the codes replace the form that made them, so focus has somewhere to go. */
  takeFocus: boolean;
  onDone: () => void;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const introRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (takeFocus) introRef.current?.focus();
  }, [takeFocus]);
  const text = kitText({
    site: me.site.name,
    email: me.user.email,
    codes: kit.codes,
    madeOn: intl.formatDate(Date.now(), { dateStyle: "long" }),
    origin: window.location.origin,
  });
  // Overview reminds someone until they've kept a copy. Not being able to note that they
  // have is no reason to stop them: it only means one more reminder.
  function saved() {
    void api("/auth/recovery-kit/saved", { method: "POST" })
      .then(() => queryClient.invalidateQueries({ queryKey: KIT_KEY }))
      .catch(() => {});
  }
  return (
    <div className="mt-2 grid gap-4">
      <p ref={introRef} tabIndex={-1} className="outline-none">
        <FormattedMessage id="kit.saveIt" />
      </p>
      <ol
        aria-label={intl.formatMessage({ id: "kit.codes" })}
        onCopy={saved}
        className="grid w-fit max-w-full grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-x-8 gap-y-2 rounded-2xl bg-sunken px-6 py-5 font-mono text-lg tracking-wide sm:grid-cols-2 print:bg-transparent print:p-0"
      >
        {kit.codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <p className="hidden print:block">
        <FormattedMessage
          id="kit.printedWhere"
          values={{ address: `${window.location.origin}/admin/recover` }}
        />
      </p>
      <div className="flex flex-wrap gap-3 print:hidden">
        <button
          type="button"
          className={primaryButtonClass}
          onClick={() => {
            downloadKit(text, me.site.name);
            saved();
          }}
        >
          <FormattedMessage id="kit.download" />
        </button>
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => {
            window.print();
            saved();
          }}
        >
          <FormattedMessage id="kit.print" />
        </button>
        <button type="button" className={secondaryButtonClass} onClick={onDone}>
          <FormattedMessage id={kit.next === "/account" ? "kit.done" : "kit.continue"} />
        </button>
      </div>
    </div>
  );
}

function KitSection({
  me,
  shown,
  madeHere,
  onMade,
  onDone,
}: {
  me: Me;
  shown: FreshKit | null;
  madeHere: boolean;
  onMade: (kit: FreshKit) => void;
  onDone: () => void;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [missing, setMissing] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  const status = useQuery({
    queryKey: KIT_KEY,
    queryFn: () => api<KitStatus>("/auth/recovery-kit"),
  });

  const make = useMutation({
    mutationFn: () =>
      api<{ codes: string[] }>("/auth/recovery-kit", { method: "POST", body: { password } }),
    onSuccess: ({ codes }) => {
      setPassword("");
      onMade({ codes, next: "/account" });
      void queryClient.invalidateQueries({ queryKey: KIT_KEY });
    },
    onError: () => passwordRef.current?.focus(),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (make.isPending) return;
    setMissing(password === "");
    if (password === "") passwordRef.current?.focus();
    else make.mutate();
  }

  return (
    <section
      aria-labelledby="account-kit"
      className="card mt-5 p-5 sm:p-7 print:border-0 print:p-0 print:shadow-none"
    >
      <h2 id="account-kit" className="text-xl font-bold">
        <FormattedMessage id="kit.heading" />
      </h2>
      {shown ? (
        <KitCodes me={me} kit={shown} takeFocus={madeHere} onDone={onDone} />
      ) : (
        <>
          {status.data ? (
            <p className="mt-1">
              {status.data.codesLeft > 0 && status.data.madeAt !== null ? (
                <FormattedMessage
                  id={status.data.saved ? "kit.left" : "kit.leftUnsaved"}
                  values={{
                    left: status.data.codesLeft,
                    date: <FormattedDate value={status.data.madeAt} dateStyle="long" />,
                  }}
                />
              ) : (
                <FormattedMessage id="kit.none" />
              )}
            </p>
          ) : (
            <Waiting query={status} />
          )}
          <p className="mt-1 text-muted">
            <FormattedMessage id="kit.about" />
          </p>
          <form onSubmit={onSubmit} noValidate className="mt-6 grid max-w-md gap-4">
            <PasswordField
              ref={passwordRef}
              label={intl.formatMessage({ id: "kit.password" })}
              hint={<FormattedMessage id="kit.passwordHint" />}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setMissing(false);
                make.reset();
              }}
              error={
                missing
                  ? intl.formatMessage({ id: "kit.passwordRequired" })
                  : fieldError(make.error, "password")
              }
              autoComplete="current-password"
              required
            />
            <FormProblem error={make.error} fields={["password"]} />
            <div>
              <button type="submit" disabled={make.isPending} className={secondaryButtonClass}>
                <FormattedMessage id={make.isPending ? "kit.making" : "kit.make"} />
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}

function AccountScreen({ me }: { me: Me }) {
  const intl = useIntl();
  const [, navigate] = useLocation();
  // Codes made a moment ago, at setup, on accepting an invite, or below.
  const [shown, setShown] = useState<FreshKit | null>(freshKit);
  const [madeHere, setMadeHere] = useState(false);
  useEffect(() => () => forgetFreshKit(), []);
  // Straight after setup or an invite, the kit is the only thing to see to.
  const onlyKit = shown !== null && !madeHere;

  const kit = (
    <KitSection
      me={me}
      shown={shown}
      madeHere={madeHere}
      onMade={(made) => {
        setMadeHere(true);
        setShown(made);
      }}
      onDone={() => {
        const next = shown?.next ?? "/account";
        forgetFreshKit();
        setShown(null);
        if (next !== "/account") navigate(next);
      }}
    />
  );
  return (
    <AdminLayout
      me={me}
      screen="account"
      title={onlyKit ? intl.formatMessage({ id: "kit.titleNew" }) : undefined}
    >
      {onlyKit ? (
        kit
      ) : (
        // The codes are printed as they are, without the rest of the screen.
        <>
          <div className="print:hidden">
            <Section heading="account.details">
              <NameForm key={me.user.name} me={me} />
              <EmailForm me={me} />
              <PasswordForm />
            </Section>
          </div>
          {kit}
          <div className="print:hidden">
            <DevicesSection />
            <AppearanceSection />
          </div>
        </>
      )}
    </AdminLayout>
  );
}

/** Account (PLAN.md §6): who someone is here, how they get in, and how the admin looks. */
export function Account() {
  return <SignedIn>{(me) => <AccountScreen me={me} />}</SignedIn>;
}
