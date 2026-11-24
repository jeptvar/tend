import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { FormattedDate, FormattedMessage, useIntl } from "react-intl";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import { primaryButtonClass, secondaryButtonClass } from "../components/AuthLayout.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Field, PasswordField } from "../components/fields.tsx";
import { showToast } from "../components/Toast.tsx";
import { Waiting } from "../components/Waiting.tsx";
import { ApiError, api, errorText } from "../lib/api.ts";
import { ME_KEY, type Me } from "../lib/queries.ts";

// People (PLAN.md J5): who can sign in, invites still waiting, and inviting someone. The
// server decides who may do what; this only leaves out what someone can't do.

type Role = "admin" | "editor" | "writer";

interface Person {
  id: string;
  name: string;
  email: string;
  role: Role;
  isOwner: boolean;
  lastSeenAt: number | null;
  /** Kept from signing in, for now. */
  disabled: boolean;
  canManage: boolean;
}

interface Invite {
  id: string;
  email: string;
  role: Role;
  invitedBy: string | null;
  expiresAt: number;
  canManage: boolean;
}

interface PeopleList {
  people: Person[];
  invites: Invite[];
}

const PEOPLE_KEY = ["people"];

/** The roles someone can give: Admin only by the Owner. Writer comes with reviews (v0.3). */
function rolesFor(me: Me): Role[] {
  return me.user.isOwner ? ["editor", "admin"] : ["editor"];
}

/**
 * A link made just now, to copy and send however suits. Tend keeps only a hash of it, so it
 * can't be shown again: a new one can always be made.
 */
function OneTimeLink({ link, label, children }: { link: string; label: string; children: string }) {
  const intl = useIntl();
  const inputId = useId();
  const introRef = useRef<HTMLParagraphElement>(null);
  const [status, setStatus] = useState("");
  // It replaces the button that made it, so focus moves here rather than being lost.
  useLayoutEffect(() => {
    introRef.current?.focus();
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setStatus(intl.formatMessage({ id: "people.copied" }));
    } catch {
      setStatus(intl.formatMessage({ id: "people.copyByHand" }));
    }
  }

  return (
    <div className="grid gap-2 rounded-lg border border-brand p-3">
      <p ref={introRef} tabIndex={-1} className="outline-none">
        {children}
      </p>
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={inputId}
          readOnly
          value={link}
          onFocus={(event) => event.target.select()}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-muted bg-white px-3 font-mono text-sm text-[#1d2420]"
        />
        <button type="button" onClick={copy} className={secondaryButtonClass}>
          <FormattedMessage id="people.copy" />
        </button>
      </div>
      <p role="status" className="text-sm empty:sr-only">
        {status}
      </p>
    </div>
  );
}

function InviteForm({ me }: { me: Me }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const emailRef = useRef<HTMLInputElement>(null);
  const roles = rolesFor(me);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [missing, setMissing] = useState(false);
  const [made, setMade] = useState<{ email: string; link: string } | null>(null);

  const send = useMutation({
    mutationFn: () =>
      api<{ invite: Invite; token: string }>("/admin/people/invites", {
        method: "POST",
        body: { email, role },
      }),
    onSuccess: ({ invite, token }) => {
      setMade({ email: invite.email, link: `${window.location.origin}/admin/invite#${token}` });
      setEmail("");
      void queryClient.invalidateQueries({ queryKey: PEOPLE_KEY });
    },
    onError: () => emailRef.current?.focus(),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (send.isPending) return;
    if (email.trim() === "") {
      setMissing(true);
      emailRef.current?.focus();
      return;
    }
    setMissing(false);
    setMade(null);
    send.mutate();
  }

  const emailError = missing
    ? intl.formatMessage({ id: "people.emailRequired" })
    : send.error instanceof ApiError && send.error.field === "email"
      ? errorText(send.error, "")
      : undefined;

  return (
    <section aria-labelledby="people-invite" className="mt-8">
      <h2 id="people-invite" className="text-xl font-semibold">
        <FormattedMessage id="people.invite" />
      </h2>
      <form onSubmit={onSubmit} noValidate className="mt-3 grid gap-5">
        <Field
          ref={emailRef}
          label={intl.formatMessage({ id: "people.email" })}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setMissing(false);
            send.reset();
          }}
          error={emailError}
          type="email"
          autoComplete="off"
          autoCapitalize="none"
          maxLength={254}
          required
        />
        <fieldset className="grid gap-3">
          <legend className="mb-2 font-medium">
            <FormattedMessage id="people.roleLegend" />
          </legend>
          {roles.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer gap-3 rounded-lg border border-muted/50 p-3 has-checked:border-brand has-focus-visible:outline-3 has-focus-visible:outline-brand"
            >
              <input
                type="radio"
                name="role"
                value={option}
                checked={role === option}
                onChange={() => setRole(option)}
                className="mt-1 size-4 accent-brand"
              />
              <span>
                <span className="block font-medium">
                  <FormattedMessage id={`people.role.${option}`} />
                </span>
                <span className="block text-sm text-muted">
                  <FormattedMessage id={`people.roleHint.${option}`} />
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <p role="alert" className="font-medium text-danger empty:sr-only">
          {send.isError &&
            !emailError &&
            errorText(send.error, intl.formatMessage({ id: "offline.body" }))}
        </p>
        <div>
          <button type="submit" disabled={send.isPending} className={primaryButtonClass}>
            <FormattedMessage id="people.makeInvite" />
          </button>
        </div>
      </form>
      {made && (
        <div className="mt-4">
          <OneTimeLink link={made.link} label={intl.formatMessage({ id: "people.inviteLink" })}>
            {intl.formatMessage({ id: "people.inviteMade" }, { email: made.email })}
          </OneTimeLink>
        </div>
      )}
    </section>
  );
}

function PersonRow({ me, person }: { me: Me; person: Person }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const selectId = useId();
  const headingId = useId();
  const options = [...new Set<Role>([person.role, ...rolesFor(me)])];
  const [role, setRole] = useState<Role>(person.role);
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"remove" | "handOver" | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: PEOPLE_KEY });

  /** Changes something about them, with Undo to change it back. */
  const change = useMutation({
    mutationFn: (patch: { role?: Role; disabled?: boolean }) =>
      api<Person>(`/admin/people/${person.id}`, { method: "PATCH", body: patch }),
    onSuccess: (changed, patch) => {
      void refresh();
      setRole(changed.role);
      // Who they were, not who they are now.
      const before = patch.role ? { role: person.role } : { disabled: person.disabled };
      const message = patch.role
        ? intl.formatMessage(
            { id: "people.roleChanged" },
            { name: person.name, role: changed.role },
          )
        : intl.formatMessage(
            { id: changed.disabled ? "people.keptOutDone" : "people.letInDone" },
            { name: person.name },
          );
      showToast({
        message,
        action: {
          label: intl.formatMessage({ id: "list.undo" }),
          run: () => {
            void api<Person>(`/admin/people/${person.id}`, { method: "PATCH", body: before })
              .then((back) => {
                setRole(back.role);
                void refresh();
                showToast({ message: intl.formatMessage({ id: "people.undone" }) });
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
  const reset = useMutation({
    mutationFn: () =>
      api<{ token: string }>(`/admin/people/${person.id}/reset-link`, { method: "POST" }),
    onSuccess: ({ token }) => setResetLink(`${window.location.origin}/admin/reset#${token}`),
  });
  const remove = useMutation({
    mutationFn: () => api(`/admin/people/${person.id}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirming(null);
      void refresh();
      showToast({ message: intl.formatMessage({ id: "people.removed" }, { name: person.name }) });
    },
  });
  const error = change.error ?? reset.error;
  const isMe = person.id === me.user.id;

  return (
    <li className="grid gap-3 border-b border-ink/10 py-4">
      <div>
        <p className="font-medium break-words">
          {person.name}
          {isMe && (
            <span className="text-muted">
              {" "}
              <FormattedMessage id="people.you" />
            </span>
          )}
        </p>
        <p className="text-muted [overflow-wrap:anywhere]">{person.email}</p>
        <p className="text-sm text-muted">
          <FormattedMessage id={person.isOwner ? "people.owner" : `people.role.${person.role}`} />
          {" · "}
          {person.disabled && (
            <strong className="font-medium text-danger">
              <FormattedMessage id="people.keptOut" />
              {" · "}
            </strong>
          )}
          {person.lastSeenAt === null ? (
            <FormattedMessage id="people.neverSeen" />
          ) : (
            <FormattedMessage
              id="people.lastSeen"
              values={{ date: <FormattedDate value={person.lastSeenAt} dateStyle="medium" /> }}
            />
          )}
        </p>
      </div>
      {person.canManage && (
        <div className="flex flex-wrap items-end gap-3">
          {options.length > 1 && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (role !== person.role && !change.isPending) change.mutate({ role });
              }}
            >
              <div className="grid gap-1">
                <label htmlFor={selectId} className="text-sm font-medium">
                  <FormattedMessage id="people.roleOf" values={{ name: person.name }} />
                </label>
                <select
                  id={selectId}
                  value={role}
                  onChange={(event) => setRole(event.target.value as Role)}
                  className="min-h-11 rounded-lg border border-muted bg-white px-3 text-[#1d2420]"
                >
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {intl.formatMessage({ id: `people.role.${option}` })}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                disabled={role === person.role || change.isPending}
                className={secondaryButtonClass}
              >
                <FormattedMessage id="people.changeRole" />
              </button>
            </form>
          )}
          {!person.disabled && (
            <button
              type="button"
              disabled={reset.isPending}
              onClick={() => reset.mutate()}
              className={secondaryButtonClass}
            >
              <FormattedMessage id="people.sendReset" />
            </button>
          )}
          <button
            type="button"
            disabled={change.isPending}
            onClick={() => change.mutate({ disabled: !person.disabled })}
            className={secondaryButtonClass}
          >
            <FormattedMessage id={person.disabled ? "people.letIn" : "people.keepOut"} />
          </button>
          <button
            type="button"
            onClick={() => setConfirming("remove")}
            className={secondaryButtonClass}
          >
            <FormattedMessage id="people.remove" />
          </button>
          {me.user.isOwner && !person.disabled && (
            <button
              type="button"
              onClick={() => setConfirming("handOver")}
              className={secondaryButtonClass}
            >
              <FormattedMessage id="people.handOver" />
            </button>
          )}
        </div>
      )}
      <p role="alert" className="font-medium text-danger empty:sr-only">
        {error && errorText(error, intl.formatMessage({ id: "offline.body" }))}
      </p>
      {resetLink && (
        <OneTimeLink link={resetLink} label={intl.formatMessage({ id: "people.resetLink" })}>
          {intl.formatMessage({ id: "people.resetMade" }, { name: person.name })}
        </OneTimeLink>
      )}
      {confirming === "handOver" && (
        <HandOver person={person} onClose={() => setConfirming(null)} />
      )}
      {confirming === "remove" && (
        <Dialog labelledBy={headingId} onClose={() => setConfirming(null)}>
          <div className="grid gap-4">
            <h2 id={headingId} className="text-xl font-semibold">
              <FormattedMessage id="people.confirmRemove" values={{ name: person.name }} />
            </h2>
            <p>
              <FormattedMessage id="people.confirmRemoveBody" />
            </p>
            <p role="alert" className="font-medium text-danger empty:sr-only">
              {remove.error && errorText(remove.error, intl.formatMessage({ id: "offline.body" }))}
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className={primaryButtonClass}
                onClick={() => setConfirming(null)}
              >
                <FormattedMessage id="people.keep" />
              </button>
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
                className={secondaryButtonClass}
              >
                <FormattedMessage id="people.remove" />
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </li>
  );
}

/** Handing the whole site to someone: it can't be taken back, so it asks for the password. */
function HandOver({ person, onClose }: { person: Person; onClose: () => void }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const headingId = useId();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [missing, setMissing] = useState(false);
  const handOver = useMutation({
    mutationFn: () =>
      api("/auth/transfer-ownership", {
        method: "POST",
        body: { personId: person.id, password },
      }),
    onSuccess: async () => {
      onClose();
      showToast({
        message: intl.formatMessage({ id: "people.handedOver" }, { name: person.name }),
      });
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      await queryClient.invalidateQueries({ queryKey: PEOPLE_KEY });
    },
    onError: () => passwordRef.current?.focus(),
  });
  const aboutPassword =
    handOver.error instanceof ApiError && handOver.error.field === "password"
      ? errorText(handOver.error, "")
      : undefined;
  return (
    <Dialog labelledBy={headingId} onClose={onClose}>
      <form
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (handOver.isPending) return;
          setMissing(password === "");
          if (password === "") passwordRef.current?.focus();
          else handOver.mutate();
        }}
      >
        <h2 id={headingId} className="text-xl font-semibold">
          <FormattedMessage id="people.handOverHeading" values={{ name: person.name }} />
        </h2>
        <p>
          <FormattedMessage id="people.handOverBody" />
        </p>
        <PasswordField
          ref={passwordRef}
          label={intl.formatMessage({ id: "kit.password" })}
          value={password}
          error={missing ? intl.formatMessage({ id: "kit.passwordRequired" }) : aboutPassword}
          autoComplete="current-password"
          onChange={(event) => {
            setPassword(event.target.value);
            setMissing(false);
            handOver.reset();
          }}
        />
        <p role="alert" className="font-medium text-danger empty:sr-only">
          {handOver.error &&
            !aboutPassword &&
            errorText(handOver.error, intl.formatMessage({ id: "offline.body" }))}
        </p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={primaryButtonClass} onClick={onClose}>
            <FormattedMessage id="people.handOverNot" />
          </button>
          <button type="submit" disabled={handOver.isPending} className={secondaryButtonClass}>
            <FormattedMessage id="people.handOverConfirm" values={{ name: person.name }} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function InviteRow({ invite }: { invite: Invite }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const takeBack = useMutation({
    mutationFn: () => api(`/admin/people/invites/${invite.id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PEOPLE_KEY }),
  });
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/10 py-3">
      <div>
        <p className="font-medium [overflow-wrap:anywhere]">{invite.email}</p>
        <p className="text-sm text-muted">
          <FormattedMessage id={`people.role.${invite.role}`} />
          {" · "}
          <FormattedMessage
            id="people.inviteUntil"
            values={{ date: <FormattedDate value={invite.expiresAt} dateStyle="medium" /> }}
          />
        </p>
        <p role="alert" className="font-medium text-danger empty:sr-only">
          {takeBack.error && errorText(takeBack.error, intl.formatMessage({ id: "offline.body" }))}
        </p>
      </div>
      {invite.canManage && (
        <button
          type="button"
          disabled={takeBack.isPending}
          onClick={() => takeBack.mutate()}
          className={secondaryButtonClass}
          aria-label={intl.formatMessage({ id: "people.takeBackFor" }, { email: invite.email })}
        >
          <FormattedMessage id="people.takeBack" />
        </button>
      )}
    </li>
  );
}

function PeopleScreen({ me }: { me: Me }) {
  const list = useQuery({
    queryKey: PEOPLE_KEY,
    queryFn: () => api<PeopleList>("/admin/people"),
  });
  return (
    <AdminLayout me={me} screen="people">
      <p className="mt-2 text-lg text-muted">
        <FormattedMessage id="people.intro" />
      </p>
      {list.data ? (
        <>
          <ul className="mt-6">
            {list.data.people.map((person) => (
              <PersonRow key={person.id} me={me} person={person} />
            ))}
          </ul>
          {list.data.invites.length > 0 && (
            <section aria-labelledby="people-waiting" className="mt-8">
              <h2 id="people-waiting" className="text-xl font-semibold">
                <FormattedMessage id="people.waiting" />
              </h2>
              <ul className="mt-2">
                {list.data.invites.map((invite) => (
                  <InviteRow key={invite.id} invite={invite} />
                ))}
              </ul>
            </section>
          )}
        </>
      ) : (
        <Waiting query={list} />
      )}
      <InviteForm me={me} />
    </AdminLayout>
  );
}

export function People() {
  return <SignedIn roles={["admin"]}>{(me) => <PeopleScreen me={me} />}</SignedIn>;
}
