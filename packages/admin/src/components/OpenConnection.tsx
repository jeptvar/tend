import { useId } from "react";
import { FormattedMessage } from "react-intl";
import { connectionIsOpen } from "../lib/hosts.ts";

/**
 * Says that the connection isn't private, wherever a password might be typed (PLAN.md §12):
 * plain http to another computer can be read by anyone on the way.
 */
export function OpenConnection({ address }: { address?: string | null }) {
  const id = useId();
  if (!connectionIsOpen()) return null;
  const secure = address?.startsWith("https:") ? address : null;
  return (
    <section
      aria-labelledby={id}
      className="mb-6 rounded-2xl border-2 border-danger bg-danger-soft p-5 [overflow-wrap:anywhere] print:hidden"
    >
      <h2 id={id} className="text-lg font-semibold text-danger">
        <FormattedMessage id="http.heading" />
      </h2>
      <p className="mt-1">
        <FormattedMessage id="http.body" />
      </p>
      <p className="mt-1">
        {secure ? (
          <a
            href={`${secure}/admin/`}
            className="inline-flex min-h-11 items-center font-medium text-brand underline underline-offset-4 focus-visible:outline-3 focus-visible:outline-brand"
          >
            <FormattedMessage id="http.use" values={{ address: secure }} />
          </a>
        ) : (
          <FormattedMessage id="http.fix" />
        )}
      </p>
    </section>
  );
}
