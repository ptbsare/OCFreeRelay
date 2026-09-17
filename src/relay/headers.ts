/**
 * OpenCode client identity header forward / synthesize.
 * Adapted from OmniRoute open-sse/utils/opencodeHeaders.ts
 */

import { randomBytes } from "node:crypto";

const OPENCODE_HEADER_KEYS = [
  "x-opencode-session",
  "x-opencode-request",
  "x-opencode-project",
  "x-opencode-client",
] as const;

const AGENT_METADATA_HEADER_KEYS = ["x-session-id", "x-title"] as const;

const OPENCODE_ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// OpenCode CLI generates x-opencode-session / x-opencode-request locally:
// a 6-byte (12 hex) timestamp+seq prefix and a 14-char base62 random suffix.
// The Zen free tier now validates this exact format, so a bare UUID no longer
// passes. See https://linux.do/t/topic/2912664 (FreeTierError 403).
let lastTs = 0;
let ctr = 0;

function genOpencodeId(desc: boolean): string {
  const ts = Date.now();
  ctr = ts !== lastTs ? 1 : ctr + 1;
  lastTs = ts;
  let v = BigInt(ts) * 0x1000n + BigInt(ctr);
  if (desc) v = ~v;
  let time = "";
  for (let i = 0; i < 6; i++) {
    time += Number((v >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
  }
  const bytes = randomBytes(14);
  const rnd = Array.from(bytes).map((b) => OPENCODE_ID_CHARS[b % 62]).join("");
  return time + rnd;
}

function opencodeSessionId(): string {
  return "ses_" + genOpencodeId(true);
}

function opencodeRequestId(): string {
  return "msg_" + genOpencodeId(false);
}

export type CliDefaults = {
  userAgent: string;
  client: string;
  project: string;
};

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function setUserAgentHeader(headers: Record<string, string>, value: string): void {
  delete headers["user-agent"];
  headers["User-Agent"] = value;
}

function applyCliDefaults(headers: Record<string, string>, cliDefaults: CliDefaults): void {
  if (!headers["User-Agent"] && !headers["user-agent"]) {
    setUserAgentHeader(headers, cliDefaults.userAgent);
  }
  headers["x-opencode-client"] ||= cliDefaults.client;
  headers["x-opencode-project"] ||= cliDefaults.project;
  headers["x-opencode-request"] ||= opencodeRequestId();
  headers["x-opencode-session"] ||= opencodeSessionId();
}

/**
 * Forward OpenCode client request metadata headers to the upstream provider.
 * Client-supplied values always win; cliDefaults only fill gaps.
 */
export function forwardOpencodeClientHeaders(
  headers: Record<string, string>,
  clientHeaders: Record<string, string>,
  options?: {
    synthesizeRequestId?: boolean;
    cliDefaults?: CliDefaults;
  }
): void {
  const clientUA = clientHeaders["User-Agent"] || clientHeaders["user-agent"];
  if (clientUA) {
    setUserAgentHeader(headers, clientUA);
  }

  for (const headerName of OPENCODE_HEADER_KEYS) {
    const value = findHeader(clientHeaders, headerName);
    if (value) {
      headers[headerName] = value;
    }
  }

  for (const headerName of AGENT_METADATA_HEADER_KEYS) {
    const value = findHeader(clientHeaders, headerName);
    if (value) {
      headers[headerName] = value;
    }
  }

  if (options?.synthesizeRequestId && !headers["x-opencode-session"]) {
    const sessionAffinity =
      findHeader(clientHeaders, "x-session-affinity") || findHeader(clientHeaders, "x-session-id");
    if (sessionAffinity) {
      headers["x-opencode-session"] = sessionAffinity;
      if (!headers["x-opencode-request"]) {
        headers["x-opencode-request"] = opencodeRequestId();
      }
    }
  }

  if (options?.cliDefaults) {
    applyCliDefaults(headers, options.cliDefaults);
  }
}

export function envTruthy(value: string | undefined | null): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

/**
 * Build outbound headers for OpenCode zen upstream.
 */
export function buildUpstreamHeaders(opts: {
  apiKey?: string | null;
  stream?: boolean;
  clientHeaders?: Record<string, string> | null;
  synthesizeCliHeaders?: boolean;
  cliDefaults?: Partial<CliDefaults>;
}): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  const key = opts.apiKey?.trim();
  if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }

  if (opts.stream) {
    headers["Accept"] = "text/event-stream";
  }

  const synthesizeCli =
    opts.synthesizeCliHeaders ?? envTruthy(process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS);
  const cliDefaults: CliDefaults | undefined = synthesizeCli
    ? {
        userAgent:
          opts.cliDefaults?.userAgent ||
          process.env.OPENCODE_USER_AGENT?.trim() ||
          "opencode-cli/1.0.0",
        client: opts.cliDefaults?.client || process.env.OPENCODE_CLIENT?.trim() || "cli",
        project: opts.cliDefaults?.project || process.env.OPENCODE_PROJECT?.trim() || "default",
      }
    : undefined;

  if (opts.clientHeaders || cliDefaults) {
    forwardOpencodeClientHeaders(headers, opts.clientHeaders ?? {}, {
      synthesizeRequestId: true,
      cliDefaults,
    });
  }

  return headers;
}
