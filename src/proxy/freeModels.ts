/**
 * Free-model registry for OCFreeRelay.
 *
 * Determines which upstream models are "free" from the official OpenCode Zen
 * free-model view and keeps every model in that view. The HTTP layer serves
 * ONLY these models (both /v1/models and /v1/chat/completions) so no paid model
 * is ever exposed to clients — that is the point of this project.
 *
 * Resilience:
 *  - The parsed result is cached to data/free-models.json (last success).
 *  - On refresh failure we keep the previous set (disk / memory), and before
 *    any successful scrape we use a static baseline of the currently-known
 *    free model ids so a fresh boot is not empty and no paid model leaks.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const ZEN_PRICING_URL =
  process.env.OCFREERELAY_PRICING_URL || "https://opencode.ai/docs/zen";
/** Public-source refresh is opt-in because authenticated Zen can show more free models. */
export const AUTO_REFRESH_FREE_MODELS = process.env.OCFREERELAY_AUTO_REFRESH_FREE_MODELS === "true";

/**
 * Baseline free-model ids (snapshot of the authenticated Zen free-model view).
 * Used as the starting set / last-resort fallback; refreshed only by an explicitly
 * configured source that has been reconciled with the authenticated view.
 */
export const KNOWN_FREE_MODELS: string[] = [
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "hy3-free",
  "laguna-s-2.1-free",
  "muse-spark-1.2",
  "muse-spark-1.2-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "x-preview-f-free",
];

/** Display names whose official model ids are not derivable by normalization. */
const MODEL_ID_ALIASES: Record<string, string> = {
  "ox-alpha-free": "x-preview-f-free",
};

/** "DeepSeek V4 Flash Free" -> "deepseek-v4-flash-free" (lowercase, dash-separated). */
export function normalizeModelName(name: string): string {
  const normalized = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return MODEL_ID_ALIASES[normalized] ?? normalized;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x3C;/g, "<")
    .replace(/&#x26;/g, "&")
    .trim();
}

/**
 * Parse free model ids from the configured official HTML source.
 * Pure + unit-testable: finds the table whose header includes Model + Cached
 * Write, then keeps rows whose Input & Output columns are "Free".
 */
export function parseFreeModelIds(html: string): string[] {
  const found = new Set<string>();
  const tableRe = /<table>([\s\S]*?)<\/table>/gi;
  for (const m of html.matchAll(tableRe)) {
    const table = m[1];
    if (!/<th[^>]*>\s*Model\s*<\/th>/i.test(table)) continue;
    if (!/<th[^>]*>\s*Cached\s*Write\s*<\/th>/i.test(table)) continue;
    const rows = table.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    for (const tr of rows) {
      const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
      if (!tds || tds.length < 3) continue;
      const cells = tds.map(stripTags);
      const name = cells[0];
      if (!name) continue;
      if (/^free$/i.test(cells[1]) && /^free$/i.test(cells[2])) {
        found.add(normalizeModelName(name));
      }
    }
  }
  return [...found];
}

export type FreeModelStatus = {
  count: number;
  ids: string[];
  lastFetchedAt: string | null;
  lastError: string | null;
  usingBaseline: boolean;
};

function defaultCachePath(): string {
  const settingsPath = process.env.OCFREERELAY_SETTINGS_PATH;
  const base = settingsPath ? dirname(settingsPath) : resolve(process.cwd(), "data");
  return resolve(base, "free-models.json");
}

export class FreeModelRegistry {
  private _ids = new Set<string>();
  private lastFetchedAt: string | null = null;
  private lastError: string | null = null;
  private cachePath: string;

  constructor(opts?: { defaultIds?: string[]; cachePath?: string }) {
    this._ids = new Set(opts?.defaultIds ?? KNOWN_FREE_MODELS);
    this.cachePath = opts?.cachePath ?? defaultCachePath();
  }

  /** True when the model (bare id, e.g. "big-pickle") is in the free set. */
  has(id: string | undefined | null): boolean {
    if (!id) return false;
    if (this._ids.has(id)) return true;
    const norm = normalizeModelName(id);
    return this._ids.has(norm);
  }

  ids(): string[] {
    return [...this._ids].sort();
  }

  count(): number {
    return this._ids.size;
  }

  status(): FreeModelStatus {
    return {
      count: this._ids.size,
      ids: this.ids(),
      lastFetchedAt: this.lastFetchedAt,
      lastError: this.lastError,
      usingBaseline: this.lastFetchedAt === null,
    };
  }

  /** Restore the last successful scrape from disk (so a restart keeps it). */
  async loadCache(): Promise<void> {
    try {
      const text = await readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(text) as { fetchedAt?: string; ids?: unknown };
      const ids = Array.isArray(parsed.ids)
        ? parsed.ids.filter((x): x is string => typeof x === "string")
        : [];
      if (ids.length) {
        this._ids = new Set(ids);
        this.lastFetchedAt = typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : null;
        this.lastError = null;
      }
    } catch {
      /* no cache yet — keep baseline */
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true });
    await writeFile(
      this.cachePath,
      JSON.stringify(
        { fetchedAt: this.lastFetchedAt, ids: this.ids() },
        null,
        2
      ),
      "utf8"
    );
  }

  /** Refresh from the configured official source; preserve the baseline on failure. */
  async refresh(fetchImpl?: typeof fetch): Promise<FreeModelStatus> {
    const fetcher = fetchImpl ?? globalThis.fetch;
    try {
      const res = await fetcher(ZEN_PRICING_URL, {
        headers: { "User-Agent": "oc-free-relay/1.0 (+https://github.com)" },
      });
      if (!res.ok) throw new Error(`pricing page HTTP ${res.status}`);
      const parsed = parseFreeModelIds(await res.text());
      if (parsed.length === 0) {
        throw new Error("pricing page parsed 0 free models");
      }
      this._ids = new Set(parsed);
      this.lastFetchedAt = new Date().toISOString();
      this.lastError = null;
      await this.persist();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      // keep previous set
    }
    return this.status();
  }
}
