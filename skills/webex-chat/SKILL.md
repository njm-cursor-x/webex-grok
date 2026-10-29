---
name: webex-chat
description: Read and send Webex messages as the signed-in user. Use when the user asks to check a Webex space, read a direct conversation, find what was said, or send a Webex message.
---

# Webex chat

Use the Webex messaging connector. Do not drive the Webex website to read or send chat.

The tools act as the person who connected Webex. They can open every space that person belongs to, including direct conversations. They cannot open a space that person is not in.

## Find a space

Call `webex-search-spaces` or `webex-get-space`. Match the user's words against the space title. Use a direct space for a 1:1 and a group space for a room. If several titles match, ask which one before reading or sending.

## Read

Call `webex-get-message` or `webex-search-messages` for that space. Quote what you found. Do not invent messages that were not in the tool result. Call `webex-get-thread` only when the user asked about one thread.

## Send

Call `webex-create-message` only after the user has asked to send. Post as the connected user, in Webex markdown (`**bold**`, `*italic*`, lists, links). Do not use Slack formatting. Keep the text to what the user asked to say.

Do not delete messages, edit messages, change membership, upload files, or create webhooks unless the user explicitly asks for that.

If the tool says the Webex connection expired, ask the user to reconnect Webex from Connect apps. Do not ask them to create an API key.
