/**
 * Rides out a short network drop (a Wi-Fi roam, a brief DNS or route loss) for a call to a model vendor.
 * Only a connection-level failure is retried: fetch rejected, so no response and no byte has reached anyone. Never after an abort or timeout
 * (the caller's signal), and never once a response exists. The waits stop early when the signal aborts, so the existing call timeout still bounds everything.
 */
export const BLIP_BACKOFF_MS: readonly number[] = [500, 1500, 4000];

/** What a failed fetch says about why, without headers, bodies or keys: the cause code and message only. */
export function causeOf(e: unknown): { err: string; code?: string; cause?: string } {
  const err = e instanceof Error ? e.message : String(e);
  const c = e instanceof Error ? (e as { cause?: unknown }).cause : undefined;
  const code = c && typeof c === "object" && typeof (c as { code?: unknown }).code === "string" ? (c as { code: string }).code : undefined;
  const cause = c instanceof Error ? c.message : typeof c === "string" ? c : undefined;
  return { err, ...(code ? { code } : {}), ...(cause ? { cause: cause.slice(0, 300) } : {}) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => { signal.removeEventListener("abort", done); resolve(); }, ms);
    const done = (): void => { clearTimeout(t); resolve(); };
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function fetchRiding(
  send: () => Promise<Response>,
  signal: AbortSignal,
  onRetry: (info: { attempt: number; waitMs: number; err: string; code?: string; cause?: string }) => void,
  backoff: readonly number[] = BLIP_BACKOFF_MS,
): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      return await send();
    } catch (e) {
      if (signal.aborted || i >= backoff.length) throw e;
      onRetry({ attempt: i + 1, waitMs: backoff[i]!, ...causeOf(e) });
      await sleep(backoff[i]!, signal);
      if (signal.aborted) throw e;
    }
  }
}
