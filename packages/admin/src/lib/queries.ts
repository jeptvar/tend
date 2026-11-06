import { type QueryClient, useQuery } from "@tanstack/react-query";
import { ApiError, api } from "./api.ts";
import type { Doc } from "./doc.ts";

export interface SetupStatus {
  needsSetup: boolean;
  codeKind: "code" | "password";
}

export interface Me {
  user: { id: string; name: string; email: string; role: string; isOwner: boolean };
  site: { name: string; tagline: string };
  starter: "blog" | "business" | "blank" | null;
  siteIsPublic: boolean;
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
  data: { doc: Doc };
}

export const SETUP_STATUS_KEY = ["setup-status"];
export const ME_KEY = ["me"];

export function entriesKey(type: EntryType, trashed: boolean) {
  return ["entries", type, trashed ? "trash" : "all"];
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
