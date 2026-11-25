/**
 * 项目启停能力的策略来源。
 *
 * 一条原则：**未显式开启就等于关闭**。
 * - 内置助手进程读 config/config.json 的 agent 段
 * - MCP 进程同源，但允许用环境变量覆盖，方便给不同客户端不同授权
 *
 * 这里只负责「能不能、对哪些项目、多频繁」，不碰命令内容：
 * 命令原文永远来自数据库里已有的项目配置。
 */
import fs from "node:fs";
import type { ProjectControlPolicy } from "./define-tool.js";

export interface ProjectControlConfig {
  enabled: boolean;
  policy: ProjectControlPolicy;
  /** 关闭原因，写进日志，避免「为什么工具不见了」这类疑问 */
  reason: string;
}

const DEFAULT_MAX_ACTIONS_PER_MINUTE = 3;
const MIN_ACTIONS_PER_MINUTE = 1;
const MAX_ACTIONS_PER_MINUTE = 20;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
};

/** 只接受正整数数组；空数组表示不限制项目 */
const parseIdList = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  for (const item of value) {
    const id = Number(item);
    if (Number.isInteger(id) && id > 0) seen.add(id);
  }
  return [...seen].sort((a, b) => a - b);
};

/** 解析 "1,2,3" 这类环境变量 */
const parseIdText = (value: string): number[] => parseIdList(value.split(","));

const readConfigAgent = (configPath: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
    if (isRecord(parsed) && isRecord(parsed.agent)) return parsed.agent;
  } catch {
    /* 配置缺失或格式错误都按关闭处理 */
  }
  return {};
};

/**
 * 读取启停能力的开关与策略。
 * 开关优先级：环境变量 > config.json；两者都没有就是关闭。
 */
export const readProjectControlConfig = (
  options: { configPath: string; env?: NodeJS.ProcessEnv },
): ProjectControlConfig => {
  const env = options.env ?? process.env;
  const agent = readConfigAgent(options.configPath);

  const envFlag = String(env.GITSTATUS_AGENT_PROJECT_CONTROL ?? "").trim().toLowerCase();
  const fileFlag = agent.projectControl === true;
  const enabled =
    envFlag === "" ? fileFlag : envFlag === "1" || envFlag === "true" || envFlag === "on";

  const envIds = String(env.GITSTATUS_AGENT_ALLOWED_PROJECT_IDS ?? "").trim();
  const allowedProjectIds = envIds ? parseIdText(envIds) : parseIdList(agent.allowedProjectIds);

  const maxActionsPerMinute = clampInt(
    env.GITSTATUS_AGENT_MAX_ACTIONS_PER_MINUTE ?? agent.maxActionsPerMinute,
    DEFAULT_MAX_ACTIONS_PER_MINUTE,
    MIN_ACTIONS_PER_MINUTE,
    MAX_ACTIONS_PER_MINUTE,
  );

  return {
    enabled,
    policy: { allowedProjectIds, maxActionsPerMinute },
    reason: enabled
      ? `enabled (allowed=${allowedProjectIds.length === 0 ? "all" : allowedProjectIds.join(",")})`
      : "disabled",
  };
};

/**
 * 每项目每分钟的动作次数限制。
 *
 * 主要防模型陷入「重启→看日志→再重启」的循环，把本来正常的服务打挂。
 * 按进程内存计数：内置助手与 MCP 各算各的，合起来的最坏情况是两倍配额。
 */
export interface ActionLimiter {
  /** 取一个令牌；返回 false 表示超限 */
  take(projectId: number): boolean;
  /** 距离下一次可用还需多少毫秒，用于给模型可读的提示 */
  retryAfterMs(projectId: number): number;
}

export const createActionLimiter = (
  maxPerMinute: number,
  windowMs = 60_000,
): ActionLimiter => {
  const hits = new Map<number, number[]>();
  const limit = Math.max(1, Math.round(maxPerMinute));

  const prune = (projectId: number, now: number): number[] => {
    const list = (hits.get(projectId) ?? []).filter((at) => now - at < windowMs);
    hits.set(projectId, list);
    return list;
  };

  return {
    take(projectId) {
      const now = Date.now();
      const list = prune(projectId, now);
      if (list.length >= limit) return false;
      list.push(now);
      return true;
    },
    retryAfterMs(projectId) {
      const now = Date.now();
      const list = prune(projectId, now);
      if (list.length < limit) return 0;
      const oldest = list[0];
      if (oldest === undefined) return 0;
      return Math.max(0, windowMs - (now - oldest));
    },
  };
};
