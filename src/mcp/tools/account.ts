/**
 * 账号信息工具。
 *
 * 只暴露「我是谁」，不做用户管理的增删改：
 * 账号管理属于管理员页面操作，不适合交给模型自动执行。
 */
import { defineTool, type ToolDefinition } from "../define-tool.js";
import { asRecord, asText } from "./format.js";

export const accountTools: ToolDefinition[] = [
  defineTool({
    name: "gitstatus_whoami",
    title: "查看当前身份",
    description:
      "返回当前 API 密钥所属账号的用户名、角色（readonly/readwrite/admin）、状态与最后登录时间。"
      + "在调用其他工具前可用它确认权限范围。",
    readOnly: true,
    requiredRole: "readonly",
    parameters: {},
    async run(ctx) {
      const payload = await ctx.api.get("/auth/me");
      const user = asRecord(asRecord(payload).user);
      const text = [
        `账号：${asText(user.username) || "(未知)"}`,
        `角色：${asText(user.role)}`,
        `状态：${asText(user.status)}`,
        `注册时间：${asText(user.createdAt)}`,
        `最后登录：${asText(user.lastLoginAt) || "从未登录"}`,
      ].join("\n");
      return { text, structured: payload };
    },
  }),
];
