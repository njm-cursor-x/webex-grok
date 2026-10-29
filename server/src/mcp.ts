import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WebexApiError, type WebexClient } from "./webex.ts";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function failure(error: unknown) {
  const message = error instanceof WebexApiError ? error.message : "Webex request failed";
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

export function createMcpServer(client: WebexClient): McpServer {
  const server = new McpServer({ name: "webex", version: "0.1.0" });

  server.registerTool(
    "list_spaces",
    {
      title: "List Webex spaces",
      description:
        "List Webex spaces the signed-in user belongs to, including direct conversations and locked rooms. Optionally filter by title.",
      inputSchema: {
        type: z.enum(["direct", "group"]).optional().describe("direct is a 1:1 conversation. group is a room."),
        query: z.string().max(200).optional().describe("Case-insensitive match against the space title."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum spaces to return. Defaults to 50."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        return text(await client.listSpaces({ type: args.type, query: args.query, limit: args.limit ?? 50 }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_messages",
    {
      title: "Read Webex messages",
      description:
        "Read the most recent messages in a Webex space the signed-in user belongs to. Results are newest first. Pass before with a message id to page older messages. Pass parentId only for one thread.",
      inputSchema: {
        roomId: z.string().min(1).max(256).describe("Space id from list_spaces."),
        parentId: z.string().min(1).max(256).optional().describe("Parent message id when reading a single thread."),
        before: z.string().min(1).max(256).optional().describe("Message id. Older messages are read with Webex beforeMessage."),
        limit: z.number().int().min(1).max(100).optional().describe("Page size. Defaults to 30."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const messages = await client.listMessages({
          roomId: args.roomId,
          parentId: args.parentId,
          before: args.before,
          limit: args.limit ?? 30,
        });
        return text({ messages });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a Webex message",
      description:
        "Post a markdown message as the signed-in user. Provide roomId or toPersonEmail, not both. Only call this when the user asked to send.",
      inputSchema: {
        markdown: z.string().min(1).max(7000).describe("Message body in Webex markdown."),
        roomId: z.string().min(1).max(256).optional().describe("Space id to post in."),
        toPersonEmail: z.string().min(3).max(320).optional().describe("Email address for a 1:1 message."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async (args) => {
      const hasRoom = Boolean(args.roomId);
      const hasEmail = Boolean(args.toPersonEmail);
      if (hasRoom === hasEmail) {
        return failure(new WebexApiError("Provide either roomId or toPersonEmail", 400));
      }
      if (args.toPersonEmail && !/^[^\s@]+@[^\s@]+$/.test(args.toPersonEmail)) {
        return failure(new WebexApiError("toPersonEmail must be an email address", 400));
      }
      try {
        return text(
          await client.sendMessage({
            markdown: args.markdown,
            roomId: args.roomId,
            toPersonEmail: args.toPersonEmail,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
