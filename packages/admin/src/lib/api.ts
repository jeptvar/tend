export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;
  readonly fix: string | undefined;
  /** On an edit conflict, the version someone else saved. */
  readonly current: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    field?: string,
    fix?: string,
    current?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
    this.fix = fix;
    this.current = current;
  }
}

// Long enough for a busy server, short enough that nobody is left at a spinner.
const REQUEST_TIMEOUT_MS = 20_000;

/** The code for "the server didn't answer", which the screens word themselves. */
export const OFFLINE = "offline";

function offline(): ApiError {
  return new ApiError(0, OFFLINE, "Can't reach Tend.");
}

export async function api<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(method === "GET"
        ? {}
        : {
            headers: { "Content-Type": "application/json", ...options.headers },
            body: JSON.stringify(options.body ?? {}),
          }),
    });
  } catch {
    throw offline();
  }

  if (response.status === 204) return undefined as T;
  let data: {
    error?: { code: string; message: string; field?: string; fix?: string };
    current?: unknown;
  } & T;
  try {
    data = await response.json();
  } catch {
    // A proxy's own error page: the dev server's, say, when Tend itself isn't running.
    throw offline();
  }
  if (!response.ok) {
    if (!data.error) throw offline();
    const { code, message, field, fix } = data.error;
    throw new ApiError(response.status, code, message, field, fix, data.current);
  }
  return data;
}

/** What to show a person: what happened, then what to do about it. */
export function errorText(error: unknown, offlineText: string): string {
  if (error instanceof ApiError && error.code !== OFFLINE) {
    return error.fix ? `${error.message} ${error.fix}` : error.message;
  }
  return offlineText;
}
