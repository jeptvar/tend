import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FormattedMessage, useIntl } from "react-intl";
import { Redirect } from "wouter";
import {
  AuthLayout,
  CannotReachTend,
  Loading,
  secondaryButtonClass,
} from "../components/AuthLayout.tsx";
import { api, errorText } from "../lib/api.ts";
import { ME_KEY, useMe, useSetupStatus } from "../lib/queries.ts";

/** Where people land after setup and sign-in. The real checklist arrives with pages and posts. */
export function Overview() {
  const intl = useIntl();
  const me = useMe();
  const status = useSetupStatus();
  const queryClient = useQueryClient();

  const signOut = useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    onSuccess: () => queryClient.setQueryData(ME_KEY, null),
  });

  if (me.isPending || status.isPending) return <Loading />;
  // A background check failing, on a phone that lost signal for a moment, say, is no
  // reason to replace a page that's working. Only a first answer is worth blocking on.
  if ((me.isError && me.data === undefined) || (status.isError && !status.data)) {
    return (
      <CannotReachTend
        error={me.error ?? status.error}
        retrying={me.isFetching || status.isFetching}
        onRetry={() => {
          void me.refetch();
          void status.refetch();
        }}
      />
    );
  }
  if (!me.data) return <Redirect to={status.data?.needsSetup ? "/setup" : "/login"} replace />;

  const { user, site, starter } = me.data;
  return (
    <AuthLayout screen="overview" title={site.name}>
      {site.tagline && <p className="mt-2 text-lg break-words text-muted">{site.tagline}</p>}
      <p className="mt-6 text-lg">
        <FormattedMessage id="overview.ready" />
      </p>
      <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <dt className="text-muted">
          <FormattedMessage id="overview.signedInAs" />
        </dt>
        <dd className="min-w-0 break-words">
          {user.name} ({user.email})
        </dd>
        {starter && (
          <>
            <dt className="text-muted">
              <FormattedMessage id="overview.startingPoint" />
            </dt>
            <dd>
              <FormattedMessage id={`setup.start.${starter}`} />
            </dd>
          </>
        )}
      </dl>
      <p className="mt-6 text-muted">
        <FormattedMessage id="overview.next" />
      </p>
      {/* Always mounted: screen readers can miss a live region added along with its text. */}
      <p role="alert" className="mt-4 font-medium text-danger empty:sr-only">
        {signOut.isError && errorText(signOut.error, intl.formatMessage({ id: "offline.body" }))}
      </p>
      <div className="mt-8">
        <button
          type="button"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
          className={secondaryButtonClass}
        >
          <FormattedMessage id="overview.signOut" />
        </button>
      </div>
    </AuthLayout>
  );
}
