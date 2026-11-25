/**
 * An error whose message was written for the person using Relay and is safe to show them
 * (for example "That model isn't included in ClinePass"). Anything else stays in the local log.
 */
export class PublicError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "PublicError";
  }
}

/** A short description of an error for chat replies and logs, without stack traces. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error";
}
