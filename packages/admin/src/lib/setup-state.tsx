import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiError, api } from "./api.ts";
import { SETUP_STATUS_KEY, useSetupStatus } from "./queries.ts";
import { forgetSetupCode, readSetupCode, storeSetupCode } from "./setup-code.ts";

export type CodeState = "none" | "checking" | "ok";
export type Starter = "blog" | "business" | "blank";

export interface SiteDraft {
  name: string;
  tagline: string;
}

export interface OwnerDraft {
  name: string;
  email: string;
  password: string;
}

export interface FieldError {
  field: string;
  message: string;
}

interface SetupContextValue {
  code: string | null;
  codeState: CodeState;
  /** Why the code couldn't be used, in the server's words. */
  codeError: unknown;
  submitCode: (code: string) => Promise<void>;
  rejectCode: (error: unknown) => void;
  site: SiteDraft;
  setSite: (site: SiteDraft) => void;
  owner: OwnerDraft;
  setOwner: (owner: OwnerDraft) => void;
  starter: Starter;
  setStarter: (starter: Starter) => void;
  /** A problem the server found at the last step, shown on the step it belongs to. */
  fieldError: FieldError | null;
  setFieldError: (error: FieldError | null) => void;
  /** Set when someone else finished setup first, so sign-in can explain what happened. */
  closedElsewhere: boolean;
  setClosedElsewhere: (closed: boolean) => void;
  /** Set when setup ended with a backup restored, so sign-in can say the site is back. */
  restored: Restored | null;
  setRestored: (restored: Restored) => void;
}

/**
 * A site brought back from a backup, by name if Tend said which. From Settings → Backups, it
 * also says when what was restored had been saved.
 */
export interface Restored {
  site: string | null;
  savedAt?: string | undefined;
}

const SetupContext = createContext<SetupContextValue | null>(null);

const EMPTY_SITE: SiteDraft = { name: "", tagline: "" };
const EMPTY_OWNER: OwnerDraft = { name: "", email: "", password: "" };
const DEFAULT_STARTER: Starter = "blog";

// Answers that mean the code itself is no good. Anything else (Tend restarting, too
// many tries) says nothing about the code, so it's kept for the next try.
const CODE_REJECTIONS = new Set(["setup_code_wrong", "needs_fixing", "setup_closed"]);

/** What's been typed across the setup steps. It's kept in memory only, never stored. */
export function SetupProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const status = useSetupStatus();
  const [code, setCode] = useState(readSetupCode);
  const [codeState, setCodeState] = useState<CodeState>(code ? "checking" : "none");
  const [codeError, setCodeError] = useState<unknown>(null);
  const [site, setSite] = useState(EMPTY_SITE);
  const [owner, setOwner] = useState(EMPTY_OWNER);
  const [starter, setStarter] = useState(DEFAULT_STARTER);
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [closedElsewhere, setClosedElsewhere] = useState(false);
  const [restored, setRestored] = useState<Restored | null>(null);

  const rejectCode = useCallback((error: unknown) => {
    forgetSetupCode();
    setCode(null);
    setCodeState("none");
    setCodeError(error);
  }, []);

  const submitCode = useCallback(
    async (candidate: string) => {
      setCodeState("checking");
      setCodeError(null);
      try {
        await api("/auth/setup/check-code", { method: "POST", body: { code: candidate } });
        storeSetupCode(candidate);
        setCode(candidate);
        setCodeState("ok");
      } catch (error) {
        if (error instanceof ApiError && CODE_REJECTIONS.has(error.code)) {
          rejectCode(error);
        } else {
          setCode(candidate);
          setCodeState("none");
          setCodeError(error);
        }
        if (error instanceof ApiError && error.code === "setup_closed") {
          await queryClient.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
        }
      }
    },
    [queryClient, rejectCode],
  );

  // Once, for the code that came with the link. StrictMode runs effects twice, and a
  // wrong code shouldn't count as two guesses.
  const checkedLinkCode = useRef(false);
  useEffect(() => {
    if (checkedLinkCode.current) return;
    checkedLinkCode.current = true;
    if (code) void submitCode(code);
  }, [code, submitCode]);

  // However setup ended (here or in another tab), nothing typed should stay in memory,
  // above all the password. This also catches drafts saved as a step unmounts.
  const setupIsDone = status.data?.needsSetup === false;
  const hasDrafts = code !== null || site !== EMPTY_SITE || owner !== EMPTY_OWNER;
  useEffect(() => {
    if (!setupIsDone || !hasDrafts) return;
    forgetSetupCode();
    setCode(null);
    setCodeState("none");
    setCodeError(null);
    setSite(EMPTY_SITE);
    setOwner(EMPTY_OWNER);
    setStarter(DEFAULT_STARTER);
    setFieldError(null);
  }, [setupIsDone, hasDrafts]);

  const value = useMemo(
    () => ({
      code,
      codeState,
      codeError,
      submitCode,
      rejectCode,
      site,
      setSite,
      owner,
      setOwner,
      starter,
      setStarter,
      fieldError,
      setFieldError,
      closedElsewhere,
      setClosedElsewhere,
      restored,
      setRestored,
    }),
    [
      code,
      codeState,
      codeError,
      submitCode,
      rejectCode,
      site,
      owner,
      starter,
      fieldError,
      closedElsewhere,
      restored,
    ],
  );
  return <SetupContext.Provider value={value}>{children}</SetupContext.Provider>;
}

export function useSetup(): SetupContextValue {
  const value = useContext(SetupContext);
  if (!value) throw new Error("useSetup needs a SetupProvider");
  return value;
}
