import assert from "node:assert/strict";
import test from "node:test";
import { buildAuthorizeUrl, nextLink, refreshWebexToken, WebexClient } from "../src/webex.ts";

const config = { webexClientId: "client", webexClientSecret: "secret" };

test("authorize URL uses the Webex v1 endpoint and the requested scopes", () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: "client",
      redirectUri: "https://example.com/oauth/webex/callback",
      state: "state-1",
    }),
  );
  assert.equal(url.origin + url.pathname, "https://webexapis.com/v1/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("redirect_uri"), "https://example.com/oauth/webex/callback");
  assert.match(url.searchParams.get("scope") ?? "", /spark:messages_read/);
  assert.match(url.searchParams.get("scope") ?? "", /spark:messages_write/);
});

test("next link parser reads the rel=next URL", () => {
  assert.equal(
    nextLink('<https://webexapis.com/v1/rooms?cursor=abc>; rel="next"'),
    "https://webexapis.com/v1/rooms?cursor=abc",
  );
  assert.equal(nextLink(null), undefined);
  assert.equal(nextLink('<https://evil.example/steal>; rel="next"'), undefined);
  assert.equal(nextLink('<http://webexapis.com/v1/rooms>; rel="next"'), undefined);
});

test("list and send call the signed-in user's Webex API", async () => {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/rooms")) {
      return Response.json({
        items: [
          { id: "room-1", title: "Launch", type: "group", lastActivity: "2026-10-01T00:00:00.000Z" },
          { id: "room-2", title: "Ada Lovelace", type: "direct", lastActivity: "2026-10-02T00:00:00.000Z" },
        ],
      });
    }
    if (url.includes("/messages") && (init?.method ?? "GET") === "GET") {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("roomId"), "room-1");
      assert.equal(parsed.searchParams.get("parentId"), "parent-1");
      assert.equal(parsed.searchParams.get("beforeMessage"), "msg-0");
      assert.equal(parsed.searchParams.get("before"), null);
      return Response.json({
        items: [
          {
            id: "msg-1",
            roomId: "room-1",
            parentId: "parent-1",
            personEmail: "ada@example.com",
            created: "2026-10-02T00:00:00.000Z",
            text: "hello",
          },
        ],
      });
    }
    const body = JSON.parse(String(init?.body)) as { markdown: string; toPersonEmail: string };
    assert.equal(body.markdown, "**hi**");
    assert.equal(body.toPersonEmail, "ada@example.com");
    return Response.json({ id: "msg-2", roomId: "room-2", created: "2026-10-03T00:00:00.000Z" });
  };

  const client = new WebexClient(fetchImpl, "access", async () => "refreshed");
  const spaces = await client.listSpaces({ query: "launch", limit: 10 });
  assert.deepEqual(spaces.spaces.map((space) => space.id), ["room-1"]);
  const messages = await client.listMessages({
    roomId: "room-1",
    parentId: "parent-1",
    before: "msg-0",
    limit: 10,
  });
  assert.equal(messages[0]?.text, "hello");
  const sent = await client.sendMessage({ markdown: "**hi**", toPersonEmail: "ada@example.com" });
  assert.equal(sent.id, "msg-2");
  assert.ok(seen.every((call) => !call.includes("access")));
});

test("a 401 refreshes the Webex token once and retries", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/access_token")) {
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 100 });
    }
    calls += 1;
    if (calls === 1) return Response.json({ message: "expired" }, { status: 401 });
    return Response.json({ items: [{ id: "room-1", title: "Launch", type: "group" }] });
  };
  const refreshed = await refreshWebexToken(fetchImpl, config, "old-refresh", 1_000);
  assert.equal(refreshed.accessToken, "new-access");
  assert.equal(refreshed.refreshToken, "new-refresh");
  assert.equal(refreshed.expiresAt, 1_000 + 40_000);

  let current = "old-access";
  const client = new WebexClient(fetchImpl, current, async () => {
    const next = await refreshWebexToken(fetchImpl, config, "old-refresh", 1_000);
    current = next.accessToken;
    return current;
  });
  const spaces = await client.listSpaces({ limit: 5 });
  assert.equal(spaces.spaces[0]?.id, "room-1");
  assert.equal(calls, 2);
});
