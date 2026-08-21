/**
 * Unit tests for the free-model scraper + registry.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FreeModelRegistry,
  KNOWN_FREE_MODELS,
  normalizeModelName,
  parseFreeModelIds,
} from "../src/proxy/freeModels.js";

const PRICING_HTML = `<html><body>
<h2>Pricing</h2>
<p>prices per 1M tokens</p>
<table><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th></tr></thead><tbody>
<tr><td>Big Pickle</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
<tr><td>Ox Alpha Free</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
<tr><td>MiMo-V2.5 Free</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
<tr><td>Hy3 Free</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
<tr><td>Nemotron 3 Ultra Free</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
<tr><td>Nemotron 3.5 Lightning Free</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
<tr><td>Muse Spark 1.2 Contributor Free</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
<tr><td>MiniMax M3</td><td>$0.30</td><td>$1.20</td><td>$0.06</td><td>-</td></tr>
<tr><td>Claude Opus 4.5</td><td>$5.00</td><td>$25.00</td><td>$0.50</td><td>$6.25</td></tr>
</tbody></table>
<table><thead><tr><th>Model</th><th>Model ID</th></tr></thead><tbody>
<tr><td>Big Pickle</td><td>big-pickle</td></tr>
</tbody></table>
</body></html>`;
describe("parseFreeModelIds", () => {
  it("extracts only rows whose Input & Output are Free", () => {
    const ids = parseFreeModelIds(PRICING_HTML);
    expect(ids.sort()).toEqual([
      "big-pickle",
      "hy3-free",
      "mimo-v2.5-free",
      "muse-spark-1.2-contributor-free",
      "nemotron-3-ultra-free",
      "nemotron-3.5-lightning-free",
      "x-preview-f-free",
    ]);

  it("ignores non-pricing tables (no Cached Write header)", () => {
    const html = `<table><thead><tr><th>Model</th><th>Model ID</th></tr></thead>
      <tbody><tr><td>Big Pickle</td><td>big-pickle</td></tr></tbody></table>`;
    expect(parseFreeModelIds(html)).toEqual([]);
  });

  it("normalizes display names to model ids", () => {
    expect(normalizeModelName("Ox Alpha Free")).toBe("x-preview-f-free");
    expect(normalizeModelName(" MiMo-V2.5 Free ")).toBe("mimo-v2.5-free");
    expect(normalizeModelName("Nemotron 3 Ultra Free")).toBe("nemotron-3-ultra-free");
    expect(normalizeModelName("Nemotron 3.5 Lightning Free")).toBe("nemotron-3.5-lightning-free");
    expect(normalizeModelName("Muse Spark 1.2 Contributor Free")).toBe("muse-spark-1.2-contributor-free");
});

describe("FreeModelRegistry", () => {
  it("uses the known-free baseline by default and rejects paid ids", () => {
    const reg = new FreeModelRegistry();
    expect(reg.has("big-pickle")).toBe(true);
    expect(reg.has("x-preview-f-free")).toBe(true);
    expect(reg.has("gpt-5.5-pro")).toBe(false);
    expect(reg.has("claude-opus-5")).toBe(false);
    expect(reg.has("")).toBe(false);
    expect(reg.has(undefined)).toBe(false);
  });

  it("accepts a custom seed and an opencode/ prefix is stripped by caller", () => {
    const reg = new FreeModelRegistry({ defaultIds: ["hy3-free"] });
    expect(reg.has("hy3-free")).toBe(true);
    expect(reg.has("gpt-5.5-pro")).toBe(false);
    expect(KNOWN_FREE_MODELS.length).toBeGreaterThan(0);
  });

  it("refresh scrapes, persists cache, and falls back on failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocfr-fm-"));
    try {
      const reg = new FreeModelRegistry({ cachePath: join(dir, "free-models.json") });

      // Successful scrape
      let status = await reg.refresh(async () => new Response(PRICING_HTML, { status: 200 }));
      expect(status.count).toBe(7);
      expect(status.lastError).toBeNull();
      expect(status.usingBaseline).toBe(false);
      expect(reg.has("big-pickle")).toBe(true);
      expect(reg.has("minimax-m3")).toBe(false);

      // Cache file written
      const cached = JSON.parse(await readFile(join(dir, "free-models.json"), "utf8")) as {
        ids: string[];
      };
      expect(cached.ids).toContain("big-pickle");

      // New registry restores from cache
      const restored = new FreeModelRegistry({ cachePath: join(dir, "free-models.json") });
      await restored.loadCache();
      expect(restored.has("big-pickle")).toBe(true);
      expect(restored.has("minimax-m3")).toBe(false);

      // Failed refresh keeps previous set and records error
      const before = reg.ids();
      status = await reg.refresh(async () => new Response("boom", { status: 500 }));
      expect(status.lastError).toContain("HTTP 500");
      expect(reg.ids()).toEqual(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refresh failure with no prior data keeps baseline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocfr-fm2-"));
    try {
      const reg = new FreeModelRegistry({ cachePath: join(dir, "free-models.json") });
      const status = await reg.refresh(async () => new Response("nope", { status: 503 }));
      expect(status.lastError).toBeTruthy();
      expect(status.usingBaseline).toBe(true);
      expect(reg.has("big-pickle")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
