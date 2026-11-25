import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";
import { runBeforeSignOut } from "./held-drafts.ts";
import { ME_KEY, SETUP_STATUS_KEY } from "./queries.ts";

/** Signs out here, or on every device. */
export function useSignOut(everywhere = false) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // Anything being edited is saved first. If that fails, this stops here and says so,
      // with the person still signed in and their text still on the screen.
      await runBeforeSignOut();
      await api(everywhere ? "/auth/logout-all" : "/auth/logout", { method: "POST" });
    },
    onSuccess: () => {
      // Lists and titles shouldn't still be here for whoever signs in next on this computer.
      queryClient.removeQueries({
        predicate: ({ queryKey }) =>
          queryKey[0] !== ME_KEY[0] && queryKey[0] !== SETUP_STATUS_KEY[0],
      });
      queryClient.setQueryData(ME_KEY, null);
    },
  });
}
