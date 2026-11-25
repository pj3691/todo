/**
 * 工具汇总入口。
 *
 * 新增工具时只需在这里挂上所属模块的数组：
 * 角色过滤与注册由 ToolRegistry 统一处理。
 *
 * 注意 `projectControlTools` 刻意不并入 `allTools`：
 * 它受 `agent.projectControl` 开关控制，未开启时连 tools/list 都不该出现，
 * 因此由宿主（内置助手 / MCP 入口）在读取配置后决定是否追加注册。
 */
import type { ToolDefinition } from "../define-tool.js";
import { accountTools } from "./account.js";
import { projectControlTools } from "./project-control.js";
import { projectTools } from "./projects.js";
import { timeTools } from "./time.js";
import { todoTools } from "./todo.js";

export const allTools: ToolDefinition[] = [
  ...accountTools,
  ...timeTools,
  ...todoTools,
  ...projectTools,
];

/** 需要显式开启才能注册的工具 */
export const gatedTools: ToolDefinition[] = [...projectControlTools];

/** 文档生成用：全部工具，含受开关控制的 */
export const documentedTools: ToolDefinition[] = [...allTools, ...gatedTools];
