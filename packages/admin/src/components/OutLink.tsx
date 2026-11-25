import type { ReactNode } from "react";
import { FormattedMessage } from "react-intl";
import { textLinkClass } from "./AuthLayout.tsx";
import { Icon } from "./icons.tsx";

/** A link to another site, which opens in a new tab and says so. */
export function OutLink({
  href,
  className = textLinkClass,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noopener" className={`${className} gap-1.5`}>
      {children}
      <Icon name="view" className="size-4" />
      <span className="sr-only">
        <FormattedMessage id="common.newTab" />
      </span>
    </a>
  );
}
