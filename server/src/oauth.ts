import { isAllowedRedirect, webexConfigured, webexRedirectUri, type Config } from "./config.ts";
import { verifyS256 } from "./pkce.ts";
import type { TokenStore } from "./store.ts";
import { buildAuthorizeUrl, exchangeAuthorizationCode, type WebexApiError } from "./webex.ts";

export type OauthFailure = {
  status: number;
  error: string;
  description: string;
};

const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

export function protectedResourceMetadata(config: Config): Record<string, unknown> {
  return {
    resource: `${config.publicBaseUrl}/mcp`,
    authorization_servers: [config.publicBaseUrl],
    scopes_supported: ["webex"],
    bearer_methods_supported: ["header"],
  };
}

export function authorizationServerMetadata(config: Config): Record<string, unknown> {
  return {
    issuer: config.publicBaseUrl,
    authorization_endpoint: `${config.publicBaseUrl}/authorize`,
    token_endpoint: `${config.publicBaseUrl}/token`,
    registration_endpoint: `${config.publicBaseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["webex"],
  };
}

export function registerClient(
  store: TokenStore,
  config: Config,
  body: unknown,
  now: number,
): { clientId: string; redirectUris: string[] } | OauthFailure {
  if (!body || typeof body !== "object") {
    return { status: 400, error: "invalid_client_metadata", description: "Expected a JSON object" };
  }
  const record = body as Record<string, unknown>;
  const redirectUris = record.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.some((item) => typeof item !== "string")) {
    return { status: 400, error: "invalid_redirect_uri", description: "redirect_uris must be a non-empty string array" };
  }
  const uris = redirectUris as string[];
  if (uris.some((uri) => !isAllowedRedirect(config, uri))) {
    return { status: 400, error: "invalid_redirect_uri", description: "redirect_uri is not an allowed Cursor callback" };
  }
  const clientName = typeof record.client_name === "string" ? record.client_name.slice(0, 120) : undefined;
  const clientId = store.registerClient(uris, clientName, now);
  return { clientId, redirectUris: uris };
}

export function beginAuthorize(
  store: TokenStore,
  config: Config,
  query: URLSearchParams,
  now: number,
): { redirect: string } | OauthFailure {
  const redirectUri = query.get("redirect_uri") ?? "";
  const state = query.get("state") ?? "";
  const clientId = query.get("client_id") ?? "";
  const challenge = query.get("code_challenge") ?? "";
  const method = query.get("code_challenge_method") ?? "";
  const responseType = query.get("response_type") ?? "";

  const client = clientId ? store.getClient(clientId) : undefined;
  const canRedirect = client?.redirectUris.includes(redirectUri) && isAllowedRedirect(config, redirectUri);

  const fail = (error: string, description: string): { redirect: string } | OauthFailure => {
    if (!canRedirect) return { status: 400, error, description };
    const target = new URL(redirectUri);
    target.searchParams.set("error", error);
    target.searchParams.set("error_description", description);
    if (state) target.searchParams.set("state", state);
    return { redirect: target.toString() };
  };

  if (!webexConfigured(config)) {
    return fail("server_error", "Webex integration credentials are not configured");
  }
  if (responseType !== "code") return fail("unsupported_response_type", "response_type must be code");
  if (!client) return { status: 400, error: "invalid_client", description: "Unknown client_id" };
  if (!canRedirect) return { status: 400, error: "invalid_redirect_uri", description: "redirect_uri is not registered" };
  if (method !== "S256" || challenge.length < 43) {
    return fail("invalid_request", "PKCE S256 code_challenge is required");
  }
  if (!state) return fail("invalid_request", "state is required");

  const webexState = store.createTransaction({
    clientId,
    redirectUri,
    codeChallenge: challenge,
    cursorState: state,
    expiresAt: now + TRANSACTION_TTL_MS,
  });
  return {
    redirect: buildAuthorizeUrl({
      clientId: config.webexClientId,
      redirectUri: webexRedirectUri(config),
      state: webexState,
    }),
  };
}

export async function completeWebexCallback(
  store: TokenStore,
  config: Config,
  query: URLSearchParams,
  fetchImpl: typeof fetch,
  now: number,
): Promise<{ redirect: string } | OauthFailure> {
  const webexState = query.get("state") ?? "";
  const transaction = webexState ? store.takeTransaction(webexState, now) : undefined;
  if (!transaction) {
    return { status: 400, error: "invalid_request", description: "Unknown or expired sign-in attempt" };
  }
  const redirectBack = (error: string, description: string) => {
    const target = new URL(transaction.redirectUri);
    target.searchParams.set("error", error);
    target.searchParams.set("error_description", description);
    target.searchParams.set("state", transaction.cursorState);
    return { redirect: target.toString() };
  };
  if (query.get("error")) {
    return redirectBack("access_denied", "Webex sign-in was not completed");
  }
  const code = query.get("code");
  if (!code) return redirectBack("invalid_request", "Webex did not return an authorization code");
  try {
    const tokens = await exchangeAuthorizationCode(fetchImpl, config, code, webexRedirectUri(config), now);
    const sessionId = store.createSession(tokens);
    const authCode = store.createAuthCode({
      clientId: transaction.clientId,
      redirectUri: transaction.redirectUri,
      codeChallenge: transaction.codeChallenge,
      sessionId,
      expiresAt: now + CODE_TTL_MS,
    });
    const target = new URL(transaction.redirectUri);
    target.searchParams.set("code", authCode);
    target.searchParams.set("state", transaction.cursorState);
    return { redirect: target.toString() };
  } catch (error) {
    const status = (error as WebexApiError).status;
    console.log(JSON.stringify({ event: "webex_token_exchange_failed", status: status ?? 0 }));
    return redirectBack("server_error", "Webex token exchange failed");
  }
}

export function grantToken(
  store: TokenStore,
  config: Config,
  fields: URLSearchParams,
  now: number,
):
  | { accessToken: string; refreshToken: string; expiresIn: number }
  | OauthFailure {
  const grant = fields.get("grant_type") ?? "";
  if (grant === "refresh_token") {
    const refresh = fields.get("refresh_token") ?? "";
    const rotated = store.rotateRefresh(refresh, now, config.accessTtlSeconds, config.refreshTtlSeconds);
    if (!rotated) return { status: 400, error: "invalid_grant", description: "Refresh token is invalid or expired" };
    return { accessToken: rotated.accessToken, refreshToken: rotated.refreshToken, expiresIn: config.accessTtlSeconds };
  }
  if (grant !== "authorization_code") {
    return { status: 400, error: "unsupported_grant_type", description: "Unsupported grant_type" };
  }
  const code = fields.get("code") ?? "";
  const verifier = fields.get("code_verifier") ?? "";
  const redirectUri = fields.get("redirect_uri") ?? "";
  const clientId = fields.get("client_id") ?? "";
  const authCode = code ? store.takeAuthCode(code, now) : undefined;
  if (!authCode || authCode.clientId !== clientId || authCode.redirectUri !== redirectUri) {
    return { status: 400, error: "invalid_grant", description: "Authorization code is invalid or expired" };
  }
  if (!verifyS256(verifier, authCode.codeChallenge)) {
    return { status: 400, error: "invalid_grant", description: "PKCE verification failed" };
  }
  const issued = store.issueTokens(authCode.sessionId, now, config.accessTtlSeconds, config.refreshTtlSeconds);
  return { accessToken: issued.accessToken, refreshToken: issued.refreshToken, expiresIn: config.accessTtlSeconds };
}
