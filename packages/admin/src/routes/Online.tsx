import type { ReactNode } from "react";
import { FormattedMessage } from "react-intl";
import { Link } from "wouter";
import { AddressChoice } from "../components/AddressChoice.tsx";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import { primaryButtonClass, textLinkClass } from "../components/AuthLayout.tsx";
import { OutLink } from "../components/OutLink.tsx";
import { guide, RAILWAY_URL } from "../lib/docs.ts";
import { onThisComputer } from "../lib/hosts.ts";
import type { Me } from "../lib/queries.ts";
import { BACKUP_DOWNLOAD_URL } from "../lib/site.ts";

// Going online (PLAN.md J1b, J10 and J11): the steps someone takes outside Tend, in order, with
// what they'll be asked on the way.

function Steps({ children }: { children: ReactNode }) {
  return <ol className="mt-6 grid list-decimal gap-6 pl-6">{children}</ol>;
}

function Step({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <li className="pl-1">
      <h2 className="text-lg font-semibold">
        <FormattedMessage id={heading} />
      </h2>
      <div className="mt-1 grid justify-items-start gap-2">{children}</div>
    </li>
  );
}

function Para({ id, values }: { id: string; values?: Record<string, ReactNode> }) {
  return (
    <p>
      <FormattedMessage id={id} values={values ?? {}} />
    </p>
  );
}

function OnlineScreen({ me }: { me: Me }) {
  return (
    <AdminLayout me={me} screen="online">
      <p className="mt-2 text-lg">
        <FormattedMessage id={onThisComputer() ? "online.intro" : "online.introElsewhere"} />
      </p>
      <Steps>
        <Step heading="online.backup">
          <Para id="online.backupBody" />
          {me.user.isOwner ? (
            <a
              href={BACKUP_DOWNLOAD_URL}
              download
              className={`${primaryButtonClass} inline-flex items-center`}
            >
              <FormattedMessage id="backups.download.button" />
            </a>
          ) : (
            <Para id="backups.download.ownerOnly" />
          )}
        </Step>
        <Step heading="online.railway">
          <Para id="online.railwayBody" />
          <Para id="online.railwayCost" />
          <OutLink href={RAILWAY_URL}>
            <FormattedMessage id="online.railwayLink" />
          </OutLink>
        </Step>
        <Step heading="online.start">
          <Para id="online.startBody" />
        </Step>
        <Step heading="online.address">
          <Para
            id="online.addressBody"
            values={{
              button: (
                <em>
                  {"“"}
                  <FormattedMessage id="overview.address.confirm" />
                  {"”"}
                </em>
              ),
            }}
          />
        </Step>
      </Steps>
      <p className="mt-8">
        <FormattedMessage id="online.after" />
      </p>
      <p className="mt-4 flex flex-wrap gap-x-6">
        <OutLink href={guide("move-your-site")}>
          <FormattedMessage id="online.guide" />
        </OutLink>
        <OutLink href={guide("own-server")}>
          <FormattedMessage id="online.ownServer" />
        </OutLink>
        <OutLink href={guide("costs")}>
          <FormattedMessage id="online.costs" />
        </OutLink>
      </p>
    </AdminLayout>
  );
}

function DomainScreen({ me }: { me: Me }) {
  const onRailway = me.platform === "railway";
  if (onThisComputer()) {
    return (
      <AdminLayout me={me} screen="domain">
        <p className="mt-2 text-lg">
          <FormattedMessage id="domain.localFirst" />
        </p>
        <p className="mt-4">
          <Link href="/online" className={textLinkClass}>
            <FormattedMessage id="steps.online" />
          </Link>
        </p>
      </AdminLayout>
    );
  }
  return (
    <AdminLayout me={me} screen="domain">
      <p className="mt-2 text-lg">
        <FormattedMessage id="domain.intro" />
      </p>
      <Steps>
        <Step heading={onRailway ? "domain.host.railway" : "domain.host.other"}>
          <Para id={onRailway ? "domain.hostBody.railway" : "domain.hostBody.other"} />
        </Step>
        <Step heading="domain.records">
          <Para id={onRailway ? "domain.recordsBody.railway" : "domain.recordsBody.other"} />
          <Para id="domain.www" />
        </Step>
        <Step heading="domain.wait">
          <Para id="domain.waitBody" />
        </Step>
        <Step heading="domain.use">
          <Para id="domain.useBody" />
          <AddressChoice me={me} />
        </Step>
      </Steps>
      <p className="mt-8 rounded-lg border border-danger p-3">
        <FormattedMessage id="domain.email" />
      </p>
      <p className="mt-4">
        <OutLink href={guide("connect-your-domain")}>
          <FormattedMessage id="domain.guide" />
        </OutLink>
      </p>
    </AdminLayout>
  );
}

export function PutOnline() {
  return <SignedIn roles={["admin"]}>{(me) => <OnlineScreen me={me} />}</SignedIn>;
}

export function ConnectDomain() {
  return <SignedIn roles={["admin"]}>{(me) => <DomainScreen me={me} />}</SignedIn>;
}
