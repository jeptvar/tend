import { useId, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { iconButtonClass } from "../components/AuthLayout.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Icon } from "../components/icons.tsx";
import { PageFrame } from "../components/PageFrame.tsx";
import { Tabs } from "../components/Tabs.tsx";

/** What people write, as it'll be. It can't reach out of its frame. */
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
    <PageFrame
      html={html}
      title={title}
      className={`h-full w-full border border-line bg-white shadow-raised ${
        device === "phone" ? "max-w-[390px] rounded-4xl" : "rounded-2xl"
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
    <fieldset>
      <legend className="sr-only">{intl.formatMessage({ id: "preview.device" })}</legend>
      <Tabs>
        {(["desktop", "phone"] as const).map((option) => (
          <Tabs.Tab key={option} chosen={device === option} onChoose={() => onChange(option)}>
            <span className="inline-flex items-center gap-2">
              <Icon name={option === "phone" ? "phone" : "computer"} className="size-4.5" />
              <FormattedMessage id={`preview.${option}`} />
            </span>
          </Tabs.Tab>
        ))}
      </Tabs>
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
          <h2 id={headingId} className="me-auto text-xl font-bold">
            <FormattedMessage id="preview.heading" />
          </h2>
          <DeviceChoice device={device} onChange={setDevice} />
          <button
            type="button"
            aria-label={intl.formatMessage({ id: "common.close" })}
            className={iconButtonClass}
            onClick={onClose}
          >
            <Icon name="close" />
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
