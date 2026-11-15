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
import { forgetUpload, retryUpload, useUpload } from "./uploads.ts";

/** Marks the editor's own changes for uploads, so they don't count as someone typing. */
export const UPLOAD_META = "tendUpload";

const controlClass =
  "min-h-11 min-w-11 rounded border border-muted bg-paper px-2 text-sm focus-visible:outline-3 focus-visible:outline-brand";

export interface ImageOptions {
  /** Opens the description dialog for a picture. */
  onDescribe: (mediaId: string) => void;
  /** A dropped, pasted or picked file has arrived and taken its placeholder's place. */
  onUploaded: (item: MediaItem, startedAt: number) => void;
}

function Notice({ children, onRemove }: { children: React.ReactNode; onRemove?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-danger p-3">
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
        <div className="grid gap-2 rounded-lg border border-dashed border-danger p-3">
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
              className="max-h-96 w-full rounded-lg object-contain opacity-60"
            />
          ) : (
            <p className="rounded-lg bg-ink/5 p-4 font-medium [overflow-wrap:anywhere]">
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
      <div className="aspect-[3/2] w-full animate-pulse rounded-lg bg-ink/10" />
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
      <div className="grid gap-2">
        <img
          src={item.previewUrl ?? undefined}
          srcSet={item.srcset}
          sizes="(min-width: 48rem) 44rem, 100vw"
          alt={item.decorative ? "" : (item.alt ?? "")}
          width={item.width ?? undefined}
          height={item.height ?? undefined}
          style={{ backgroundColor: item.dominantColor ?? undefined }}
          className={`h-auto w-full rounded-lg ${size === "normal" || nested ? "" : "ring-2 ring-brand/30"}`}
        />
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => options.onDescribe(item.id)}
              className={controlClass}
            >
              <FormattedMessage id={described ? "image.editDescription" : "image.addDescription"} />
            </button>
            {!described && (
              <span className="text-sm text-danger">
                <FormattedMessage id="image.noDescription" />
              </span>
            )}
            {!nested && (
              <label className="flex items-center gap-1 text-sm">
                <FormattedMessage id="image.size" />
                <select
                  className={controlClass}
                  value={size}
                  onChange={(event) => updateAttributes({ size: event.target.value })}
                >
                  <option value="normal">{intl.formatMessage({ id: "image.sizeNormal" })}</option>
                  <option value="wide">{intl.formatMessage({ id: "image.sizeWide" })}</option>
                  <option value="full">{intl.formatMessage({ id: "image.sizeFull" })}</option>
                </select>
              </label>
            )}
            <button type="button" onClick={remove} className={`${controlClass} ms-auto`}>
              <FormattedMessage id="image.remove" />
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <NodeViewWrapper
      data-image-view=""
      className={`my-4 rounded-lg ${selected ? "outline-3 outline-offset-4 outline-brand" : ""}`}
    >
      <div contentEditable={false} className="grid gap-2">
        {picture}
        {mediaId &&
          (editable ? (
            <input
              value={caption ?? ""}
              onChange={(event) => updateAttributes({ caption: event.target.value })}
              placeholder={intl.formatMessage({ id: "image.captionPlaceholder" })}
              aria-label={intl.formatMessage({ id: "image.caption" })}
              className="min-h-11 w-full rounded border border-transparent bg-transparent px-2 text-center text-base text-muted hover:border-muted focus-visible:border-muted focus-visible:outline-3 focus-visible:outline-brand"
            />
          ) : (
            caption && <p className="text-center text-muted">{caption}</p>
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
    return { onDescribe: () => {}, onUploaded: () => {} };
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
