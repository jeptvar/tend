import { useId } from "react";
import { FormattedMessage } from "react-intl";
import { Link } from "wouter";
import type { Me } from "../lib/queries.ts";
import { textLinkClass } from "./AuthLayout.tsx";

/** Says that pictures can't be added on this server, and who can do something about it. */
export function PicturesNotice({ me }: { me: Me }) {
  const id = useId();
  if (me.picturesWork) return null;
  const isAdmin = me.user.role === "admin";
  return (
    <section
      aria-labelledby={id}
      className="mt-6 rounded-2xl border border-danger bg-danger-soft p-5"
    >
      <h2 id={id} className="text-lg font-semibold">
        <FormattedMessage id="pictures.heading" />
      </h2>
      <p className="mt-1">
        <FormattedMessage id={isAdmin ? "pictures.body" : "pictures.bodyAsk"} />
      </p>
      {isAdmin && (
        <Link href="/help" className={textLinkClass}>
          <FormattedMessage id="pictures.help" />
        </Link>
      )}
    </section>
  );
}
