import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { encryptionKeyFromSecret, type Config } from "../src/config.ts";
import { startServer } from "../src/http.ts";
import { TokenStore } from "../src/store.ts";

const REDIRECT = "https://www.cursor.com/agents/mcp/oauth/callback";

function testConfig(): Config {
  return {
    port: 8788,
    publicBaseUrl: "http://127.0.0.1:8788",
    webexClientId: "webex-client",
    webexClientSecret: "webex-secret",
    encryptionKey: encryptionKeyFromSecret("test-encryption-key-32b!!"),
    dataPath: ":memory:",
    extraRedirectUris: [],
    accessTtlSeconds: 3600,
    refreshTtlSeconds: 86_400,
  };
}

async function listen(config: Config, fetchImpl?: typeof fetch) {
  const store = new TokenStore(":memory:", config.encryptionKey);
  const server = startServer(config, store, { fetch: fetchImpl });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    store,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      store.close();
    },
  };
}

test("sign-in issues a session token and rejects a replayed code and an old refresh token", async () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const fetchImpl: typeof fetch = async (input) => {
    assert.match(String(input), /webexapis.com\/v1\/access_token/);
    return Response.json({
      access_token: "wx-access",
      refresh_token: "wx-refresh",
      expires_in: 3600,
      token_type: "Bearer",
    });
  };
  const app = await listen(testConfig(), fetchImpl);
  try {
    const registered = await fetch(`${app.base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Cursor" }),
    });
    assert.equal(registered.status, 201);
    const client = (await registered.json()) as { client_id: string };

    const rejected = await fetch(`${app.base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"] }),
    });
    assert.equal(rejected.status, 400);

    const authorize = new URL(`${app.base}/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", client.client_id);
    authorize.searchParams.set("redirect_uri", REDIRECT);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", "cursor-state");
    const start = await fetch(authorize, { redirect: "manual" });
    assert.equal(start.status, 302);
    const webex = new URL(start.headers.get("location") ?? "");
    assert.equal(webex.origin + webex.pathname, "https://webexapis.com/v1/authorize");
    assert.equal(webex.searchParams.get("redirect_uri"), "http://127.0.0.1:8788/oauth/webex/callback");
    const webexState = webex.searchParams.get("state");
    assert.ok(webexState);

    const missing = await fetch(`${app.base}/oauth/webex/callback?code=nope&state=not-a-state`);
    assert.equal(missing.status, 400);

    const callback = await fetch(
      `${app.base}/oauth/webex/callback?code=webex-code&state=${encodeURIComponent(webexState)}`,
      { redirect: "manual" },
    );
    assert.equal(callback.status, 302);
    const back = new URL(callback.headers.get("location") ?? "");
    assert.equal(back.origin + back.pathname, REDIRECT);
    assert.equal(back.searchParams.get("state"), "cursor-state");
    const code = back.searchParams.get("code");
    assert.ok(code);

    const token = await fetch(`${app.base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: client.client_id,
      }),
    });
    assert.equal(token.status, 200);
    const issued = (await token.json()) as { access_token: string; refresh_token: string; expires_in: number };
    assert.equal(issued.expires_in, 3600);
    assert.equal(app.store.getByAccessToken(issued.access_token, Date.now())?.webexAccessToken, "wx-access");

    const replay = await fetch(`${app.base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: client.client_id,
      }),
    });
    assert.equal(replay.status, 400);

    const refreshed = await fetch(`${app.base}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: issued.refresh_token }),
    });
    assert.equal(refreshed.status, 200);
    const rotated = (await refreshed.json()) as { access_token: string; refresh_token: string };
    assert.notEqual(rotated.refresh_token, issued.refresh_token);
    assert.equal(app.store.getByAccessToken(issued.access_token, Date.now()), undefined);

    const stale = await fetch(`${app.base}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: issued.refresh_token }),
    });
    assert.equal(stale.status, 400);

    const mcp = await fetch(`${app.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${rotated.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.notEqual(mcp.status, 401);
    const unauthenticated = await fetch(`${app.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);
  } finally {
    await app.close();
  }
});
