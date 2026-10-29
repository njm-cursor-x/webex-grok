# Webex for Grok Bot

A Grok Bot plugin that lets a bot read and send Webex messages as the person who connected it, and a skill that joins a Webex meeting in the bot's browser.

The person connecting Webex signs in with their company account. They do not create an API key. A Webex admin allows the integration once in Control Hub.

## What it does

- `list_spaces` lists group rooms and direct conversations the signed-in user belongs to.
- `list_messages` reads messages in one of those spaces, including a thread.
- `send_message` posts as that user.
- `join-webex-meeting` tells the bot's computer how to open a meeting link in the browser. A waiting room counts as a successful join. The computer can see the screen and does not hear the call.

This is a personal connector. It does not sit in Webex as its own bot, and it does not listen for new messages in the background.

## Layout

- `.cursor-plugin/plugin.json`, `mcp.json`, and `skills/` are the marketplace plugin.
- `server/` is the connector. Cursor signs in there with PKCE. The server sends the user to Webex, stores the refresh token encrypted, and calls the Webex REST API with that user's token.

`mcp.json` points at the deployed server. Until that host exists, the URL is `https://pending-deploy.invalid/mcp` and Connect will not succeed.

## Run the server locally

```bash
cd server
cp .env.example .env
# Fill in WEBEX_CLIENT_ID, WEBEX_CLIENT_SECRET, and TOKEN_ENCRYPTION_KEY.
npm ci
npm test
npm start
```

The server listens on port 8788. `GET /healthz` returns `{ "ok": true }`.

Create one [Webex Integration](https://developer.webex.com/my-apps) (not a bot, and not a personal access token). Set the redirect URI to:

```text
http://127.0.0.1:8788/oauth/webex/callback
```

Use that same origin, without a trailing slash, as `PUBLIC_BASE_URL`. Request these scopes:

```text
spark:people_read spark:rooms_read spark:messages_read spark:messages_write
```

For a public host, register `https://<host>/oauth/webex/callback` instead and set `PUBLIC_BASE_URL` to `https://<host>`.

## Docker

```bash
docker build -t webex-grokbot server
docker run --rm -p 8788:8788 \
  -e PUBLIC_BASE_URL=https://<host> \
  -e WEBEX_CLIENT_ID \
  -e WEBEX_CLIENT_SECRET \
  -e TOKEN_ENCRYPTION_KEY \
  -v webex-data:/data \
  webex-grokbot
```

The SQLite file lives at `/data/webex.sqlite`. Use a persistent disk so refresh tokens survive a restart.

Keep the Webex client secret and `TOKEN_ENCRYPTION_KEY` in the host environment. Do not commit them.

## Railway

The service root is `server/` (`railway.toml` is there). Mount a volume at `/data`. Set:

```text
PUBLIC_BASE_URL=https://<railway-domain>
DATA_PATH=/data/webex.sqlite
WEBEX_CLIENT_ID=
WEBEX_CLIENT_SECRET=
TOKEN_ENCRYPTION_KEY=
```

Register `https://<railway-domain>/oauth/webex/callback` as the Integration redirect URI. Leave the service awake, and run one replica. The token database is a single SQLite file.

## Marketplace

Grok Bot lists this plugin from the Cursor Marketplace because it has an MCP server and skills.

1. Deploy the server and replace the URL in `mcp.json` with `https://<host>/mcp`.
2. Open a pull request. BugBot and a security review should be clean before the listing goes in.
3. Submit the public repository at [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish).

Review is manual. Questions go to marketplace-publishing@cursor.com. A later git push is not live until that review accepts the update.

A Cursor team admin can also add this repository as a team marketplace for a pilot, from the team Plugins page, without waiting on the public listing.
