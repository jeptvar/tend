import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { api } from "./api.ts";
import type { LinkTarget } from "./queries.ts";

const FRESH_MS = 10_000;

/**
 * The pages and posts a link can go to: the ones with these words, or the latest for none. Both
 * the editor and the site menu look for them here, because an answer that's kept under one name
 * has to be one shape.
 */
export function linkTargets(words: string) {
  return queryOptions({
    queryKey: ["link-targets", words],
    queryFn: () =>
      api<{ targets: LinkTarget[] }>(`/admin/link-targets?q=${encodeURIComponent(words)}`).then(
        (reply) => reply.targets,
      ),
    staleTime: FRESH_MS,
    // What was found stays until the next is, so nothing goes from under a finger.
    placeholderData: keepPreviousData,
  });
}
