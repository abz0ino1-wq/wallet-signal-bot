import { logger } from "./logger";

export async function fetchJson<T>(
  url: string,
  opts: { timeoutMs?: number; retries?: number; headers?: Record<string, string> } = {}
): Promise<T> {
  const { timeoutMs = 10_000, retries = 2, headers } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const backoffMs = 500 * 2 ** attempt;
        logger.warn(`fetchJson retry ${attempt + 1}/${retries} for ${url}: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
