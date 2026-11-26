import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { DeviceChoice } from "../editor/PreviewDialog.tsx";
import { api } from "../lib/api.ts";
import type { Design } from "../lib/site.ts";
import { BrowserFrame } from "./BrowserFrame.tsx";
import { PageFrame } from "./PageFrame.tsx";
import { Problem } from "./Problem.tsx";

/** How long a change has to rest, so a colour being chosen isn't drawn at every step. */
const REST_MS = 350;
/** The sizes the site is drawn at, then made small enough to fit. */
const WINDOW = { desktop: { width: 1280 }, phone: { width: 390, height: 844 } };

function useRested<T>(value: T): T {
  const [rested, setRested] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setRested(value), REST_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return rested;
}

/** The room there is inside something, kept up to date. */
function useRoom() {
  const ref = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const watcher = new ResizeObserver(() =>
      setRoom({ width: element.clientWidth, height: element.clientHeight }),
    );
    watcher.observe(element);
    return () => watcher.disconnect();
  }, []);
  return { ref, room };
}

/**
 * The page, as a picture that can be scrolled. When it changes, the new one takes the old one's
 * place once it's ready, so it never goes blank.
 */
function Page({
  html,
  title,
  scale,
  width,
  height,
}: {
  html: string;
  title: string;
  scale: number;
  width: number;
  height: number;
}) {
  const [pages, setPages] = useState<{ id: number; html: string }[]>([]);
  const last = useRef(0);
  useEffect(() => {
    last.current += 1;
    const page = { id: last.current, html };
    // The first is the one that's showing. Any other hadn't been ready in time.
    setPages((shown) => [...shown.slice(0, 1), page]);
  }, [html]);
  return pages.map(({ id, html: own }, index) => (
    <PageFrame
      key={id}
      html={own}
      title={title}
      onReady={() => setPages((shown) => shown.filter((other) => other.id >= id))}
      style={{ width, height, transform: `scale(${scale})` }}
      className={`absolute top-0 left-0 origin-top-left bg-white ${index === 0 ? "" : "invisible"}`}
    />
  ));
}

/** The site with a design that isn't saved yet, beside the form that's changing it. */
export function LivePreview({ design, name }: { design: Design; name: string }) {
  const intl = useIntl();
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const { ref, room } = useRoom();
  const rested = useRested(design);
  const preview = useQuery({
    queryKey: ["design-preview", rested],
    queryFn: () => api<{ html: string }>("/admin/design/preview", { method: "POST", body: rested }),
    placeholderData: keepPreviousData,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const phone = device === "phone";
  const scale = phone
    ? Math.min(1, room.height / WINDOW.phone.height)
    : Math.min(1, room.width / WINDOW.desktop.width);
  const width = phone ? WINDOW.phone.width : Math.max(WINDOW.desktop.width, room.width);
  const height = phone ? WINDOW.phone.height : room.height / (scale || 1);
  const page = preview.data && scale > 0 && (
    <Page
      html={preview.data.html}
      title={intl.formatMessage({ id: "preview.frame" })}
      scale={scale}
      width={width}
      height={height}
    />
  );
  return (
    <section
      aria-label={intl.formatMessage({ id: "design.preview" })}
      className="sticky top-0 flex h-dvh flex-col gap-4 p-7 short:static short:h-160"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold text-muted">
          <FormattedMessage id="design.preview" />
        </h2>
        <DeviceChoice device={device} onChange={setDevice} />
      </div>
      {preview.error && (
        <p className="rounded-2xl border border-danger bg-danger-soft px-5 py-3 font-medium [overflow-wrap:anywhere] text-danger">
          <Problem error={preview.error} />
        </p>
      )}
      <div ref={ref} className="relative min-h-0 flex-1">
        {phone ? (
          <div
            style={{ width: width * scale, height: height * scale }}
            className="relative mx-auto overflow-hidden rounded-4xl border border-line bg-white shadow-raised"
          >
            {page}
          </div>
        ) : (
          <BrowserFrame name={name} className="absolute inset-0 flex shadow-raised">
            <div className="relative min-h-0 flex-1 overflow-hidden">{page}</div>
          </BrowserFrame>
        )}
      </div>
    </section>
  );
}
