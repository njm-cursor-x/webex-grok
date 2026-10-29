import { WEBEX_SCOPES, type Config } from "./config.ts";

const TOKEN_URL = "https://webexapis.com/v1/access_token";
const API_ORIGIN = "https://webexapis.com/v1";
const WEBEX_TIMEOUT_MS = 20_000;

export type WebexTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export class WebexApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WebexApiError";
    this.status = status;
  }
}

export type Space = {
  id: string;
  title: string;
  type: string;
  lastActivity: string | null;
};

export type ChatMessage = {
  id: string;
  roomId: string;
  parentId: string | null;
  personEmail: string | null;
  created: string | null;
  text: string;
};

export function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string;
}): string {
  const url = new URL("https://webexapis.com/v1/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scopes ?? WEBEX_SCOPES);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (!match?.[1]) continue;
    try {
      const url = new URL(match[1]);
      if (url.protocol === "https:" && url.hostname === "webexapis.com") return url.toString();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

type FetchLike = typeof fetch;

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { message?: unknown };
    if (typeof body.message === "string" && body.message.length > 0) {
      return body.message.slice(0, 300);
    }
  } catch {
    // Fall through to the raw body, truncated.
  }
  return text.slice(0, 300) || `Webex request failed (${response.status})`;
}

export async function exchangeAuthorizationCode(
  fetchImpl: FetchLike,
  config: Pick<Config, "webexClientId" | "webexClientSecret">,
  code: string,
  redirectUri: string,
  now: number,
): Promise<WebexTokens> {
  return requestTokens(
    fetchImpl,
    {
      grant_type: "authorization_code",
      client_id: config.webexClientId,
      client_secret: config.webexClientSecret,
      code,
      redirect_uri: redirectUri,
    },
    now,
    "",
  );
}

export async function refreshWebexToken(
  fetchImpl: FetchLike,
  config: Pick<Config, "webexClientId" | "webexClientSecret">,
  refreshToken: string,
  now: number,
): Promise<WebexTokens> {
  return requestTokens(
    fetchImpl,
    {
      grant_type: "refresh_token",
      client_id: config.webexClientId,
      client_secret: config.webexClientSecret,
      refresh_token: refreshToken,
    },
    now,
    refreshToken,
  );
}

async function requestTokens(
  fetchImpl: FetchLike,
  fields: Record<string, string>,
  now: number,
  previousRefresh: string,
): Promise<WebexTokens> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(WEBEX_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new WebexApiError(await errorMessage(response), response.status);
  }
  const body = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new WebexApiError("Webex token response did not include an access token", response.status);
  }
  const refresh =
    typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? body.refresh_token
      : previousRefresh;
  if (refresh.length === 0) {
    throw new WebexApiError("Webex token response did not include a refresh token", response.status);
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 1209600;
  return {
    accessToken: body.access_token,
    refreshToken: refresh,
    expiresAt: now + Math.max(0, expiresIn - 60) * 1000,
  };
}

export class WebexClient {
  private readonly fetchImpl: FetchLike;
  private accessToken: string;
  private readonly refresh: () => Promise<string>;

  constructor(fetchImpl: FetchLike, accessToken: string, refresh: () => Promise<string>) {
    this.fetchImpl = fetchImpl;
    this.accessToken = accessToken;
    this.refresh = refresh;
  }

  async listSpaces(input: { type?: "direct" | "group"; query?: string; limit: number }): Promise<{
    spaces: Space[];
    truncated: boolean;
  }> {
    const first = new URL(`${API_ORIGIN}/rooms`);
    first.searchParams.set("max", "100");
    first.searchParams.set("sortBy", "lastactivity");
    if (input.type) first.searchParams.set("type", input.type);
    const collected: Space[] = [];
    let url: string | undefined = first.toString();
    let pages = 0;
    let more = false;
    while (url && pages < 3 && collected.length < 100) {
      const page = await this.getJson(url);
      pages += 1;
      const items = Array.isArray(page.items) ? page.items : [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const room = item as Record<string, unknown>;
        if (typeof room.id !== "string") continue;
        collected.push({
          id: room.id,
          title: typeof room.title === "string" ? room.title : "",
          type: typeof room.type === "string" ? room.type : "group",
          lastActivity: typeof room.lastActivity === "string" ? room.lastActivity : null,
        });
      }
      url = nextLink(page.link);
      more = Boolean(url);
    }
    const needle = input.query?.trim().toLowerCase();
    const filtered = needle
      ? collected.filter((space) => space.title.toLowerCase().includes(needle))
      : collected;
    return {
      spaces: filtered.slice(0, input.limit),
      truncated: more || filtered.length > input.limit,
    };
  }

  async listMessages(input: {
    roomId: string;
    parentId?: string;
    before?: string;
    limit: number;
  }): Promise<ChatMessage[]> {
    const url = new URL(`${API_ORIGIN}/messages`);
    url.searchParams.set("roomId", input.roomId);
    url.searchParams.set("max", String(input.limit));
    if (input.parentId) url.searchParams.set("parentId", input.parentId);
    if (input.before) url.searchParams.set("beforeMessage", input.before);
    const page = await this.getJson(url.toString());
    const items = Array.isArray(page.items) ? page.items : [];
    return items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const message = item as Record<string, unknown>;
      if (typeof message.id !== "string" || typeof message.roomId !== "string") return [];
      const text =
        typeof message.text === "string"
          ? message.text
          : typeof message.markdown === "string"
            ? message.markdown
            : "";
      return [
        {
          id: message.id,
          roomId: message.roomId,
          parentId: typeof message.parentId === "string" ? message.parentId : null,
          personEmail: typeof message.personEmail === "string" ? message.personEmail : null,
          created: typeof message.created === "string" ? message.created : null,
          text,
        },
      ];
    });
  }

  async sendMessage(input: {
    markdown: string;
    roomId?: string;
    toPersonEmail?: string;
  }): Promise<{ id: string; roomId: string | null; created: string | null; toPersonEmail: string | null }> {
    const payload: Record<string, string> = { markdown: input.markdown };
    if (input.roomId) payload.roomId = input.roomId;
    if (input.toPersonEmail) payload.toPersonEmail = input.toPersonEmail;
    const page = await this.sendJson(`${API_ORIGIN}/messages`, payload);
    if (typeof page.id !== "string") {
      throw new WebexApiError("Webex did not return a message id", 502);
    }
    return {
      id: page.id,
      roomId: typeof page.roomId === "string" ? page.roomId : input.roomId ?? null,
      created: typeof page.created === "string" ? page.created : null,
      toPersonEmail: typeof page.toPersonEmail === "string" ? page.toPersonEmail : input.toPersonEmail ?? null,
    };
  }

  private async getJson(url: string): Promise<{ items?: unknown; link: string | null } & Record<string, unknown>> {
    const response = await this.request(url);
    const link = response.headers.get("link");
    const body = (await response.json()) as Record<string, unknown>;
    return { ...body, link };
  }

  private async sendJson(url: string, payload: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.request(url, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return (await response.json()) as Record<string, unknown>;
  }

  private async request(url: string, init?: RequestInit): Promise<Response> {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.hostname !== "webexapis.com") {
      throw new WebexApiError("Refusing a Webex request outside webexapis.com", 400);
    }
    const run = (token: string) =>
      this.fetchImpl(target.toString(), {
        ...init,
        signal: AbortSignal.timeout(WEBEX_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(init?.body ? { "content-type": "application/json" } : {}),
        },
      });
    let response = await run(this.accessToken);
    if (response.status === 401) {
      this.accessToken = await this.refresh();
      response = await run(this.accessToken);
    }
    if (!response.ok) {
      throw new WebexApiError(await errorMessage(response), response.status);
    }
    return response;
  }
}
