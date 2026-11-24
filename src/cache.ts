// JSON-file cache under ./cache plus per-source health. No database.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REFRESH_MS, type SourceId } from "./constants.ts";

export const CACHE_DIR =
  process.env.CACHE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "cache");

const memory = new Map<string, unknown>();

function pathFor(name: string): string {
  return join(CACHE_DIR, `${name}.json`);
}

/** Read a cache file. Falls back to the last good in-memory copy; returns null if never cached. */
export function readCache<T>(name: string): T | null {
  try {
    const value = JSON.parse(readFileSync(pathFor(name), "utf8")) as T;
    memory.set(name, value);
    return value;
  } catch {
    return (memory.get(name) as T | undefined) ?? null;
  }
}

/** Atomic write (temp file + rename) so a crash mid-write never corrupts the last good cache. */
export function writeCache(name: string, value: unknown): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${pathFor(name)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, pathFor(name));
  memory.set(name, value);
}

// ---------------------------------------------------------------- health

export interface SourceHealth {
  lastAttempt: string | null;
  lastSuccess: string | null;
  lastError: { at: string; message: string } | null;
  lastSummary: string | null;
}

type HealthFile = Record<SourceId, SourceHealth>;

const EMPTY: SourceHealth = { lastAttempt: null, lastSuccess: null, lastError: null, lastSummary: null };

export function readHealth(): HealthFile {
  const h = readCache<Partial<HealthFile>>("health") ?? {};
  return {
    sdg: { ...EMPTY, ...h.sdg },
    doj: { ...EMPTY, ...h.doj },
    gdelt: { ...EMPTY, ...h.gdelt },
  };
}

export function recordSuccess(source: SourceId, summary: string): void {
  const h = readHealth();
  const now = new Date().toISOString();
  h[source] = { ...h[source], lastAttempt: now, lastSuccess: now, lastSummary: summary };
  writeCache("health", h);
}

export function recordError(source: SourceId, err: unknown): void {
  const h = readHealth();
  const now = new Date().toISOString();
  const message = err instanceof Error ? err.message : String(err);
  h[source] = { ...h[source], lastAttempt: now, lastError: { at: now, message } };
  writeCache("health", h);
}

/**
 * A source is stale when it has never succeeded, when its latest attempt failed,
 * or when its last success is older than twice its refresh interval.
 */
export function isStale(source: SourceId, health = readHealth()): boolean {
  const h = health[source];
  if (!h.lastSuccess) return true;
  if (h.lastError && h.lastError.at > h.lastSuccess) return true;
  return Date.now() - Date.parse(h.lastSuccess) > 2 * REFRESH_MS[source];
}
