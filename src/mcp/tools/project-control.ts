/**
 * 项目管理工具（启停）。
 *
 * 这三个工具只有在 `agent.projectControl` 显式开启时才会注册，
 * 关闭时连 `tools/list` 里都看不到——这比「注册了但调用时报错」好，
 * 后者会让模型反复重试。
 *
 * 安全边界（见 docs/AI能力边界与安全约定.md）：
 * - 参数只有 id，绝不接受命令文本；命令原文来自数据库里已有的项目配置
 * - 最低角色 admin：启停影响的是服务器进程，与改数据不是一个量级
 * - 项目白名单 + 每项目每分钟限流，防模型陷入重启循环
 * - 内置助手上执行前要求用户在页面上确认，并展示将要执行的命令
 * - 每次调用写审计日志，包含通道（web / mcp）
 *
 * 刻意不提供：自定义命令执行、端口 kill、项目配置写入。
 */
import {
  defineTool,
  type ConfirmRequest,
  type ProjectControlPolicy,
  type ToolContext,
  type ToolAuditEntry,
  type ToolDefinition,
} from "../define-tool.js";
import { createActionLimiter } from "../project-policy.js";
import { asArray, asNumber, asRecord, asText } from "./format.js";

type ProjectAction = "start" | "stop" | "restart";

const ACTION_LABEL: Record<ProjectAction, string> = {
  start: "启动",
  stop: "停止",
  restart: "重启",
};

/**
 * 限流器随工具集创建。
 *
 * 开关关闭时整套工具不注册，这里也就不会被构造；
 * 开关重新打开需要重启后端，计数自然清零，不存在残留状态。
 */
const limiters = new Map<number, ReturnType<typeof createActionLimiter>>();

const limiterFor = (maxPerMinute: number) => {
  const key = maxPerMinute;
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = createActionLimiter(maxPerMinute);
    limiters.set(key, limiter);
  }
  return limiter;
};

/** 从 /projects 列表里找出目标项目，用于确认展示与审计 */
const findProject = async (ctx: ToolContext, id: number): Promise<Record<string, unknown>> => {
  const payload = await ctx.api.get("/projects");
  const projects = asArray(asRecord(payload).projects);
  for (const item of projects) {
    const project = asRecord(item);
    if (Number(project.id) === id) return project;
  }
  throw new Error(`项目 #${id} 不存在`);
};

const describeAction = (
  action: ProjectAction,
  project: Record<string, unknown>,
): ConfirmRequest => {
  const id = Number(project.id) || 0;
  const name = asText(project.name);
  const command = asText(project.command);
  const status = asText(project.status) || "stopped";
  const pid = asNumber(project.pid);
  const label = ACTION_LABEL[action];
  const lines = [
    `项目 #${id} ${name}`,
    `当前状态：${status}${pid === null ? "" : `（pid ${pid}）`}`,
  ];
  if (action !== "stop") {
    lines.push(`启动命令：${command || "（该项目没有配置启动命令）"}`);
  }
  if (action === "stop") lines.push("停止会结束该项目当前运行实例及其子进程。");
  return {
    action,
    projectId: id,
    projectName: name,
    command,
    title: `请求${label}项目`,
    detail: lines.join("\n"),
  };
};

const renderOutcome = (action: ProjectAction, payload: unknown): string => {
  const body = asRecord(payload);
  const project = asRecord(body.project);
  const name = asText(project.name);
  const status = asText(body.status) || "unknown";
  const pid = asNumber(body.pid);
  const head = `${ACTION_LABEL[action]}${name ? `「${name}」` : "项目"}完成，当前状态 ${status}${pid === null ? "" : `，pid ${pid}`}。`;
  const hint =
    action === "stop"
      ? "如需查看停止前的输出，仍可用 gitstatus_project_logs 读取当前实例日志。"
      : "可以用 gitstatus_project_logs 读取启动输出确认是否正常。";
  return `${head}\n${hint}`;
};

/** 三个动作共用的执行流程：策略 → 限流 → 确认 → 调用接口 → 审计 */
const runAction = async (
  ctx: ToolContext,
  args: Record<string, unknown>,
  action: ProjectAction,
  toolName: string,
) => {
  const policy: ProjectControlPolicy | undefined = ctx.projectControl;
  if (!policy) throw new Error("项目启停能力未开启");

  const id = asNumber(args.id) ?? 0;
  if (!Number.isInteger(id) || id <= 0) throw new Error("项目 id 必须是正整数");

  if (policy.allowedProjectIds.length > 0 && !policy.allowedProjectIds.includes(id)) {
    throw new Error(
      `项目 #${id} 不在 AI 可操作的范围内（allowedProjectIds: ${policy.allowedProjectIds.join(",")}）`,
    );
  }

  const limiter = limiterFor(policy.maxActionsPerMinute);
  if (!limiter.take(id)) {
    const waitSeconds = Math.ceil(limiter.retryAfterMs(id) / 1000);
    throw new Error(
      `操作过于频繁：每个项目每分钟最多 ${policy.maxActionsPerMinute} 次，请等待约 ${waitSeconds} 秒后重试`,
    );
  }

  const project = await findProject(ctx, id);
  const request = describeAction(action, project);
  const startedAt = Date.now();

  const audit = (outcome: ToolAuditEntry["outcome"], message: string): void => {
    ctx.audit?.({
      channel: ctx.channel ?? "web",
      tool: toolName,
      projectId: id,
      projectName: request.projectName,
      command: action === "stop" ? "" : request.command,
      outcome,
      message,
      durationMs: Date.now() - startedAt,
    });
  };

  // 有确认桥就必须先过用户这一关；MCP 通道没有这个能力，靠开关与角色兜底
  if (ctx.confirm) {
    const approved = await ctx.confirm(request);
    if (!approved) {
      audit("denied", "用户拒绝");
      return {
        text: `用户拒绝了${ACTION_LABEL[action]}项目 #${id} 的请求，未执行任何操作。不要再重复发起同一个请求，改为说明情况。`,
        structured: { res: false, denied: true, projectId: id, action },
      };
    }
  }

  try {
    const payload = await ctx.api.post(`/projects/${id}/${action}`);
    audit("ok", asText(asRecord(payload).status) || "completed");
    return { text: renderOutcome(action, payload), structured: payload };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit("error", message);
    throw error;
  }
};

const strategyHint =
  "该工具需要 config/config.json 的 agent.projectControl 开启后才存在，且仅管理员可用。"
  + "启动前先确认项目当前状态，已经运行的项目不要重复启动。";

export const projectControlTools: ToolDefinition[] = [
  defineTool({
    name: "gitstatus_project_start",
    title: "启动项目",
    description:
      "启动项目管理中某个已配置启动命令的项目（按 id）。"
      + `${strategyHint}内置助手会在执行前请用户在页面上确认，并展示将要执行的命令；`
      + "传入的只有项目 id，不能指定或修改命令内容。",
    readOnly: false,
    requiredRole: "admin",
    parameters: {
      id: { type: "integer", required: true, description: "要启动的项目 id" },
    },
    async run(ctx, args) {
      return runAction(ctx, args, "start", "gitstatus_project_start");
    },
  }),

  defineTool({
    name: "gitstatus_project_stop",
    title: "停止项目",
    description:
      "停止某个正在运行的项目（按 id），会结束该项目当前实例及其子进程。"
      + `${strategyHint}停止前建议先用 gitstatus_project_logs 看看它在做什么。`,
    readOnly: false,
    requiredRole: "admin",
    parameters: {
      id: { type: "integer", required: true, description: "要停止的项目 id" },
    },
    async run(ctx, args) {
      return runAction(ctx, args, "stop", "gitstatus_project_stop");
    },
  }),

  defineTool({
    name: "gitstatus_project_restart",
    title: "重启项目",
    description:
      "重启某个项目（先停止再启动，按 id）。"
      + `${strategyHint}改完配置或端口被占用时用这个；不要连续反复调用。`,
    readOnly: false,
    requiredRole: "admin",
    parameters: {
      id: { type: "integer", required: true, description: "要重启的项目 id" },
    },
    async run(ctx, args) {
      return runAction(ctx, args, "restart", "gitstatus_project_restart");
    },
  }),
];
