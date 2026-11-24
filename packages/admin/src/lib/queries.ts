import { type InfiniteData, type QueryClient, useQuery } from "@tanstack/react-query";
import { ApiError, api } from "./api.ts";
import type { Doc } from "./doc.ts";

export interface SetupStatus {
  needsSetup: boolean;
  codeKind: "code" | "password";
}

export interface Me {
  user: { id: string; name: string; email: string; role: string; isOwner: boolean };
  site: {
    name: string;
    tagline: string;
    /** The site's own address, or null while it follows the one each page is asked for. */
    address: string | null;
    /** Who says so: where Tend runs, an Admin, or the hosting platform. */
    addressFrom: "set" | "confirmed" | "platform" | null;
    /** Whether people anywhere could reach it there. */
    addressIsPublic: boolean;
    visibility: "public" | "coming_soon" | "private";
  };
  starter: "blog" | "business" | "blank" | null;
  /** Where Tend runs. */
  platform: "railway" | "render" | "fly" | "docker" | "local";
  /** For Admins: why this site could be lost with its container, if it could. */
  dataRisk: {
    why: "unmounted" | "unnamed";
    path: string;
    platform: "railway" | "render" | "fly" | "docker" | "local";
  } | null;
}

export type EntryType = "post" | "page";

export interface EntrySummary {
  id: string;
  type: EntryType;
  status: "draft" | "scheduled" | "published";
  title: string;
  slug: string;
  isHome: boolean;
  isExample: boolean;
  dirty: boolean;
  rev: number;
  /** Where visitors can see it right now, if they can. */
  url: string | null;
  firstPublishedAt: number | null;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
}

export interface EntryFull extends EntrySummary {
  data: {
    doc: Doc;
    summary: string | null;
    featuredImage?: { mediaId: string; alt: string | null } | null;
    seo?: {
      title: string | null;
      description: string | null;
      imageId: string | null;
      noindex: boolean;
    };
    tagIds?: string[];
  };
  /** Who saved it last, so a conflict can say who changed it. */
  updatedBy: { id: string; name: string | null } | null;
  /** What the address would be if this were published now. */
  address: { path: string; problem: { message: string; fix: string | null } | null };
  /** Whether the site menu links to it, for "Show in site menu". */
  menu?: { automatic: boolean; inMenu: boolean; size: number };
}

export interface LinkTarget {
  id: string;
  type: EntryType;
  title: string;
  /** Where visitors reach it. Null when it isn't on the site right now. */
  url: string | null;
}

export type RevisionKind =
  | "autosave"
  | "publish"
  | "restore"
  | "before_discard"
  | "conflict"
  | "import";

export interface RevisionSummary {
  id: string;
  kind: RevisionKind;
  title: string;
  authorName: string | null;
  createdAt: number;
  isLive: boolean;
}

export interface RevisionDetail {
  id: string;
  kind: RevisionKind;
  title: string;
  createdAt: number;
  previewHtml: string;
}

export const SETUP_STATUS_KEY = ["setup-status"];
export const ME_KEY = ["me"];

/** The parts of a list of posts or pages, each with its own tab. */
export const ENTRY_VIEWS = ["all", "drafts", "published", "trash"] as const;
export type EntryView = (typeof ENTRY_VIEWS)[number];

/** Every list of one kind, whichever part of it and whatever was searched for. */
export function entriesKey(type: EntryType) {
  return ["entries", type];
}

export function entryListKey(type: EntryType, view: EntryView, search: string) {
  return [...entriesKey(type), view, search];
}

export interface EntryPage {
  entries: EntrySummary[];
  nextCursor: string | null;
  counts: Record<EntryView, number>;
}

export function entryKey(id: string) {
  return ["entry", id];
}

export function useSetupStatus() {
  return useQuery({
    queryKey: SETUP_STATUS_KEY,
    queryFn: () => api<SetupStatus>("/auth/setup/status"),
  });
}

async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>("/auth/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/** The signed-in person, or null when nobody is. */
export function useMe() {
  return useQuery({ queryKey: ME_KEY, queryFn: fetchMe });
}

/**
 * Checks that a sign-in actually stuck. A browser that refuses the cookie would
 * otherwise land back on an empty sign-in form with no hint why.
 */
export async function confirmSignedIn(
  queryClient: QueryClient,
  refusedText: string,
): Promise<void> {
  const me = await fetchMe();
  if (!me) throw new ApiError(0, "cookie_refused", refusedText);
  queryClient.setQueryData(ME_KEY, me);
}

/** Takes a row out of the list straight away, ahead of the list being fetched again. */
export function withoutEntry(
  data: InfiniteData<EntryPage> | undefined,
  id: string,
): InfiniteData<EntryPage> | undefined {
  return (
    data && {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        entries: page.entries.filter((row) => row.id !== id),
      })),
    }
  );
}
