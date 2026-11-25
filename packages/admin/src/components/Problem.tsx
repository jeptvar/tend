import { FormattedMessage, useIntl } from "react-intl";
import { ApiError, errorText } from "../lib/api.ts";

/** Signing in again, or waiting a moment, is all there is to say about these. */
const SAYS_IT_ALL = new Set([401, 429]);

/**
 * What went wrong and what to do about it, with a page about it to read. A problem with one
 * field says what the field needs, so it has no page.
 */
export function Problem({ error }: { error: unknown }) {
  const intl = useIntl();
  const docs =
    error instanceof ApiError && !error.field && !SAYS_IT_ALL.has(error.status)
      ? error.docs
      : undefined;
  return (
    <>
      {errorText(error, intl.formatMessage({ id: "offline.body" }))}
      {docs && (
        <>
          {" "}
          <a
            href={docs}
            target="_blank"
            rel="noopener"
            className="inline-flex min-h-11 min-w-11 items-center font-normal text-brand underline underline-offset-4 focus-visible:outline-3 focus-visible:outline-brand"
          >
            <FormattedMessage id="common.more" />
            <span className="sr-only"> {intl.formatMessage({ id: "common.newTab" })}</span>
          </a>
        </>
      )}
    </>
  );
}
