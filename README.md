# Webex for Grok Bot

A Grok Bot plugin that reads and sends Webex messages as the person who connected it, and a skill that joins a Webex meeting in the bot's browser.

Webex hosts the messaging connector. This repository does not run a server.

## What it does

The plugin connects to Cisco's messaging connector at `https://mcp.webexapis.com/mcp/webex-messaging`. The person signs in with their company Webex account. They do not create an API key.

A Webex admin enables the Messaging MCP server once in Control Hub. Until that is on, Connect will not succeed for that company.

The tools act as the signed-in person. The chat skill uses them to find a space, read it, and send when asked.

`join-webex-meeting` tells the bot's computer how to open a meeting link in the browser. A waiting room counts as a successful join. The computer can see the screen and does not hear the call. Joining a meeting does not go through the messaging connector.

## Layout

- `.cursor-plugin/plugin.json` is the marketplace manifest.
- `mcp.json` points at Cisco's messaging connector.
- `skills/webex-chat` covers reading and sending.
- `skills/join-webex-meeting` covers joining a call in the browser.

## Marketplace

Grok Bot lists this plugin from the Cursor Marketplace because it has an MCP server and skills.

Submit the public repository at [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish). Review is manual. Questions go to marketplace-publishing@cursor.com. A later git push is not live until that review accepts the update.

A Cursor team admin can also add this repository as a team marketplace for a pilot, from the team Plugins page, without waiting on the public listing.
