import { type IframeHTMLAttributes, useEffect, useRef } from "react";

interface PageFrameProps
  extends Omit<IframeHTMLAttributes<HTMLIFrameElement>, "onLoad" | "sandbox" | "src" | "srcDoc"> {
  html: string;
  title: string;
  /** Once the page is there. */
  onReady?: () => void;
}

/**
 * A page from the site, in a frame that's allowed nothing: no scripts, no forms, no opening
 * anything, and no way to the admin it's in.
 *
 * The page goes in once the frame has a size. Safari picks which size of a picture to use as it
 * starts on the page, and in a frame that has none yet that's the smallest, which it then keeps.
 */
export function PageFrame({ html, title, onReady, ...frame }: PageFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const watcher = new ResizeObserver(() => {
      if (element.clientWidth === 0) return;
      watcher.disconnect();
      element.srcdoc = html;
    });
    watcher.observe(element);
    return () => watcher.disconnect();
  }, [html]);
  return (
    <iframe
      ref={ref}
      sandbox=""
      title={title}
      // An empty one says that it has loaded, too.
      onLoad={() => {
        if (ref.current?.srcdoc) onReady?.();
      }}
      {...frame}
    />
  );
}
