/**
 * GitStatus MCP 服务入口（stdio）。
 *
 * 由 MCP 客户端以子进程方式拉起，通过 stdin/stdout 通信。
 * 因此这里**绝不能写 stdout**：协议消息独占 stdout，所有日志走 stderr。
 *
 * 环境变量：
 * - GITSTATUS_API_URL    后端地址，默认 http://127.0.0.1:30012
 * - GITSTATUS_API_KEY    必填，GitStatus 账号页创建的 API 密钥（gsk_ 开头）
 * - GITSTATUS_MCP_TIMEOUT_MS  单次调用超时，默认 20000
 * - GITSTATUS_MCP_READONLY    设为 1 时只注册只读工具
 * - GITSTATUS_CONFIG_PATH     配置路径，默认 ./config/config.json
 *
 * 项目启停能力默认关闭。开启方式：config/config.json 的 `agent.projectControl` 设为 true，
 * 或用 `GITSTATUS_AGENT_PROJECT_CONTROL=1` 为单个客户端单独授权；
 * 还可用 `GITSTATUS_AGENT_ALLOWED_PROJECT_IDS=1,2` 限制可操作项目。
 */
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApiClient } from "./api-client.js";
import { ToolRegistry, type UserRole } from "./define-tool.js";
import { readProjectControlConfig } from "./project-policy.js";
import { createMcpServer } from "./server.js";
import { allTools, gatedTools } from "./tools/index.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:30012";
const DEFAULT_TIMEOUT_MS = 20_000;

const log = (message: string): void => {
  // stdout 是 MCP 协议通道，日志必须走 stderr，否则会让客户端解析失败
  process.stderr.write(`[gitstatus-mcp] ${message}\n`);
};

const isUserRole = (value: unknown): value is UserRole =>
  value === "readonly" || value === "readwrite" || value === "admin";

interface McpConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  readOnlyMode: boolean;
}

const readConfig = (): McpConfig => {
  const timeoutRaw = Number(process.env.GITSTATUS_MCP_TIMEOUT_MS);
  return {
    baseUrl: (process.env.GITSTATUS_API_URL || DEFAULT_BASE_URL).trim(),
    apiKey: (process.env.GITSTATUS_API_KEY || "").trim(),
    timeoutMs:
      Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? timeoutRaw
        : DEFAULT_TIMEOUT_MS,
    readOnlyMode: ["1", "true"].includes(
      (process.env.GITSTATUS_MCP_READONLY || "").toLowerCase(),
    ),
  };
};

const main = async (): Promise<void> => {
  const config = readConfig();
  if (!config.apiKey) {
    log(
      "缺少 GITSTATUS_API_KEY。请先在 GitStatus 账号页创建 API 密钥，再把它配到 MCP 客户端的环境变量里。",
    );
    process.exit(1);
  }

  const api = createApiClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  });

  // 启动时先确认密钥有效并取出角色：
  // 否则客户端会拿到一整屏必然失败的工具，排查成本更高
  let username = "";
  let role: UserRole = "readonly";
  try {
    const me = await api.get("/auth/me");
    const user =
      typeof me === "object" && me !== null
        ? ((me as { user?: unknown }).user as Record<string, unknown> | undefined)
        : undefined;
    username = String(user?.username ?? "");
    if (isUserRole(user?.role)) role = user.role;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`无法使用该密钥访问 ${config.baseUrl}：${message}`);
    process.exit(1);
  }

  const registry = new ToolRegistry();
  const baseTools = config.readOnlyMode
    ? allTools.filter((tool) => tool.readOnly)
    : allTools;
  registry.add(...baseTools);

  /**
   * 项目启停：开关、白名单、限流三层都在后端之外再拦一道。
   * MCP 通道没有人工确认（控制不了客户端 UI），所以默认关闭尤其重要。
   */
  const projectControl = readProjectControlConfig({
    configPath: process.env.GITSTATUS_CONFIG_PATH
      ? path.resolve(process.env.GITSTATUS_CONFIG_PATH)
      : path.resolve("config/config.json"),
  });
  if (projectControl.enabled && !config.readOnlyMode) {
    registry.add(...gatedTools);
  }

  const context = projectControl.enabled && !config.readOnlyMode
    ? {
        api,
        role,
        channel: "mcp" as const,
        projectControl: projectControl.policy,
        audit: (entry: unknown) => log(`[audit] ${JSON.stringify(entry)}`),
      }
    : { api, role, channel: "mcp" as const };

  const server = createMcpServer({ registry, context });
  await server.connect(new StdioServerTransport());

  log(
    `已连接 ${config.baseUrl} · 账号 ${username || "(未知)"} · 角色 ${role} · `
      + `${registry.visible(role).length}/${registry.size} 个工具可用`
      + `${config.readOnlyMode ? " · 只读模式" : ""}`
      + ` · 项目启停 ${projectControl.enabled && !config.readOnlyMode ? projectControl.reason : "disabled"}`,
  );
};

main().catch((error: unknown) => {
  log(`启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
