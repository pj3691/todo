/**
 * 生成 docs/MCP工具说明.md。
 *
 * 工具清单、参数表、角色要求全部从工具定义读取，改代码后重跑即可同步；
 * 文件顶部「机制说明」是手写常量，生成时原样写到文件开头。
 *
 * 用法：npm run mcp:docs
 */
import fs from "node:fs";
import path from "node:path";
import { ROLE_LEVEL, hasRoleLevel, type ToolDefinition } from "./define-tool.js";
import { documentedTools } from "./tools/index.js";

const OUTPUT = path.resolve("docs/MCP工具说明.md");

/** 需要显式开启 agent.projectControl 才会注册的工具 */
const GATED_TOOL_NAMES = new Set([
  "gitstatus_project_start",
  "gitstatus_project_stop",
  "gitstatus_project_restart",
]);

/** 按工具名第二段分组，顺序即文档章节顺序 */
const GROUP_ORDER = [
  "whoami",
  "now",
  "todo",
  "category",
  "tag",
  "share",
  "today",
  "project",
  "port",
];

const GROUP_LABEL: Record<string, string> = {
  whoami: "账号",
  now: "时间",
  todo: "待办",
  category: "分类",
  tag: "标签",
  share: "共享",
  today: "汇总",
  project: "项目",
  port: "端口（只读）",
};

/** 各分组对应的后端接口前缀，方便对照 后端API说明.md */
const GROUP_ENDPOINT: Record<string, string> = {
  whoami: "`/gitstatus/api/auth/me`",
  now: "本地时钟，不访问接口",
  todo: "`/gitstatus/api/todos`",
  category: "`/gitstatus/api/todo-categories`",
  tag: "`/gitstatus/api/todo-tags`",
  share: "`/gitstatus/api/todo-shares`",
  today: "`/gitstatus/api/todo-widget/summary`",
  project: "`/gitstatus/api/projects`",
  port: "`/gitstatus/api/projects/ports/:port`",
};

const ROLE_LABEL: Record<string, string> = {
  readonly: "只读",
  readwrite: "读写",
  admin: "管理员",
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const groupOf = (name: string): string => name.split("_")[1] ?? "other";

const renderType = (node: Record<string, unknown>): string => {
  const raw = node.type;
  if (Array.isArray(raw)) return raw.map(String).join(" | ");
  if (raw === "array") {
    const items = asRecord(node.items);
    const itemType = Array.isArray(items.type)
      ? items.type.map(String).join(" | ")
      : String(items.type ?? "any");
    return `${itemType}[]`;
  }
  return typeof raw === "string" ? raw : "any";
};

const escapeCell = (text: string): string => text.replace(/\|/g, "\\|");

/** 一个工具的参数表 */
const renderParams = (tool: ToolDefinition): string => {
  const schema = asRecord(tool.parameters);
  const properties = asRecord(schema.properties);
  const required = Array.isArray(schema.required)
    ? schema.required.map(String)
    : [];
  const entries = Object.entries(properties);

  if (entries.length === 0) {
    return "无参数。";
  }

  const rows = entries.map(([key, value]) => {
    const node = asRecord(value);
    const enumText = Array.isArray(node.enum)
      ? `可选值：${node.enum.map(String).join(" / ")}`
      : "";
    const description = escapeCell(String(node.description ?? ""));
    const note = [description, enumText].filter(Boolean).join("；");
    const nullable = Array.isArray(node.type) && node.type.includes("null")
      ? "（可传 null）"
      : "";
    return `| \`${key}\` | ${renderType(node)} | ${required.includes(key) ? "是" : "否"} | ${note}${nullable} |`;
  });

  return [
    "| 参数 | 类型 | 必填 | 说明 |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
};

/** 单个工具的小节 */
const renderTool = (tool: ToolDefinition): string => {
  const role = `${ROLE_LABEL[tool.requiredRole] ?? tool.requiredRole}（\`${tool.requiredRole}\`）`;
  const lines = [
    `#### \`${tool.name}\` · ${tool.title}`,
    "",
    `> ${tool.description}`,
    "",
    `- 属性：${tool.readOnly ? "只读" : "可写"} · 最低角色 ${role}`,
    ...(GATED_TOOL_NAMES.has(tool.name)
      ? ["- 开关：需 `agent.projectControl` 开启后才会注册，默认关闭"]
      : []),
    "",
    renderParams(tool),
    "",
  ];
  return lines.join("\n");
};

/** 角色可见性统计表 */
const renderRoleMatrix = (tools: ToolDefinition[]): string => {
  const roles = ["readonly", "readwrite", "admin"] as const;
  const rows = roles.map((role) => {
    const visible = tools.filter((tool) => hasRoleLevel(role, tool.requiredRole));
    const writes = visible.filter((tool) => !tool.readOnly).length;
    return `| ${ROLE_LABEL[role]}（\`${role}\`） | ${visible.length} | ${writes} | ${visible.length - writes} |`;
  });
  return [
    "| 角色 | 可见工具 | 可写工具 | 只读工具 |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
};

/** 文件顶部的手写说明，生成时原样保留 */
const HEADER = `# MCP 工具说明

> 本文件的**工具清单部分**由 \`npm run mcp:docs\` 从 \`src/mcp/tools/\` 自动生成，改完工具定义重跑即可同步，请勿手改生成区。
> 机制说明与配置示例是手写的，可以直接编辑。

## 一、LLM 是怎么知道有哪些工具的

不需要它读这份文件。

MCP 是运行时发现协议：客户端连上服务端后会发一次 \`tools/list\`，服务端返回每个工具的

- \`name\`：工具标识
- \`description\`：一段自然语言说明，这段就是写给模型看的
- \`inputSchema\`：标准 JSON Schema 参数定义
- \`annotations\`：\`readOnlyHint\` / \`destructiveHint\`

客户端把这四项拼进模型上下文，模型就能像调用本地函数一样选择工具、填参数。所以**工具描述本身就是文档**，而且是运行时注入、永远与实现同步的那一份；本文件只是同一份信息给人查阅的镜像。

也正因为如此，决定调用准确率的是 \`description\` 的质量。本项目每个工具的说明都写了三件事：什么时候该用、参数是什么语义、边界在哪（比如项目启停工具明确写了「只接受项目 id，不能写命令」）。

如果客户端不支持 MCP，也可以把本文件连同 [后端API说明.md](./后端API说明.md) 一起交给模型，让它按工具语义直接拼 HTTP 请求。但那种方式没有 schema 约束、没有角色过滤，调用准确性和安全性都明显低于走 MCP。

## 二、连接配置

服务端入口是 \`src/mcp/main.ts\`，通过 stdio 通信。客户端配置示例：

\`\`\`json
{
  "mcpServers": {
    "gitstatus": {
      "command": "node",
      "args": ["node_modules/tsx/dist/cli.mjs", "src/mcp/main.ts"],
      "cwd": "d:\\\\1-WorkFile\\\\program\\\\gitStatus",
      "env": {
        "GITSTATUS_API_URL": "http://localhost:30012",
        "GITSTATUS_API_KEY": "gsk_你的密钥"
      }
    }
  }
}
\`\`\`

用 \`node\` + \`tsx\` 的 cli 路径而不是 \`npx tsx\`，是为了绕开 Windows 上 \`.cmd\` 的 PATH 解析问题。

| 环境变量 | 必填 | 说明 |
| --- | --- | --- |
| \`GITSTATUS_API_KEY\` | 是 | 账号页「我的 API 密钥」创建，\`gsk_\` 开头 |
| \`GITSTATUS_API_URL\` | 否 | 后端地址，默认 \`http://127.0.0.1:30012\` |
| \`GITSTATUS_MCP_TIMEOUT_MS\` | 否 | 单次调用超时，默认 20000 |
| \`GITSTATUS_MCP_READONLY\` | 否 | 设为 \`1\` 时只注册只读工具，进一步收窄权限 |
| \`GITSTATUS_AGENT_PROJECT_CONTROL\` | 否 | 设为 \`1\` 时为本客户端单独开启项目启停，覆盖 config.json |
| \`GITSTATUS_AGENT_ALLOWED_PROJECT_IDS\` | 否 | 逗号分隔的项目白名单，只放行列出的 id |
| \`GITSTATUS_AGENT_MAX_ACTIONS_PER_MINUTE\` | 否 | 每项目每分钟动作次数上限，默认 3 |
| \`GITSTATUS_CONFIG_PATH\` | 否 | 配置路径，默认 \`./config/config.json\` |

启动时服务端会先调一次 \`/auth/me\` 验证密钥并取出角色，密钥无效直接退出并在 stderr 给出原因，避免客户端拿到一屏必然失败的工具。

## 三、权限分级

工具可见性由密钥所属账号的**当前角色**决定，每次请求实时查库，改角色立即生效。无权使用的工具不会出现在 \`tools/list\` 里，而不是调用时才报错：只读账号看不到任何写工具，读写及以上才能看到写工具。各角色可见数量由自动生成区的总表给出。

项目启停工具还多两道门槛：

1. **开关**：\`config/config.json\` 的 \`agent.projectControl\` 为 \`true\`（或本进程设置了 \`GITSTATUS_AGENT_PROJECT_CONTROL=1\`）才会注册；关闭时这三个工具在 \`tools/list\` 里完全不存在。
2. **角色**：最低要求 \`admin\`，读写账号即使开关打开也看不到。

另有 \`allowedProjectIds\` 白名单（空表示全部）与每项目每分钟 3 次限流。MCP 通道无法做人工确认，所以真正的护栏是“默认关闭 + 管理员 + 白名单”；内置助手在页面上还会弹一次确认，展示将要执行的命令原文。

## 四、和 HTTP 接口的关系

MCP 服务不直接访问数据库，而是作为 \`/gitstatus/api\` 的普通客户端：

\`\`\`
MCP 客户端 → stdio → src/mcp → HTTP(Bearer gsk_) → Express 路由 → SQLite
\`\`\`

这样归属校验、共享权限、完成口径、审计日志全部沿用后端原有链路，MCP 层只做「参数收敛 + 结果投影」。各工具的接口前缀见每组标题下方。

要对照字段级细节，看 [后端API说明.md](./后端API说明.md)。

为什么项目启停默认关闭、为何命令执行与项目配置写入永远不开放，见 [AI能力边界与安全约定.md](./AI能力边界与安全约定.md)。

## 五、工具清单（自动生成）

`;

const main = (): void => {
  const tools = [...documentedTools];

  const sections: string[] = [];
  for (const group of GROUP_ORDER) {
    const items = tools.filter((tool) => groupOf(tool.name) === group);
    if (items.length === 0) continue;
    const label = GROUP_LABEL[group] ?? group;
    sections.push(
      [
        `### ${label}（${items.length} 个）`,
        "",
        `对应接口：${GROUP_ENDPOINT[group] ?? "—"}`,
        "",
        ...items.map(renderTool),
      ].join("\n"),
    );
  }

  const other = tools.filter((tool) => !GROUP_ORDER.includes(groupOf(tool.name)));
  if (other.length > 0) {
    sections.push(
      [`### 其他（${other.length} 个）`, "", ...other.map(renderTool)].join("\n"),
    );
  }

  const body = [
    HEADER.trimEnd(),
    `共 ${tools.length} 个工具，按域名分组。\`角色\` 是最低可调用角色，低于该角色的账号完全看不到该工具。`,
    "",
    "### 角色可见性总表",
    "",
    renderRoleMatrix(tools),
    "",
    ...sections,
  ].join("\n");

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${body.trimEnd()}\n`, "utf8");
  console.log(
    `generated ${path.relative(process.cwd(), OUTPUT)} · ${tools.length} tools · `
      + `roles ${Object.keys(ROLE_LEVEL).join("/")}`,
  );
};

main();
