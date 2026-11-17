import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FormattedDate, FormattedMessage, useIntl } from "react-intl";
import { useLocation } from "wouter";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import { primaryButtonClass, secondaryButtonClass } from "../components/AuthLayout.tsx";
import { PasswordField } from "../components/fields.tsx";
import { ApiError, api, errorText } from "../lib/api.ts";
import type { Me } from "../lib/queries.ts";
import {
  downloadKit,
  type FreshKit,
  forgetFreshKit,
  freshKit,
  kitText,
} from "../lib/recovery-kit.ts";

const KIT_KEY = ["recovery-kit"];

interface KitStatus {
  codesLeft: number;
  madeAt: number | null;
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
  return (
    <div className="mt-2 grid gap-4">
      <p ref={introRef} tabIndex={-1} className="outline-none">
        <FormattedMessage id="kit.saveIt" />
      </p>
      <ol
        aria-label={intl.formatMessage({ id: "kit.codes" })}
        className="grid w-fit grid-cols-2 gap-x-8 gap-y-1 font-mono text-lg tracking-wide"
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
          onClick={() => downloadKit(text, me.site.name)}
        >
          <FormattedMessage id="kit.download" />
        </button>
        <button type="button" className={secondaryButtonClass} onClick={() => window.print()}>
          <FormattedMessage id="kit.print" />
        </button>
        <button type="button" className={secondaryButtonClass} onClick={onDone}>
          <FormattedMessage id={kit.next === "/account" ? "kit.done" : "kit.continue"} />
        </button>
      </div>
    </div>
  );
}

function AccountScreen({ me }: { me: Me }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  // Codes made a moment ago, at setup, on accepting an invite, or below.
  const [shown, setShown] = useState<FreshKit | null>(freshKit);
  const [madeHere, setMadeHere] = useState(false);
  const [password, setPassword] = useState("");
  const [missing, setMissing] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => forgetFreshKit(), []);

  const status = useQuery({
    queryKey: KIT_KEY,
    queryFn: () => api<KitStatus>("/auth/recovery-kit"),
  });

  const make = useMutation({
    mutationFn: () =>
      api<{ codes: string[] }>("/auth/recovery-kit", { method: "POST", body: { password } }),
    onSuccess: ({ codes }) => {
      setPassword("");
      setMadeHere(true);
      setShown({ codes, next: "/account" });
      void queryClient.invalidateQueries({ queryKey: KIT_KEY });
    },
    onError: () => passwordRef.current?.focus(),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (make.isPending) return;
    if (password === "") {
      setMissing(true);
      passwordRef.current?.focus();
      return;
    }
    setMissing(false);
    make.mutate();
  }

  function done() {
    const next = shown?.next ?? "/account";
    forgetFreshKit();
    setShown(null);
    if (next !== "/account") navigate(next);
  }

  const fieldError = missing
    ? intl.formatMessage({ id: "kit.passwordRequired" })
    : make.error instanceof ApiError && make.error.field === "password"
      ? errorText(make.error, "")
      : undefined;
  const formError =
    make.isError && !fieldError
      ? errorText(make.error, intl.formatMessage({ id: "offline.body" }))
      : null;

  return (
    <AdminLayout
      me={me}
      screen="account"
      title={shown && !madeHere ? intl.formatMessage({ id: "kit.titleNew" }) : undefined}
    >
      <section aria-labelledby="account-kit" className="mt-8">
        <h2 id="account-kit" className="text-xl font-semibold">
          <FormattedMessage id="kit.heading" />
        </h2>
        {shown ? (
          <KitCodes me={me} kit={shown} takeFocus={madeHere} onDone={done} />
        ) : (
          <>
            <p className="mt-1">
              {status.data && status.data.codesLeft > 0 && status.data.madeAt !== null ? (
                <FormattedMessage
                  id="kit.left"
                  values={{
                    left: status.data.codesLeft,
                    date: <FormattedDate value={status.data.madeAt} dateStyle="long" />,
                  }}
                />
              ) : status.data ? (
                <FormattedMessage id="kit.none" />
              ) : null}
            </p>
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
                error={fieldError}
                autoComplete="current-password"
                required
              />
              <p role="alert" className="font-medium text-danger empty:sr-only">
                {formError}
              </p>
              <div>
                <button type="submit" disabled={make.isPending} className={primaryButtonClass}>
                  <FormattedMessage id={make.isPending ? "kit.making" : "kit.make"} />
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </AdminLayout>
  );
}

/** Account (PLAN.md's admin footer): for now, the recovery kit. */
export function Account() {
  return <SignedIn>{(me) => <AccountScreen me={me} />}</SignedIn>;
}
