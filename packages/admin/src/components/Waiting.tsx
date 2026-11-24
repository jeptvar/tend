import type { UseQueryResult } from "@tanstack/react-query";
import { FormattedMessage, useIntl } from "react-intl";
import { errorText } from "../lib/api.ts";
import { secondaryButtonClass } from "./AuthLayout.tsx";

/**
 * What's shown in place of something until it has loaded: that it's on its way, or what went
 * wrong, with a way to try again.
 */
export function Waiting({
  query,
}: {
  query: Pick<UseQueryResult, "error" | "isFetching" | "refetch">;
}) {
  const intl = useIntl();
  if (!query.error) {
    return (
      <p className="mt-6 text-muted">
        <FormattedMessage id="common.loading" />
      </p>
    );
  }
  return (
    <div className="mt-6 grid justify-items-start gap-3">
      <p role="alert" className="font-medium text-danger">
        {errorText(query.error, intl.formatMessage({ id: "offline.body" }))}
      </p>
      <button
        type="button"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
        className={secondaryButtonClass}
      >
        <FormattedMessage id={query.isFetching ? "common.trying" : "common.tryAgain"} />
      </button>
    </div>
  );
}
