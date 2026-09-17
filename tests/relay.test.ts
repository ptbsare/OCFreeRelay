/**
 * Unit tests for pure relay logic — call shipped functions from src/relay.
 */
import { describe, expect, it } from "vitest";
import {
  AccountRotator,
  buildChatCompletionsUrl,
  buildModelsUrl,
  buildUpstreamHeaders,
  forwardOpencodeClientHeaders,
  injectReasoningContentForThinkingModel,
  isThinkingMessageModel,
  normalizeBaseUrl,
  parseEffortLevel,
  passthroughBody,
  transformRequestBody,
  DEFAULT_BASE_URL,
} from "../src/relay/index.js";

describe("URL building", () => {
  it("normalizes base URL and builds chat/models paths for zen free upstream", () => {
    expect(normalizeBaseUrl("https://opencode.ai/zen/v1/")).toBe("https://opencode.ai/zen/v1");
    expect(normalizeBaseUrl("")).toBe(DEFAULT_BASE_URL);
    expect(buildChatCompletionsUrl("https://opencode.ai/zen/v1")).toBe(
      "https://opencode.ai/zen/v1/chat/completions"
    );
    expect(buildModelsUrl("https://opencode.ai/zen/v1")).toBe(
      "https://opencode.ai/zen/v1/models"
    );
  });
});

describe("transparent body passthrough + OpenCode fixes", () => {
  it("preserves representative chat payload fields while normalizing model/stream", () => {
    const payload = {
      model: "big-pickle",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      max_tokens: 128,
      tools: [{ type: "function", function: { name: "x", parameters: {} } }],
      user: "alice",
    };
    const out = transformRequestBody("big-pickle", payload, false) as Record<string, unknown>;
    expect(out.model).toBe("big-pickle");
    expect(out.stream).toBe(false);
    expect(out.temperature).toBe(0.2);
    expect(out.max_tokens).toBe(128);
    expect(out.user).toBe("alice");
    expect(out.messages).toEqual(payload.messages);
    expect(out.tools).toEqual(payload.tools);
    // original object not mutated
    expect(payload).not.toHaveProperty("stream");
  });

  it("passthroughBody keeps extra fields without stripping", () => {
    const payload = {
      model: "mimo-v2.5-free",
      messages: [{ role: "user", content: "hi" }],
      client_metadata: { app: "x" },
      custom_field: 42,
    };
    const out = passthroughBody("mimo-v2.5-free", payload, true) as Record<string, unknown>;
    expect(out.custom_field).toBe(42);
    expect(out.client_metadata).toEqual({ app: "x" });
    expect(out.stream).toBe(true);
  });

  it("strips client_metadata that OpenCode upstream rejects", () => {
    const out = transformRequestBody(
      "hy3-free",
      {
        model: "hy3-free",
        messages: [{ role: "user", content: "x" }],
        client_metadata: { source: "cli" },
      },
      false
    ) as Record<string, unknown>;
    expect(out).not.toHaveProperty("client_metadata");
    expect(out.messages).toEqual([{ role: "user", content: "x" }]);
  });

  it("injects reasoning_content placeholder for thinking free models", () => {
    expect(isThinkingMessageModel("deepseek-v4-flash-free")).toBe(true);
    const out = transformRequestBody(
      "deepseek-v4-flash-free",
      {
        model: "deepseek-v4-flash-free",
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "a" },
        ],
      },
      false
    ) as { messages: Array<Record<string, unknown>> };
    expect(out.messages[1].reasoning_content).toBe(" ");
  });

  it("injectReasoningContentForThinkingModel leaves non-assistant messages alone", () => {
    const body = {
      messages: [{ role: "user", content: "u" }],
    };
    expect(injectReasoningContentForThinkingModel(body)).toBe(body);
  });

  it("maps effort-tier model aliases to base + reasoning_effort", () => {
    expect(parseEffortLevel("deepseek-v4-flash-high")).toEqual({
      baseModel: "deepseek-v4-flash",
      effort: "high",
    });
    const out = transformRequestBody(
      "deepseek-v4-flash-high",
      { model: "deepseek-v4-flash-high", messages: [] },
      false
    ) as Record<string, unknown>;
    expect(out.model).toBe("deepseek-v4-flash");
    expect(out.reasoning_effort).toBe("high");
  });
});

describe("header construction", () => {
  it("sets Bearer Authorization and Accept for stream", () => {
    const h = buildUpstreamHeaders({
      apiKey: "sk-test-key",
      stream: true,
      synthesizeCliHeaders: false,
    });
    expect(h["Authorization"]).toBe("Bearer sk-test-key");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Accept"]).toBe("text/event-stream");
  });

  // OmniRoute OpencodeExecutor.buildHeaders: only set Authorization when key is truthy.
  // OpenCode free multi-account slots are fingerprint+proxy, not API keys.
  it("omits Authorization when apiKey is empty (keyless free tier)", () => {
    for (const apiKey of ["", "   ", null, undefined] as const) {
      const h = buildUpstreamHeaders({
        apiKey,
        stream: false,
        synthesizeCliHeaders: false,
      });
      expect(h).not.toHaveProperty("Authorization");
    }
  });

  it("forwards OpenCode identity headers from client", () => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    forwardOpencodeClientHeaders(
      headers,
      {
        "x-opencode-client": "cli",
        "X-Opencode-Project": "myproj",
        "user-agent": "opencode-cli/9.9.9",
        "x-session-id": "sess-1",
      },
      { synthesizeRequestId: true }
    );
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["x-opencode-project"]).toBe("myproj");
    expect(headers["User-Agent"]).toBe("opencode-cli/9.9.9");
    expect(headers["x-session-id"]).toBe("sess-1");
    expect(headers["x-opencode-session"]).toBe("sess-1");
    expect(headers["x-opencode-request"]).toMatch(
      /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/
    );
  });

  it("synthesizes CLI defaults when enabled and client omitted them", () => {
    const h = buildUpstreamHeaders({
      apiKey: "k",
      stream: false,
      synthesizeCliHeaders: true,
      cliDefaults: {
        userAgent: "opencode-cli/1.0.0",
        client: "cli",
        project: "default",
      },
      clientHeaders: {},
    });
    expect(h["User-Agent"]).toBe("opencode-cli/1.0.0");
    expect(h["x-opencode-client"]).toBe("cli");
    expect(h["x-opencode-project"]).toBe("default");
    expect(h["x-opencode-request"]).toMatch(
      /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/
    );
    expect(h["x-opencode-session"]).toMatch(
      /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
    );
  });

  it("client-supplied headers win over CLI defaults", () => {
    const h = buildUpstreamHeaders({
      apiKey: "k",
      synthesizeCliHeaders: true,
      cliDefaults: { userAgent: "default-ua", client: "cli", project: "default" },
      clientHeaders: {
        "User-Agent": "real-client/2.0",
        "x-opencode-client": "desktop",
      },
    });
    expect(h["User-Agent"]).toBe("real-client/2.0");
    expect(h["x-opencode-client"]).toBe("desktop");
  });
});

describe("multi-key sticky affinity / 429 cooldown", () => {
  it("sticks to the same ready account until cooldown, then advances and sticks again", () => {
    const rot = new AccountRotator();
    rot.sync([
      { id: "a", apiKey: "ka" },
      { id: "b", apiKey: "kb" },
      { id: "c", apiKey: "kc" },
    ]);

    const first = rot.pick(1_000_000);
    const second = rot.pick(1_000_000);
    const third = rot.pick(1_000_000);
    // Sticky: successive picks return the same worker while ready
    expect(first.id).toBe(second.id);
    expect(second.id).toBe(third.id);

    // Mark sticky account in long cooldown (simulates 429)
    rot.markCooldown(first, 1_000_000, 0);
    expect(rot.isReady(first, 1_000_000 + 100)).toBe(false);
    expect(first.cooldownUntil).toBeGreaterThan(1_000_000);

    // Next pick advances to another ready worker and stays there
    const next = rot.pick(1_000_000 + 100);
    expect(next.id).not.toBe(first.id);
    const picked: string[] = [];
    for (let i = 0; i < 6; i++) {
      picked.push(rot.pick(1_000_000 + 100).id);
    }
    expect(picked.every((id) => id !== first.id)).toBe(true);
    expect(new Set(picked).size).toBe(1);
    expect(picked[0]).toBe(next.id);

    rot.markSuccess(next);
    expect(next.consecutiveFails).toBe(0);
  });

  it("exponential cooldown grows with consecutive fails", () => {
    const rot = new AccountRotator();
    rot.sync([{ id: "only", apiKey: "k" }]);
    const acct = rot.pick(0);
    rot.markCooldown(acct, 0, 0);
    const firstCd = acct.cooldownUntil;
    rot.markCooldown(acct, 0, 0);
    expect(acct.cooldownUntil).toBeGreaterThan(firstCd);
    expect(acct.consecutiveFails).toBe(2);
  });

  it("readyCount reflects cooldowns", () => {
    const rot = new AccountRotator();
    rot.sync([
      { id: "a", apiKey: "1" },
      { id: "b", apiKey: "2" },
    ]);
    expect(rot.readyCount(0)).toBe(2);
    const a = rot.getAccounts().find((x) => x.id === "a")!;
    rot.markCooldown(a, 0, 0);
    expect(rot.readyCount(0)).toBe(1);
  });
});
