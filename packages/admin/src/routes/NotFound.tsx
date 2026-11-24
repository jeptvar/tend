import { FormattedMessage } from "react-intl";
import { Link } from "wouter";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import { textLinkClass } from "../components/AuthLayout.tsx";

/** For an address in the admin that isn't anything, instead of a screen nobody asked for. */
export function NotFound() {
  return (
    <SignedIn>
      {(me) => (
        <AdminLayout me={me} screen="notFound">
          <p className="mt-2 text-lg">
            <FormattedMessage id="notFound.body" />
          </p>
          <p className="mt-4">
            <Link href="/" className={textLinkClass}>
              <FormattedMessage id="notFound.back" />
            </Link>
          </p>
        </AdminLayout>
      )}
    </SignedIn>
  );
}
