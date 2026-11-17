import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, type RefObject, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Link, useLocation } from "wouter";
import {
  AuthLayout,
  CannotReachTend,
  Loading,
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { Field, PasswordField } from "../components/fields.tsx";
import { showToast } from "../components/Toast.tsx";
import { ApiError, api, errorText } from "../lib/api.ts";
import { forgetLinkToken, type LinkKind, readLinkToken } from "../lib/link-token.ts";
import { suggestPassphrase } from "../lib/passphrase.ts";
import { confirmSignedIn } from "../lib/queries.ts";
import { holdFreshKit } from "../lib/recovery-kit.ts";

// Getting in without the password you had (PLAN.md J5 and J7): accepting an invite,
// choosing a new password from a link, and using a recovery code. None needs signing in.

const MIN_PASSWORD_LENGTH = 12;

/** How many recovery codes were left after one was used just now, for the next screen. */
let codesLeftAfterRecovery: number | null = null;

/** A link that can't be used: not all of it arrived, or it's used up or out of date. */
function LinkProblem({ error }: { error?: unknown }) {
  const intl = useIntl();
  return (
    <AuthLayout screen="link">
      <p role="alert" className="mt-3 text-lg text-muted">
        {error
          ? errorText(error, intl.formatMessage({ id: "offline.body" }))
          : intl.formatMessage({ id: "link.incomplete" })}
      </p>
      <div className="mt-8">
        <Link href="/login" className={textLinkClass}>
          <FormattedMessage id="forgot.back" />
        </Link>
      </div>
    </AuthLayout>
  );
}

/** Asks Tend about the link before showing its form, so a dead link says so straight away. */
function useLinkCheck<T>(kind: LinkKind, path: string) {
  const [token] = useState(() => readLinkToken(kind));
  const check = useQuery({
    queryKey: ["link", kind, token],
    enabled: token !== null,
    retry: false,
    // Asked once: what it says doesn't change while the form is open.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => api<T>(path, { method: "POST", body: { token } }),
  });
  return { token, check };
}

/** What to show before the form: still asking, can't ask, or the link's no good. */
function beforeForm(
  token: string | null,
  check: ReturnType<typeof useLinkCheck>["check"],
): ReactNode {
  if (token === null) return <LinkProblem />;
  if (check.isPending) return <Loading />;
  if (check.isError) {
    if (check.error instanceof ApiError && check.error.status === 404) {
      return <LinkProblem error={check.error} />;
    }
    return (
      <CannotReachTend
        error={check.error}
        retrying={check.isFetching}
        onRetry={() => check.refetch()}
      />
    );
  }
  return null;
}

/** A new password, with a passphrase to suggest. */
function NewPasswordField({
  inputRef,
  password,
  onChange,
  error,
  labelId,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  password: string;
  onChange: (password: string) => void;
  error: string | undefined;
  labelId: string;
}) {
  const intl = useIntl();
  const [visible, setVisible] = useState(false);
  const [suggested, setSuggested] = useState(false);
  return (
    <div className="grid gap-3">
      <PasswordField
        ref={inputRef}
        label={intl.formatMessage({ id: labelId })}
        hint={
          <FormattedMessage id="setup.account.passwordHint" values={{ min: MIN_PASSWORD_LENGTH }} />
        }
        value={password}
        onChange={(event) => {
          onChange(event.target.value);
          setSuggested(false);
        }}
        error={error}
        visible={visible}
        onVisibleChange={setVisible}
        autoComplete="new-password"
        required
      />
      <div>
        <button
          type="button"
          onClick={() => {
            onChange(suggestPassphrase());
            setVisible(true);
            setSuggested(true);
            inputRef.current?.focus();
          }}
          className={secondaryButtonClass}
        >
          <FormattedMessage id="setup.account.suggest" />
        </button>
      </div>
      {/* Always mounted: screen readers can miss a live region added along with its text. */}
      <p role="status" className="text-sm text-muted empty:sr-only">
        {suggested && <FormattedMessage id="setup.account.suggested" />}
      </p>
    </div>
  );
}

/** What's wrong with a new password before it's sent, if anything. */
function tooShort(password: string, intl: ReturnType<typeof useIntl>): string | undefined {
  return [...password].length < MIN_PASSWORD_LENGTH
    ? intl.formatMessage({ id: "setup.account.passwordShort" }, { min: MIN_PASSWORD_LENGTH })
    : undefined;
}

/** The server's word on a field, when the error is about that field. */
function fieldError(error: unknown, field: string): string | undefined {
  return error instanceof ApiError && error.field === field ? error.message : undefined;
}

interface InviteInfo {
  site: string;
  email: string;
  role: "admin" | "editor" | "writer";
  invitedBy: string | null;
}

/** J5: someone invited sets up their account, and gets their recovery kit. */
export function AcceptInvite() {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const { token, check } = useLinkCheck<InviteInfo>("invite", "/auth/invite/check");
  const nameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ name?: string; password?: string }>({});

  const accept = useMutation({
    mutationFn: async () => {
      const { recoveryCodes } = await api<{ recoveryCodes: string[] }>("/auth/invite/accept", {
        method: "POST",
        body: { token, name: name.trim(), password },
      });
      await confirmSignedIn(queryClient, intl.formatMessage({ id: "auth.cookieRefused" }));
      return recoveryCodes;
    },
    onSuccess: (codes) => {
      forgetLinkToken("invite");
      holdFreshKit(codes, "/");
      navigate("/account", { replace: true });
    },
    onError: (error) => {
      if (fieldError(error, "name")) nameRef.current?.focus();
      else passwordRef.current?.focus();
    },
  });

  const early = beforeForm(token, check);
  if (early || !check.data) return early;
  const invite = check.data;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (accept.isPending) return;
    const found = {
      name:
        name.trim() === "" ? intl.formatMessage({ id: "setup.account.nameRequired" }) : undefined,
      password: tooShort(password, intl),
    };
    setErrors(found);
    if (found.name) nameRef.current?.focus();
    else if (found.password) passwordRef.current?.focus();
    else accept.mutate();
  }

  const role = { role: invite.role };
  const shown = {
    name: errors.name ?? fieldError(accept.error, "name"),
    password: errors.password ?? fieldError(accept.error, "password"),
  };
  const formError =
    accept.isError && !shown.name && !shown.password
      ? errorText(accept.error, intl.formatMessage({ id: "offline.body" }))
      : null;

  return (
    <AuthLayout
      screen="invite"
      title={intl.formatMessage({ id: "invite.title" }, { site: invite.site })}
      focusHeading={false}
    >
      <p className="mt-3 text-lg text-muted">
        {invite.invitedBy ? (
          <FormattedMessage
            id="invite.from"
            values={{ name: invite.invitedBy, site: invite.site, ...role }}
          />
        ) : (
          <FormattedMessage id="invite.fromNoName" values={{ site: invite.site, ...role }} />
        )}
      </p>
      <p className="mt-2 [overflow-wrap:anywhere]">
        <FormattedMessage id="invite.email" values={{ email: invite.email }} />
      </p>
      <form onSubmit={onSubmit} noValidate className="mt-8 grid gap-6">
        <Field
          ref={nameRef}
          label={intl.formatMessage({ id: "setup.account.name" })}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setErrors((current) => ({ ...current, name: undefined }));
          }}
          error={shown.name}
          autoComplete="name"
          maxLength={100}
          required
          autoFocus
        />
        <NewPasswordField
          inputRef={passwordRef}
          password={password}
          onChange={(value) => {
            setPassword(value);
            setErrors((current) => ({ ...current, password: undefined }));
            accept.reset();
          }}
          error={shown.password}
          labelId="setup.account.password"
        />
        <p role="alert" className="font-medium text-danger empty:sr-only">
          {formError}
        </p>
        <div className="flex justify-end">
          <button type="submit" disabled={accept.isPending} className={primaryButtonClass}>
            <FormattedMessage id={accept.isPending ? "invite.submitting" : "invite.submit"} />
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}

interface ResetInfo {
  email: string;
  name: string;
  site: string;
}

/** J7: a new password, from a link someone sent or one a recovery code led to. */
export function ResetPassword() {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const { token, check } = useLinkCheck<ResetInfo>("reset", "/auth/reset/check");
  const [codesLeft] = useState(() => codesLeftAfterRecovery);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [short, setShort] = useState<string>();

  const save = useMutation({
    mutationFn: async () => {
      await api("/auth/reset", { method: "POST", body: { token, password } });
      await confirmSignedIn(queryClient, intl.formatMessage({ id: "auth.cookieRefused" }));
    },
    onSuccess: () => {
      forgetLinkToken("reset");
      codesLeftAfterRecovery = null;
      navigate("/", { replace: true });
      showToast({ message: intl.formatMessage({ id: "reset.done" }) });
    },
    onError: () => passwordRef.current?.focus(),
  });

  const early = beforeForm(token, check);
  if (early || !check.data) return early;
  const person = check.data;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (save.isPending) return;
    const problem = tooShort(password, intl);
    setShort(problem);
    if (problem) passwordRef.current?.focus();
    else save.mutate();
  }

  const error = short ?? fieldError(save.error, "password");
  return (
    <AuthLayout screen="reset" focusHeading={false}>
      <p className="mt-3 text-lg text-muted [overflow-wrap:anywhere]">
        <FormattedMessage id="reset.for" values={{ email: person.email, site: person.site }} />
      </p>
      {codesLeft !== null && (
        <p className="mt-2">
          <FormattedMessage id="reset.codesLeft" values={{ left: codesLeft }} />
        </p>
      )}
      <form onSubmit={onSubmit} noValidate className="mt-8 grid gap-6">
        <NewPasswordField
          inputRef={passwordRef}
          password={password}
          onChange={(value) => {
            setPassword(value);
            setShort(undefined);
            save.reset();
          }}
          error={error}
          labelId="reset.password"
        />
        <p role="alert" className="font-medium text-danger empty:sr-only">
          {save.isError &&
            !error &&
            errorText(save.error, intl.formatMessage({ id: "offline.body" }))}
        </p>
        <div className="flex justify-end">
          <button type="submit" disabled={save.isPending} className={primaryButtonClass}>
            <FormattedMessage id={save.isPending ? "reset.saving" : "reset.submit"} />
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}

/** J7: one of the eight codes from the recovery kit, then a new password. */
export function Recover() {
  const intl = useIntl();
  const [, navigate] = useLocation();
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [missing, setMissing] = useState<"email" | "code" | null>(null);

  const tryCode = useMutation({
    mutationFn: () =>
      api<{ token: string; codesLeft: number }>("/auth/recover", {
        method: "POST",
        body: { email: email.trim(), code },
      }),
    onSuccess: ({ token, codesLeft }) => {
      codesLeftAfterRecovery = codesLeft;
      navigate(`/reset#${token}`);
    },
    onError: () => codeRef.current?.focus(),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (tryCode.isPending) return;
    if (email.trim() === "") {
      setMissing("email");
      emailRef.current?.focus();
    } else if (code.trim() === "") {
      setMissing("code");
      codeRef.current?.focus();
    } else {
      setMissing(null);
      tryCode.mutate();
    }
  }

  return (
    <AuthLayout screen="recover" focusHeading={false}>
      <p className="mt-3 text-lg text-muted">
        <FormattedMessage id="recover.intro" />
      </p>
      <form onSubmit={onSubmit} noValidate className="mt-8 grid gap-6">
        <Field
          ref={emailRef}
          label={intl.formatMessage({ id: "login.email" })}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            tryCode.reset();
          }}
          error={
            missing === "email" ? intl.formatMessage({ id: "login.emailRequired" }) : undefined
          }
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          required
          autoFocus
        />
        <Field
          ref={codeRef}
          label={intl.formatMessage({ id: "recover.code" })}
          hint={<FormattedMessage id="recover.codeHint" />}
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            tryCode.reset();
          }}
          error={
            missing === "code" ? intl.formatMessage({ id: "recover.codeRequired" }) : undefined
          }
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          required
        />
        <p role="alert" className="font-medium text-danger empty:sr-only">
          {tryCode.isError && errorText(tryCode.error, intl.formatMessage({ id: "offline.body" }))}
        </p>
        <div className="flex items-center justify-between gap-4">
          <Link href="/login/forgot" className={textLinkClass}>
            <FormattedMessage id="common.back" />
          </Link>
          <button type="submit" disabled={tryCode.isPending} className={primaryButtonClass}>
            <FormattedMessage id="common.continue" />
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
