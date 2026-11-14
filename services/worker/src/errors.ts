/** A failure that retrying cannot fix: the job goes straight to dead (or is turned into a recorded outcome by its handler). */
export class PermanentError extends Error {
  constructor(message: string, readonly code = "permanent") {
    super(message);
    this.name = "PermanentError";
  }
}

/** A failure of an external service that is worth retrying with backoff. */
export class TransientError extends Error {
  constructor(message: string, readonly code = "transient", readonly retryAfterMs?: number) {
    super(message);
    this.name = "TransientError";
  }
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
