import express from "express";
import type Database from "better-sqlite3";
import { spawn } from "child_process";
import multer from "multer";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

type TodoFeatureOptions = {
  db: Database.Database;
  apiPrefix: string;
  authMiddleware: express.RequestHandler;
  /** 写操作守卫：只读角色在 POST/PATCH/PUT/DELETE 时会被拒绝 */
  requireWrite: express.RequestHandler;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
  logError: (message: string, error?: unknown) => void;
};

// 目录沿用旧名，保证历史图片文件仍可直接读取
const todoAttachmentsDir = path.resolve("./src/output/todo-images");

/** 删除指定用户的全部待办附件文件（用户被删除时调用） */
export const removeTodoAttachmentsForUser = (userId: number): void => {
  if (!Number.isInteger(userId) || userId <= 0) return;
  try {
    fs.rmSync(path.join(todoAttachmentsDir, String(userId)), {
      recursive: true,
      force: true,
    });
  } catch {
    // 文件清理失败不影响用户删除结果
  }
};

// 桌宠角色素材：按用户保存到本地磁盘，文件名以 userId- 开头便于清理
const petAssetsDir = path.resolve("./src/output/pet-assets");
const MAX_PET_IMAGE_BYTES = 2 * 1024 * 1024;

/** 删除指定用户的桌宠角色素材（用户被删除时调用） */
export const removePetAssetsForUser = (userId: number): void => {
  if (!Number.isInteger(userId) || userId <= 0) return;
  try {
    if (!fs.existsSync(petAssetsDir)) return;
    for (const name of fs.readdirSync(petAssetsDir)) {
      if (!name.startsWith(`${userId}-`)) continue;
      try {
        fs.unlinkSync(path.join(petAssetsDir, name));
      } catch {
        // 单个文件删除失败不影响其余文件
      }
    }
  } catch {
    // 文件清理失败不影响用户删除结果
  }
};

export type TodoTransferStats = {
  categories: number;
  tags: number;
  todos: number;
  attachments: number;
};

/**
 * 将源用户的全部待办数据迁移给目标用户。
 * - 分类按层级重建；目标用户已有同名同级分类时直接复用
 * - 标签同名时复用目标标签，并合并重复的待办-标签关联
 * - 待办与图片只改归属用户，记录 ID 保持不变
 * - 图片文件从事务提交后从源目录移动到目标目录
 */
export const transferTodoData = (
  db: Database.Database,
  sourceUserId: number,
  targetUserId: number,
): TodoTransferStats => {
  if (sourceUserId === targetUserId) {
    throw new Error("source and target user must differ");
  }

  const selectCategoriesStmt = db.prepare(
    `SELECT id, parent_id, name, color, sort_order, created_at, updated_at
     FROM todo_categories WHERE user_id = ? ORDER BY sort_order ASC, id ASC`,
  );
  const findCategorySiblingStmt = db.prepare(
    `SELECT id FROM todo_categories
     WHERE user_id = ? AND IFNULL(parent_id, 0) = IFNULL(?, 0)
       AND name = ? COLLATE NOCASE LIMIT 1`,
  );
  const insertCategoryStmt = db.prepare(
    `INSERT INTO todo_categories
     (user_id, parent_id, name, color, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const selectTagsStmt = db.prepare(
    `SELECT id, name, color, created_at, updated_at
     FROM todo_tags WHERE user_id = ? ORDER BY id ASC`,
  );
  const findTagStmt = db.prepare(
    `SELECT id FROM todo_tags
     WHERE user_id = ? AND name = ? COLLATE NOCASE LIMIT 1`,
  );
  const insertTagStmt = db.prepare(
    `INSERT INTO todo_tags (user_id, name, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const selectTodosStmt = db.prepare(
    `SELECT id, category_id FROM todos WHERE user_id = ?`,
  );
  const updateTodoStmt = db.prepare(
    `UPDATE todos SET user_id = ?, category_id = ?
     WHERE id = ? AND user_id = ?`,
  );

  const selectImagesStmt = db.prepare(
    `SELECT id, stored_name FROM todo_attachments WHERE user_id = ?`,
  );
  const updateImageStmt = db.prepare(
    `UPDATE todo_attachments SET user_id = ? WHERE id = ?`,
  );

  const selectTagLinkConflictsStmt = db.prepare(
    `SELECT todo_id FROM todo_tag_links
     WHERE tag_id = ?
       AND todo_id IN (SELECT todo_id FROM todo_tag_links WHERE tag_id = ?)`,
  );
  const deleteTagLinkStmt = db.prepare(
    `DELETE FROM todo_tag_links WHERE todo_id = ? AND tag_id = ?`,
  );
  const updateTagLinksStmt = db.prepare(
    `UPDATE todo_tag_links SET tag_id = ? WHERE tag_id = ?`,
  );

  const categoryRows = selectCategoriesStmt.all(sourceUserId) as Array<{
    id: number;
    parent_id: number | null;
    name: string;
    color: string;
    sort_order: number;
    created_at: string;
    updated_at: string;
  }>;
  const tagRows = selectTagsStmt.all(sourceUserId) as Array<{
    id: number;
    name: string;
    color: string;
    created_at: string;
    updated_at: string;
  }>;
  const imageRows = selectImagesStmt.all(sourceUserId) as Array<{
    id: number;
    stored_name: string;
  }>;

  let todoCount = 0;

  const migrate = db.transaction(() => {
    // 1. 分类：按层级迁移，同名同级分类复用目标用户已有记录
    const categoryMap = new Map<number, number>();
    const pending = [...categoryRows];
    let guard = pending.length + 1;
    while (pending.length > 0 && guard > 0) {
      guard -= 1;
      let progressed = false;
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const row = pending[i]!;
        if (row.parent_id !== null && !categoryMap.has(row.parent_id)) continue;

        const newParentId =
          row.parent_id === null ? null : categoryMap.get(row.parent_id) ?? null;
        const existing = findCategorySiblingStmt.get(
          targetUserId,
          newParentId,
          row.name,
        ) as { id: number } | undefined;

        let newId: number;
        if (existing) {
          newId = existing.id;
        } else {
          const info = insertCategoryStmt.run(
            targetUserId,
            newParentId,
            row.name,
            row.color,
            row.sort_order,
            row.created_at,
            row.updated_at,
          );
          newId = Number(info.lastInsertRowid);
        }
        categoryMap.set(row.id, newId);
        pending.splice(i, 1);
        progressed = true;
      }
      // 父级缺失或存在环时，将剩余分类作为根分类迁移
      if (!progressed) break;
    }
    for (const row of pending) {
      const existing = findCategorySiblingStmt.get(
        targetUserId,
        null,
        row.name,
      ) as { id: number } | undefined;
      let newId: number;
      if (existing) {
        newId = existing.id;
      } else {
        const info = insertCategoryStmt.run(
          targetUserId,
          null,
          row.name,
          row.color,
          row.sort_order,
          row.created_at,
          row.updated_at,
        );
        newId = Number(info.lastInsertRowid);
      }
      categoryMap.set(row.id, newId);
    }

    // 2. 标签：同名标签复用，重复的待办关联先清理再合并
    const tagMap = new Map<number, number>();
    for (const row of tagRows) {
      const existing = findTagStmt.get(targetUserId, row.name) as
        | { id: number }
        | undefined;
      let newId: number;
      if (existing) {
        newId = existing.id;
      } else {
        const info = insertTagStmt.run(
          targetUserId,
          row.name,
          row.color,
          row.created_at,
          row.updated_at,
        );
        newId = Number(info.lastInsertRowid);
      }
      tagMap.set(row.id, newId);

      if (newId !== row.id) {
        const conflicts = selectTagLinkConflictsStmt.all(row.id, newId) as Array<{
          todo_id: number;
        }>;
        for (const conflict of conflicts) {
          deleteTagLinkStmt.run(conflict.todo_id, row.id);
        }
        updateTagLinksStmt.run(newId, row.id);
      }
    }

    // 3. 待办：保持 ID 不变，仅改归属用户与分类映射
    const todoRows = selectTodosStmt.all(sourceUserId) as Array<{
      id: number;
      category_id: number | null;
    }>;
    for (const row of todoRows) {
      const newCategoryId =
        row.category_id === null
          ? null
          : categoryMap.get(row.category_id) ?? null;
      updateTodoStmt.run(targetUserId, newCategoryId, row.id, sourceUserId);
      todoCount += 1;
    }

    // 4. 图片元数据：记录 ID 不变，仅改归属用户
    for (const row of imageRows) {
      updateImageStmt.run(targetUserId, row.id);
    }

    // 5. 清空源用户的分类与标签（待办、图片已改归属，标签关联已合并）
    db.prepare("UPDATE todo_categories SET parent_id = NULL WHERE user_id = ?").run(
      sourceUserId,
    );
    db.prepare("DELETE FROM todo_categories WHERE user_id = ?").run(sourceUserId);
    db.prepare("DELETE FROM todo_tags WHERE user_id = ?").run(sourceUserId);

    return {
      categories: categoryRows.length,
      tags: tagRows.length,
      todos: todoCount,
      attachments: imageRows.length,
    } satisfies TodoTransferStats;
  });

  const stats = migrate();

  // 5. 附件文件移动放在事务提交之后，避免回滚后文件位置与元数据不一致
  const sourceDir = path.join(todoAttachmentsDir, String(sourceUserId));
  const targetDir = path.join(todoAttachmentsDir, String(targetUserId));
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch {
    // 目录创建失败时由下方逐文件移动兜底
  }
  for (const row of imageRows) {
    const sourcePath = path.join(sourceDir, row.stored_name);
    const targetPath = path.join(targetDir, row.stored_name);
    try {
      if (!fs.existsSync(sourcePath)) continue;
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      fs.renameSync(sourcePath, targetPath);
    } catch {
      // 单个文件移动失败不影响整体迁移结果
    }
  }

  return stats;
};

type AuthedRequest = express.Request & {
  user?: { userId?: number; username?: string; role?: string };
};

type CategoryRow = {
  id: number;
  user_id: number;
  parent_id: number | null;
  name: string;
  color: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type TagRow = {
  id: number;
  user_id: number;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
};

type TodoScheduleType = "once" | "daily";
type TodoPriority = "low" | "normal" | "high";

type TodoRow = {
  id: number;
  user_id: number;
  category_id: number | null;
  title: string;
  description: string;
  priority: TodoPriority;
  schedule_type: TodoScheduleType;
  due_date: string | null;
  due_time: string | null;
  repeat_start_date: string | null;
  repeat_end_date: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type CompletionRow = {
  id: number;
  todo_id: number;
  completion_date: string;
  completed_at: string;
  created_at: string;
};

type ReminderRow = {
  id: number;
  todo_id: number;
  reminder_type: TodoScheduleType;
  remind_at: string | null;
  remind_time: string | null;
  enabled: number;
  next_trigger_at: string | null;
  created_at: string;
  updated_at: string;
};
type TodoAttachmentRow = {
  id: number;
  todo_id: number;
  user_id: number;
  kind: TodoAttachmentKind;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size: number;
  created_at: string;
};

/** 共享范围：文件夹（含子文件夹）或收件箱 */
type ShareScope = "category" | "inbox";
/** 共享权限：只读 / 可编辑（增删改） */
type SharePermission = "readonly" | "write";
/** 当前用户对某条数据的实际权限，owner 表示数据归属自己 */
type DataAccessLevel = "owner" | SharePermission;

type ShareRow = {
  id: number;
  owner_id: number;
  grantee_id: number;
  scope: ShareScope;
  category_id: number | null;
  permission: SharePermission;
  created_at: string;
  updated_at: string;
};

/** 按所有者聚合后的共享范围，用于任务与分类的可见性过滤 */
type SharedScope = {
  ownerId: number;
  ownerUsername: string;
  /** 可访问的分类 ID（含子分类）；null 表示没有文件夹共享 */
  categoryIds: Set<number> | null;
  /** 每个分类对应的共享权限 */
  categoryPermissions: Map<number, SharePermission>;
  inboxPermission: SharePermission | null;
  shareIds: number[];
};

class TodoHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function fail(status: number, message: string): never {
  throw new TodoHttpError(status, message);
}

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const pad2 = (value: number): string => String(value).padStart(2, "0");

const formatLocalDate = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const formatLocalDateTime = (date: Date): string =>
  `${formatLocalDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;

const localToday = (): string => formatLocalDate(new Date());
const localNow = (): string => formatLocalDateTime(new Date());

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const PRIORITIES: TodoPriority[] = ["low", "normal", "high"];
const TODO_IMAGE_MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
};

/** 附件限制：图片保持原有 5 张 / 8 MB，其他文件单独计数 */
const MAX_TODO_IMAGES = 5;
const MAX_TODO_FILES = 10;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** 不允许保存的可执行文件后缀，避免附件区被当作分发渠道 */
const BLOCKED_FILE_EXTENSIONS = new Set([
  ".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".pif",
  ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh",
  ".sh", ".jar", ".reg", ".lnk",
]);

type TodoAttachmentKind = "image" | "file";

const attachmentKindOf = (mime: string): TodoAttachmentKind =>
  TODO_IMAGE_MIME_EXT[String(mime || "").toLowerCase()] ? "image" : "file";

/** 从原始文件名中提取安全的扩展名；不可用时按 MIME 兜底 */
const safeFileExtension = (originalName: string, mime: string): string => {
  const match = /^[^.]+(\.[A-Za-z0-9]{1,10})$/.exec(String(originalName || ""));
  if (match && match[1]) return match[1].toLowerCase();
  return TODO_IMAGE_MIME_EXT[mime] ?? ".bin";
};

/** multer 以 latin1 解析文件名，非 ASCII 名称需要还原为 UTF-8 */
const decodeUploadFileName = (raw: string): string => {
  if (!/[^\x00-\x7F]/.test(raw)) return raw;
  try {
    const decoded = Buffer.from(raw, "latin1").toString("utf8");
    return decoded.includes("\uFFFD") ? raw : decoded;
  } catch {
    return raw;
  }
};

/** 去掉路径分隔符与控制字符，只保留文件名本身 */
const sanitizeUploadFileName = (raw: string): string => {
  const base = path.basename(String(raw || "").replace(/\\/g, "/"));
  return base.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 255);
};

// 系统默认程序打开附件时使用的临时副本目录（保留原始文件名）
const attachmentOpenTempDir = path.join(os.tmpdir(), "gitstatus-open");

/** 清理 24 小时前的临时副本，避免目录无限增长 */
const cleanupAttachmentOpenTempDir = (): void => {
  try {
    const deadline = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(attachmentOpenTempDir)) {
      const fullPath = path.join(attachmentOpenTempDir, name);
      try {
        if (fs.statSync(fullPath).mtimeMs < deadline) fs.unlinkSync(fullPath);
      } catch {
        // 文件仍被系统程序占用时跳过，下次再清理
      }
    }
  } catch {
    // 目录还不存在时忽略
  }
};

/**
 * 判断请求是否来自本机。
 * 系统默认程序打开属于宿主机行为，远程设备触发会开在服务器上，因此只允许本机调用。
 */
const isLoopbackRequest = (req: express.Request): boolean => {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    ?.trim() || "";
  const address = forwarded || String(req.socket.remoteAddress || "");
  return (
    address === "::1" ||
    address === "127.0.0.1" ||
    address.startsWith("::ffff:127.")
  );
};

/**
 * 用系统默认程序打开附件。
 * 浏览器无法直接调用本地程序，改由后端以原文件名复制到临时目录后交给系统打开。
 */
const openAttachmentWithSystem = (
  attachment: TodoAttachmentRow,
  sourcePath: string,
  logWarn: (message: string) => void,
): void => {
  const originalName = sanitizeUploadFileName(attachment.original_name) || "attachment";
  const fallbackExtension = path.extname(attachment.stored_name);
  const fileName = path.extname(originalName)
    ? originalName
    : `${originalName}${fallbackExtension}`;
  fs.mkdirSync(attachmentOpenTempDir, { recursive: true });
  cleanupAttachmentOpenTempDir();
  const targetPath = path.join(attachmentOpenTempDir, `${attachment.id}-${fileName}`);
  try {
    fs.copyFileSync(sourcePath, targetPath);
  } catch {
    // 上一次打开的副本仍被系统程序占用时直接复用，同一附件内容不会变化
    if (!fs.existsSync(targetPath)) throw new Error("failed to prepare attachment for opening");
  }

  const command =
    process.platform === "win32"
      ? "cmd.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", targetPath] : [targetPath];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", (error) => {
    logWarn(`[todo] failed to open attachment ${attachment.id}: ${error.message}`);
  });
  child.unref();
};

const validateDateParts = (year: number, month: number, day: number): boolean => {
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
};

const isValidDateOnly = (value: string): boolean => {
  const match = DATE_ONLY_RE.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  if (!yearText || !monthText || !dayText) return false;
  return validateDateParts(Number(yearText), Number(monthText), Number(dayText));
};

const parseDateOnly = (value: string): Date => {
  const match = DATE_ONLY_RE.exec(value);
  if (!match) return new Date(Number.NaN);
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    0,
    0,
    0,
    0,
  );
};

const addDays = (dateOnly: string, days: number): string => {
  const date = parseDateOnly(dateOnly);
  date.setDate(date.getDate() + days);
  return formatLocalDate(date);
};

const datePart = (dateTime: string): string => dateTime.slice(0, 10);

const normalizeOptionalDate = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!isValidDateOnly(text)) fail(400, `${field} must be YYYY-MM-DD`);
  return text;
};

const normalizeRequiredDate = (value: unknown, field: string): string => {
  const date = normalizeOptionalDate(value, field);
  if (!date) fail(400, `${field} is required`);
  return date;
};

const normalizeOptionalTime = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!TIME_RE.test(text)) fail(400, `${field} must be HH:mm`);
  return text;
};

const normalizeOptionalLocalDateTime = (
  value: unknown,
  field: string,
): string | null => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const match = LOCAL_DATETIME_RE.exec(text);
  if (!match) fail(400, `${field} must be YYYY-MM-DD HH:mm`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  if (!yearText || !monthText || !dayText || !hourText || !minuteText) {
    fail(400, `${field} must be YYYY-MM-DD HH:mm`);
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText || "0");
  if (
    !validateDateParts(year, month, day) ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59 ||
    second < 0 || second > 59
  ) {
    fail(400, `${field} must be YYYY-MM-DD HH:mm`);
  }
  return formatLocalDateTime(new Date(year, month - 1, day, hour, minute, second));
};

const normalizeOnceDateTime = (value: unknown, field: string): string => {
  const text = String(value ?? "").trim();
  const match = LOCAL_DATETIME_RE.exec(text);
  if (!match) fail(400, `${field} must be YYYY-MM-DD HH:mm:ss`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  if (!yearText || !monthText || !dayText || !hourText || !minuteText) {
    fail(400, `${field} must be YYYY-MM-DD HH:mm:ss`);
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText || "0");
  if (
    !validateDateParts(year, month, day) ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59 ||
    second < 0 || second > 59
  ) {
    fail(400, `${field} must be YYYY-MM-DD HH:mm:ss`);
  }
  return formatLocalDateTime(new Date(year, month - 1, day, hour, minute, second));
};

const normalizeTime = (value: unknown, field: string): string => {
  const text = String(value ?? "").trim();
  if (!TIME_RE.test(text)) fail(400, `${field} must be HH:mm`);
  return text;
};

const normalizeColor = (value: unknown, fallback = "#8b949e"): string => {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const color = String(value).trim();
  if (!COLOR_RE.test(color)) fail(400, "color must be a #RRGGBB value");
  return color.toLowerCase();
};

const parseOptionalPositiveId = (value: unknown, field: string): number | null => {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    fail(400, `invalid ${field}`);
  }
  return numberValue;
};

const parsePositiveId = (value: unknown, field: string): number => {
  const parsed = parseOptionalPositiveId(value, field);
  if (parsed === null) fail(400, `${field} is required`);
  return parsed;
};

const parseSortOrder = (value: unknown, fallback: number): number => {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    fail(400, "sortOrder must be a non-negative integer");
  }
  return numberValue;
};

const normalizePriority = (value: unknown, fallback: TodoPriority): TodoPriority => {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const priority = String(value).trim().toLowerCase() as TodoPriority;
  if (!PRIORITIES.includes(priority)) fail(400, "invalid priority");
  return priority;
};

const normalizeScheduleType = (
  value: unknown,
  fallback: TodoScheduleType,
): TodoScheduleType => {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const scheduleType = String(value).trim().toLowerCase();
  if (scheduleType !== "once" && scheduleType !== "daily") {
    fail(400, "scheduleType must be once or daily");
  }
  return scheduleType;
};

const normalizeTagIds = (value: unknown): number[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(400, "tagIds must be an array");
  const result = new Set<number>();
  for (const item of value) {
    result.add(parsePositiveId(item, "tagId"));
  }
  return [...result];
};

const getRequestUserId = (req: express.Request): number => {
  const userId = Number((req as AuthedRequest).user?.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    fail(401, "not authenticated");
  }
  return userId;
};const computeNextDailyTrigger = (
  task: Pick<TodoRow, "repeat_start_date" | "repeat_end_date">,
  remindTime: string,
  now: Date,
): string | null => {
  const today = formatLocalDate(now);
  let candidateDate = today;
  if (task.repeat_start_date && candidateDate < task.repeat_start_date) {
    candidateDate = task.repeat_start_date;
  }
  let candidate = `${candidateDate} ${remindTime}:00`;
  if (candidate <= formatLocalDateTime(now)) {
    candidateDate = addDays(candidateDate, 1);
    candidate = `${candidateDate} ${remindTime}:00`;
  }
  if (task.repeat_end_date && candidateDate > task.repeat_end_date) {
    return null;
  }
  return candidate;
};

const taskIsActiveOnDate = (
  task: Pick<TodoRow, "repeat_start_date" | "repeat_end_date">,
  dateOnly: string,
): boolean => {
  if (task.repeat_start_date && dateOnly < task.repeat_start_date) return false;
  if (task.repeat_end_date && dateOnly > task.repeat_end_date) return false;
  return true;
};

type AccessMeta = {
  ownerUsername?: string | null;
  permission?: DataAccessLevel;
  shared?: boolean;
};

const toCategoryDto = (row: CategoryRow, meta: AccessMeta = {}) => ({
  id: row.id,
  parentId: row.parent_id,
  name: row.name,
  color: row.color,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ownerId: row.user_id,
  ownerUsername: meta.ownerUsername ?? null,
  permission: meta.permission ?? "owner",
  shared: meta.shared ?? false,
});

const toTagDto = (row: TagRow, meta: AccessMeta = {}) => ({
  id: row.id,
  name: row.name,
  color: row.color,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ownerId: row.user_id,
  ownerUsername: meta.ownerUsername ?? null,
  shared: meta.shared ?? false,
});

const toReminderDto = (row: ReminderRow | undefined) =>
  row
    ? {
        id: row.id,
        type: row.reminder_type,
        remindAt: row.remind_at,
        remindTime: row.remind_time,
        enabled: Boolean(row.enabled),
        nextTriggerAt: row.next_trigger_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

type PetSettingsRow = {
  user_id: number;
  interval_enabled: number;
  interval_minutes: number;
  interval_work_hours: number;
  work_start: string;
  work_end: string;
  work_start_enabled: number;
  work_end_enabled: number;
  due_lead_minutes: number;
  pet_image: string | null;
  updated_at: string;
};

/** 桌宠提醒设置的默认值，与设置页保持一致 */
const PET_SETTINGS_DEFAULTS = {
  intervalEnabled: true,
  intervalMinutes: 60,
  intervalWithinWorkHours: false,
  workStart: "09:00",
  workEnd: "18:00",
  workStartEnabled: true,
  workEndEnabled: true,
  dueLeadMinutes: 15,
};

const toPetSettingsDto = (row: PetSettingsRow | undefined, petImageUrl: string | null = null) => ({
  intervalEnabled: row
    ? Boolean(row.interval_enabled)
    : PET_SETTINGS_DEFAULTS.intervalEnabled,
  intervalMinutes: row ? Number(row.interval_minutes) : PET_SETTINGS_DEFAULTS.intervalMinutes,
  intervalWithinWorkHours: row
    ? Boolean(row.interval_work_hours)
    : PET_SETTINGS_DEFAULTS.intervalWithinWorkHours,
  workStart: row?.work_start ?? PET_SETTINGS_DEFAULTS.workStart,
  workEnd: row?.work_end ?? PET_SETTINGS_DEFAULTS.workEnd,
  workStartEnabled: row
    ? Boolean(row.work_start_enabled)
    : PET_SETTINGS_DEFAULTS.workStartEnabled,
  workEndEnabled: row ? Boolean(row.work_end_enabled) : PET_SETTINGS_DEFAULTS.workEndEnabled,
  dueLeadMinutes: row ? Number(row.due_lead_minutes) : PET_SETTINGS_DEFAULTS.dueLeadMinutes,
  /** 自定义角色素材地址；为空时前端使用内置造型 */
  petImageUrl,
  updatedAt: row?.updated_at ?? null,
});

const sendRouteError = (
  res: express.Response,
  error: unknown,
  context: string,
  logError: (message: string, error?: unknown) => void,
): void => {
  if (error instanceof TodoHttpError) {
    res.status(error.status).json({ res: false, message: error.message });
    return;
  }
  logError(`[todo] ${context}`, error);
  res.status(500).json({
    res: false,
    message: error instanceof Error ? error.message : `${context} failed`,
  });
};

export const registerTodoFeature = (
  app: express.Express,
  options: TodoFeatureOptions,
): void => {
  const { db, apiPrefix, authMiddleware, requireWrite, logInfo, logWarn, logError } =
    options;

  /** 待办模块的写操作统一要求读写及以上角色，GET 类请求不受限制 */
  const writeGuard: express.RequestHandler = (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    requireWrite(req, res, next);
  };

  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      parent_id INTEGER,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#8b949e',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES todo_categories(id) ON DELETE RESTRICT
    )
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_todo_categories_sibling_name
    ON todo_categories(user_id, IFNULL(parent_id, 0), name COLLATE NOCASE)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_todo_categories_user_parent
    ON todo_categories(user_id, parent_id, sort_order, id)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#0969da',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_todo_tags_name
    ON todo_tags(user_id, name COLLATE NOCASE)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category_id INTEGER,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
      schedule_type TEXT NOT NULL DEFAULT 'once' CHECK (schedule_type IN ('once','daily')),
      due_date TEXT,
      due_time TEXT,
      repeat_start_date TEXT,
      repeat_end_date TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      deleted_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES todo_categories(id) ON DELETE SET NULL,
      CHECK (
        (schedule_type = 'once' AND repeat_start_date IS NULL AND repeat_end_date IS NULL)
        OR
        (schedule_type = 'daily' AND due_date IS NULL AND repeat_start_date IS NOT NULL
          AND (repeat_end_date IS NULL OR repeat_end_date >= repeat_start_date))
      )
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_todos_user_active
    ON todos(user_id, deleted_at, category_id, schedule_type, sort_order, id)
  `);

  // Backward-compatible migration for databases created before due-time support.
  const todoColumns = db.prepare("PRAGMA table_info(todos)").all() as Array<{ name: string }>;
  if (!todoColumns.some((column) => column.name === "due_time")) {
    db.exec("ALTER TABLE todos ADD COLUMN due_time TEXT");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_tag_links (
      todo_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (todo_id, tag_id),
      FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES todo_tags(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_todo_tag_links_tag
    ON todo_tag_links(tag_id, todo_id)
  `);

  // 旧版只有图片附件，升级为通用附件表；历史数据整体保留并标记为 image
  const hasLegacyImageTable = Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'todo_images'")
      .get(),
  );
  const hasAttachmentTable = Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'todo_attachments'")
      .get(),
  );
  if (hasLegacyImageTable && !hasAttachmentTable) {
    db.exec("ALTER TABLE todo_images RENAME TO todo_attachments");
    db.exec("DROP INDEX IF EXISTS idx_todo_images_todo");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'image' CHECK (kind IN ('image','file')),
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  const attachmentColumns = db
    .prepare("PRAGMA table_info(todo_attachments)")
    .all() as Array<{ name: string }>;
  if (!attachmentColumns.some((column) => column.name === "kind")) {
    db.exec(
      "ALTER TABLE todo_attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'",
    );
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_todo_attachments_todo
    ON todo_attachments(todo_id, id)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL,
      completion_date TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE (todo_id, completion_date),
      FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_todo_completions_date
    ON todo_completions(completion_date, todo_id)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL UNIQUE,
      reminder_type TEXT NOT NULL CHECK (reminder_type IN ('once','daily')),
      remind_at TEXT,
      remind_time TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_trigger_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
      CHECK (
        (reminder_type = 'once' AND remind_at IS NOT NULL AND remind_time IS NULL)
        OR
        (reminder_type = 'daily' AND remind_time IS NOT NULL AND remind_at IS NULL)
      )
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_todo_reminders_due
    ON todo_reminders(enabled, next_trigger_at)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_notification_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id INTEGER NOT NULL,
      scheduled_for TEXT NOT NULL,
      sent_at TEXT,
      channel TEXT NOT NULL DEFAULT 'windows',
      status TEXT NOT NULL CHECK (status IN ('sent','failed','skipped')),
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE (reminder_id, scheduled_for),
      FOREIGN KEY (reminder_id) REFERENCES todo_reminders(id) ON DELETE CASCADE
    )
  `);

  // 数据共享：所有者把某个文件夹（含子文件夹）或收件箱的增删改权限授予其他用户
  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      grantee_id INTEGER NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('category','inbox')),
      category_id INTEGER,
      permission TEXT NOT NULL CHECK (permission IN ('readonly','write')),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (grantee_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES todo_categories(id) ON DELETE CASCADE,
      CHECK (
        (scope = 'category' AND category_id IS NOT NULL)
        OR (scope = 'inbox' AND category_id IS NULL)
      )
    )
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_todo_shares_target
    ON todo_shares(owner_id, grantee_id, scope, IFNULL(category_id, 0))
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_todo_shares_grantee
    ON todo_shares(grantee_id, owner_id)
  `);

  // 桌宠提醒设置：按用户保存间隔提醒、上下班时间与截止提醒提前量
  db.exec(`
    CREATE TABLE IF NOT EXISTS pet_settings (
      user_id INTEGER PRIMARY KEY,
      interval_enabled INTEGER NOT NULL DEFAULT 1,
      interval_minutes INTEGER NOT NULL DEFAULT 60,
      interval_work_hours INTEGER NOT NULL DEFAULT 0,
      work_start TEXT NOT NULL DEFAULT '09:00',
      work_end TEXT NOT NULL DEFAULT '18:00',
      work_start_enabled INTEGER NOT NULL DEFAULT 1,
      work_end_enabled INTEGER NOT NULL DEFAULT 1,
      due_lead_minutes INTEGER NOT NULL DEFAULT 15,
      pet_image TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // 兼容旧库：补充角色素材字段
  const petSettingsCols = db.prepare("PRAGMA table_info(pet_settings)").all() as Array<{
    name: string;
  }>;
  if (!petSettingsCols.some((col) => col.name === "pet_image")) {
    db.exec("ALTER TABLE pet_settings ADD COLUMN pet_image TEXT");
  }

  const listCategoriesStmt = db.prepare(
    `SELECT id, user_id, parent_id, name, color, sort_order, created_at, updated_at
     FROM todo_categories WHERE user_id = ? ORDER BY sort_order ASC, id ASC`,
  );
  const getCategoryStmt = db.prepare(
    `SELECT id, user_id, parent_id, name, color, sort_order, created_at, updated_at
     FROM todo_categories WHERE id = ? AND user_id = ?`,
  );
  const getCategoryByIdStmt = db.prepare(
    `SELECT id, user_id, parent_id, name, color, sort_order, created_at, updated_at
     FROM todo_categories WHERE id = ?`,
  );
  const findCategorySiblingStmt = db.prepare(
    `SELECT id FROM todo_categories
     WHERE user_id = ? AND IFNULL(parent_id, 0) = IFNULL(?, 0)
       AND name = ? COLLATE NOCASE AND id <> ? LIMIT 1`,
  );
  const insertCategoryStmt = db.prepare(
    `INSERT INTO todo_categories
     (user_id, parent_id, name, color, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateCategoryStmt = db.prepare(
    `UPDATE todo_categories
     SET parent_id = ?, name = ?, color = ?, sort_order = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  );
  const countCategoryChildrenStmt = db.prepare(
    `SELECT COUNT(*) AS count FROM todo_categories WHERE user_id = ? AND parent_id = ?`,
  );
  const countCategoryActiveTasksStmt = db.prepare(
    `SELECT COUNT(*) AS count FROM todos
     WHERE user_id = ? AND category_id = ? AND deleted_at IS NULL`,
  );
  const countInboxActiveTasksStmt = db.prepare(
    `SELECT COUNT(*) AS count FROM todos
     WHERE user_id = ? AND category_id IS NULL AND deleted_at IS NULL`,
  );
  const detachAllCategoryTasksStmt = db.prepare(
    `UPDATE todos SET category_id = NULL WHERE user_id = ? AND category_id = ?`,
  );
  const deleteCategoryStmt = db.prepare(
    `DELETE FROM todo_categories WHERE id = ? AND user_id = ?`,
  );

  const listTagsStmt = db.prepare(
    `SELECT id, user_id, name, color, created_at, updated_at
     FROM todo_tags WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC, id ASC`,
  );
  const getTagStmt = db.prepare(
    `SELECT id, user_id, name, color, created_at, updated_at
     FROM todo_tags WHERE id = ? AND user_id = ?`,
  );
  const findTagSiblingStmt = db.prepare(
    `SELECT id FROM todo_tags
     WHERE user_id = ? AND name = ? COLLATE NOCASE AND id <> ? LIMIT 1`,
  );
  const insertTagStmt = db.prepare(
    `INSERT INTO todo_tags (user_id, name, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const updateTagStmt = db.prepare(
    `UPDATE todo_tags SET name = ?, color = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  );
  const deleteTagStmt = db.prepare(
    `DELETE FROM todo_tags WHERE id = ? AND user_id = ?`,
  );

  const getTodoStmt = db.prepare(
    `SELECT * FROM todos
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  );
  const getTodoByIdStmt = db.prepare(
    `SELECT * FROM todos WHERE id = ? AND deleted_at IS NULL`,
  );
  const listActiveTodosStmt = db.prepare(
    `SELECT * FROM todos
     WHERE user_id = ? AND deleted_at IS NULL
     ORDER BY sort_order ASC, id ASC`,
  );
  const insertTodoStmt = db.prepare(
    `INSERT INTO todos
     (user_id, category_id, title, description, priority, schedule_type,
      due_date, due_time, repeat_start_date, repeat_end_date, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateTodoStmt = db.prepare(
    `UPDATE todos
     SET category_id = ?, title = ?, description = ?, priority = ?,
         schedule_type = ?, due_date = ?, due_time = ?, repeat_start_date = ?,
         repeat_end_date = ?, sort_order = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  );
  const softDeleteTodoStmt = db.prepare(
    `UPDATE todos SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  );
  const touchTodoStmt = db.prepare(
    `UPDATE todos SET updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  );

  const listTodoTagsStmt = db.prepare(
    `SELECT t.id, t.user_id, t.name, t.color, t.created_at, t.updated_at
     FROM todo_tags t
     INNER JOIN todo_tag_links l ON l.tag_id = t.id
     WHERE l.todo_id = ? AND t.user_id = ?
     ORDER BY t.name COLLATE NOCASE ASC, t.id ASC`,
  );
  const deleteTodoTagLinksStmt = db.prepare(
    `DELETE FROM todo_tag_links WHERE todo_id = ?`,
  );
  const insertTodoTagLinkStmt = db.prepare(
    `INSERT OR IGNORE INTO todo_tag_links (todo_id, tag_id) VALUES (?, ?)`,
  );

  const listTodoAttachmentsStmt = db.prepare(
    `SELECT * FROM todo_attachments WHERE todo_id = ? AND user_id = ? ORDER BY id ASC`,
  );
  const getTodoAttachmentStmt = db.prepare(
    `SELECT * FROM todo_attachments WHERE id = ? AND todo_id = ? AND user_id = ?`,
  );
  const getTodoAttachmentByIdStmt = db.prepare(
    `SELECT * FROM todo_attachments WHERE id = ?`,
  );

  // ---------- 数据共享语句 ----------
  const shareSelectColumns = `
    SELECT s.*, o.username AS owner_username, g.username AS grantee_username,
           c.name AS category_name
    FROM todo_shares s
    INNER JOIN users o ON o.id = s.owner_id
    INNER JOIN users g ON g.id = s.grantee_id
    LEFT JOIN todo_categories c ON c.id = s.category_id
  `;
  const listOwnedSharesStmt = db.prepare(
    `${shareSelectColumns} WHERE s.owner_id = ? ORDER BY s.created_at DESC, s.id DESC`,
  );
  const listReceivedSharesStmt = db.prepare(
    `${shareSelectColumns} WHERE s.grantee_id = ? ORDER BY s.created_at DESC, s.id DESC`,
  );
  const listAllSharesStmt = db.prepare(
    `${shareSelectColumns} ORDER BY s.created_at DESC, s.id DESC LIMIT 500`,
  );
  const getShareListRowStmt = db.prepare(`${shareSelectColumns} WHERE s.id = ?`);
  const getShareByIdStmt = db.prepare(`SELECT * FROM todo_shares WHERE id = ?`);
  const findShareStmt = db.prepare(
    `SELECT * FROM todo_shares
     WHERE owner_id = ? AND grantee_id = ? AND scope = ?
       AND IFNULL(category_id, 0) = IFNULL(?, 0)`,
  );
  const insertShareStmt = db.prepare(
    `INSERT INTO todo_shares
     (owner_id, grantee_id, scope, category_id, permission, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateSharePermissionStmt = db.prepare(
    `UPDATE todo_shares SET permission = ?, updated_at = ? WHERE id = ?`,
  );
  const deleteShareStmt = db.prepare(`DELETE FROM todo_shares WHERE id = ?`);
  const listCategorySharesForGranteeStmt = db.prepare(
    `SELECT * FROM todo_shares WHERE grantee_id = ? AND scope = 'category' ORDER BY id ASC`,
  );
  const listInboxSharesForGranteeStmt = db.prepare(
    `SELECT * FROM todo_shares WHERE grantee_id = ? AND scope = 'inbox' ORDER BY id ASC`,
  );
  const getUsernameStmt = db.prepare(`SELECT username FROM users WHERE id = ?`);
  const getShareUserStmt = db.prepare(
    `SELECT id, username, role, status FROM users WHERE id = ?`,
  );
  const listShareUsersStmt = db.prepare(
    `SELECT id, username, role FROM users
     WHERE id <> ? AND status = 'active'
     ORDER BY username COLLATE NOCASE ASC`,
  );

  // 任务所在分类被共享给当前用户时，沿父链向上查找权限（取最高）
  const resolveCategoryShareStmt = db.prepare(
    `WITH RECURSIVE category_chain(id, parent_id) AS (
       SELECT id, parent_id FROM todo_categories WHERE id = ?
       UNION ALL
       SELECT c.id, c.parent_id FROM todo_categories c
       INNER JOIN category_chain cc ON c.id = cc.parent_id
     )
     SELECT s.permission AS permission
     FROM todo_shares s
     WHERE s.grantee_id = ? AND s.owner_id = ? AND s.scope = 'category'
       AND s.category_id IN (SELECT id FROM category_chain)
     ORDER BY CASE s.permission WHEN 'write' THEN 2 ELSE 1 END DESC
     LIMIT 1`,
  );
  const resolveInboxShareStmt = db.prepare(
    `SELECT s.permission AS permission
     FROM todo_shares s
     WHERE s.grantee_id = ? AND s.owner_id = ? AND s.scope = 'inbox'
     ORDER BY CASE s.permission WHEN 'write' THEN 2 ELSE 1 END DESC
     LIMIT 1`,
  );
  const insertTodoAttachmentStmt = db.prepare(
    `INSERT INTO todo_attachments
     (todo_id, user_id, kind, original_name, stored_name, mime_type, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteTodoAttachmentStmt = db.prepare(
    `DELETE FROM todo_attachments WHERE id = ? AND todo_id = ? AND user_id = ?`,
  );
  const countTodoAttachmentsByKindStmt = db.prepare(
    `SELECT kind, COUNT(*) AS count FROM todo_attachments
     WHERE todo_id = ? AND user_id = ? GROUP BY kind`,
  );

  const getAnyCompletionStmt = db.prepare(
    `SELECT * FROM todo_completions WHERE todo_id = ?
     ORDER BY completed_at DESC, id DESC LIMIT 1`,
  );
  const getCompletionForDateStmt = db.prepare(
    `SELECT * FROM todo_completions WHERE todo_id = ? AND completion_date = ?`,
  );
  const insertCompletionStmt = db.prepare(
    `INSERT OR IGNORE INTO todo_completions
     (todo_id, completion_date, completed_at, created_at) VALUES (?, ?, ?, ?)`,
  );
  const deleteCompletionForDateStmt = db.prepare(
    `DELETE FROM todo_completions WHERE todo_id = ? AND completion_date = ?`,
  );
  const deleteAllCompletionsStmt = db.prepare(
    `DELETE FROM todo_completions WHERE todo_id = ?`,
  );

  const getReminderStmt = db.prepare(
    `SELECT * FROM todo_reminders WHERE todo_id = ?`,
  );
  const upsertReminderStmt = db.prepare(
    `INSERT INTO todo_reminders
     (todo_id, reminder_type, remind_at, remind_time, enabled, next_trigger_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(todo_id) DO UPDATE SET
       reminder_type = excluded.reminder_type,
       remind_at = excluded.remind_at,
       remind_time = excluded.remind_time,
       enabled = 1,
       next_trigger_at = excluded.next_trigger_at,
       updated_at = excluded.updated_at`,
  );
  const deleteReminderStmt = db.prepare(
    `DELETE FROM todo_reminders WHERE todo_id = ?`,
  );
  const disableReminderForTodoStmt = db.prepare(
    `UPDATE todo_reminders
     SET enabled = 0, next_trigger_at = NULL, updated_at = ?
     WHERE todo_id = ?`,
  );
  const dueRemindersStmt = db.prepare(
    `SELECT r.*, t.user_id, t.title AS todo_title, t.description AS todo_description,
            t.schedule_type AS todo_schedule_type, t.repeat_start_date,
            t.repeat_end_date, t.category_id, t.deleted_at
     FROM todo_reminders r
     INNER JOIN todos t ON t.id = r.todo_id
     WHERE r.enabled = 1 AND r.next_trigger_at IS NOT NULL
       AND r.next_trigger_at <= ?
     ORDER BY r.next_trigger_at ASC LIMIT 20`,
  );
  const updateReminderNextStmt = db.prepare(
    `UPDATE todo_reminders
     SET next_trigger_at = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
  );
  const insertNotificationLogStmt = db.prepare(
    `INSERT OR IGNORE INTO todo_notification_logs
     (reminder_id, scheduled_for, sent_at, channel, status, error, created_at)
     VALUES (?, ?, ?, 'windows', ?, ?, ?)`,
  );
  if (!fs.existsSync(todoAttachmentsDir)) {
    fs.mkdirSync(todoAttachmentsDir, { recursive: true });
  }

  // 图片与其他文件共用同一个上传入口，格式与大小在路由内按类型分别校验
  const todoAttachmentUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_FILE_BYTES,
      files: MAX_TODO_IMAGES + MAX_TODO_FILES,
    },
  });

  const todoAttachmentFields = todoAttachmentUpload.fields([
    { name: "images", maxCount: MAX_TODO_IMAGES },
    { name: "files", maxCount: MAX_TODO_FILES },
    { name: "file", maxCount: 1 },
  ]);

  const flattenUploadedFiles = (files: unknown): Express.Multer.File[] => {
    if (!files) return [];
    if (Array.isArray(files)) return files as Express.Multer.File[];
    if (typeof files !== "object") return [];
    return Object.values(files as Record<string, Express.Multer.File[]>).flat();
  };

  const toTodoAttachmentDto = (row: TodoAttachmentRow) => ({
    id: row.id,
    kind: row.kind,
    originalName: row.original_name,
    mimeType: row.mime_type,
    size: row.size,
    url: `${apiPrefix}/todo-attachments/${row.id}`,
    createdAt: row.created_at,
  });

  const getTodoTags = (todoId: number, userId: number): TagRow[] =>
    listTodoTagsStmt.all(todoId, userId) as TagRow[];

  const toTodoDto = (row: TodoRow, selectedDate: string, access: AccessMeta = {}) => {
    const category = row.category_id
      ? (getCategoryStmt.get(row.category_id, row.user_id) as CategoryRow | undefined)
      : undefined;
    const tags = getTodoTags(row.id, row.user_id).map((tag) => toTagDto(tag, access));
    const attachments = (listTodoAttachmentsStmt.all(row.id, row.user_id) as TodoAttachmentRow[])
      .map(toTodoAttachmentDto);
    // images 保留为图片子集，兼容旧调用方；attachments 包含全部文件
    const images = attachments.filter((item) => item.kind === "image");
    const completion =
      row.schedule_type === "daily"
        ? (getCompletionForDateStmt.get(row.id, selectedDate) as CompletionRow | undefined)
        : (getAnyCompletionStmt.get(row.id) as CompletionRow | undefined);
    const reminder = getReminderStmt.get(row.id) as ReminderRow | undefined;
    const isCompleted = Boolean(completion);
    const isActiveOnDate =
      row.schedule_type === "daily" ? taskIsActiveOnDate(row, selectedDate) : true;
    const nowDateTime = localNow();
    const dueDateTime = row.due_date
      ? `${row.due_date} ${row.due_time || "23:59"}:00`
      : null;
    const isToday = selectedDate === localToday();
    const isOverdue =
      !isCompleted &&
      row.schedule_type === "once" &&
      Boolean(row.due_date) &&
      (
        String(row.due_date) < selectedDate ||
        (
          isToday &&
          String(row.due_date) === selectedDate &&
          Boolean(dueDateTime) &&
          String(dueDateTime) < nowDateTime
        )
      );

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      categoryId: row.category_id,
      category: category ? toCategoryDto(category, access) : null,
      tags,
      images,
      attachments,
      priority: row.priority,
      scheduleType: row.schedule_type,
      dueDate: row.due_date,
      dueTime: row.due_time,
      repeatStartDate: row.repeat_start_date,
      repeatEndDate: row.repeat_end_date,
      sortOrder: row.sort_order,
      isCompleted,
      completedAt: completion?.completed_at ?? null,
      completionDate: completion?.completion_date ?? null,
      isOverdue,
      isActiveOnDate,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reminder: toReminderDto(reminder),
      ownerId: row.user_id,
      ownerUsername: access.ownerUsername ?? null,
      permission: access.permission ?? "owner",
      shared: access.shared ?? false,
    };
  };

  type TodoDto = ReturnType<typeof toTodoDto>;

  /** 「只显示当天」的可见性判断：每日任务按重复区间，单次任务按创建日 ~ 截止日区间 */
  const isTodoVisibleOnDate = (todo: TodoDto, selectedDate: string): boolean => {
    if (todo.scheduleType === "daily") return todo.isActiveOnDate;
    if (todo.isCompleted) {
      // 已完成：出现在完成日期，有截止日期时也可在截止日期看到
      return todo.dueDate === selectedDate || todo.completionDate === selectedDate;
    }
    const createdDateKey = String(todo.createdAt || "").slice(0, 10);
    if (todo.dueDate) {
      // 有截止日期：创建日期到截止日期之间每天可见
      if (!createdDateKey) return selectedDate <= todo.dueDate;
      // 截止日期早于创建日期时不构成区间，只保留截止日期当天
      if (todo.dueDate < createdDateKey) return todo.dueDate === selectedDate;
      return selectedDate >= createdDateKey && selectedDate <= todo.dueDate;
    }
    // 无截止日期的单次事件：只在其创建日期及之后显示
    return !createdDateKey || selectedDate >= createdDateKey;
  };

  const ensureCategoryBelongsToUser = (
    userId: number,
    categoryId: number,
  ): CategoryRow => {
    const row = getCategoryStmt.get(categoryId, userId) as CategoryRow | undefined;
    if (!row) fail(400, "category not found");
    return row;
  };

  const ensureTagsBelongToUser = (userId: number, tagIds: number[]): void => {
    for (const tagId of tagIds) {
      const row = getTagStmt.get(tagId, userId) as TagRow | undefined;
      if (!row) fail(400, `tag ${tagId} not found`);
    }
  };

  const getTodoOrThrow = (userId: number, todoId: number): TodoRow => {
    const row = getTodoStmt.get(todoId, userId) as TodoRow | undefined;
    if (!row) fail(404, "todo not found");
    return row;
  };

  // ---------- 数据共享辅助函数 ----------

  const getOwnerUsername = (userId: number): string => {
    const row = getUsernameStmt.get(userId) as { username: string } | undefined;
    return row?.username ?? `用户 #${userId}`;
  };

  const maxPermission = (
    current: SharePermission | null | undefined,
    next: SharePermission,
  ): SharePermission => (current === "write" || next === "write" ? "write" : "readonly");

  /** 解析当前用户对某个文件夹的访问：自己的文件夹或可访问的共享文件夹 */
  const resolveCategoryAccess = (
    userId: number,
    categoryId: number,
  ): { row: CategoryRow; ownerId: number; permission: DataAccessLevel } => {
    const own = getCategoryStmt.get(categoryId, userId) as CategoryRow | undefined;
    if (own) return { row: own, ownerId: userId, permission: "owner" };
    const row = getCategoryByIdStmt.get(categoryId) as CategoryRow | undefined;
    if (!row) fail(404, "category not found");
    const share = resolveCategoryShareStmt.get(categoryId, userId, row.user_id) as
      | { permission: SharePermission }
      | undefined;
    if (!share) fail(404, "category not found");
    return { row, ownerId: row.user_id, permission: share.permission };
  };

  /** 解析当前用户对某个任务的访问：自己的任务或通过文件夹/收件箱共享获得的任务 */
  const getTodoAccess = (
    userId: number,
    todoId: number,
  ): { row: TodoRow; ownerId: number; permission: DataAccessLevel } => {
    const row = getTodoByIdStmt.get(todoId) as TodoRow | undefined;
    if (!row) fail(404, "todo not found");
    if (row.user_id === userId) return { row, ownerId: userId, permission: "owner" };
    let permission: SharePermission | undefined;
    if (row.category_id === null) {
      permission = (
        resolveInboxShareStmt.get(userId, row.user_id) as
          | { permission: SharePermission }
          | undefined
      )?.permission;
    } else {
      permission = (
        resolveCategoryShareStmt.get(row.category_id, userId, row.user_id) as
          | { permission: SharePermission }
          | undefined
      )?.permission;
    }
    // 没有共享时统一按不存在处理，避免泄露他人的任务 ID
    if (!permission) fail(404, "todo not found");
    return { row, ownerId: row.user_id, permission };
  };

  /** 只读共享禁止任何增删改操作 */
  const ensureWritableAccess = (
    access: { permission: DataAccessLevel },
    action = "modify",
  ): void => {
    if (access.permission === "readonly") {
      fail(403, `readonly share: cannot ${action} shared data`);
    }
  };

  /** 非所有者访问时，为 DTO 附加来源与权限标记 */
  const toAccessMeta = (
    access: { ownerId: number; permission: DataAccessLevel },
    viewerId: number,
  ): AccessMeta =>
    access.ownerId === viewerId
      ? {}
      : {
          ownerUsername: getOwnerUsername(access.ownerId),
          permission: access.permission,
          shared: true,
        };

  /** 汇总“共享给我”的范围：按所有者聚合分类子树与收件箱权限 */
  const loadSharedScopes = (userId: number): SharedScope[] => {
    const scopes = new Map<number, SharedScope>();
    const ensureScope = (ownerId: number): SharedScope => {
      let scope = scopes.get(ownerId);
      if (!scope) {
        scope = {
          ownerId,
          ownerUsername: getOwnerUsername(ownerId),
          categoryIds: null,
          categoryPermissions: new Map(),
          inboxPermission: null,
          shareIds: [],
        };
        scopes.set(ownerId, scope);
      }
      return scope;
    };

    for (const share of listInboxSharesForGranteeStmt.all(userId) as ShareRow[]) {
      const scope = ensureScope(share.owner_id);
      scope.inboxPermission = maxPermission(scope.inboxPermission, share.permission);
      scope.shareIds.push(share.id);
    }

    const childrenByOwner = new Map<number, Map<number | null, CategoryRow[]>>();
    for (const share of listCategorySharesForGranteeStmt.all(userId) as ShareRow[]) {
      const scope = ensureScope(share.owner_id);
      if (!childrenByOwner.has(share.owner_id)) {
        const rows = listCategoriesStmt.all(share.owner_id) as CategoryRow[];
        const children = new Map<number | null, CategoryRow[]>();
        for (const row of rows) {
          const list = children.get(row.parent_id) ?? [];
          list.push(row);
          children.set(row.parent_id, list);
        }
        childrenByOwner.set(share.owner_id, children);
      }
      if (share.category_id === null) continue;
      if (!scope.categoryIds) scope.categoryIds = new Set<number>();
      const stack = [share.category_id];
      const children = childrenByOwner.get(share.owner_id) ?? new Map();
      const visited = new Set<number>();
      while (stack.length) {
        const current = stack.pop();
        if (current === undefined || visited.has(current)) continue;
        visited.add(current);
        scope.categoryIds.add(current);
        scope.categoryPermissions.set(
          current,
          maxPermission(scope.categoryPermissions.get(current), share.permission),
        );
        for (const child of children.get(current) ?? []) stack.push(child.id);
      }
      scope.shareIds.push(share.id);
    }

    return [...scopes.values()];
  };

  /** 文件夹路径，用于共享列表展示（如“工作 / 本周”） */
  const buildCategoryPath = (ownerId: number, categoryId: number): string => {
    const rows = listCategoriesStmt.all(ownerId) as CategoryRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const parts: string[] = [];
    const visited = new Set<number>();
    let cursor: number | null = categoryId;
    while (cursor !== null && !visited.has(cursor)) {
      visited.add(cursor);
      const node = byId.get(cursor);
      if (!node) break;
      parts.unshift(node.name);
      cursor = node.parent_id;
    }
    return parts.join(" / ");
  };

  type ShareListRow = ShareRow & {
    owner_username: string;
    grantee_username: string;
    category_name: string | null;
  };

  const toShareDto = (row: ShareListRow) => ({
    id: row.id,
    ownerId: row.owner_id,
    ownerUsername: row.owner_username,
    granteeId: row.grantee_id,
    granteeUsername: row.grantee_username,
    scope: row.scope,
    categoryId: row.category_id,
    categoryName: row.category_name,
    categoryPath:
      row.scope === "category" && row.category_id
        ? buildCategoryPath(row.owner_id, row.category_id)
        : null,
    permission: row.permission,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const isAdminRequest = (req: express.Request): boolean =>
    String((req as AuthedRequest).user?.role || "") === "admin";

  const collectCategoryIds = (
    userId: number,
    rootId: number,
    includeDescendants: boolean,
  ): number[] => {
    if (!includeDescendants) return [rootId];
    const rows = listCategoriesStmt.all(userId) as CategoryRow[];
    const children = new Map<number, number[]>();
    for (const row of rows) {
      if (row.parent_id === null) continue;
      const list = children.get(row.parent_id) ?? [];
      list.push(row.id);
      children.set(row.parent_id, list);
    }
    const result: number[] = [];
    const stack = [rootId];
    while (stack.length) {
      const current = stack.pop();
      if (current === undefined) continue;
      result.push(current);
      for (const child of children.get(current) ?? []) stack.push(child);
    }
    return result;
  };

  const priorityRank: Record<TodoPriority, number> = {
    high: 0,
    normal: 1,
    low: 2,
  };  // Category API
  const categoryRouter = express.Router();
  categoryRouter.use(authMiddleware);
  categoryRouter.use(writeGuard);

  categoryRouter.get("/", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const ownRows = listCategoriesStmt.all(userId) as CategoryRow[];
      const categories = ownRows.map((row) => toCategoryDto(row));
      const visibleIds = new Set<number>(ownRows.map((row) => row.id));
      const sharedScopes = loadSharedScopes(userId);

      // 共享分类统一追加在自己的分类之后，并标记来源与权限
      for (const scope of sharedScopes) {
        if (!scope.categoryIds || scope.categoryIds.size === 0) continue;
        const rows = listCategoriesStmt.all(scope.ownerId) as CategoryRow[];
        for (const row of rows) {
          if (!scope.categoryIds.has(row.id)) continue;
          visibleIds.add(row.id);
        }
        for (const row of rows) {
          if (!scope.categoryIds.has(row.id)) continue;
          const dto = toCategoryDto(row, {
            ownerUsername: scope.ownerUsername,
            permission: scope.categoryPermissions.get(row.id) ?? "readonly",
            shared: true,
          });
          // 父分类不可见时（共享的是子文件夹），把它作为根节点展示
          if (dto.parentId !== null && !visibleIds.has(dto.parentId)) {
            dto.parentId = null;
          }
          categories.push(dto);
        }
      }

      res.json({ res: true, categories });
    } catch (error) {
      sendRouteError(res, error, "list todo categories", logError);
    }
  });

  categoryRouter.post("/", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = String(body.name ?? "").trim();
      if (!name) fail(400, "name is required");
      if (name.length > 80) fail(400, "name must be at most 80 characters");
      const parentId = parseOptionalPositiveId(body.parentId, "parentId");
      if (parentId !== null) ensureCategoryBelongsToUser(userId, parentId);
      const duplicate = findCategorySiblingStmt.get(userId, parentId, name, 0);
      if (duplicate) fail(409, "a category with this name already exists here");
      const color = normalizeColor(body.color);
      const sortOrder = parseSortOrder(body.sortOrder, 0);
      const now = localNow();
      const info = insertCategoryStmt.run(
        userId, parentId, name, color, sortOrder, now, now,
      );
      const category = getCategoryStmt.get(
        Number(info.lastInsertRowid), userId,
      ) as CategoryRow;
      res.status(201).json({ res: true, category: toCategoryDto(category) });
    } catch (error) {
      sendRouteError(res, error, "create todo category", logError);
    }
  });

  categoryRouter.patch("/:id", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const categoryId = parsePositiveId(req.params.id, "category id");
      const current = ensureCategoryBelongsToUser(userId, categoryId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = hasOwn(body, "name")
        ? String(body.name ?? "").trim()
        : current.name;
      if (!name) fail(400, "name is required");
      if (name.length > 80) fail(400, "name must be at most 80 characters");
      const parentId = hasOwn(body, "parentId")
        ? parseOptionalPositiveId(body.parentId, "parentId")
        : current.parent_id;
      const color = hasOwn(body, "color")
        ? normalizeColor(body.color, current.color)
        : current.color;
      const sortOrder = hasOwn(body, "sortOrder")
        ? parseSortOrder(body.sortOrder, current.sort_order)
        : current.sort_order;

      if (parentId !== null) {
        if (parentId === categoryId) {
          fail(400, "a category cannot be its own parent");
        }
        ensureCategoryBelongsToUser(userId, parentId);
        let cursor: number | null = parentId;
        while (cursor !== null) {
          if (cursor === categoryId) {
            fail(400, "cannot move a category into its descendant");
          }
          const parent = getCategoryStmt.get(cursor, userId) as
            | CategoryRow
            | undefined;
          if (!parent) break;
          cursor = parent.parent_id;
        }
      }

      const duplicate = findCategorySiblingStmt.get(
        userId, parentId, name, categoryId,
      );
      if (duplicate) fail(409, "a category with this name already exists here");

      updateCategoryStmt.run(
        parentId, name, color, sortOrder, localNow(), categoryId, userId,
      );
      const updated = getCategoryStmt.get(categoryId, userId) as CategoryRow;
      res.json({ res: true, category: toCategoryDto(updated) });
    } catch (error) {
      sendRouteError(res, error, "update todo category", logError);
    }
  });

  categoryRouter.delete("/:id", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const categoryId = parsePositiveId(req.params.id, "category id");
      ensureCategoryBelongsToUser(userId, categoryId);
      const children = countCategoryChildrenStmt.get(userId, categoryId) as {
        count: number;
      };
      if (children.count > 0) {
        fail(409, "category has subfolders; move or delete them first");
      }
      const activeTasks = countCategoryActiveTasksStmt.get(
        userId, categoryId,
      ) as { count: number };
      if (activeTasks.count > 0) {
        fail(409, "category has tasks; move or delete them first");
      }
      detachAllCategoryTasksStmt.run(userId, categoryId);
      deleteCategoryStmt.run(categoryId, userId);
      res.json({ res: true, message: "category deleted" });
    } catch (error) {
      sendRouteError(res, error, "delete todo category", logError);
    }
  });  // Tag API
  const tagRouter = express.Router();
  tagRouter.use(authMiddleware);
  tagRouter.use(writeGuard);

  tagRouter.get("/", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const tags = (listTagsStmt.all(userId) as TagRow[]).map((row) => toTagDto(row));
      // 共享数据上的标签属于所有者，这里一并返回用于筛选与任务编辑
      for (const scope of loadSharedScopes(userId)) {
        const rows = listTagsStmt.all(scope.ownerId) as TagRow[];
        for (const row of rows) {
          tags.push(
            toTagDto(row, {
              ownerUsername: scope.ownerUsername,
              shared: true,
            }),
          );
        }
      }
      res.json({ res: true, tags });
    } catch (error) {
      sendRouteError(res, error, "list todo tags", logError);
    }
  });

  tagRouter.post("/", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = String(body.name ?? "").trim();
      if (!name) fail(400, "name is required");
      if (name.length > 40) fail(400, "name must be at most 40 characters");
      const duplicate = findTagSiblingStmt.get(userId, name, 0);
      if (duplicate) fail(409, "a tag with this name already exists");
      const color = normalizeColor(body.color, "#0969da");
      const now = localNow();
      const info = insertTagStmt.run(userId, name, color, now, now);
      const tag = getTagStmt.get(Number(info.lastInsertRowid), userId) as TagRow;
      res.status(201).json({ res: true, tag: toTagDto(tag) });
    } catch (error) {
      sendRouteError(res, error, "create todo tag", logError);
    }
  });

  tagRouter.patch("/:id", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const tagId = parsePositiveId(req.params.id, "tag id");
      const current = getTagStmt.get(tagId, userId) as TagRow | undefined;
      if (!current) fail(404, "tag not found");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = hasOwn(body, "name")
        ? String(body.name ?? "").trim()
        : current.name;
      if (!name) fail(400, "name is required");
      if (name.length > 40) fail(400, "name must be at most 40 characters");
      const duplicate = findTagSiblingStmt.get(userId, name, tagId);
      if (duplicate) fail(409, "a tag with this name already exists");
      const color = hasOwn(body, "color")
        ? normalizeColor(body.color, current.color)
        : current.color;
      updateTagStmt.run(name, color, localNow(), tagId, userId);
      const updated = getTagStmt.get(tagId, userId) as TagRow;
      res.json({ res: true, tag: toTagDto(updated) });
    } catch (error) {
      sendRouteError(res, error, "update todo tag", logError);
    }
  });

  tagRouter.delete("/:id", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const tagId = parsePositiveId(req.params.id, "tag id");
      const current = getTagStmt.get(tagId, userId) as TagRow | undefined;
      if (!current) fail(404, "tag not found");
      deleteTagStmt.run(tagId, userId);
      res.json({ res: true, message: "tag deleted" });
    } catch (error) {
      sendRouteError(res, error, "delete todo tag", logError);
    }
  });  // Todo API
  const todoRouter = express.Router();
  todoRouter.use(authMiddleware);
  todoRouter.use(writeGuard);

  todoRouter.get("/", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const selectedDateRaw = String(req.query.date ?? "").trim();
      const selectedDate = selectedDateRaw || localToday();
      if (!isValidDateOnly(selectedDate)) {
        fail(400, "date must be YYYY-MM-DD");
      }
      const categoryId = parseOptionalPositiveId(req.query.categoryId, "categoryId");
      const tagId = parseOptionalPositiveId(req.query.tagId, "tagId");
      const includeDescendants = String(req.query.includeDescendants ?? "true") !== "false";
      const typeRaw = String(req.query.type ?? "").trim();
      if (typeRaw && typeRaw !== "once" && typeRaw !== "daily") {
        fail(400, "type must be once or daily");
      }
      const statusRaw = String(req.query.status ?? "").trim();
      if (statusRaw && statusRaw !== "pending" && statusRaw !== "completed") {
        fail(400, "status must be pending or completed");
      }
      const viewRaw = String(req.query.view ?? "").trim();
      if (viewRaw && !["all", "today", "inbox"].includes(viewRaw)) {
        fail(400, "view must be all, today or inbox");
      }
      const inboxOnly = ["1", "true"].includes(
        String(req.query.inbox ?? "").trim().toLowerCase(),
      );
      const createdDate = normalizeOptionalDate(req.query.createdDate, "createdDate");
      const createdFrom = normalizeOptionalLocalDateTime(
        req.query.createdFrom,
        "createdFrom",
      );
      const createdTo = normalizeOptionalLocalDateTime(
        req.query.createdTo,
        "createdTo",
      );
      if (createdFrom && createdTo && createdFrom > createdTo) {
        fail(400, "createdFrom must not be later than createdTo");
      }
      const dueDate = normalizeOptionalDate(req.query.dueDate, "dueDate");
      const dueFrom = normalizeOptionalDate(req.query.dueFrom, "dueFrom");
      const dueTo = normalizeOptionalDate(req.query.dueTo, "dueTo");
      if (dueFrom && dueTo && dueFrom > dueTo) {
        fail(400, "dueFrom must not be later than dueTo");
      }
      const search = String(req.query.search ?? "").trim().toLowerCase();

      const sharedScopes = loadSharedScopes(userId);

      let allowedCategoryIds: Set<number> | null = null;
      let categoryOwnerId: number | null = null;
      if (categoryId !== null) {
        const access = resolveCategoryAccess(userId, categoryId);
        categoryOwnerId = access.ownerId;
        if (access.permission === "owner") {
          allowedCategoryIds = new Set(
            collectCategoryIds(userId, categoryId, includeDescendants),
          );
        } else {
          const scope = sharedScopes.find((item) => item.ownerId === access.ownerId);
          const sharedIds = scope?.categoryIds ?? new Set<number>();
          if (includeDescendants) {
            allowedCategoryIds = new Set(
              collectCategoryIds(access.ownerId, categoryId, true).filter((id) =>
                sharedIds.has(id),
              ),
            );
          } else {
            allowedCategoryIds = new Set([categoryId]);
          }
        }
      }

      const ownRows = listActiveTodosStmt.all(userId) as TodoRow[];
      const merged: Array<{ row: TodoRow; access: AccessMeta }> = ownRows.map((row) => ({
        row,
        access: {},
      }));

      // 合并“共享给我”的任务：按文件夹子树或收件箱范围判断可见性与权限
      for (const scope of sharedScopes) {
        if (categoryOwnerId !== null && scope.ownerId !== categoryOwnerId) continue;
        const ownerRows = listActiveTodosStmt.all(scope.ownerId) as TodoRow[];
        for (const row of ownerRows) {
          let permission: SharePermission | null = null;
          if (row.category_id === null) {
            permission = scope.inboxPermission;
          } else if (scope.categoryIds?.has(row.category_id)) {
            permission = scope.categoryPermissions.get(row.category_id) ?? null;
          }
          if (!permission) continue;
          if (
            allowedCategoryIds &&
            (row.category_id === null || !allowedCategoryIds.has(row.category_id))
          ) {
            continue;
          }
          merged.push({
            row,
            access: {
              ownerUsername: scope.ownerUsername,
              permission,
              shared: true,
            },
          });
        }
      }

      let todos = merged.map(({ row, access }) => toTodoDto(row, selectedDate, access));

      if (createdDate) {
        todos = todos.filter((todo) => String(todo.createdAt || "").slice(0, 10) === createdDate);
      }
      if (createdFrom) {
        const fromMinute = createdFrom.slice(0, 16);
        todos = todos.filter((todo) => String(todo.createdAt || "").slice(0, 16) >= fromMinute);
      }
      if (createdTo) {
        const toMinute = createdTo.slice(0, 16);
        todos = todos.filter((todo) => String(todo.createdAt || "").slice(0, 16) <= toMinute);
      }
      if (dueDate) {
        todos = todos.filter((todo) => todo.dueDate === dueDate);
      }
      if (dueFrom) {
        todos = todos.filter((todo) => Boolean(todo.dueDate) && String(todo.dueDate) >= dueFrom);
      }
      if (dueTo) {
        todos = todos.filter((todo) => Boolean(todo.dueDate) && String(todo.dueDate) <= dueTo);
      }

      if (allowedCategoryIds) {
        todos = todos.filter(
          (todo) => todo.categoryId !== null && allowedCategoryIds?.has(todo.categoryId),
        );
      }
      if (viewRaw === "inbox" || inboxOnly) {
        todos = todos.filter((todo) => todo.categoryId === null);
      }
      if (typeRaw) {
        todos = todos.filter((todo) => todo.scheduleType === typeRaw);
      }
      if (statusRaw) {
        todos = todos.filter((todo) =>
          statusRaw === "completed" ? todo.isCompleted : !todo.isCompleted,
        );
      }
      if (tagId !== null) {
        todos = todos.filter((todo) => todo.tags.some((tag) => tag.id === tagId));
      }
      if (search) {
        todos = todos.filter(
          (todo) =>
            todo.title.toLowerCase().includes(search) ||
            todo.description.toLowerCase().includes(search),
        );
      }
      if (viewRaw === "today") {
        todos = todos.filter((todo) => isTodoVisibleOnDate(todo, selectedDate));
      }

      todos.sort((a, b) => {
        const completedDiff = Number(a.isCompleted) - Number(b.isCompleted);
        if (completedDiff !== 0) return completedDiff;
        const overdueDiff = Number(b.isOverdue) - Number(a.isOverdue);
        if (overdueDiff !== 0) return overdueDiff;
        const priorityDiff = priorityRank[a.priority] - priorityRank[b.priority];
        if (priorityDiff !== 0) return priorityDiff;
        if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) {
          return a.dueDate.localeCompare(b.dueDate);
        }
        if (a.dueDate && b.dueDate && a.dueDate === b.dueDate) {
          const timeDiff = String(a.dueTime || "23:59").localeCompare(String(b.dueTime || "23:59"));
          if (timeDiff !== 0) return timeDiff;
        }
        if (a.dueDate && !b.dueDate) return -1;
        if (!a.dueDate && b.dueDate) return 1;
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.id - b.id;
      });

      const page = Math.max(1, Number(req.query.page) || 1);
      const rawPageSize = Number(req.query.pageSize) || 200;
      const pageSize = Math.min(500, Math.max(1, Math.floor(rawPageSize)));
      const total = todos.length;
      const start = (page - 1) * pageSize;
      res.json({
        res: true,
        total,
        page,
        pageSize,
        date: selectedDate,
        todos: todos.slice(start, start + pageSize),
      });
    } catch (error) {
      sendRouteError(res, error, "list todos", logError);
    }
  });

  todoRouter.post("/", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = String(body.title ?? "").trim();
      if (!title) fail(400, "title is required");
      if (title.length > 200) fail(400, "title must be at most 200 characters");
      const description = String(body.description ?? "");
      if (description.length > 5000) {
        fail(400, "description must be at most 5000 characters");
      }
      const categoryId = parseOptionalPositiveId(body.categoryId, "categoryId");
      // 可写入自己的文件夹，或写权限共享文件夹（任务归属文件夹所有者）
      let ownerId = userId;
      if (categoryId !== null) {
        const access = resolveCategoryAccess(userId, categoryId);
        ensureWritableAccess(access, "create todos in");
        ownerId = access.ownerId;
      }
      const priority = normalizePriority(body.priority, "normal");
      const scheduleType = normalizeScheduleType(body.scheduleType, "once");
      let dueDate: string | null = null;
      let dueTime: string | null = null;
      let repeatStartDate: string | null = null;
      let repeatEndDate: string | null = null;

      if (scheduleType === "once") {
        dueDate = normalizeOptionalDate(body.dueDate, "dueDate");
        dueTime = normalizeOptionalTime(body.dueTime, "dueTime");
        if (dueTime && !dueDate) fail(400, "dueTime requires dueDate");
      } else {
        repeatStartDate = normalizeRequiredDate(
          body.repeatStartDate ?? localToday(),
          "repeatStartDate",
        );
        repeatEndDate = normalizeOptionalDate(body.repeatEndDate, "repeatEndDate");
        if (repeatEndDate && repeatEndDate < repeatStartDate) {
          fail(400, "repeatEndDate must not be earlier than repeatStartDate");
        }
      }

      const tagIds = normalizeTagIds(body.tagIds) ?? [];
      ensureTagsBelongToUser(ownerId, tagIds);
      const sortOrder = parseSortOrder(body.sortOrder, 0);
      const now = localNow();
      const createTodo = db.transaction(() => {
        const info = insertTodoStmt.run(
          ownerId, categoryId, title, description, priority, scheduleType,
          dueDate, dueTime, repeatStartDate, repeatEndDate, sortOrder, now, now,
        );
        const todoId = Number(info.lastInsertRowid);
        for (const tagId of tagIds) insertTodoTagLinkStmt.run(todoId, tagId);
        return todoId;
      });
      const todoId = createTodo();
      const row = getTodoOrThrow(ownerId, todoId);
      res.status(201).json({
        res: true,
        todo: toTodoDto(
          row,
          localToday(),
          ownerId === userId
            ? {}
            : { ownerUsername: getOwnerUsername(ownerId), permission: "write", shared: true },
        ),
      });
    } catch (error) {
      sendRouteError(res, error, "create todo", logError);
    }
  });

  todoRouter.get("/:id", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      const access = getTodoAccess(userId, todoId);
      const dateRaw = String(req.query.date ?? "").trim();
      const selectedDate = dateRaw || localToday();
      if (!isValidDateOnly(selectedDate)) fail(400, "date must be YYYY-MM-DD");
      res.json({
        res: true,
        todo: toTodoDto(access.row, selectedDate, toAccessMeta(access, userId)),
      });
    } catch (error) {
      sendRouteError(res, error, "get todo", logError);
    }
  });  todoRouter.patch("/:id", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      const access = getTodoAccess(userId, todoId);
      ensureWritableAccess(access, "update");
      const ownerId = access.ownerId;
      const current = access.row;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = hasOwn(body, "title")
        ? String(body.title ?? "").trim()
        : current.title;
      if (!title) fail(400, "title is required");
      if (title.length > 200) fail(400, "title must be at most 200 characters");
      const description = hasOwn(body, "description")
        ? String(body.description ?? "")
        : current.description;
      if (description.length > 5000) {
        fail(400, "description must be at most 5000 characters");
      }
      const categoryId = hasOwn(body, "categoryId")
        ? parseOptionalPositiveId(body.categoryId, "categoryId")
        : current.category_id;
      if (categoryId !== null) {
        const categoryAccess = resolveCategoryAccess(userId, categoryId);
        ensureWritableAccess(categoryAccess, "move todo into");
        // 任务归属保持稳定，不允许通过移动改变所有者
        if (categoryAccess.ownerId !== ownerId) {
          fail(400, "cannot move a task across different owners");
        }
      } else if (ownerId !== userId) {
        // 共享任务移入收件箱时，要求该所有者的收件箱确实共享给了当前用户
        const inboxShare = resolveInboxShareStmt.get(userId, ownerId) as
          | { permission: SharePermission }
          | undefined;
        if (!inboxShare) {
          fail(400, "cannot move this task to an inbox that is not shared with you");
        }
        ensureWritableAccess({ permission: inboxShare.permission }, "move todo into");
      }
      const priority = hasOwn(body, "priority")
        ? normalizePriority(body.priority, current.priority)
        : current.priority;
      const scheduleType = hasOwn(body, "scheduleType")
        ? normalizeScheduleType(body.scheduleType, current.schedule_type)
        : current.schedule_type;
      let dueDate: string | null = null;
      let dueTime: string | null = null;
      let repeatStartDate: string | null = null;
      let repeatEndDate: string | null = null;

      if (scheduleType === "once") {
        dueDate = hasOwn(body, "dueDate")
          ? normalizeOptionalDate(body.dueDate, "dueDate")
          : current.due_date;
        dueTime = hasOwn(body, "dueTime")
          ? normalizeOptionalTime(body.dueTime, "dueTime")
          : current.due_time;
        if (dueTime && !dueDate) fail(400, "dueTime requires dueDate");
      } else {
        const startCandidate = hasOwn(body, "repeatStartDate")
          ? body.repeatStartDate
          : current.repeat_start_date ?? localToday();
        repeatStartDate = normalizeRequiredDate(startCandidate, "repeatStartDate");
        repeatEndDate = hasOwn(body, "repeatEndDate")
          ? normalizeOptionalDate(body.repeatEndDate, "repeatEndDate")
          : current.repeat_end_date;
        if (repeatEndDate && repeatEndDate < repeatStartDate) {
          fail(400, "repeatEndDate must not be earlier than repeatStartDate");
        }
      }

      const tagIds = normalizeTagIds(body.tagIds);
      if (tagIds) ensureTagsBelongToUser(ownerId, tagIds);
      const sortOrder = hasOwn(body, "sortOrder")
        ? parseSortOrder(body.sortOrder, current.sort_order)
        : current.sort_order;
      const now = localNow();
      const scheduleChanged = scheduleType !== current.schedule_type;
      const updateTodo = db.transaction(() => {
        updateTodoStmt.run(
          categoryId, title, description, priority, scheduleType,
          dueDate, dueTime, repeatStartDate, repeatEndDate, sortOrder, now,
          todoId, ownerId,
        );
        if (tagIds) {
          deleteTodoTagLinksStmt.run(todoId);
          for (const tagId of tagIds) insertTodoTagLinkStmt.run(todoId, tagId);
        }
        if (scheduleChanged) disableReminderForTodoStmt.run(now, todoId);
      });
      updateTodo();
      const updated = getTodoOrThrow(ownerId, todoId);
      const selectedDateRaw = String(req.query.date ?? "").trim();
      const selectedDate = selectedDateRaw || localToday();
      if (!isValidDateOnly(selectedDate)) fail(400, "date must be YYYY-MM-DD");
      res.json({
        res: true,
        todo: toTodoDto(updated, selectedDate, toAccessMeta(access, userId)),
      });
    } catch (error) {
      sendRouteError(res, error, "update todo", logError);
    }
  });

  todoRouter.delete("/:id", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      const access = getTodoAccess(userId, todoId);
      ensureWritableAccess(access, "delete");
      const now = localNow();
      const removeTodo = db.transaction(() => {
        softDeleteTodoStmt.run(now, now, todoId, access.ownerId);
        disableReminderForTodoStmt.run(now, todoId);
      });
      removeTodo();
      res.json({ res: true, message: "todo deleted" });
    } catch (error) {
      sendRouteError(res, error, "delete todo", logError);
    }
  });  todoRouter.post("/:id/complete", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      const access = getTodoAccess(userId, todoId);
      ensureWritableAccess(access, "complete");
      const todo = access.row;
      const body = (req.body ?? {}) as Record<string, unknown>;
      // 单次任务的完成日期取服务器当前日期；每日任务才按用户选中的日期记录
      const completionDate = todo.schedule_type === "once"
        ? localToday()
        : normalizeRequiredDate(body.date ?? localToday(), "date");

      if (todo.schedule_type === "daily" && !taskIsActiveOnDate(todo, completionDate)) {
        fail(400, "date is outside this daily task's active range");
      }

      let completion: CompletionRow | undefined;
      if (todo.schedule_type === "once") {
        completion = getAnyCompletionStmt.get(todoId) as CompletionRow | undefined;
      } else {
        completion = getCompletionForDateStmt.get(
          todoId,
          completionDate,
        ) as CompletionRow | undefined;
      }

      if (!completion) {
        const now = localNow();
        insertCompletionStmt.run(todoId, completionDate, now, now);
        touchTodoStmt.run(now, todoId, access.ownerId);
        completion = getCompletionForDateStmt.get(
          todoId,
          completionDate,
        ) as CompletionRow | undefined;
        if (!completion) {
          completion = getAnyCompletionStmt.get(todoId) as CompletionRow | undefined;
        }
      }

      res.json({
        res: true,
        completion: completion
          ? {
              id: completion.id,
              todoId: completion.todo_id,
              completionDate: completion.completion_date,
              completedAt: completion.completed_at,
            }
          : null,
        todo: toTodoDto(
          getTodoOrThrow(access.ownerId, todoId),
          completionDate,
          toAccessMeta(access, userId),
        ),
      });
    } catch (error) {
      sendRouteError(res, error, "complete todo", logError);
    }
  });

  todoRouter.delete("/:id/complete", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      const access = getTodoAccess(userId, todoId);
      ensureWritableAccess(access, "uncomplete");
      const todo = access.row;
      const rawDate = String(req.query.date ?? "").trim();
      let changed = 0;
      // 单次任务只有一条完成记录，取消完成时始终清空，避免跨日期取消失效
      if (todo.schedule_type === "once" || !rawDate) {
        changed = Number(deleteAllCompletionsStmt.run(todoId).changes || 0);
      } else {
        const completionDate = normalizeRequiredDate(
          rawDate || localToday(),
          "date",
        );
        changed = Number(deleteCompletionForDateStmt.run(todoId, completionDate).changes || 0);
      }
      if (changed > 0) touchTodoStmt.run(localNow(), todoId, access.ownerId);
      res.json({
        res: true,
        message: "completion removed",
        todo: toTodoDto(
          getTodoOrThrow(access.ownerId, todoId),
          localToday(),
          toAccessMeta(access, userId),
        ),
      });
    } catch (error) {
      sendRouteError(res, error, "uncomplete todo", logError);
    }
  });

  todoRouter.put("/:id/reminder", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      const access = getTodoAccess(userId, todoId);
      ensureWritableAccess(access, "set reminder on");
      const todo = access.row;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reminderType = normalizeScheduleType(
        body.reminderType,
        todo.schedule_type,
      );
      if (reminderType !== todo.schedule_type) {
        fail(400, "reminder type must match the task schedule type");
      }

      const nowDate = new Date();
      const now = formatLocalDateTime(nowDate);
      let remindAt: string | null = null;
      let remindTime: string | null = null;
      let nextTriggerAt: string | null = null;

      if (reminderType === "once") {
        const existingCompletion = getAnyCompletionStmt.get(todoId) as
          | CompletionRow
          | undefined;
        if (existingCompletion) {
          fail(409, "cannot add a reminder to a completed one-time task");
        }
        remindAt = normalizeOnceDateTime(body.remindAt, "remindAt");
        if (remindAt <= now) fail(400, "remindAt must be in the future");
        nextTriggerAt = remindAt;
      } else {
        remindTime = normalizeTime(body.remindTime, "remindTime");
        nextTriggerAt = computeNextDailyTrigger(todo, remindTime, nowDate);
        if (!nextTriggerAt) {
          fail(400, "no future occurrence is available for this daily task");
        }
      }

      upsertReminderStmt.run(
        todoId, reminderType, remindAt, remindTime, nextTriggerAt, now, now,
      );
      touchTodoStmt.run(now, todoId, access.ownerId);
      const reminder = getReminderStmt.get(todoId) as ReminderRow | undefined;
      res.json({ res: true, reminder: toReminderDto(reminder) });
    } catch (error) {
      sendRouteError(res, error, "set todo reminder", logError);
    }
  });

  todoRouter.delete("/:id/reminder", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      const access = getTodoAccess(userId, todoId);
      ensureWritableAccess(access, "remove reminder from");
      deleteReminderStmt.run(todoId);
      touchTodoStmt.run(localNow(), todoId, access.ownerId);
      res.json({ res: true, message: "reminder deleted" });
    } catch (error) {
      sendRouteError(res, error, "delete todo reminder", logError);
    }
  });

  // ========== 附件 API（图片 + 普通文件） ==========
  const listTodoAttachments = (todoId: number, ownerId: number) =>
    (listTodoAttachmentsStmt.all(todoId, ownerId) as TodoAttachmentRow[]).map(
      toTodoAttachmentDto,
    );

  /** 读取任务当前图片 / 文件数量，用于分别限制上传总量 */
  const readAttachmentCounts = (todoId: number, ownerId: number) => {
    const counts: Record<TodoAttachmentKind, number> = { image: 0, file: 0 };
    const rows = countTodoAttachmentsByKindStmt.all(todoId, ownerId) as Array<{
      kind: TodoAttachmentKind;
      count: number;
    }>;
    for (const row of rows) counts[row.kind] = Number(row.count) || 0;
    return counts;
  };

  const handleUploadedAttachments =
    (imagesOnly: boolean): express.RequestHandler =>
    (req, res) => {
      try {
        const userId = getRequestUserId(req);
        const todoId = parsePositiveId(req.params.id, "todo id");
        const access = getTodoAccess(userId, todoId);
        ensureWritableAccess(access, "add attachments to");
        const ownerId = access.ownerId;
        const uploaded = flattenUploadedFiles(req.files);
        if (uploaded.length === 0) fail(400, "at least one file is required");

        const counts = readAttachmentCounts(todoId, ownerId);
        let imageCount = counts.image;
        let fileCount = counts.file;
        const planned: Array<{
          file: Express.Multer.File;
          kind: TodoAttachmentKind;
          extension: string;
          originalName: string;
        }> = [];

        for (const file of uploaded) {
          const mime = String(file.mimetype || "").toLowerCase();
          const kind = attachmentKindOf(mime);
          if (imagesOnly && kind !== "image") {
            fail(400, "only jpeg/png/gif/webp/bmp/avif images are allowed");
          }
          const originalName = sanitizeUploadFileName(
            decodeUploadFileName(String(file.originalname || "")),
          );
          if (kind === "image") {
            if (file.size > MAX_IMAGE_BYTES) {
              fail(400, "each image must be 8 MB or smaller");
            }
            imageCount += 1;
            if (imageCount > MAX_TODO_IMAGES) {
              fail(400, `a task can have at most ${MAX_TODO_IMAGES} images`);
            }
          } else {
            if (file.size > MAX_FILE_BYTES) {
              fail(400, "each file must be 32 MB or smaller");
            }
            const extension = safeFileExtension(originalName, mime);
            if (BLOCKED_FILE_EXTENSIONS.has(extension)) {
              fail(400, `file type ${extension} is not allowed`);
            }
            fileCount += 1;
            if (fileCount > MAX_TODO_FILES) {
              fail(400, `a task can have at most ${MAX_TODO_FILES} files`);
            }
          }
          planned.push({
            file,
            kind,
            extension:
              kind === "image"
                ? (TODO_IMAGE_MIME_EXT[mime] as string)
                : safeFileExtension(originalName, mime),
            originalName:
              originalName || (kind === "image" ? "image" : "attachment"),
          });
        }

        const userDir = path.join(todoAttachmentsDir, String(ownerId));
        fs.mkdirSync(userDir, { recursive: true });
        const createdRows: TodoAttachmentRow[] = [];
        const createdPaths: string[] = [];

        try {
          for (const item of planned) {
            const storedName = `${crypto.randomUUID()}${item.extension}`;
            const fullPath = path.join(userDir, storedName);
            fs.writeFileSync(fullPath, item.file.buffer);
            createdPaths.push(fullPath);
            const info = insertTodoAttachmentStmt.run(
              todoId,
              ownerId,
              item.kind,
              item.originalName.slice(0, 255),
              storedName,
              String(item.file.mimetype || "application/octet-stream").toLowerCase(),
              item.file.size,
              localNow(),
            );
            const row = getTodoAttachmentStmt.get(
              Number(info.lastInsertRowid),
              todoId,
              ownerId,
            ) as TodoAttachmentRow | undefined;
            if (!row) throw new Error("failed to read uploaded attachment metadata");
            createdRows.push(row);
          }
        } catch (uploadError) {
          for (const row of createdRows) {
            deleteTodoAttachmentStmt.run(row.id, todoId, ownerId);
          }
          for (const filePath of createdPaths) {
            try {
              fs.unlinkSync(filePath);
            } catch {
              // Best-effort cleanup for an incomplete upload.
            }
          }
          throw uploadError;
        }

        touchTodoStmt.run(localNow(), todoId, ownerId);
        const attachments = listTodoAttachments(todoId, ownerId);
        res.status(201).json({
          res: true,
          attachments,
          images: attachments.filter((item) => item.kind === "image"),
          todo: toTodoDto(
            getTodoOrThrow(ownerId, todoId),
            localToday(),
            toAccessMeta(access, userId),
          ),
        });
      } catch (error) {
        sendRouteError(res, error, "upload todo attachments", logError);
      }
    };

  const attachmentUploadMiddleware: express.RequestHandler = (req, res, next) => {
    todoAttachmentFields(req, res, (error: unknown) => {
      if (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarn(`[todo] attachment upload rejected: ${message}`);
        res.status(400).json({ res: false, message });
        return;
      }
      next();
    });
  };

  const deleteAttachmentHandler: express.RequestHandler = (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      const attachmentId = parsePositiveId(
        req.params.attachmentId ?? req.params.imageId,
        "attachment id",
      );
      const access = getTodoAccess(userId, todoId);
      ensureWritableAccess(access, "delete attachments from");
      const ownerId = access.ownerId;
      const attachment = getTodoAttachmentStmt.get(
        attachmentId,
        todoId,
        ownerId,
      ) as TodoAttachmentRow | undefined;
      if (!attachment) fail(404, "attachment not found");
      deleteTodoAttachmentStmt.run(attachmentId, todoId, ownerId);
      touchTodoStmt.run(localNow(), todoId, ownerId);
      try {
        fs.unlinkSync(
          path.join(todoAttachmentsDir, String(ownerId), attachment.stored_name),
        );
      } catch {
        // Metadata is authoritative; a missing file should not block deletion.
      }
      res.json({ res: true, message: "attachment deleted" });
    } catch (error) {
      sendRouteError(res, error, "delete todo attachment", logError);
    }
  };

  const serveAttachmentHandler: express.RequestHandler = (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const attachmentId = parsePositiveId(req.params.id, "attachment id");
      const attachment = getTodoAttachmentByIdStmt.get(attachmentId) as
        | TodoAttachmentRow
        | undefined;
      if (!attachment) fail(404, "attachment not found");
      // 读取附件同样需要任务访问权限（自己的或共享给自己的）
      getTodoAccess(userId, attachment.todo_id);
      const fullPath = path.join(
        todoAttachmentsDir,
        String(attachment.user_id),
        attachment.stored_name,
      );
      if (!fs.existsSync(fullPath)) fail(404, "attachment file not found");

      const mime = String(attachment.mime_type || "").toLowerCase();
      const inlineImage = attachment.kind === "image" && Boolean(TODO_IMAGE_MIME_EXT[mime]);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=3600");
      if (inlineImage) {
        res.type(mime);
      } else {
        // 非图片附件强制下载，避免 HTML/SVG 等被浏览器内联执行
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(attachment.original_name).replace(/'/g, "%27")}`,
        );
      }
      res.sendFile(fullPath, (error) => {
        if (error && !res.headersSent) {
          res.status(404).json({ res: false, message: "attachment not found" });
        }
      });
    } catch (error) {
      sendRouteError(res, error, "read todo attachment", logError);
    }
  };

  todoRouter.get("/:id/attachments", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      const access = getTodoAccess(userId, todoId);
      res.json({ res: true, attachments: listTodoAttachments(todoId, access.ownerId) });
    } catch (error) {
      sendRouteError(res, error, "list todo attachments", logError);
    }
  });

  todoRouter.post(
    "/:id/attachments",
    attachmentUploadMiddleware,
    handleUploadedAttachments(false),
  );

  todoRouter.delete("/:id/attachments/:attachmentId", deleteAttachmentHandler);

  // 兼容旧版图片接口：只暴露图片类型的附件
  todoRouter.get("/:id/images", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      const access = getTodoAccess(userId, todoId);
      const images = listTodoAttachments(todoId, access.ownerId).filter(
        (item) => item.kind === "image",
      );
      res.json({ res: true, images });
    } catch (error) {
      sendRouteError(res, error, "list todo images", logError);
    }
  });

  todoRouter.post(
    "/:id/images",
    attachmentUploadMiddleware,
    handleUploadedAttachments(true),
  );

  todoRouter.delete("/:id/images/:imageId", deleteAttachmentHandler);

  const todoAttachmentRouter = express.Router();
  todoAttachmentRouter.use(authMiddleware);
  todoAttachmentRouter.get("/:id", serveAttachmentHandler);
  /** 用系统默认程序打开非图片附件（仅限本机访问） */
  todoAttachmentRouter.get("/:id/open", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const attachmentId = parsePositiveId(req.params.id, "attachment id");
      // 系统默认程序打开属于宿主机行为，远程设备直接拒绝
      if (!isLoopbackRequest(req)) {
        fail(403, "system open is only available on the host machine");
      }
      const attachment = getTodoAttachmentByIdStmt.get(attachmentId) as
        | TodoAttachmentRow
        | undefined;
      if (!attachment) fail(404, "attachment not found");
      getTodoAccess(userId, attachment.todo_id);
      if (attachment.kind !== "file") {
        fail(400, "images are previewed in the browser");
      }
      const fullPath = path.join(
        todoAttachmentsDir,
        String(attachment.user_id),
        attachment.stored_name,
      );
      if (!fs.existsSync(fullPath)) fail(404, "attachment file not found");
      openAttachmentWithSystem(attachment, fullPath, logWarn);
      res.json({ res: true, message: "opened" });
    } catch (error) {
      sendRouteError(res, error, "open todo attachment", logError);
    }
  });
  // ========== 数据共享 API ==========
  const shareRouter = express.Router();
  shareRouter.use(authMiddleware);
  shareRouter.use(writeGuard);

  /** 共享可选项：自己的文件夹、收件箱任务数、可共享用户 */
  shareRouter.get("/options", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const categories = (listCategoriesStmt.all(userId) as CategoryRow[]).map((row) => ({
        ...toCategoryDto(row),
        path: buildCategoryPath(userId, row.id),
        taskCount: (countCategoryActiveTasksStmt.get(userId, row.id) as { count: number }).count,
      }));
      const inboxCount = (
        countInboxActiveTasksStmt.get(userId) as { count: number }
      ).count;
      const users = listShareUsersStmt.all(userId) as Array<{
        id: number;
        username: string;
        role: string;
      }>;
      res.json({
        res: true,
        categories,
        inboxCount,
        users,
        isAdmin: isAdminRequest(req),
      });
    } catch (error) {
      sendRouteError(res, error, "load share options", logError);
    }
  });

  /** 共享列表：scope=mine（我共享出去的）| received（共享给我的）| all（管理员） */
  shareRouter.get("/", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const scopeRaw = String(req.query.scope ?? "mine").trim();
      if (!["mine", "received", "all"].includes(scopeRaw)) {
        fail(400, "scope must be mine, received or all");
      }
      let rows: ShareListRow[];
      if (scopeRaw === "received") {
        rows = listReceivedSharesStmt.all(userId) as ShareListRow[];
      } else if (scopeRaw === "all") {
        if (!isAdminRequest(req)) fail(403, "admin only");
        rows = listAllSharesStmt.all() as ShareListRow[];
      } else {
        rows = listOwnedSharesStmt.all(userId) as ShareListRow[];
      }
      res.json({ res: true, scope: scopeRaw, shares: rows.map(toShareDto) });
    } catch (error) {
      sendRouteError(res, error, "list shares", logError);
    }
  });

  /** 新建共享：把某个文件夹（含子文件夹）或收件箱共享给其他用户 */
  shareRouter.post("/", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const granteeId = parsePositiveId(body.granteeId, "granteeId");
      if (granteeId === userId) fail(400, "cannot share data with yourself");

      const scopeRaw = String(body.scope ?? "").trim();
      if (scopeRaw !== "category" && scopeRaw !== "inbox") {
        fail(400, "scope must be category or inbox");
      }
      const permissionRaw = String(body.permission ?? "readonly").trim();
      if (permissionRaw !== "readonly" && permissionRaw !== "write") {
        fail(400, "permission must be readonly or write");
      }

      const grantee = getShareUserStmt.get(granteeId) as
        | { id: number; username: string; role: string; status: string }
        | undefined;
      if (!grantee) fail(404, "user not found");
      if (grantee.status !== "active") fail(400, "target user is disabled");

      let categoryId: number | null = null;
      if (scopeRaw === "category") {
        categoryId = parsePositiveId(body.categoryId, "categoryId");
        const category = getCategoryStmt.get(categoryId, userId) as
          | CategoryRow
          | undefined;
        if (!category) fail(404, "category not found");
      }

      const now = localNow();
      const existing = findShareStmt.get(
        userId,
        granteeId,
        scopeRaw,
        categoryId,
      ) as ShareRow | undefined;
      let shareId: number;
      if (existing) {
        // 重复共享同一范围时，直接更新权限
        updateSharePermissionStmt.run(permissionRaw, now, existing.id);
        shareId = existing.id;
      } else {
        const info = insertShareStmt.run(
          userId,
          granteeId,
          scopeRaw,
          categoryId,
          permissionRaw,
          now,
          now,
        );
        shareId = Number(info.lastInsertRowid);
      }

      const created = getShareListRowStmt.get(shareId) as ShareListRow;
      logInfo(
        `[todo] share ${scopeRaw}${categoryId ? `#${categoryId}` : ""} from ${userId} to ${granteeId} (${permissionRaw})`,
      );
      res.status(existing ? 200 : 201).json({ res: true, share: toShareDto(created) });
    } catch (error) {
      sendRouteError(res, error, "create share", logError);
    }
  });

  /** 修改共享权限 */
  shareRouter.patch("/:id", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const shareId = parsePositiveId(req.params.id, "share id");
      const share = getShareByIdStmt.get(shareId) as ShareRow | undefined;
      if (!share) fail(404, "share not found");
      if (share.owner_id !== userId && !isAdminRequest(req)) {
        fail(403, "only the data owner can change this share");
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const permissionRaw = String(body.permission ?? "").trim();
      if (permissionRaw !== "readonly" && permissionRaw !== "write") {
        fail(400, "permission must be readonly or write");
      }
      updateSharePermissionStmt.run(permissionRaw, localNow(), shareId);
      const updated = getShareListRowStmt.get(shareId) as ShareListRow;
      res.json({ res: true, share: toShareDto(updated) });
    } catch (error) {
      sendRouteError(res, error, "update share", logError);
    }
  });

  /** 取消共享 */
  shareRouter.delete("/:id", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const shareId = parsePositiveId(req.params.id, "share id");
      const share = getShareByIdStmt.get(shareId) as ShareRow | undefined;
      if (!share) fail(404, "share not found");
      if (share.owner_id !== userId && !isAdminRequest(req)) {
        fail(403, "only the data owner can remove this share");
      }
      deleteShareStmt.run(shareId);
      res.json({ res: true, message: "share removed" });
    } catch (error) {
      sendRouteError(res, error, "delete share", logError);
    }
  });

  // ========== 桌宠挂件 API ==========
  const widgetRouter = express.Router();
  widgetRouter.use(authMiddleware);

  const nextReminderForUserStmt = db.prepare(
    `SELECT r.id AS reminder_id, r.todo_id, r.next_trigger_at, r.reminder_type,
            t.title, t.due_date, t.due_time, t.priority
     FROM todo_reminders r
     INNER JOIN todos t ON t.id = r.todo_id
     WHERE t.user_id = ? AND t.deleted_at IS NULL
       AND r.enabled = 1 AND r.next_trigger_at IS NOT NULL AND r.next_trigger_at > ?
       AND (
         SELECT COUNT(*) FROM todo_completions c
         WHERE c.todo_id = t.id
           AND (r.reminder_type = 'once' OR c.completion_date = date(r.next_trigger_at))
       ) = 0
     ORDER BY r.next_trigger_at ASC
     LIMIT 1`,
  );
  const recentReminderEventsStmt = db.prepare(
    `SELECT l.reminder_id, l.scheduled_for, l.status, l.created_at,
            r.todo_id, t.title
     FROM todo_notification_logs l
     INNER JOIN todo_reminders r ON r.id = l.reminder_id
     INNER JOIN todos t ON t.id = r.todo_id
     WHERE t.user_id = ?
       AND l.created_at >= ?
       AND l.status IN ('sent','failed')
     ORDER BY l.created_at ASC, l.id ASC
     LIMIT 20`,
  );
  const getPetSettingsStmt = db.prepare(
    `SELECT * FROM pet_settings WHERE user_id = ?`,
  );
  const ensurePetSettingsStmt = db.prepare(
    `INSERT OR IGNORE INTO pet_settings (user_id) VALUES (?)`,
  );
  const updatePetImageStmt = db.prepare(
    `UPDATE pet_settings SET pet_image = ?, updated_at = ? WHERE user_id = ?`,
  );
  const upsertPetSettingsStmt = db.prepare(
    `INSERT INTO pet_settings
       (user_id, interval_enabled, interval_minutes, interval_work_hours,
        work_start, work_end, work_start_enabled, work_end_enabled,
        due_lead_minutes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       interval_enabled = excluded.interval_enabled,
       interval_minutes = excluded.interval_minutes,
       interval_work_hours = excluded.interval_work_hours,
       work_start = excluded.work_start,
       work_end = excluded.work_end,
       work_start_enabled = excluded.work_start_enabled,
       work_end_enabled = excluded.work_end_enabled,
       due_lead_minutes = excluded.due_lead_minutes,
       updated_at = excluded.updated_at`,
  );

  const normalizeSettingsTime = (value: unknown, field: string): string => {
    const text = String(value ?? "").trim();
    if (!TIME_RE.test(text)) fail(400, `${field} must be HH:mm`);
    return text;
  };

  const parseSettingsFlag = (value: unknown, fallback: boolean): boolean => {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    const text = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(text)) return true;
    if (["0", "false", "no", "off"].includes(text)) return false;
    return fallback;
  };

  const parseSettingsInt = (
    value: unknown,
    fallback: number,
    min: number,
    max: number,
    field: string,
  ): number => {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      fail(400, `${field} must be an integer between ${min} and ${max}`);
    }
    return parsed;
  };

  /** 角色素材地址带上文件名作为版本号，替换图片后浏览器会自动取新图 */
  const petImageUrlFor = (row: PetSettingsRow | undefined): string | null =>
    row?.pet_image
      ? `${apiPrefix}/todo-widget/assets/pet?v=${encodeURIComponent(row.pet_image)}`
      : null;

  if (!fs.existsSync(petAssetsDir)) {
    fs.mkdirSync(petAssetsDir, { recursive: true });
  }
  const petImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PET_IMAGE_BYTES, files: 1 },
  }).single("file");

  /** 桌宠提醒设置 */
  widgetRouter.get("/settings", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const row = getPetSettingsStmt.get(userId) as PetSettingsRow | undefined;
      res.json({ res: true, settings: toPetSettingsDto(row, petImageUrlFor(row)) });
    } catch (error) {
      sendRouteError(res, error, "load pet settings", logError);
    }
  });

  widgetRouter.put("/settings", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const current = toPetSettingsDto(
        getPetSettingsStmt.get(userId) as PetSettingsRow | undefined,
      );

      const intervalEnabled = parseSettingsFlag(
        body.intervalEnabled,
        current.intervalEnabled,
      );
      const intervalMinutes = parseSettingsInt(
        body.intervalMinutes,
        current.intervalMinutes,
        5,
        480,
        "intervalMinutes",
      );
      const intervalWithinWorkHours = parseSettingsFlag(
        body.intervalWithinWorkHours,
        current.intervalWithinWorkHours,
      );
      const workStart =
        body.workStart === undefined
          ? current.workStart
          : normalizeSettingsTime(body.workStart, "workStart");
      const workEnd =
        body.workEnd === undefined
          ? current.workEnd
          : normalizeSettingsTime(body.workEnd, "workEnd");
      if (workEnd <= workStart) {
        fail(400, "workEnd must be later than workStart");
      }
      const workStartEnabled = parseSettingsFlag(
        body.workStartEnabled,
        current.workStartEnabled,
      );
      const workEndEnabled = parseSettingsFlag(
        body.workEndEnabled,
        current.workEndEnabled,
      );
      const dueLeadMinutes = parseSettingsInt(
        body.dueLeadMinutes,
        current.dueLeadMinutes,
        0,
        1440,
        "dueLeadMinutes",
      );

      const now = localNow();
      upsertPetSettingsStmt.run(
        userId,
        intervalEnabled ? 1 : 0,
        intervalMinutes,
        intervalWithinWorkHours ? 1 : 0,
        workStart,
        workEnd,
        workStartEnabled ? 1 : 0,
        workEndEnabled ? 1 : 0,
        dueLeadMinutes,
        now,
      );
      const saved = getPetSettingsStmt.get(userId) as PetSettingsRow;
      res.json({ res: true, settings: toPetSettingsDto(saved, petImageUrlFor(saved)) });
    } catch (error) {
      sendRouteError(res, error, "save pet settings", logError);
    }
  });

  /** 读取当前用户的角色素材 */
  widgetRouter.get("/assets/pet", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const row = getPetSettingsStmt.get(userId) as PetSettingsRow | undefined;
      const petImage = row?.pet_image;
      if (!petImage) fail(404, "pet image not found");
      const fullPath = path.join(petAssetsDir, path.basename(petImage));
      if (!fs.existsSync(fullPath)) fail(404, "pet image not found");
      res.setHeader("Cache-Control", "private, no-store");
      res.sendFile(fullPath);
    } catch (error) {
      sendRouteError(res, error, "load pet image", logError);
    }
  });

  /** 上传或替换角色素材 */
  widgetRouter.post(
    "/assets/pet",
    (req, res, next) => {
      petImageUpload(req, res, (error) => {
        if (error) {
          const message =
            error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
              ? "pet image must be 2MB or smaller"
              : error.message;
          logWarn(`[todo] pet image rejected: ${message}`);
          res.status(400).json({ res: false, message });
          return;
        }
        next();
      });
    },
    (req, res) => {
      try {
        const userId = getRequestUserId(req);
        const file = req.file;
        if (!file) fail(400, "file is required");
        const mime = String(file.mimetype || "").toLowerCase();
        const extension = TODO_IMAGE_MIME_EXT[mime];
        if (!extension) {
          fail(400, "only jpeg/png/gif/webp/bmp/avif images are allowed");
        }
        if (!fs.existsSync(petAssetsDir)) {
          fs.mkdirSync(petAssetsDir, { recursive: true });
        }
        const storedName = `${userId}-${crypto.randomUUID()}${extension}`;
        const fullPath = path.join(petAssetsDir, storedName);
        fs.writeFileSync(fullPath, file.buffer);

        const current = getPetSettingsStmt.get(userId) as PetSettingsRow | undefined;
        ensurePetSettingsStmt.run(userId);
        updatePetImageStmt.run(storedName, localNow(), userId);
        if (current?.pet_image) {
          try {
            fs.unlinkSync(path.join(petAssetsDir, path.basename(current.pet_image)));
          } catch {
            // 旧素材不存在时忽略
          }
        }

        const saved = getPetSettingsStmt.get(userId) as PetSettingsRow;
        logInfo(`[todo] pet image updated for user ${userId}`);
        res.status(201).json({
          res: true,
          settings: toPetSettingsDto(saved, petImageUrlFor(saved)),
        });
      } catch (error) {
        sendRouteError(res, error, "upload pet image", logError);
      }
    },
  );

  /** 恢复默认角色（删除上传的素材） */
  widgetRouter.delete("/assets/pet", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const current = getPetSettingsStmt.get(userId) as PetSettingsRow | undefined;
      ensurePetSettingsStmt.run(userId);
      updatePetImageStmt.run(null, localNow(), userId);
      if (current?.pet_image) {
        try {
          fs.unlinkSync(path.join(petAssetsDir, path.basename(current.pet_image)));
        } catch {
          // 文件已不存在时忽略
        }
      }
      const saved = getPetSettingsStmt.get(userId) as PetSettingsRow;
      res.json({ res: true, settings: toPetSettingsDto(saved, petImageUrlFor(saved)) });
    } catch (error) {
      sendRouteError(res, error, "delete pet image", logError);
    }
  });

  type WidgetReminderRow = {
    reminder_id: number;
    todo_id: number;
    next_trigger_at: string;
    reminder_type: TodoScheduleType;
    title: string;
    due_date: string | null;
    due_time: string | null;
    priority: TodoPriority;
  };
  type WidgetEventRow = {
    reminder_id: number;
    scheduled_for: string;
    status: string;
    created_at: string;
    todo_id: number;
    title: string;
  };

  /**
   * 桌宠挂件汇总：当天待办数量、今日预览、下一条提醒与最近的提醒事件。
   * since 为上次同步到的服务端时间，用于增量拉取提醒事件。
   */
  widgetRouter.get("/summary", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const today = localToday();
      const now = localNow();
      const sinceRaw = String(req.query.since ?? "").trim();
      const since = sinceRaw
        ? normalizeOptionalLocalDateTime(sinceRaw, "since")
        : formatLocalDateTime(new Date(Date.now() - 5 * 60 * 1000));

      const rows = listActiveTodosStmt.all(userId) as TodoRow[];
      const todayTodos = rows.map((row) => toTodoDto(row, today));
      const visible = todayTodos.filter((todo) => isTodoVisibleOnDate(todo, today));
      const pending = visible.filter((todo) => !todo.isCompleted);
      // 逾期口径与任务 DTO 保持一致：日期已过，或当天已过截止时刻
      const overdue = pending.filter((todo) => todo.isOverdue);
      const preview = pending
        .slice()
        .sort(
          (a, b) =>
            Number(b.isOverdue) - Number(a.isOverdue) ||
            priorityRank[a.priority] - priorityRank[b.priority] ||
            String(a.dueTime || "23:59").localeCompare(String(b.dueTime || "23:59")) ||
            a.id - b.id,
        )
        .slice(0, 3)
        .map((todo) => ({
          id: todo.id,
          title: todo.title,
          priority: todo.priority,
          dueDate: todo.dueDate,
          dueTime: todo.dueTime,
          isOverdue: todo.isOverdue,
        }));

      const nextRow = nextReminderForUserStmt.get(userId, now) as
        | WidgetReminderRow
        | undefined;
      const eventRows = recentReminderEventsStmt.all(userId, since) as WidgetEventRow[];

      const settingsRow = getPetSettingsStmt.get(userId) as PetSettingsRow | undefined;
      const settings = toPetSettingsDto(settingsRow, petImageUrlFor(settingsRow));

      // 截止提醒：单次任务按 dueDate + dueTime，重复任务按 repeatEndDate + 下班时间
      const dueSoon: Array<{
        key: string;
        todoId: number;
        title: string;
        dueAt: string;
        minutesLeft: number;
        scheduleType: TodoScheduleType;
        priority: TodoPriority;
      }> = [];
      if (settings.dueLeadMinutes > 0) {
        const windowEnd = formatLocalDateTime(
          new Date(Date.now() + settings.dueLeadMinutes * 60 * 1000),
        );
        const nowDate = new Date(now.replace(" ", "T"));
        for (const todo of todayTodos) {
          let effectiveDueAt: string | null = null;
          if (todo.scheduleType === "once") {
            if (!todo.dueDate || todo.isCompleted) continue;
            effectiveDueAt = `${todo.dueDate} ${todo.dueTime || settings.workEnd}:00`;
          } else {
            if (!todo.repeatEndDate) continue;
            effectiveDueAt = `${todo.repeatEndDate} ${settings.workEnd}:00`;
            const completion = getCompletionForDateStmt.get(
              todo.id,
              todo.repeatEndDate,
            ) as CompletionRow | undefined;
            if (completion) continue;
          }
          if (effectiveDueAt <= now || effectiveDueAt > windowEnd) continue;
          const diffMinutes = Math.max(
            1,
            Math.round(
              (new Date(effectiveDueAt.replace(" ", "T")).getTime() - nowDate.getTime()) /
                60000,
            ),
          );
          dueSoon.push({
            key: `due|${todo.id}|${effectiveDueAt}`,
            todoId: todo.id,
            title: todo.title,
            dueAt: effectiveDueAt,
            minutesLeft: diffMinutes,
            scheduleType: todo.scheduleType,
            priority: todo.priority,
          });
        }
        dueSoon.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
      }

      res.json({
        res: true,
        now,
        today,
        settings,
        stats: {
          pending: pending.length,
          overdue: overdue.length,
          completed: visible.length - pending.length,
          total: visible.length,
        },
        preview,
        dueSoon: dueSoon.slice(0, 5),
        nextReminder: nextRow
          ? {
              reminderId: nextRow.reminder_id,
              todoId: nextRow.todo_id,
              title: nextRow.title,
              triggerAt: nextRow.next_trigger_at,
              type: nextRow.reminder_type,
              dueDate: nextRow.due_date,
              dueTime: nextRow.due_time,
              priority: nextRow.priority,
            }
          : null,
        events: eventRows.map((row) => ({
          key: `${row.reminder_id}|${row.scheduled_for}`,
          reminderId: row.reminder_id,
          todoId: row.todo_id,
          title: row.title,
          triggerAt: row.scheduled_for,
          status: row.status,
          createdAt: row.created_at,
        })),
      });
    } catch (error) {
      sendRouteError(res, error, "load widget summary", logError);
    }
  });

  app.use(`${apiPrefix}/todo-categories`, categoryRouter);
  app.use(`${apiPrefix}/todo-tags`, tagRouter);
  app.use(`${apiPrefix}/todos`, todoRouter);
  app.use(`${apiPrefix}/todo-attachments`, todoAttachmentRouter);
  // 旧路径继续可用，历史图片链接不会失效
  app.use(`${apiPrefix}/todo-images`, todoAttachmentRouter);
  app.use(`${apiPrefix}/todo-shares`, shareRouter);
  app.use(`${apiPrefix}/todo-widget`, widgetRouter);

  const showWindowsToast = (title: string, body: string): Promise<void> => {
    if (process.platform !== "win32") {
      return Promise.reject(new Error("Windows notifications are only available on win32"));
    }
    const safeTitle = title.slice(0, 120);
    const safeBody = body.slice(0, 400);
    const script = `
$ErrorActionPreference = 'Stop'
$title = [System.Security.SecurityElement]::Escape([string]$env:GITSTATUS_TOAST_TITLE)
$body = [System.Security.SecurityElement]::Escape([string]$env:GITSTATUS_TOAST_BODY)
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>")
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('GitStatus').Show($toast)
`;
    const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
    return new Promise((resolve, reject) => {
      let stderr = "";
      let settled = false;
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Sta",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encodedCommand,
        ],
        {
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
          env: {
            ...process.env,
            GITSTATUS_TOAST_TITLE: safeTitle,
            GITSTATUS_TOAST_BODY: safeBody,
          },
        },
      );
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error("Windows notification timed out"));
      }, 15000);
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
      });
    });
  };

  type DueReminderRow = ReminderRow & {
    user_id: number;
    todo_title: string;
    todo_description: string;
    todo_schedule_type: TodoScheduleType;
    repeat_start_date: string | null;
    repeat_end_date: string | null;
    category_id: number | null;
    deleted_at: string | null;
  };

  const writeNotificationLog = (
    reminderId: number,
    scheduledFor: string,
    status: "sent" | "failed" | "skipped",
    sentAt: string | null,
    error: string | null,
  ): void => {
    try {
      insertNotificationLogStmt.run(
        reminderId,
        scheduledFor,
        sentAt,
        status,
        error,
        localNow(),
      );
    } catch (logFailure) {
      logError("[todo] failed to write notification log", logFailure);
    }
  };

  let reminderTickRunning = false;

  const runReminderTick = async (): Promise<void> => {
    if (reminderTickRunning) return;
    reminderTickRunning = true;
    try {
      const dueRows = dueRemindersStmt.all(localNow()) as DueReminderRow[];
      const today = localToday();
      for (const row of dueRows) {
        const scheduledFor = row.next_trigger_at;
        if (!scheduledFor) continue;

        if (row.deleted_at) {
          updateReminderNextStmt.run(null, 0, localNow(), row.id);
          writeNotificationLog(row.id, scheduledFor, "skipped", null, "task deleted");
          continue;
        }

        if (row.reminder_type === "once") {
          const completion = getAnyCompletionStmt.get(row.todo_id) as
            | CompletionRow
            | undefined;
          if (completion) {
            writeNotificationLog(
              row.id,
              scheduledFor,
              "skipped",
              null,
              `task completed at ${completion.completed_at}`,
            );
          } else {
            const category = row.category_id
              ? (getCategoryStmt.get(row.category_id, row.user_id) as
                  | CategoryRow
                  | undefined)
              : undefined;
            const message = category
              ? `${row.todo_title} · ${category.name}`
              : row.todo_title;
            try {
              await showWindowsToast("待办提醒", message);
              writeNotificationLog(row.id, scheduledFor, "sent", localNow(), null);
              logInfo(`[todo] reminder sent: #${row.id} ${row.todo_title}`);
            } catch (toastError) {
              const messageText =
                toastError instanceof Error ? toastError.message : String(toastError);
              writeNotificationLog(
                row.id,
                scheduledFor,
                "failed",
                null,
                messageText,
              );
              logWarn(`[todo] reminder failed: #${row.id} ${messageText}`);
            }
          }
          updateReminderNextStmt.run(null, 0, localNow(), row.id);
          continue;
        }

        const scheduledDate = datePart(scheduledFor);
        const completion = getCompletionForDateStmt.get(
          row.todo_id,
          scheduledDate,
        ) as CompletionRow | undefined;
        if (scheduledDate < today) {
          writeNotificationLog(
            row.id,
            scheduledFor,
            "skipped",
            null,
            "daily reminder missed while backend was offline",
          );
        } else if (completion) {
          writeNotificationLog(
            row.id,
            scheduledFor,
            "skipped",
            null,
            "daily task already completed",
          );
        } else {
          const category = row.category_id
            ? (getCategoryStmt.get(row.category_id, row.user_id) as
                | CategoryRow
                | undefined)
            : undefined;
          const message = category
            ? `${row.todo_title} · ${category.name}`
            : row.todo_title;
          try {
            await showWindowsToast("每日待办提醒", message);
            writeNotificationLog(row.id, scheduledFor, "sent", localNow(), null);
            logInfo(`[todo] daily reminder sent: #${row.id} ${row.todo_title}`);
          } catch (toastError) {
            const messageText =
              toastError instanceof Error ? toastError.message : String(toastError);
            writeNotificationLog(
              row.id,
              scheduledFor,
              "failed",
              null,
              messageText,
            );
            logWarn(`[todo] daily reminder failed: #${row.id} ${messageText}`);
          }
        }

        const nextTrigger = row.remind_time
          ? computeNextDailyTrigger(
              {
                repeat_start_date: row.repeat_start_date,
                repeat_end_date: row.repeat_end_date,
              },
              row.remind_time,
              new Date(),
            )
          : null;
        updateReminderNextStmt.run(
          nextTrigger,
          nextTrigger ? 1 : 0,
          localNow(),
          row.id,
        );
      }
    } catch (error) {
      logError("[todo] reminder scheduler failed", error);
    } finally {
      reminderTickRunning = false;
    }
  };

  const reminderTimer = setInterval(() => {
    void runReminderTick();
  }, 30_000);
  reminderTimer.unref();
  const startupTimer = setTimeout(() => {
    void runReminderTick();
  }, 2_000);
  startupTimer.unref();
  logInfo("[todo] reminder scheduler started (30s interval)");
};






