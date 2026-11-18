/**
 * 结果渲染辅助。
 *
 * 后端的 DTO 字段很多，直接丢给模型噪声太大；
 * 这里统一投影成「一行一条」的中文摘要，原始数据仍随 structuredContent 返回。
 */

export const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export const asText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
};

export const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const asBoolean = (value: unknown): boolean => value === true;

const PRIORITY_LABEL: Record<string, string> = {
  high: "高",
  normal: "普通",
  low: "低",
};

/** 单条待办的一行摘要 */
export const todoLine = (value: unknown): string => {
  const todo = asRecord(value);
  const priority = asText(todo.priority) || "normal";
  const tags = asArray(todo.tags)
    .map((tag) => asText(asRecord(tag).name))
    .filter(Boolean);
  const category = asRecord(todo.category);
  const parts: string[] = [
    `#${asText(todo.id)} [${asBoolean(todo.isCompleted) ? "x" : " "}] ${asText(todo.title)}`,
  ];

  if (priority !== "normal") {
    parts.push(`优先级${PRIORITY_LABEL[priority] ?? priority}`);
  }
  if (asBoolean(todo.isOverdue)) parts.push("已逾期");
  if (asText(todo.scheduleType) === "daily") {
    const start = asText(todo.repeatStartDate);
    const end = asText(todo.repeatEndDate);
    parts.push(`每日任务 ${start}${end ? `~${end}` : " 起"}`);
  } else if (asText(todo.dueDate)) {
    const time = asText(todo.dueTime);
    parts.push(`截止 ${asText(todo.dueDate)}${time ? ` ${time}` : ""}`);
  }
  if (asText(category.name)) parts.push(`分类 ${asText(category.name)}`);
  if (tags.length > 0) parts.push(`标签 ${tags.join("、")}`);
  if (asBoolean(todo.shared) && asText(todo.ownerUsername)) {
    parts.push(`来自 ${asText(todo.ownerUsername)}（${asText(todo.permission)}）`);
  }

  return parts.join(" · ");
};

/** 单条待办的完整信息，用于查询单个任务 */
export const todoDetail = (value: unknown): string => {
  const todo = asRecord(value);
  const lines: string[] = [todoLine(todo)];

  const description = asText(todo.description);
  if (description) lines.push(`描述：${description}`);

  const reminder = asRecord(todo.reminder);
  if (asText(reminder.nextTriggerAt)) {
    lines.push(`提醒：${asText(reminder.nextTriggerAt)}`);
  }

  const attachments = asArray(todo.attachments);
  if (attachments.length > 0) {
    const names = attachments.map((item) => {
      const file = asRecord(item);
      return `${asText(file.originalName)}（${asText(file.kind)}）`;
    });
    lines.push(`附件：${names.join("、")}`);
  }

  lines.push(
    `创建于 ${asText(todo.createdAt)}，最后更新 ${asText(todo.updatedAt)}`,
  );
  return lines.join("\n");
};

/** 分类的一行摘要 */
export const categoryLine = (value: unknown): string => {
  const item = asRecord(value);
  const parts = [`#${asText(item.id)} ${asText(item.name)}`];
  if (asText(item.color)) parts.push(`颜色 ${asText(item.color)}`);
  if (asNumber(item.parentId) !== null) parts.push(`父分类 #${asText(item.parentId)}`);
  if (asBoolean(item.shared) && asText(item.ownerUsername)) {
    parts.push(`来自 ${asText(item.ownerUsername)}`);
  }
  return parts.join(" · ");
};

/** 标签的一行摘要 */
export const tagLine = (value: unknown): string => {
  const item = asRecord(value);
  const parts = [`#${asText(item.id)} ${asText(item.name)}`];
  if (asText(item.color)) parts.push(`颜色 ${asText(item.color)}`);
  return parts.join(" · ");
};

/** 共享记录的一行摘要 */
export const shareLine = (value: unknown): string => {
  const item = asRecord(value);
  const owner = asText(item.ownerUsername) || `用户#${asText(item.ownerId)}`;
  const grantee = asText(item.granteeUsername) || `用户#${asText(item.granteeId)}`;
  // scope 只有 inbox / category 两种，分类共享优先显示完整路径
  const target =
    asText(item.scope) === "inbox"
      ? "收件箱"
      : asText(item.categoryPath) || asText(item.categoryName) || "分类";
  return `${owner} → ${grantee} · ${asText(item.permission)} · ${target}`;
};
