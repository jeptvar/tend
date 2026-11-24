import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Link, Redirect, useLocation } from "wouter";
import {
  AuthLayout,
  CannotReachTend,
  Loading,
  primaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { Field, PasswordField } from "../components/fields.tsx";
import { Problem } from "../components/Problem.tsx";
import { ApiError, api } from "../lib/api.ts";
import { nextPath } from "../lib/next-path.ts";
import { confirmSignedIn, useMe, useSetupStatus } from "../lib/queries.ts";
import { useSetup } from "../lib/setup-state.tsx";

// Survives the trip to the Forgot password page and back. Passwords are never kept here.
let rememberedEmail = "";

export function Login() {
  const intl = useIntl();
  const me = useMe();
  const status = useSetupStatus();
  const setup = useSetup();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState(rememberedEmail);
  const [password, setPassword] = useState("");
  const [missing, setMissing] = useState<"email" | "password" | null>(null);

  const signIn = useMutation({
    mutationFn: async () => {
      await api("/auth/login", { method: "POST", body: { email, password } });
      await confirmSignedIn(queryClient, intl.formatMessage({ id: "auth.cookieRefused" }));
    },
    onSuccess: () => {
      rememberedEmail = "";
      setup.setClosedElsewhere(false);
      // A Private site sends visitors here from the page they wanted, so that's where they
      // go back to. It's outside the admin, so it's a whole new page, not a route in here.
      const next = nextPath(window.location.search, window.location.origin);
      if (next) window.location.assign(next);
      else navigate("/", { replace: true });
    },
    onError: (error) => {
      // Only a password that was judged wrong is worth clearing. After a dropped
      // connection, it would just mean typing a long one again on a phone.
      if (error instanceof ApiError && error.code === "login_failed") setPassword("");
      passwordRef.current?.focus();
    },
  });

  if ((me.isPending && !me.data) || status.isPending) return <Loading />;
  if (status.isError && !status.data) {
    return (
      <CannotReachTend
        error={status.error}
        retrying={status.isFetching}
        onRetry={() => status.refetch()}
      />
    );
  }
  if (me.data) return <Redirect to="/" replace />;
  if (status.data?.needsSetup) return <Redirect to="/setup" replace />;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (signIn.isPending) return;
    if (email.trim() === "") {
      setMissing("email");
      emailRef.current?.focus();
    } else if (password === "") {
      setMissing("password");
      passwordRef.current?.focus();
    } else {
      setMissing(null);
      signIn.mutate();
    }
  }

  return (
    <AuthLayout screen="login" focusHeading={false}>
      {setup.closedElsewhere && (
        <p className="mt-3 text-muted">
          <FormattedMessage id="login.closedElsewhere" />
        </p>
      )}
      {setup.restored && (
        <p className="mt-3 text-lg text-muted">
          {setup.restored.site ? (
            <FormattedMessage id="login.restored" values={{ site: setup.restored.site }} />
          ) : (
            <FormattedMessage id="login.restoredUnnamed" />
          )}
        </p>
      )}
      <form onSubmit={onSubmit} noValidate className="mt-8 grid gap-6">
        <Field
          ref={emailRef}
          label={intl.formatMessage({ id: "login.email" })}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            rememberedEmail = event.target.value;
            signIn.reset();
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
        <PasswordField
          ref={passwordRef}
          label={intl.formatMessage({ id: "login.password" })}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            signIn.reset();
          }}
          error={
            missing === "password"
              ? intl.formatMessage({ id: "login.passwordRequired" })
              : undefined
          }
          autoComplete="current-password"
          required
        />
        {/* Always mounted: screen readers can miss a live region added along with its text. */}
        <p role="alert" className="font-medium text-danger empty:sr-only">
          {signIn.isError && <Problem error={signIn.error} />}
        </p>
        <div className="flex items-center justify-between gap-4">
          <Link href="/login/forgot" className={textLinkClass}>
            <FormattedMessage id="login.forgot" />
          </Link>
          <button type="submit" disabled={signIn.isPending} className={primaryButtonClass}>
            <FormattedMessage id={signIn.isPending ? "login.signingIn" : "login.submit"} />
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}

/** For whoever looks after the server, however Tend was put on it. */
const COMMANDS = [
  { id: "forgot.npm", command: "npx tendcms reset-password you@example.com" },
  {
    id: "forgot.docker",
    command: "docker compose exec tend tendcms reset-password you@example.com",
  },
];

/** J7: the ways back in, the one that needs nobody else first. */
export function ForgotPassword() {
  return (
    <AuthLayout screen="forgot">
      <ol className="mt-6 grid list-decimal gap-6 pl-6 text-lg">
        <li>
          <Link href="/recover" className={`${textLinkClass} font-medium underline`}>
            <FormattedMessage id="forgot.code" />
          </Link>
          <p className="mt-1 text-base text-muted">
            <FormattedMessage id="forgot.codeHint" />
          </p>
        </li>
        <li>
          <span className="font-medium">
            <FormattedMessage id="forgot.someone" />
          </span>
          <p className="mt-1 text-base text-muted">
            <FormattedMessage id="forgot.someoneHint" />
          </p>
        </li>
        <li>
          <span className="font-medium">
            <FormattedMessage id="forgot.developer" />
          </span>
          <p className="mt-1 text-base text-muted">
            <FormattedMessage id="forgot.developerHint" />
          </p>
          {COMMANDS.map(({ id, command }) => (
            <div key={id} className="mt-2">
              <p className="text-base">
                <FormattedMessage id={id} />
              </p>
              <pre className="mt-1 rounded-lg border border-muted/50 bg-white/60 p-3 text-sm break-all whitespace-pre-wrap dark:bg-white/5">
                <code>{command}</code>
              </pre>
            </div>
          ))}
        </li>
      </ol>
      <div className="mt-8">
        <Link href="/login" className={textLinkClass}>
          <FormattedMessage id="forgot.back" />
        </Link>
      </div>
    </AuthLayout>
  );
}
