import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";

interface SiteStyleReply {
  css: string;
  accent: string | null;
  accentDark: string | null;
}

export const SITE_STYLE_KEY = ["site-style"];
const KEEP_MS = 5 * 60_000;

/**
 * The site's own fonts and colour, so what's written looks as it will there (index.css has where
 * each is used). Without them, as when there's no connection, it's in the admin's.
 */
export function SiteStyle() {
  const style = useQuery({
    queryKey: SITE_STYLE_KEY,
    queryFn: () => api<SiteStyleReply>("/admin/design/style"),
    staleTime: KEEP_MS,
    retry: false,
  });
  if (!style.data) return null;
  const { css, accent, accentDark } = style.data;
  const colors = [
    accent && `--tend-site-accent: ${accent};`,
    accentDark && `--tend-site-accent-dark: ${accentDark};`,
  ];
  return <style>{`${css}\n:root { ${colors.filter(Boolean).join(" ")} }`}</style>;
}
