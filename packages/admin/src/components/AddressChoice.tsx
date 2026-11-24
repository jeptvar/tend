import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { api, errorText } from "../lib/api.ts";
import { onThisComputer } from "../lib/hosts.ts";
import { ME_KEY, type Me } from "../lib/queries.ts";
import { secondaryButtonClass } from "./AuthLayout.tsx";

/** Confirms that the address the admin is open at is the site's own. */
export function useConfirmAddress(onDone?: () => void) {
  const queryClient = useQueryClient();
  const address = window.location.origin;
  return useMutation({
    mutationFn: () =>
      api<{ address: string }>("/admin/address", { method: "POST", body: { address } }),
    onSuccess: () => {
      onDone?.();
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}

/**
 * What the site's address is, who says so, and the way to change it: opening the admin at the
 * new one and choosing it here, so that it can only be one that leads to this site.
 */
export function AddressChoice({ me }: { me: Me }) {
  const intl = useIntl();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const confirm = useConfirmAddress(() => statusRef.current?.focus());
  const { address, addressFrom } = me.site;
  const here = window.location.origin;
  const strong = (text: string) => <strong className="break-all">{text}</strong>;
  const canUse = addressFrom !== "set" && !onThisComputer() && here !== address;

  return (
    <div className="grid gap-3">
      <p>
        {address ? (
          <FormattedMessage id="address.is" values={{ address: strong(address) }} />
        ) : (
          <FormattedMessage id="address.unknown" />
        )}{" "}
        {addressFrom && <FormattedMessage id={`address.from.${addressFrom}`} />}
      </p>
      {canUse && (
        <div>
          <button
            type="button"
            aria-disabled={confirm.isPending}
            onClick={() => {
              if (!confirm.isPending) confirm.mutate();
            }}
            className={`${secondaryButtonClass} [overflow-wrap:anywhere] aria-disabled:opacity-60`}
          >
            <FormattedMessage id="address.use" values={{ address: here }} />
          </button>
        </div>
      )}
      {!canUse && addressFrom !== "set" && !onThisComputer() && (
        <p className="text-sm text-muted">
          <FormattedMessage id="address.change" />
        </p>
      )}
      {/* Always mounted: screen readers can miss a live region added along with its text. */}
      <p ref={statusRef} tabIndex={-1} role="status" className="outline-none empty:sr-only">
        {confirm.isSuccess && (
          <FormattedMessage id="overview.address.done" values={{ address: confirm.data.address }} />
        )}
      </p>
      <p role="alert" className="font-medium text-danger empty:sr-only">
        {confirm.isError && errorText(confirm.error, intl.formatMessage({ id: "offline.body" }))}
      </p>
    </div>
  );
}
