/**
 * MCP 服务端。
 *
 * 使用 SDK 的低层 Server + JSON Schema 直通：
 * 工具的 inputSchema 已由 defineTool 编译成标准 JSON Schema，
 * 不需要再经过 Zod 之类的中间层，避免第二份 schema 来源。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext, ToolRegistry } from "./define-tool.js";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describeError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

/** 工具执行失败：按 MCP 约定用 isError 结果返回，而不是让请求报协议错误 */
const errorResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

export interface CreateServerOptions {
  registry: ToolRegistry;
  context: ToolContext;
}

export const createMcpServer = (
  options: CreateServerOptions,
): Server => {
  const { registry, context } = options;
  // 角色在进程生命周期内不变，工具可见性只需算一次
  const visible = registry.visible(context.role);

  const server = new Server(
    { name: "gitstatus", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visible.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.parameters,
      annotations: {
        readOnlyHint: tool.readOnly,
        // 非只读工具都带破坏性提示，让客户端在调用前有机会确认
        destructiveHint: !tool.readOnly,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const tool = visible.find((item) => item.name === name);
    if (!tool) {
      // 区分「不存在」与「当前角色不可见」，否则排查时容易误判成拼写错误
      const registered = registry.get(name) !== undefined;
      return errorResult(
        registered
          ? `当前账号角色（${context.role}）无权调用工具 ${name}`
          : `未知工具：${name}`,
      );
    }

    try {
      const args = isPlainObject(request.params.arguments)
        ? request.params.arguments
        : {};
      const outcome = await tool.run(context, args);
      const structured = isPlainObject(outcome.structured)
        ? outcome.structured
        : undefined;
      return {
        content: [{ type: "text" as const, text: outcome.text }],
        ...(structured === undefined ? {} : { structuredContent: structured }),
      };
    } catch (error) {
      return errorResult(describeError(error));
    }
  });

  return server;
};
