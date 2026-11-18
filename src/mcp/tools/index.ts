/**
 * 工具汇总入口。
 *
 * 新增工具时只需在这里挂上所属模块的数组：
 * 角色过滤与注册由 ToolRegistry 统一处理。
 */
import type { ToolDefinition } from "../define-tool.js";
import { accountTools } from "./account.js";
import { projectTools } from "./projects.js";
import { timeTools } from "./time.js";
import { todoTools } from "./todo.js";

export const allTools: ToolDefinition[] = [
  ...accountTools,
  ...timeTools,
  ...todoTools,
  ...projectTools,
];
