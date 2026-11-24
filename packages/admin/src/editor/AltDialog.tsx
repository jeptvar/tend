import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { FormattedMessage } from "react-intl";
import { primaryButtonClass, secondaryButtonClass } from "../components/AuthLayout.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Problem } from "../components/Problem.tsx";
import { api } from "../lib/api.ts";
import { type MediaItem, rememberMedia } from "../lib/media.ts";

/**
 * Asks for a picture's description as soon as it's added (PLAN.md J2), or later from the
 * picture itself. It's saved to Media, so it's the same wherever the picture is used.
 */
export function AltDialog({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  const queryClient = useQueryClient();
  const headingId = useId();
  const altId = useId();
  const hintId = useId();
  const [alt, setAlt] = useState(item.alt ?? "");
  const [decorative, setDecorative] = useState(item.decorative);

  const save = useMutation({
    mutationFn: () =>
      api<MediaItem>(`/admin/media/${item.id}`, {
        method: "PATCH",
        body: { alt: alt.trim() || null, decorative },
      }),
    onSuccess: (updated) => {
      rememberMedia(queryClient, updated);
      onClose();
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Dialog labelledBy={headingId} onClose={onClose}>
      <form onSubmit={onSubmit} className="grid gap-4">
        <h2 id={headingId} className="text-xl font-semibold">
          <FormattedMessage id="alt.heading" />
        </h2>
        {item.previewUrl && (
          <img
            src={item.previewUrl}
            alt=""
            style={{ backgroundColor: item.dominantColor ?? undefined }}
            className="max-h-48 w-full rounded-lg object-contain"
          />
        )}
        <div className="grid gap-2">
          <label htmlFor={altId} className="font-medium">
            <FormattedMessage id="media.description" />
          </label>
          <textarea
            id={altId}
            rows={3}
            autoFocus
            value={decorative ? "" : alt}
            disabled={decorative}
            aria-describedby={hintId}
            onChange={(event) => setAlt(event.target.value)}
            className="w-full rounded-lg border border-muted bg-white px-3 py-2 text-lg text-[#1d2420] focus-visible:outline-3 focus-visible:outline-brand disabled:opacity-60"
          />
          <p id={hintId} className="text-sm text-muted">
            <FormattedMessage id="alt.hint" />
          </p>
        </div>
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            checked={decorative}
            onChange={(event) => setDecorative(event.target.checked)}
            className="h-5 w-5 accent-brand"
          />
          <FormattedMessage id="media.decorative" />
        </label>
        <p role="alert" className="font-medium text-danger empty:sr-only">
          {save.error && <Problem error={save.error} />}
        </p>
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={save.isPending} className={primaryButtonClass}>
            <FormattedMessage id="media.save" />
          </button>
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            <FormattedMessage id="alt.later" />
          </button>
        </div>
      </form>
    </Dialog>
  );
}
