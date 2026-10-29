import { createHash } from "node:crypto";

export const WEBEX_SCOPES = [
  "spark:people_read",
  "spark:rooms_read",
  "spark:messages_read",
  "spark:messages_write",
].join(" ");

export const CURSOR_REDIRECT_URIS = [
  "https://www.cursor.com/agents/mcp/oauth/callback",
  "http://localhost:8787/callback",
];

export type Config = {
  port: number;
  publicBaseUrl: string;
  webexClientId: string;
  webexClientSecret: string;
  encryptionKey: Buffer;
  dataPath: string;
  extraRedirectUris: string[];
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
};

export function webexRedirectUri(config: Config): string {
  return `${config.publicBaseUrl}/oauth/webex/callback`;
}

export function webexConfigured(config: Config): boolean {
  return config.webexClientId.length > 0 && config.webexClientSecret.length > 0;
}

export function isAllowedRedirect(config: Config, uri: string): boolean {
  return CURSOR_REDIRECT_URIS.includes(uri) || config.extraRedirectUris.includes(uri);
}

export function acceptedExtraRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return url.protocol === "http:" && local;
}

export function encryptionKeyFromSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const secret = env.TOKEN_ENCRYPTION_KEY?.trim() ?? "";
  if (secret.length < 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be at least 32 characters");
  }
  const port = Number(env.PORT ?? "8788");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(publicBaseUrl);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("PUBLIC_BASE_URL must be http or https");
  }
  const extra = (env.ALLOWED_REDIRECT_URIS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (extra.some((uri) => !acceptedExtraRedirect(uri))) {
    throw new Error("ALLOWED_REDIRECT_URIS entries must be https, or http on localhost");
  }
  return {
    port,
    publicBaseUrl,
    webexClientId: env.WEBEX_CLIENT_ID?.trim() ?? "",
    webexClientSecret: env.WEBEX_CLIENT_SECRET?.trim() ?? "",
    encryptionKey: encryptionKeyFromSecret(secret),
    dataPath: env.DATA_PATH?.trim() || "./data/webex.sqlite",
    extraRedirectUris: extra,
    accessTtlSeconds: 60 * 60,
    refreshTtlSeconds: 60 * 24 * 60 * 60,
  };
}
