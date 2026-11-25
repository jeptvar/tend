import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { FormattedMessage, type IntlShape, useIntl } from "react-intl";
import { Link } from "wouter";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import { secondaryButtonClass, textLinkClass } from "../components/AuthLayout.tsx";
import { Disclosure } from "../components/Disclosure.tsx";
import { OutLink } from "../components/OutLink.tsx";
import { Waiting } from "../components/Waiting.tsx";
import { api } from "../lib/api.ts";
import { bytesText } from "../lib/bytes.ts";
import { guide, ISSUES_URL } from "../lib/docs.ts";
import type { Me } from "../lib/queries.ts";

interface Health {
  version: string;
  node: string;
  platform: string;
  system: string;
  runningForSeconds: number;
  memoryBytes: number;
  databaseBytes: number | null;
  findings: { kind: "OK" | "LOOK" | "FIX"; text: string }[];
}

interface Topic {
  id: string;
  roles?: string[];
  /** The screen it's about. */
  href?: string;
  link?: string;
}

const TOPICS: Topic[] = [
  { id: "write", href: "/posts", link: "nav.posts" },
  { id: "change", roles: ["admin", "editor"], href: "/pages", link: "nav.pages" },
  { id: "pictures", href: "/media", link: "nav.media" },
  { id: "undo" },
  { id: "menu", roles: ["admin", "editor"], href: "/menu", link: "nav.menu" },
  { id: "look", roles: ["admin"], href: "/design", link: "nav.design" },
  { id: "people", roles: ["admin"], href: "/people", link: "nav.people" },
  { id: "backup", roles: ["admin"], href: "/settings/backups", link: "settings.backups" },
  { id: "online", roles: ["admin"], href: "/online", link: "steps.online" },
  { id: "locked", href: "/account", link: "nav.account" },
];

function Answer({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <Disclosure summary={summary}>
      <div className="grid justify-items-start gap-2">{children}</div>
    </Disclosure>
  );
}

function healthText(intl: IntlShape, health: Health): string {
  const lines = [
    `Tend ${health.version}, Node.js ${health.node}, ${health.platform} (${health.system})`,
    intl.formatMessage(
      { id: "help.running" },
      {
        hours: Math.floor(health.runningForSeconds / 3600),
        memory: bytesText(intl, health.memoryBytes),
      },
    ),
  ];
  if (health.databaseBytes !== null) {
    lines.push(
      intl.formatMessage({ id: "help.database" }, { size: bytesText(intl, health.databaseBytes) }),
    );
  }
  return [...lines, ...health.findings.map(({ kind, text }) => `${kind}: ${text}`)].join("\n");
}

/** How Tend is doing, for whoever can do something about it, and to send with a question. */
function AboutTend() {
  const intl = useIntl();
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api<Health>("/admin/health"),
    staleTime: 0,
  });
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  if (!health.data) return <Waiting query={health} />;
  const info = health.data;
  const text = healthText(intl, info);
  return (
    <>
      <ul className="grid gap-2">
        {info.findings.map((finding) => (
          <li key={finding.text} className="[overflow-wrap:anywhere]">
            <strong className={finding.kind === "OK" ? "text-brand" : "text-danger"}>
              <FormattedMessage id={`help.finding.${finding.kind}`} />
            </strong>{" "}
            {finding.text}
          </li>
        ))}
      </ul>
      <pre className="w-full rounded-xl bg-sunken p-3 text-sm break-words whitespace-pre-wrap">
        {text.split("\n").slice(0, 3).join("\n")}
      </pre>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            navigator.clipboard
              .writeText(text)
              .then(() => setCopied("yes"))
              .catch(() => setCopied("no"));
          }}
          className={secondaryButtonClass}
        >
          <FormattedMessage id="help.copy" />
        </button>
        <span role="status">
          {copied && (
            <FormattedMessage id={copied === "yes" ? "publish.copied" : "help.copyFailed"} />
          )}
        </span>
      </div>
      <p className="text-sm text-muted">
        <FormattedMessage id="help.copyHint" />
      </p>
      <OutLink href={ISSUES_URL}>
        <FormattedMessage id="help.report" />
      </OutLink>
    </>
  );
}

function HelpScreen({ me }: { me: Me }) {
  const [about, setAbout] = useState(false);
  const isAdmin = me.user.role === "admin";
  return (
    <AdminLayout me={me} screen="help" intro={<FormattedMessage id="help.intro" />}>
      <div className="mt-6 grid gap-3">
        {TOPICS.filter((topic) => !topic.roles || topic.roles.includes(me.user.role)).map(
          (topic) => (
            <Answer key={topic.id} summary={<FormattedMessage id={`help.${topic.id}`} />}>
              <p>
                <FormattedMessage id={`help.${topic.id}Body`} />
              </p>
              {topic.href && topic.link && (
                <Link href={topic.href} className={textLinkClass}>
                  <FormattedMessage
                    id="help.goTo"
                    values={{ place: <FormattedMessage id={topic.link} /> }}
                  />
                </Link>
              )}
            </Answer>
          ),
        )}
      </div>
      <p className="mt-6 flex flex-wrap gap-x-6">
        <OutLink href={guide("")}>
          <FormattedMessage id="help.guide" />
        </OutLink>
      </p>
      {!isAdmin && (
        <p className="mt-4 text-muted">
          <FormattedMessage id="help.askAdmin" />
        </p>
      )}
      {isAdmin && (
        <Disclosure
          className="card mt-6"
          onToggle={setAbout}
          summary={<FormattedMessage id="help.about" />}
        >
          <div className="grid grid-cols-1 justify-items-start gap-4">{about && <AboutTend />}</div>
        </Disclosure>
      )}
    </AdminLayout>
  );
}

/** In the same place on every screen: short answers, and how Tend is doing for Admins. */
export function Help() {
  return <SignedIn>{(me) => <HelpScreen me={me} />}</SignedIn>;
}
