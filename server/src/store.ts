import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { decryptString, encryptString, randomToken } from "./crypto.ts";

export type StoredSession = {
  id: string;
  webexAccessToken: string;
  webexRefreshToken: string;
  webexExpiresAt: number;
};

type SessionRow = {
  id: string;
  access_hash: string | null;
  refresh_hash: string | null;
  access_expires_at: number | null;
  refresh_expires_at: number | null;
  webex_access: string;
  webex_refresh: string;
  webex_expires_at: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export class TokenStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

  constructor(path: string, key: Buffer) {
    this.key = key;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        redirect_uris TEXT NOT NULL,
        client_name TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transactions (
        webex_state TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        cursor_state TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        session_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        access_hash TEXT UNIQUE,
        refresh_hash TEXT UNIQUE,
        access_expires_at INTEGER,
        refresh_expires_at INTEGER,
        webex_access TEXT NOT NULL,
        webex_refresh TEXT NOT NULL,
        webex_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  registerClient(redirectUris: string[], clientName: string | undefined, now: number): string {
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM clients").get() as { n: number };
    if (count.n >= 5000) {
      this.db
        .prepare(
          `DELETE FROM clients WHERE client_id IN (
             SELECT client_id FROM clients ORDER BY created_at ASC LIMIT 500
           )`,
        )
        .run();
    }
    const clientId = randomToken(16);
    this.db
      .prepare(
        "INSERT INTO clients (client_id, redirect_uris, client_name, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(clientId, JSON.stringify(redirectUris), clientName ?? null, now);
    return clientId;
  }

  getClient(clientId: string): { clientId: string; redirectUris: string[] } | undefined {
    const row = this.db
      .prepare("SELECT client_id, redirect_uris FROM clients WHERE client_id = ?")
      .get(clientId) as { client_id: string; redirect_uris: string } | undefined;
    if (!row) return undefined;
    const redirectUris = JSON.parse(row.redirect_uris) as unknown;
    if (!Array.isArray(redirectUris) || redirectUris.some((item) => typeof item !== "string")) {
      return undefined;
    }
    return { clientId: row.client_id, redirectUris };
  }

  createTransaction(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    cursorState: string;
    expiresAt: number;
  }): string {
    const webexState = randomToken(24);
    this.db.prepare("DELETE FROM transactions WHERE expires_at <= ?").run(Date.now());
    this.db
      .prepare(
        `INSERT INTO transactions
          (webex_state, client_id, redirect_uri, code_challenge, cursor_state, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        webexState,
        input.clientId,
        input.redirectUri,
        input.codeChallenge,
        input.cursorState,
        input.expiresAt,
      );
    return webexState;
  }

  takeTransaction(webexState: string, now: number): {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    cursorState: string;
  } | undefined {
    const row = this.db
      .prepare(
        `DELETE FROM transactions
         WHERE webex_state = ? AND expires_at > ?
         RETURNING client_id, redirect_uri, code_challenge, cursor_state`,
      )
      .get(webexState, now) as
      | {
          client_id: string;
          redirect_uri: string;
          code_challenge: string;
          cursor_state: string;
        }
      | undefined;
    if (!row) {
      this.db.prepare("DELETE FROM transactions WHERE webex_state = ?").run(webexState);
      return undefined;
    }
    return {
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      cursorState: row.cursor_state,
    };
  }

  createSession(tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }): string {
    const id = randomToken(16);
    const now = Date.now();
    this.db
      .prepare("DELETE FROM sessions WHERE refresh_expires_at IS NOT NULL AND refresh_expires_at <= ?")
      .run(now);
    this.db
      .prepare("DELETE FROM sessions WHERE access_hash IS NULL AND created_at <= ?")
      .run(now - 60 * 60 * 1000);
    this.db
      .prepare(
        `INSERT INTO sessions
          (id, webex_access, webex_refresh, webex_expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        encryptString(tokens.accessToken, this.key),
        encryptString(tokens.refreshToken, this.key),
        tokens.expiresAt,
        now,
      );
    return id;
  }

  createAuthCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    sessionId: string;
    expiresAt: number;
  }): string {
    const code = randomToken(32);
    this.db.prepare("DELETE FROM auth_codes WHERE expires_at <= ?").run(Date.now());
    this.db
      .prepare(
        `INSERT INTO auth_codes
          (code, client_id, redirect_uri, code_challenge, session_id, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha256(code),
        input.clientId,
        input.redirectUri,
        input.codeChallenge,
        input.sessionId,
        input.expiresAt,
      );
    return code;
  }

  takeAuthCode(code: string, now: number): {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    sessionId: string;
  } | undefined {
    const row = this.db
      .prepare(
        `DELETE FROM auth_codes
         WHERE code = ? AND expires_at > ?
         RETURNING client_id, redirect_uri, code_challenge, session_id`,
      )
      .get(sha256(code), now) as
      | {
          client_id: string;
          redirect_uri: string;
          code_challenge: string;
          session_id: string;
        }
      | undefined;
    if (!row) {
      this.db.prepare("DELETE FROM auth_codes WHERE code = ?").run(sha256(code));
      return undefined;
    }
    return {
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      sessionId: row.session_id,
    };
  }

  issueTokens(
    sessionId: string,
    now: number,
    accessTtlSeconds: number,
    refreshTtlSeconds: number,
  ): { accessToken: string; refreshToken: string } {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const updated = this.db
      .prepare(
        `UPDATE sessions
         SET access_hash = ?, refresh_hash = ?, access_expires_at = ?, refresh_expires_at = ?
         WHERE id = ?`,
      )
      .run(
        sha256(accessToken),
        sha256(refreshToken),
        now + accessTtlSeconds * 1000,
        now + refreshTtlSeconds * 1000,
        sessionId,
      );
    if (updated.changes !== 1) {
      throw new Error("session not found");
    }
    return { accessToken, refreshToken };
  }

  getByAccessToken(accessToken: string, now: number): StoredSession | undefined {
    const row = this.db
      .prepare(
        `SELECT id, access_hash, refresh_hash, access_expires_at, refresh_expires_at,
                webex_access, webex_refresh, webex_expires_at
         FROM sessions WHERE access_hash = ?`,
      )
      .get(sha256(accessToken)) as SessionRow | undefined;
    if (!row || row.access_expires_at == null || row.access_expires_at <= now) return undefined;
    return this.toSession(row);
  }

  rotateRefresh(
    refreshToken: string,
    now: number,
    accessTtlSeconds: number,
    refreshTtlSeconds: number,
  ): { accessToken: string; refreshToken: string; session: StoredSession } | undefined {
    const accessToken = randomToken(32);
    const nextRefresh = randomToken(32);
    const row = this.db
      .prepare(
        `UPDATE sessions
         SET access_hash = ?, refresh_hash = ?, access_expires_at = ?, refresh_expires_at = ?
         WHERE refresh_hash = ? AND refresh_expires_at > ?
         RETURNING id, access_hash, refresh_hash, access_expires_at, refresh_expires_at,
                   webex_access, webex_refresh, webex_expires_at`,
      )
      .get(
        sha256(accessToken),
        sha256(nextRefresh),
        now + accessTtlSeconds * 1000,
        now + refreshTtlSeconds * 1000,
        sha256(refreshToken),
        now,
      ) as SessionRow | undefined;
    if (!row) return undefined;
    return { accessToken, refreshToken: nextRefresh, session: this.toSession(row) };
  }

  updateWebexTokens(
    sessionId: string,
    tokens: { accessToken: string; refreshToken: string; expiresAt: number },
  ): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET webex_access = ?, webex_refresh = ?, webex_expires_at = ?
         WHERE id = ?`,
      )
      .run(
        encryptString(tokens.accessToken, this.key),
        encryptString(tokens.refreshToken, this.key),
        tokens.expiresAt,
        sessionId,
      );
  }

  private toSession(row: SessionRow): StoredSession {
    return {
      id: row.id,
      webexAccessToken: decryptString(row.webex_access, this.key),
      webexRefreshToken: decryptString(row.webex_refresh, this.key),
      webexExpiresAt: row.webex_expires_at,
    };
  }
}
