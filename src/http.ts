// Small fetch helper: timeout, retry with backoff on 429 / 5xx / network errors.

import { get as httpsGet } from "node:https";

const USER_AGENT = "funnel-data-layer/1.0 (node)";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  /** Base backoff; doubles per attempt. A Retry-After header wins if larger. */
  backoffMs?: number;
  label?: string;
  /** "https" = node:https instead of fetch, for servers with very slow TLS handshakes. */
  transport?: "fetch" | "https";
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface RawResponse { status: number; retryAfter: number; text: string }

async function viaFetch(url: string, timeoutMs: number): Promise<RawResponse> {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, retryAfter: Number(res.headers.get("retry-after")) || 0, text: await res.text() };
}

/**
 * Plain node:https GET. Used for GDELT, whose TLS handshake regularly takes 10+ seconds:
 * Node's built-in fetch gives up connecting after 10s (UND_ERR_CONNECT_TIMEOUT) and that limit
 * cannot be changed without an extra dependency. Here the only limit is the overall timeout.
 */
function viaHttps(url: string, timeoutMs: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        clearTimeout(timer);
        resolve({
          status: res.statusCode ?? 0,
          retryAfter: Number(res.headers["retry-after"]) || 0,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const { timeoutMs = 60_000, retries = 3, backoffMs = 2_000, label = new URL(url).hostname } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await (opts.transport === "https" ? viaHttps : viaFetch)(url, timeoutMs);
      if (res.status >= 200 && res.status < 300) return res.text;
      const retryable = res.status === 429 || res.status >= 500;
      lastErr = new HttpError(res.status, `${label}: HTTP ${res.status}`);
      if (!retryable) throw lastErr;
      const retryAfter = res.retryAfter * 1000;
      if (attempt < retries) {
        const wait = Math.max(retryAfter, backoffMs * 2 ** attempt);
        console.warn(`[http] ${label}: HTTP ${res.status}, retry ${attempt + 1}/${retries} in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    } catch (err) {
      if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err;
      lastErr = err;
      if (!(err instanceof HttpError) && attempt < retries) {
        const wait = backoffMs * 2 ** attempt;
        console.warn(`[http] ${label}: ${(err as Error).message}, retry ${attempt + 1}/${retries} in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${opts.label ?? new URL(url).hostname}: response was not JSON (${text.slice(0, 80).replace(/\s+/g, " ")}…)`);
  }
}
