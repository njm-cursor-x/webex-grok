import { createHash } from "node:crypto";
import { tokensEqual } from "./crypto.ts";

export function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifyS256(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) return false;
  return tokensEqual(s256Challenge(verifier), challenge);
}
