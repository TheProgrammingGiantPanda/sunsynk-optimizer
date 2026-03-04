/**
 * Retries an async operation with exponential backoff.
 * Never retries HTTP 4xx responses — those indicate configuration errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { retries?: number; baseDelayMs?: number; label?: string } = {}
): Promise<T> {
  const { retries = 3, baseDelayMs = 1000, label = 'request' } = options;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status: number | undefined = err?.response?.status;
      if (status !== undefined && status >= 400 && status < 500) throw err;
      if (attempt <= retries) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        console.warn(
          `[retry] ${label} failed (attempt ${attempt}/${retries + 1}), retrying in ${delay}ms: ${err?.message ?? err}`
        );
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
