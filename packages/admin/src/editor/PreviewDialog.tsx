import { useId, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { secondaryButtonClass } from "../components/AuthLayout.tsx";
import { Dialog } from "../components/Dialog.tsx";

/**
 * Sandboxed with no permissions at all: no scripts, no forms, no opening anything, and no
 * access to the admin it's sitting in. What people write can't reach out of this frame.
 */
export function PreviewFrame({
  html,
  title,
  device,
}: {
  html: string;
  title: string;
  device: "desktop" | "phone";
}) {
  return (
    <iframe
      sandbox=""
      srcDoc={html}
      title={title}
      className={`h-full w-full rounded border border-muted bg-white ${
        device === "phone" ? "max-w-[375px]" : ""
      }`}
    />
  );
}

export function DeviceChoice({
  device,
  onChange,
}: {
  device: "desktop" | "phone";
  onChange: (device: "desktop" | "phone") => void;
}) {
  const intl = useIntl();
  return (
    <fieldset className="flex items-center gap-1">
      <legend className="sr-only">{intl.formatMessage({ id: "preview.device" })}</legend>
      {(["desktop", "phone"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={device === option}
          onClick={() => onChange(option)}
          className="min-h-11 min-w-11 rounded px-3 hover:underline focus-visible:outline-3 focus-visible:outline-brand aria-pressed:bg-ink aria-pressed:text-paper"
        >
          <FormattedMessage id={`preview.${option}`} />
        </button>
      ))}
    </fieldset>
  );
}

export function PreviewDialog({ html, onClose }: { html: string; onClose: () => void }) {
  const intl = useIntl();
  const headingId = useId();
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  return (
    <Dialog labelledBy={headingId} onClose={onClose} size="full">
      <div className="flex h-full flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <h2 id={headingId} className="me-auto text-xl font-semibold">
            <FormattedMessage id="preview.heading" />
          </h2>
          <DeviceChoice device={device} onChange={setDevice} />
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            <FormattedMessage id="common.close" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 justify-center">
          <PreviewFrame
            html={html}
            title={intl.formatMessage({ id: "preview.frame" })}
            device={device}
          />
        </div>
      </div>
    </Dialog>
  );
}
