---
name: webex-chat
description: Read and send Webex messages as the signed-in user. Use when the user asks to check a Webex space, read a direct conversation, find what was said, or send a Webex message.
---

# Webex chat

Use the Webex connector tools for messages. Do not drive the Webex website to read or send chat.

The tools act as the person who connected Webex. They can open every space that person belongs to, including direct conversations and locked spaces. They cannot open a space that person is not in.

## Find a space

Call `list_spaces`. Match the user's words against `title`. Use `type: "direct"` for a 1:1 and `type: "group"` for a room. If several titles match, ask which one before reading or sending.

## Read

Call `list_messages` with the space `id`. The list is the most recent page, newest first. Pass `before` (a message id from the page) to read older messages. Pass `parentId` only when the user asked about one thread.

Quote what you found. Do not invent messages that were not in the tool result.

## Send

Call `send_message` only after the user has asked to send. Use `roomId` for a space, or `toPersonEmail` for a 1:1 when you do not have a room id. Do not pass both.

The message is posted as the connected user, in Webex markdown (`**bold**`, `*italic*`, lists, links). Do not use Slack formatting. Keep the text to what the user asked to say.

If the tool says the Webex connection expired, ask the user to reconnect Webex from Connect apps. Do not ask them to create an API key.

There is no delete tool. Do not try to delete or edit messages from the browser.
