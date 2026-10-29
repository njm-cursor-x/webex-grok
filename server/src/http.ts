import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { webexConfigured, webexRedirectUri, type Config } from "./config.ts";
import { createMcpServer } from "./mcp.ts";
import {
  authorizationServerMetadata,
  beginAuthorize,
  completeWebexCallback,
  grantToken,
  protectedResourceMetadata,
  registerClient,
} from "./oauth.ts";
import type { TokenStore } from "./store.ts";
import { refreshWebexToken, WebexClient, type WebexTokens } from "./webex.ts";

const webexRefreshes = new Map<string, Promise<WebexTokens>>();

function refreshWebexOnce(sessionId: string, run: () => Promise<WebexTokens>): Promise<WebexTokens> {
  const existing = webexRefreshes.get(sessionId);
  if (existing) return existing;
  const pending = run().finally(() => {
    if (webexRefreshes.get(sessionId) === pending) webexRefreshes.delete(sessionId);
  });
  webexRefreshes.set(sessionId, pending);
  return pending;
}

const MAX_BODY = 1_000_000;

export type ServerDeps = {
  fetch?: typeof fetch;
  now?: () => number;
};

export function startServer(config: Config, store: TokenStore, deps: ServerDeps = {}): Server {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  return createServer(async (req, res) => {
    try {
      await route(req, res, config, store, fetchImpl, now);
    } catch {
      console.log(JSON.stringify({ event: "request_failed", path: req.url?.split("?")[0] ?? "" }));
      if (!res.headersSent) {
        sendJson(res, 500, { error: "server_error", error_description: "Request failed" });
      }
    }
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  store: TokenStore,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<void> {
  const url = new URL(req.url ?? "/", config.publicBaseUrl);
  const path = url.pathname;

  if (req.method === "GET" && path === "/healthz") {
    sendJson(res, 200, { ok: true, webexConfigured: webexConfigured(config) });
    return;
  }
  if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
    sendJson(res, 200, protectedResourceMetadata(config));
    return;
  }
  if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, authorizationServerMetadata(config));
    return;
  }
  if (req.method === "POST" && path === "/register") {
    const body = await readBody(req);
    const result = registerClient(store, config, body.json, now());
    if ("error" in result) {
      sendJson(res, result.status, { error: result.error, error_description: result.description });
      return;
    }
    sendJson(res, 201, {
      client_id: result.clientId,
      redirect_uris: result.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    return;
  }
  if (req.method === "GET" && path === "/authorize") {
    const result = beginAuthorize(store, config, url.searchParams, now());
    if ("redirect" in result) {
      redirect(res, result.redirect);
      return;
    }
    sendJson(res, result.status, { error: result.error, error_description: result.description });
    return;
  }
  if (req.method === "GET" && path === "/oauth/webex/callback") {
    const result = await completeWebexCallback(store, config, url.searchParams, fetchImpl, now());
    if ("redirect" in result) {
      redirect(res, result.redirect);
      return;
    }
    sendJson(res, result.status, { error: result.error, error_description: result.description });
    return;
  }
  if (req.method === "POST" && path === "/token") {
    const body = await readBody(req);
    const fields = body.form ?? new URLSearchParams();
    if (body.json && typeof body.json === "object") {
      for (const [key, value] of Object.entries(body.json as Record<string, unknown>)) {
        if (typeof value === "string" && !fields.has(key)) fields.set(key, value);
      }
    }
    const result = grantToken(store, config, fields, now());
    if ("error" in result) {
      sendJson(res, result.status, { error: result.error, error_description: result.description });
      return;
    }
    sendJson(res, 200, {
      access_token: result.accessToken,
      token_type: "Bearer",
      expires_in: result.expiresIn,
      refresh_token: result.refreshToken,
      scope: "webex",
    });
    return;
  }
  if (path === "/mcp") {
    await handleMcp(req, res, config, store, fetchImpl, now);
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  store: TokenStore,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }
  const token = bearer(req);
  const current = token ? store.getByAccessToken(token, now()) : undefined;
  if (!token || !current) {
    unauthorized(res, config);
    return;
  }

  let accessToken = current.webexAccessToken;
  let refreshToken = current.webexRefreshToken;
  const refresh = () =>
    refreshWebexOnce(current.id, () => refreshWebexToken(fetchImpl, config, refreshToken, now()));
  if (current.webexExpiresAt <= now()) {
    try {
      const refreshed = await refresh();
      store.updateWebexTokens(current.id, refreshed);
      accessToken = refreshed.accessToken;
      refreshToken = refreshed.refreshToken;
    } catch {
      console.log(JSON.stringify({ event: "webex_refresh_failed" }));
      unauthorized(res, config);
      return;
    }
  }

  const client = new WebexClient(fetchImpl, accessToken, async () => {
    const refreshed = await refresh();
    refreshToken = refreshed.refreshToken;
    store.updateWebexTokens(current.id, refreshed);
    return refreshed.accessToken;
  });
  const mcp = createMcpServer(client);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcp.connect(transport);
  const body = await readBody(req);
  try {
    await transport.handleRequest(req, res, body.json);
  } finally {
    await transport.close();
    await mcp.close();
  }
}

function unauthorized(res: ServerResponse, config: Config): void {
  const metadata = `${config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`;
  res.writeHead(401, {
    "www-authenticate": `Bearer resource_metadata="${metadata}"`,
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: "invalid_token" }));
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store" }).end();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<{ json?: unknown; form?: URLSearchParams }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    return { form: new URLSearchParams(raw) };
  }
  if (raw.trim().length === 0) return {};
  return { json: JSON.parse(raw) as unknown };
}

export function expectedWebexCallback(config: Config): string {
  return webexRedirectUri(config);
}
