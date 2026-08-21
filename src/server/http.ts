/**
 * HTTP edge: OpenAI-compatible /v1/* + admin page/API (incl. proxy pool).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { UpstreamClient } from "../proxy/upstream.js";
import { fetchClashSubscription } from "../proxy/clash.js";
import { ClashSwitchQueue, probeClashBridge } from "../proxy/clashBridge.js";
import {
  assignHealthyProxiesToWorkers,
  mergeSubscriptionProxies,
  newProxyId,
  type ProxySubscription,
} from "../proxy/pool.js";
import {
  ProbeResultCache,
  probePoolProxies,
  probePoolProxy,
  summarizeProbeResults,
  type ProbeResult,
} from "../proxy/probe.js";
import { SettingsStore, type GatewaySettings } from "../settings/store.js";
import { AUTO_REFRESH_FREE_MODELS, FreeModelRegistry } from "../proxy/freeModels.js";
import {
  parseUsageFromObject,
  parseUsageFromSseBuffer,
  WorkerStatsStore,
} from "../settings/workerStats.js";
import { ADMIN_HTML } from "./adminHtml.js";

function applyClashHintsToBridge(
  current: GatewaySettings["clashBridge"],
  hints: {
    mixedPort?: number;
    port?: number;
    externalController?: string;
    selectorGroups?: string[];
  } | undefined
): GatewaySettings["clashBridge"] {
  if (!hints) return current;
  const next = { ...current };
  // Prefer mixed-port, then http port from subscription YAML
  if (hints.mixedPort && hints.mixedPort > 0) {
    next.localProxyPort = hints.mixedPort;
  } else if (hints.port && hints.port > 0 && !current.enabled) {
    // only auto-fill port when user has not been actively using bridge yet
    next.localProxyPort = hints.port;
  }
  if (hints.externalController) {
    next.apiBase = hints.externalController.replace(/\/+$/, "");
  }
  // Prefer first select group that is not app-specific (OpenAI/Netflix/…)
  if (hints.selectorGroups?.length) {
    const preferred =
      hints.selectorGroups.find((g) => g === "GLOBAL" || g === "主代理" || g === "Proxy") ||
      hints.selectorGroups.find(
        (g) =>
          !/netflix|openai|disney|youtube|telegram|spotify|steam|tiktok|apple|google|microsoft|bilibili|bahamut|discord|speedtest|黑名单|中国大陆/i.test(
            g
          )
      ) ||
      hints.selectorGroups[0];
    if (preferred) next.selectorGroup = preferred;
  }
  return next;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function clientHeadersFrom(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

async function readStreamFully(
  body: ReadableStream<Uint8Array> | null
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function pipeUpstream(
  res: ServerResponse,
  upstream: Awaited<ReturnType<UpstreamClient["chatCompletions"]>>,
  opts?: { onChunk?: (chunk: Uint8Array) => void }
): Promise<void> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    headers[key] = value;
  });
  headers["Access-Control-Allow-Origin"] = "*";
  headers["Access-Control-Allow-Headers"] = "*";
  headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";

  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        opts?.onChunk?.(value);
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (err) {
    try {
      res.destroy(err as Error);
    } catch {
      /* ignore */
    }
  }
}

export type App = {
  server: Server;
  store: SettingsStore;
  upstream: UpstreamClient;
  port: number;
  probes: ProbeResultCache;
  workerStats: WorkerStatsStore;
  freeModels: FreeModelRegistry;
};

export async function createApp(opts?: {
  store?: SettingsStore;
  port?: number;
  fetchImpl?: ConstructorParameters<typeof UpstreamClient>[1];
  /** For subscription fetch tests. */
  subscriptionFetch?: typeof fetch;
  /** Override probe HTTP fetch (unit tests). */
  probeFetch?: import("../proxy/probe.js").ProbeFetch;
  probes?: ProbeResultCache;
  workerStats?: WorkerStatsStore;
  /** Free-model registry for the free-only filter. Injected for tests. */
  freeModels?: FreeModelRegistry;
}): Promise<App> {
  const store = opts?.store ?? new SettingsStore();
  await store.load();
  const settings = store.get();
  const upstream = new UpstreamClient(settings, opts?.fetchImpl);
  store.updateReadyCount(upstream.rotator.readyCount(), upstream.rotator.getAccounts().length);
  const probes = opts?.probes ?? new ProbeResultCache();
  const clashProbeQueue = new ClashSwitchQueue();
  const workerStats =
    opts?.workerStats ??
    new WorkerStatsStore({
      // Keep test stats off disk unless caller supplies a path via env/store path sibling.
      persist: !opts?.workerStats && process.env.VITEST ? false : undefined,
    });
  if (!opts?.workerStats) {
    await workerStats.load().catch(() => {});
  }

  // The authenticated Zen view is the source of truth. Public-source refresh is
  // opt-in because it can omit account-visible free models. Injected registries
  // and Vitest runs never hit the network.
  const freeModels = opts?.freeModels ?? new FreeModelRegistry();
  if (opts?.freeModels) {
    // Test-injected registry: caller owns seeding; never hit the network.
  } else {
    await freeModels.loadCache().catch(() => {});
    if (AUTO_REFRESH_FREE_MODELS && !process.env.VITEST) {
      freeModels.refresh().then((s) => {
        if (s.lastError) {
          console.warn(`[free-models] refresh failed, using ${s.count} known-free: ${s.lastError}`);
        } else {
          console.log(`[free-models] refreshed ${s.count} free models from configured source`);
        }
      });
    }
  }

  const port =
    opts?.port ??
    (process.env.PORT ? Number(process.env.PORT) : undefined) ??
    settings.port ??
    9876;

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, store, upstream, {
        subscriptionFetch: opts?.subscriptionFetch,
        probeFetch: opts?.probeFetch,
        probes,
        clashProbeQueue,
        workerStats,
        freeModels,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.recordRequest(req.url || "/", 500, message);
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message, type: "server_error" } });
      } else {
        res.destroy();
      }
    }
  });

  return { server, store, upstream, port, probes, workerStats, freeModels };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: SettingsStore,
  upstream: UpstreamClient,
  ctx?: {
    subscriptionFetch?: typeof fetch;
    probeFetch?: import("../proxy/probe.js").ProbeFetch;
    probes?: ProbeResultCache;
    clashProbeQueue?: ClashSwitchQueue;
    workerStats?: WorkerStatsStore;
    freeModels?: FreeModelRegistry;
  }
): Promise<void> {
  const subscriptionFetch = ctx?.subscriptionFetch;
  const probes = ctx?.probes ?? new ProbeResultCache();
  const clashProbeQueue = ctx?.clashProbeQueue ?? new ClashSwitchQueue();
  const workerStats = ctx?.workerStats ?? new WorkerStatsStore({ persist: false });
  const freeModels = ctx?.freeModels ?? new FreeModelRegistry();
  const method = (req.method || "GET").toUpperCase();
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    });
    res.end();
    return;
  }

  if (method === "GET" && (path === "/" || path === "/admin" || path === "/admin/")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ADMIN_HTML);
    return;
  }

  if (method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true, service: "oc-free-relay" });
    return;
  }

  // Free-model registry status
  if (method === "GET" && path === "/admin/api/free-models") {
    sendJson(res, 200, freeModels.status());
    return;
  }
  // Public-source refresh is disabled unless explicitly enabled and reconciled
  // with the authenticated Zen view.
  if (method === "POST" && path === "/admin/api/free-models/refresh") {
    if (!AUTO_REFRESH_FREE_MODELS) {
      sendJson(res, 409, {
        error: {
          message: "Free-model refresh is disabled; update the authenticated Zen baseline first or set OCFREERELAY_AUTO_REFRESH_FREE_MODELS=true after reconciliation.",
        },
      });
      return;
    }
    const status = await freeModels.refresh();
    sendJson(res, 200, status);
    return;
  }

  // Admin API: settings
  if (path === "/admin/api/settings") {
    if (method === "GET") {
      sendJson(res, 200, store.get());
      return;
    }
    if (method === "PUT" || method === "POST") {
      const raw = await readBody(req);
      let parsed: Partial<GatewaySettings>;
      try {
        parsed = JSON.parse(raw.toString("utf8") || "{}") as Partial<GatewaySettings>;
      } catch {
        sendJson(res, 400, { error: { message: "Invalid JSON" } });
        return;
      }
      const saved = await store.save(parsed);
      upstream.updateSettings(saved);
      store.updateReadyCount(
        upstream.rotator.readyCount(),
        upstream.rotator.getAccounts().length
      );
      sendJson(res, 200, saved);
      return;
    }
  }

  if (method === "GET" && path === "/admin/api/status") {
    store.updateReadyCount(
      upstream.rotator.readyCount(),
      upstream.rotator.getAccounts().length
    );
    const accountIds = store.get().accounts.map((a) => a.id);
    const workers = workerStats.listForAccounts(accountIds);
    sendJson(res, 200, {
      ...store.getStatus(),
      workers,
      usageTotals: workerStats.totals(accountIds),
    });
    return;
  }

  // POST /admin/api/worker-stats/reset — clear all or one worker
  if (method === "POST" && path === "/admin/api/worker-stats/reset") {
    const raw = await readBody(req);
    let accountId: string | undefined;
    if (raw.length) {
      try {
        const body = JSON.parse(raw.toString("utf8") || "{}") as { accountId?: unknown };
        if (typeof body.accountId === "string" && body.accountId) accountId = body.accountId;
      } catch {
        sendJson(res, 400, { error: { message: "Invalid JSON" } });
        return;
      }
    }
    await workerStats.reset(accountId);
    const accountIds = store.get().accounts.map((a) => a.id);
    sendJson(res, 200, {
      ok: true,
      workers: workerStats.listForAccounts(accountIds),
      usageTotals: workerStats.totals(accountIds),
    });
    return;
  }

  // POST /admin/api/workers/assign-proxies — bind each worker to a unique probe-healthy proxy
  if (method === "POST" && path === "/admin/api/workers/assign-proxies") {
    const s = store.get();
    const raw = await readBody(req);
    let accounts = s.accounts;
    if (raw.length) {
      try {
        const body = JSON.parse(raw.toString("utf8") || "{}") as {
          accounts?: GatewaySettings["accounts"];
        };
        if (Array.isArray(body.accounts) && body.accounts.length) {
          accounts = body.accounts;
        }
      } catch {
        sendJson(res, 400, { error: { message: "Invalid JSON" } });
        return;
      }
    }

    const result = assignHealthyProxiesToWorkers({
      accounts,
      pool: s.proxyPool,
      probeResults: probes.getAll(),
      bridge: s.clashBridge,
    });

    if (result.healthyAvailable === 0) {
      sendJson(res, 400, {
        error: {
          message:
            "No healthy proxies in the pool. Run Batch Test first, then assign again.",
        },
        healthyAvailable: 0,
        assigned: 0,
        unassigned: accounts.length,
      });
      return;
    }

    const saved = await store.save({ accounts: result.accounts });
    upstream.updateSettings(saved);
    store.updateReadyCount(
      upstream.rotator.readyCount(),
      upstream.rotator.getAccounts().length
    );
    sendJson(res, 200, {
      ok: true,
      settings: saved,
      assigned: result.assigned,
      unassigned: result.unassigned,
      healthyAvailable: result.healthyAvailable,
      assignments: result.assignments,
    });
    return;
  }

  // --- Proxy pool APIs ---

  // GET /admin/api/proxy-pool
  if (method === "GET" && path === "/admin/api/proxy-pool") {
    const s = store.get();
    sendJson(res, 200, {
      proxyPool: s.proxyPool,
      proxySubscriptions: s.proxySubscriptions,
      probeResults: probes.getAll(),
    });
    return;
  }

  // POST /admin/api/proxy-pool/test-batch — latency probe (optional body.ids)
  if (method === "POST" && path === "/admin/api/proxy-pool/test-batch") {
    const s = store.get();
    let ids: string[] | null = null;
    const raw = await readBody(req);
    if (raw.length) {
      try {
        const body = JSON.parse(raw.toString("utf8") || "{}") as { ids?: unknown };
        if (Array.isArray(body.ids)) {
          ids = body.ids.filter((x): x is string => typeof x === "string" && !!x);
        }
      } catch {
        sendJson(res, 400, { error: { message: "Invalid JSON" } });
        return;
      }
    }
    const pool = s.proxyPool;
    const targets = ids?.length
      ? ids
          .map((id) => pool.find((p) => p.id === id))
          .filter((p): p is NonNullable<typeof p> => !!p)
      : pool;
    const results = await probePoolProxies(targets, s.clashBridge, {
      fetchImpl: ctx?.probeFetch,
      bridgeFetch: subscriptionFetch ?? globalThis.fetch,
      clashQueue: clashProbeQueue,
    });
    probes.setMany(results);
    sendJson(res, 200, {
      results,
      summary: summarizeProbeResults(results),
      probeResults: probes.getAll(),
    });
    return;
  }

  // POST /admin/api/proxy-pool/:id/test — single node latency probe
  if (method === "POST" && path.match(/^\/admin\/api\/proxy-pool\/[^/]+\/test$/)) {
    const id = decodeURIComponent(
      path.slice("/admin/api/proxy-pool/".length, -"/test".length)
    );
    const s = store.get();
    const proxy = s.proxyPool.find((p) => p.id === id);
    if (!proxy) {
      sendJson(res, 404, { error: { message: `Proxy not found: ${id}` } });
      return;
    }
    const result: ProbeResult = await probePoolProxy(proxy, s.clashBridge, {
      fetchImpl: ctx?.probeFetch,
      bridgeFetch: subscriptionFetch ?? globalThis.fetch,
      clashQueue: clashProbeQueue,
    });
    probes.set(result);
    sendJson(res, 200, { result, probeResults: probes.getAll() });
    return;
  }

  // POST /admin/api/proxy-pool  — add manual proxy
  if (method === "POST" && path === "/admin/api/proxy-pool") {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString("utf8") || "{}") as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: { message: "Invalid JSON" } });
      return;
    }
    try {
      const saved = await store.addManualProxy({
        name: typeof body.name === "string" ? body.name : undefined,
        type: typeof body.type === "string" ? body.type : "http",
        host: String(body.host || ""),
        port: Number(body.port),
        username: typeof body.username === "string" ? body.username : undefined,
        password: typeof body.password === "string" ? body.password : undefined,
        enabled: body.enabled !== false,
      });
      upstream.updateSettings(saved);
      store.updateReadyCount(
        upstream.rotator.readyCount(),
        upstream.rotator.getAccounts().length
      );
      sendJson(res, 200, saved);
    } catch (err) {
      sendJson(res, 400, {
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
    return;
  }

  // DELETE /admin/api/proxy-pool/:id
  if (method === "DELETE" && path.startsWith("/admin/api/proxy-pool/")) {
    const id = decodeURIComponent(path.slice("/admin/api/proxy-pool/".length));
    if (!id || id.includes("/")) {
      sendJson(res, 400, { error: { message: "Missing proxy id" } });
      return;
    }
    const saved = await store.removeProxy(id);
    probes.delete(id);
    upstream.updateSettings(saved);
    store.updateReadyCount(
      upstream.rotator.readyCount(),
      upstream.rotator.getAccounts().length
    );
    sendJson(res, 200, saved);
    return;
  }

  // POST /admin/api/proxy-subscriptions — add subscription (does not fetch yet)
  if (method === "POST" && path === "/admin/api/proxy-subscriptions") {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString("utf8") || "{}") as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: { message: "Invalid JSON" } });
      return;
    }
    const subUrl = typeof body.url === "string" ? body.url.trim() : "";
    if (!subUrl) {
      sendJson(res, 400, { error: { message: "url required" } });
      return;
    }
    const s = store.get();
    const sub: ProxySubscription = {
      id: newProxyId("sub"),
      name:
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : `sub-${s.proxySubscriptions.length + 1}`,
      url: subUrl,
      enabled: body.enabled !== false,
      lastFetchedAt: null,
      lastError: null,
      lastImportCount: 0,
    };
    const saved = await store.save({
      proxySubscriptions: [...s.proxySubscriptions, sub],
    });
    sendJson(res, 200, { subscription: sub, settings: saved });
    return;
  }

  // DELETE /admin/api/proxy-subscriptions/:id
  if (method === "DELETE" && path.startsWith("/admin/api/proxy-subscriptions/")) {
    const id = decodeURIComponent(path.slice("/admin/api/proxy-subscriptions/".length));
    if (!id || id.includes("/")) {
      sendJson(res, 400, { error: { message: "Missing subscription id" } });
      return;
    }
    const s = store.get();
    const proxyPool = s.proxyPool.filter(
      (p) => !(p.source === "subscription" && p.subscriptionId === id)
    );
    const proxySubscriptions = s.proxySubscriptions.filter((x) => x.id !== id);
    // clear account bindings that pointed at removed proxies
    const removedIds = new Set(
      s.proxyPool
        .filter((p) => p.source === "subscription" && p.subscriptionId === id)
        .map((p) => p.id)
    );
    const accounts = s.accounts.map((a) =>
      a.proxyId && removedIds.has(a.proxyId) ? { ...a, proxyId: null } : a
    );
    const saved = await store.save({ proxyPool, proxySubscriptions, accounts });
    upstream.updateSettings(saved);
    store.updateReadyCount(
      upstream.rotator.readyCount(),
      upstream.rotator.getAccounts().length
    );
    sendJson(res, 200, saved);
    return;
  }

  // POST /admin/api/proxy-subscriptions/:id/fetch — pull Clash sub into pool
  if (method === "POST" && path.match(/^\/admin\/api\/proxy-subscriptions\/[^/]+\/fetch$/)) {
    const id = decodeURIComponent(
      path.slice("/admin/api/proxy-subscriptions/".length, -"/fetch".length)
    );
    const s = store.get();
    const sub = s.proxySubscriptions.find((x) => x.id === id);
    if (!sub) {
      sendJson(res, 404, { error: { message: `Subscription not found: ${id}` } });
      return;
    }

    try {
      const result = await fetchClashSubscription({
        url: sub.url,
        subscriptionId: sub.id,
        fetchImpl: subscriptionFetch,
      });
      const mergedPool = mergeSubscriptionProxies(s.proxyPool, sub.id, result.proxies);
      const updatedSub: ProxySubscription = {
        ...sub,
        lastFetchedAt: new Date().toISOString(),
        lastError:
          result.proxies.length === 0
            ? "Parsed 0 nodes — check URL or try again"
            : null,
        lastImportCount: result.proxies.length,
        lastDirectCount: result.usableCount,
        lastBridgeableCount: result.bridgeableCount,
        lastFormat: result.format,
        lastUserAgent: result.usedUserAgent,
      };
      const proxySubscriptions = s.proxySubscriptions.map((x) =>
        x.id === id ? updatedSub : x
      );
      // Auto-fill Clash bridge endpoints from subscription YAML (mitce: 7892 / 主代理)
      const clashBridge = applyClashHintsToBridge(s.clashBridge, result.clashHints);
      const saved = await store.save({
        proxyPool: mergedPool,
        proxySubscriptions,
        clashBridge,
      });
      upstream.updateSettings(saved);
      store.updateReadyCount(
        upstream.rotator.readyCount(),
        upstream.rotator.getAccounts().length
      );
      sendJson(res, 200, {
        ok: true,
        format: result.format,
        usableCount: result.usableCount,
        bridgeableCount: result.bridgeableCount,
        skippedCount: result.skippedCount,
        totalCount: result.proxies.length,
        rawBytes: result.rawBytes,
        usedUserAgent: result.usedUserAgent,
        clashHints: result.clashHints,
        hint:
          result.usableCount === 0 && result.bridgeableCount > 0
            ? "订阅节点均为 vless/hysteria2/tuic 等协议，需开启「Clash 桥接」并运行本地 Mihomo/Clash 后才能作为出口。"
            : result.proxies.length === 0
              ? "未解析到节点。"
              : undefined,
        subscription: updatedSub,
        settings: saved,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const updatedSub: ProxySubscription = {
        ...sub,
        lastFetchedAt: new Date().toISOString(),
        lastError: message,
      };
      const proxySubscriptions = s.proxySubscriptions.map((x) =>
        x.id === id ? updatedSub : x
      );
      await store.save({ proxySubscriptions });
      sendJson(res, 502, {
        error: { message: `Subscription fetch failed: ${message}` },
        subscription: updatedSub,
      });
    }
    return;
  }

  // POST /admin/api/clash-bridge/probe
  if (method === "POST" && path === "/admin/api/clash-bridge/probe") {
    const s = store.get();
    const raw = await readBody(req);
    let override: Partial<GatewaySettings["clashBridge"]> = {};
    if (raw.length) {
      try {
        override = JSON.parse(raw.toString("utf8") || "{}") as Partial<
          GatewaySettings["clashBridge"]
        >;
      } catch {
        /* ignore */
      }
    }
    const bridge = { ...s.clashBridge, ...override };
    const result = await probeClashBridge(bridge, subscriptionFetch ?? globalThis.fetch);
    sendJson(res, result.ok ? 200 : 502, { ...result, bridge });
    return;
  }

  // POST /admin/api/proxy-subscriptions/fetch-all
  if (method === "POST" && path === "/admin/api/proxy-subscriptions/fetch-all") {
    const s = store.get();
    let pool = s.proxyPool;
    const subs = [...s.proxySubscriptions];
    const results: Array<Record<string, unknown>> = [];

    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      if (!sub.enabled) {
        results.push({ id: sub.id, skipped: true, reason: "disabled" });
        continue;
      }
      try {
        const result = await fetchClashSubscription({
          url: sub.url,
          subscriptionId: sub.id,
          fetchImpl: subscriptionFetch,
        });
        pool = mergeSubscriptionProxies(pool, sub.id, result.proxies);
        subs[i] = {
          ...sub,
          lastFetchedAt: new Date().toISOString(),
          lastError: null,
          lastImportCount: result.proxies.length,
          lastDirectCount: result.usableCount,
          lastBridgeableCount: result.bridgeableCount,
          lastFormat: result.format,
          lastUserAgent: result.usedUserAgent,
        };
        // apply hints from last successful YAML
        if (result.clashHints) {
          /* applied after loop on last hints — see below */
        }
        results.push({
          id: sub.id,
          ok: true,
          totalCount: result.proxies.length,
          usableCount: result.usableCount,
          bridgeableCount: result.bridgeableCount,
          skippedCount: result.skippedCount,
          format: result.format,
          usedUserAgent: result.usedUserAgent,
          clashHints: result.clashHints,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        subs[i] = {
          ...sub,
          lastFetchedAt: new Date().toISOString(),
          lastError: message,
        };
        results.push({ id: sub.id, ok: false, error: message });
      }
    }

    const lastHints = [...results]
      .reverse()
      .find((r) => r.ok && r.clashHints)?.clashHints as
      | Parameters<typeof applyClashHintsToBridge>[1]
      | undefined;
    const clashBridge = applyClashHintsToBridge(s.clashBridge, lastHints);

    const saved = await store.save({
      proxyPool: pool,
      proxySubscriptions: subs,
      clashBridge,
    });
    upstream.updateSettings(saved);
    store.updateReadyCount(
      upstream.rotator.readyCount(),
      upstream.rotator.getAccounts().length
    );
    sendJson(res, 200, { results, settings: saved });
    return;
  }

  // OpenAI-compatible models
  if (method === "GET" && (path === "/v1/models" || path === "/models")) {
    try {
      const result = await upstream.listModels(clientHeadersFrom(req));
      store.recordRequest(path, result.status);
      store.updateReadyCount(
        upstream.rotator.readyCount(),
        upstream.rotator.getAccounts().length
      );
      workerStats.recordRequest(result.accountId, {
        kind: "models",
        status: result.status,
      });
      // Serve ONLY free models: buffer the JSON payload and drop paid ids.
      if (result.status < 400 && result.body) {
        const buf = await readStreamFully(result.body);
        let payload: unknown = null;
        try {
          payload = JSON.parse(buf.toString("utf8"));
        } catch {
          /* upstream 200 but not JSON — fall through to passthrough */
        }
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          const obj = payload as { object?: unknown; data?: unknown };
          const data = Array.isArray(obj.data) ? obj.data : [];
          const kept = data.filter((m): boolean => {
            if (!m || typeof m !== "object") return false;
            const id = String((m as { id?: unknown }).id ?? "");
            return freeModels.has(id);
          });
          sendJson(res, result.status, {
            ...payload as Record<string, unknown>,
            object: obj.object ?? "list",
            data: kept,
          });
          return;
        }
      }
      await pipeUpstream(res, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.recordRequest(path, 502, message);
      sendJson(res, 502, {
        error: { message: `Upstream models failed: ${message}`, type: "upstream_error" },
      });
    }
    return;
  }

  // OpenAI-compatible chat completions
  if (method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8") || "{}");
    } catch {
      sendJson(res, 400, {
        error: { message: "Invalid JSON body", type: "invalid_request_error" },
      });
      return;
    }
    const stream = Boolean(
      body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        (body as { stream?: boolean }).stream
    );

    // Free-only enforcement: refuse paid / unknown models up front.
    const reqModel = body && typeof body === "object" && !Array.isArray(body)
      ? String((body as { model?: unknown }).model ?? "").replace(/^opencode\//, "")
      : "";
    if (reqModel && !freeModels.has(reqModel)) {
      store.recordRequest(path, 403, `model not allowed: ${reqModel}`);
      sendJson(res, 403, {
        error: {
          message: `Model "${reqModel}" is not a free model and is not served by this gateway (free-only).`,
          type: "model_not_allowed",
        },
      });
      return;
    }

    try {
      const result = await upstream.chatCompletions({
        body,
        stream,
        clientHeaders: clientHeadersFrom(req),
      });
      store.recordRequest(
        path,
        result.status,
        result.status >= 400 ? `upstream ${result.status}` : undefined
      );
      store.updateReadyCount(
        upstream.rotator.readyCount(),
        upstream.rotator.getAccounts().length
      );
      workerStats.recordRequest(result.accountId, {
        kind: "chat",
        status: result.status,
      });

      if (!stream && result.body && result.status < 400) {
        // Buffer non-stream body to extract usage, then forward intact.
        const buf = await readStreamFully(result.body);
        try {
          const parsed = JSON.parse(buf.toString("utf8")) as unknown;
          const usage = parseUsageFromObject(parsed);
          if (usage) workerStats.addTokens(result.accountId, usage);
        } catch {
          /* ignore non-JSON bodies */
        }
        const headers: Record<string, string> = {};
        result.headers.forEach((value, key) => {
          if (HOP_BY_HOP.has(key.toLowerCase())) return;
          headers[key] = value;
        });
        headers["Access-Control-Allow-Origin"] = "*";
        headers["Access-Control-Allow-Headers"] = "*";
        headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
        headers["Content-Length"] = String(buf.length);
        res.writeHead(result.status, headers);
        res.end(buf);
      } else if (stream && result.body) {
        const decoder = new TextDecoder();
        let sseText = "";
        await pipeUpstream(res, result, {
          onChunk: (chunk) => {
            sseText += decoder.decode(chunk, { stream: true });
            // Cap buffer to avoid unbounded growth on long streams
            if (sseText.length > 512_000) {
              sseText = sseText.slice(-256_000);
            }
          },
        });
        sseText += decoder.decode();
        const usage = parseUsageFromSseBuffer(sseText);
        if (usage) workerStats.addTokens(result.accountId, usage);
      } else {
        await pipeUpstream(res, result);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.recordRequest(path, 502, message);
      sendJson(res, 502, {
        error: { message: `Upstream chat failed: ${message}`, type: "upstream_error" },
      });
    }
    return;
  }

  sendJson(res, 404, { error: { message: `Not found: ${path}`, type: "not_found" } });
}

export function listen(app: App): Promise<void> {
  return new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(app.port, "0.0.0.0", () => {
      app.store.setRunning(true);
      resolve();
    });
  });
}

export function close(app: App): Promise<void> {
  return new Promise((resolve, reject) => {
    app.store.setRunning(false);
    app.server.close((err) => (err ? reject(err) : resolve()));
  });
}
