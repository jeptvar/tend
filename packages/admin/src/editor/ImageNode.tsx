import { mergeAttributes, Node } from "@tiptap/core";
import {
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
} from "@tiptap/react";
import { useEffect } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { type MediaItem, uploadWords, useMediaItems } from "../lib/media.ts";
import { MoveButtons } from "./move.tsx";
import { forgetUpload, retryUpload, useUpload } from "./uploads.ts";

/** Marks the editor's own changes for uploads, so they don't count as someone typing. */
export const UPLOAD_META = "tendUpload";

const controlClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-line bg-surface px-3 text-sm font-semibold text-ink hover:border-brand focus-visible:outline-3 focus-visible:outline-brand";
/** On a picture, over whatever's in it. */
const overClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-3 text-sm font-medium text-white hover:bg-white/15 focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-white aria-pressed:bg-white aria-pressed:text-[#14201b]";
const SIZES = [
  ["normal", "image.sizeNormal"],
  ["wide", "image.sizeWide"],
  ["full", "image.sizeFull"],
] as const;

export interface ImageOptions {
  /** Opens the description dialog for a picture. */
  onDescribe: (mediaId: string) => void;
  /** Asks for a picture, and hands it over. */
  onPick: (use: (mediaId: string) => void) => void;
  /** A dropped, pasted or picked file has arrived and taken its placeholder's place. */
  onUploaded: (item: MediaItem, startedAt: number) => void;
}

function Notice({ children, onRemove }: { children: React.ReactNode; onRemove?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-danger bg-danger-soft p-4 text-left font-sans text-base">
      <span className="min-w-0 flex-1 text-danger">{children}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} className={controlClass}>
          <FormattedMessage id="image.remove" />
        </button>
      )}
    </div>
  );
}

function ImageView({
  node,
  updateAttributes,
  deleteNode,
  editor,
  extension,
  getPos,
  selected,
}: NodeViewProps) {
  const intl = useIntl();
  const { mediaId, caption, size, uploadId } = node.attrs as {
    mediaId: string | null;
    caption: string | null;
    size: string;
    uploadId: string | null;
  };
  const editable = useEditorState({
    editor,
    selector: ({ editor: current }) => current.isEditable,
  });
  const upload = useUpload(mediaId ? null : uploadId);
  const lookup = useMediaItems(mediaId ? [mediaId] : []);
  const item = mediaId ? lookup.found.get(mediaId) : undefined;
  const options = extension.options as ImageOptions;
  const position = getPos();
  // Inside a section the theme decides how wide it is, so there's nothing to choose.
  const nested = typeof position === "number" && editor.state.doc.resolve(position).depth > 0;

  function remove() {
    // Stops it if it's still going, so a picture taken out doesn't turn up in Media anyway.
    if (uploadId) forgetUpload(uploadId);
    deleteNode();
    editor.commands.focus();
  }

  // Whenever its upload is done, the real picture takes the placeholder's place: when it
  // arrives, or later if the placeholder comes back with Redo. It isn't a step of its own
  // for Undo, which takes the whole thing away.
  const done = upload?.done ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per arrival
  useEffect(() => {
    if (mediaId || !done || editor.isDestroyed) return;
    const at = getPos();
    if (typeof at !== "number") return;
    // Only ever the placeholder this view is for, as it is right now.
    const current = editor.state.doc.nodeAt(at);
    if (current?.type.name !== "image" || current.attrs.uploadId !== uploadId) return;
    const { tr, schema } = editor.state;
    if (done.kind === "image") {
      tr.setNodeMarkup(at, undefined, { ...current.attrs, mediaId: done.id, uploadId: null });
    } else {
      // A PDF becomes a link to it, named after the file.
      const link = schema.marks.link?.create({ href: done.url });
      const paragraph = schema.nodes.paragraph?.create(
        null,
        schema.text(done.name, link ? [link] : []),
      );
      if (paragraph) tr.replaceWith(at, at + current.nodeSize, paragraph);
    }
    editor.view.dispatch(tr.setMeta("addToHistory", false).setMeta(UPLOAD_META, true));
    options.onUploaded(done, upload?.startedAt ?? 0);
  }, [done]);

  let picture: React.ReactNode;
  if (!mediaId) {
    if (!upload) {
      picture = (
        <Notice onRemove={editable ? remove : undefined}>
          <FormattedMessage id="image.uploadStopped" />
        </Notice>
      );
    } else if (upload.error) {
      picture = (
        <div className="grid gap-2 rounded-2xl border border-dashed border-danger bg-danger-soft p-4 text-left font-sans text-base">
          <p role="alert" className="text-danger">
            <FormattedMessage id="image.uploadFailed" values={{ name: upload.name }} />{" "}
            {upload.error}
          </p>
          <div className="flex flex-wrap gap-2">
            {upload.retryable && (
              <button
                type="button"
                className={controlClass}
                onClick={() => retryUpload(upload.id, uploadWords(intl))}
              >
                <FormattedMessage id="common.tryAgain" />
              </button>
            )}
            <button type="button" onClick={remove} className={controlClass}>
              <FormattedMessage id="image.remove" />
            </button>
          </div>
        </div>
      );
    } else {
      picture = (
        <div className="grid gap-2">
          {upload.previewUrl ? (
            <img
              src={upload.previewUrl}
              alt=""
              className="max-h-96 w-full rounded-2xl object-contain opacity-60"
            />
          ) : (
            <p className="rounded-2xl bg-sunken p-5 font-sans text-base font-medium text-ink [overflow-wrap:anywhere]">
              {upload.name}
            </p>
          )}
          <progress
            className="h-2 w-full accent-brand"
            max={1}
            value={upload.progress}
            aria-label={intl.formatMessage({ id: "media.uploadingName" }, { name: upload.name })}
          />
        </div>
      );
    }
  } else if (!item) {
    picture = lookup.isPending ? (
      <div className="tend-picture aspect-[3/2] w-full animate-pulse bg-ink/10 motion-reduce:animate-none" />
    ) : (
      <Notice onRemove={editable ? remove : undefined}>
        <FormattedMessage id={lookup.isError ? "image.cantLoad" : "image.deleted"} />
      </Notice>
    );
  } else if (item.trashedAt !== null) {
    picture = (
      <Notice onRemove={editable ? remove : undefined}>
        <FormattedMessage id="image.inTrash" values={{ name: item.name }} />
      </Notice>
    );
  } else {
    const described = item.decorative || Boolean(item.alt);
    picture = (
      <>
        <img
          src={item.previewUrl ?? undefined}
          srcSet={item.srcset}
          sizes="(min-width: 48rem) 44rem, 100vw"
          alt={item.decorative ? "" : (item.alt ?? "")}
          width={item.width ?? undefined}
          height={item.height ?? undefined}
          style={{ backgroundColor: item.dominantColor ?? undefined }}
          className="tend-picture h-auto w-full"
        />
        {editable && (
          // Over the picture while it's chosen, or pointed at, or has no description yet.
          <div className="tend-over" data-always={described ? undefined : ""}>
            {!nested && (
              <fieldset className="flex">
                <legend className="sr-only">{intl.formatMessage({ id: "image.size" })}</legend>
                {SIZES.map(([option, name]) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={size === option}
                    onClick={() => updateAttributes({ size: option })}
                    className={overClass}
                  >
                    <FormattedMessage id={name} />
                  </button>
                ))}
              </fieldset>
            )}
            <button type="button" onClick={() => options.onDescribe(item.id)} className={overClass}>
              <FormattedMessage id={described ? "image.editDescription" : "image.addDescription"} />
            </button>
            <button
              type="button"
              onClick={() => options.onPick((picked) => updateAttributes({ mediaId: picked }))}
              className={overClass}
            >
              <FormattedMessage id="image.change" />
            </button>
            <MoveButtons
              editor={editor}
              getPos={getPos}
              labels={{
                up: intl.formatMessage({ id: "image.moveUp" }),
                down: intl.formatMessage({ id: "image.moveDown" }),
              }}
              className={overClass}
            />
            <button type="button" onClick={remove} className={overClass}>
              <FormattedMessage id="image.remove" />
            </button>
          </div>
        )}
        {editable && !described && (
          <span className="tend-undescribed">
            <FormattedMessage id="image.noDescription" />
          </span>
        )}
      </>
    );
  }

  return (
    <NodeViewWrapper
      data-image-view=""
      data-size={nested ? "normal" : size}
      data-chosen={selected ? "" : undefined}
      className="tend-image"
    >
      <div contentEditable={false}>
        <div className="tend-image-frame">{picture}</div>
        {mediaId &&
          (editable ? (
            <input
              value={caption ?? ""}
              onChange={(event) => updateAttributes({ caption: event.target.value })}
              placeholder={intl.formatMessage({ id: "image.captionPlaceholder" })}
              aria-label={intl.formatMessage({ id: "image.caption" })}
              className="tend-caption"
            />
          ) : (
            caption && <p className="tend-caption">{caption}</p>
          ))}
      </div>
    </NodeViewWrapper>
  );
}

/**
 * A picture from Media. Only its ID is stored, so a new description or a replaced photo
 * shows wherever it's used. While a dropped or pasted one uploads, it holds the upload's
 * name instead, and is left out of what's saved until it arrives.
 */
export const ImageNode = Node.create<ImageOptions>({
  name: "image",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { onDescribe: () => {}, onPick: () => {}, onUploaded: () => {} };
  },

  addAttributes() {
    return {
      mediaId: { default: null },
      alt: { default: null },
      decorative: { default: false },
      caption: { default: null },
      size: { default: "normal" },
      uploadId: { default: null, rendered: false },
    };
  },

  // Only Tend's own copies: a picture pasted from somewhere else isn't in Media, so there's
  // nothing for it to point at. The paste notice says how to add it instead.
  parseHTML() {
    return [
      {
        tag: "figure[data-tend-image]",
        getAttrs: (element) => ({
          mediaId: element.getAttribute("data-media-id"),
          caption: element.getAttribute("data-caption"),
          size: element.getAttribute("data-size") ?? "normal",
        }),
      },
    ];
  },

  renderHTML({ node }) {
    const attrs = node.attrs as { mediaId: string | null; caption: string | null; size: string };
    return [
      "figure",
      mergeAttributes({
        "data-tend-image": "",
        "data-media-id": attrs.mediaId ?? "",
        "data-size": attrs.size,
        ...(attrs.caption ? { "data-caption": attrs.caption } : {}),
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});
