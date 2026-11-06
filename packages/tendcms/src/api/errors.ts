const ERROR_DOCS = "https://tendcms.dev/errors";

export interface ApiErrorDetails {
  field?: string;
  fix?: string;
  retryAfterSeconds?: number;
}

/** A failure the admin can show as it is. Every error has the same shape (PLAN.md §9). */
export class ApiError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500;
  readonly code: string;
  readonly details: ApiErrorDetails;

  constructor(
    status: ApiError["status"],
    code: string,
    message: string,
    details: ApiErrorDetails = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details.field ? { field: this.details.field } : {}),
        ...(this.details.fix ? { fix: this.details.fix } : {}),
        docs: `${ERROR_DOCS}/${this.code}`,
      },
    };
  }
}

const BUSY_RETRY_SECONDS = 5;

export function tendIsBusy(): ApiError {
  return new ApiError(429, "busy", "Tend is busy right now. Try again in a few seconds.", {
    retryAfterSeconds: BUSY_RETRY_SECONDS,
  });
}

export function tooManyTries(retryAfterSeconds: number): ApiError {
  const wait =
    retryAfterSeconds < 90
      ? `${retryAfterSeconds} ${retryAfterSeconds === 1 ? "second" : "seconds"}`
      : `${Math.ceil(retryAfterSeconds / 60)} minutes`;
  return new ApiError(429, "too_many_tries", `Too many tries. Try again in ${wait}.`, {
    retryAfterSeconds,
  });
}
