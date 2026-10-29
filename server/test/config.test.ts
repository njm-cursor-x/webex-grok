import assert from "node:assert/strict";
import test from "node:test";
import { acceptedExtraRedirect, loadConfig } from "../src/config.ts";

const key = "a".repeat(32);

test("config rejects a short encryption key and a non-https extra redirect", () => {
  assert.throws(() => loadConfig({ TOKEN_ENCRYPTION_KEY: "short-key-value" }), /32 characters/);
  assert.equal(acceptedExtraRedirect("https://example.com/callback"), true);
  assert.equal(acceptedExtraRedirect("http://localhost:8787/callback"), true);
  assert.equal(acceptedExtraRedirect("http://evil.example/callback"), false);
  assert.throws(
    () => loadConfig({ TOKEN_ENCRYPTION_KEY: key, ALLOWED_REDIRECT_URIS: "http://evil.example/callback" }),
    /ALLOWED_REDIRECT_URIS/,
  );
  const config = loadConfig({ TOKEN_ENCRYPTION_KEY: key, PORT: "8788" });
  assert.equal(config.publicBaseUrl, "http://127.0.0.1:8788");
});
