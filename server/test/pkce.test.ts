import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { decryptString, encryptString } from "../src/crypto.ts";
import { encryptionKeyFromSecret } from "../src/config.ts";
import { s256Challenge, verifyS256 } from "../src/pkce.ts";

test("S256 accepts a matching verifier and rejects a mismatch", () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = s256Challenge(verifier);
  assert.equal(verifyS256(verifier, challenge), true);
  assert.equal(verifyS256(`${verifier}x`, challenge), false);
  assert.equal(verifyS256("short", challenge), false);
});

test("token ciphertext does not round-trip with the wrong key", () => {
  const key = encryptionKeyFromSecret("test-encryption-key-32b!!");
  const other = encryptionKeyFromSecret("another-encryption-key!!");
  const payload = encryptString("refresh-token", key);
  assert.equal(decryptString(payload, key), "refresh-token");
  assert.throws(() => decryptString(payload, other));
});
