/**
 * 时间工具。
 *
 * LLM 自身没有时钟：没有这个工具时，模型只能从历史记录里猜当前时刻，
 * 「两小时后截止」这类相对时间就完全无从计算，只能反过来问用户。
 */
import { defineTool, type ToolDefinition } from "../define-tool.js";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export const pad2 = (value: number): string => String(value).padStart(2, "0");

/** 本地日期 YYYY-MM-DD，与后端 date 口径一致 */
export const formatLocalDate = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

/** 本地日期时间 YYYY-MM-DD HH:mm:ss，与后端 now 口径一致 */
export const formatLocalDateTime = (date: Date): string =>
  `${formatLocalDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;

export const weekdayOf = (date: Date): string => WEEKDAYS[date.getDay()] ?? "";

export const timeTools: ToolDefinition[] = [
  defineTool({
    name: "gitstatus_now",
    title: "获取当前时间",
    description:
      "返回服务器当前的本地日期与时刻（精确到秒），以及星期和时区。"
      + "需要计算「两小时后」「今天还剩多久」「明天几点」这类相对时间时，必须先调用它；"
      + "不要用账号登录时间、待办创建时间等历史记录推算当前时刻。",
    readOnly: true,
    requiredRole: "readonly",
    parameters: {},
    async run() {
      // MCP 服务默认与后端同机，本地时间即后端时间；时区随机器配置
      const now = new Date();
      const today = formatLocalDate(now);
      const nowText = formatLocalDateTime(now);
      const weekday = weekdayOf(now);
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";

      return {
        text: [
          `服务器当前时间：${nowText}（${weekday}）`,
          `日期：${today} · 时区：${timeZone}`,
        ].join("\n"),
        structured: {
          now: nowText,
          today,
          weekday,
          timeZone,
          iso: now.toISOString(),
          epochMs: now.getTime(),
        },
      };
    },
  }),
];
