import express from "express";
import type Database from "better-sqlite3";
import { spawn } from "child_process";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";

type TodoFeatureOptions = {
  db: Database.Database;
  apiPrefix: string;
  authMiddleware: express.RequestHandler;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
  logError: (message: string, error?: unknown) => void;
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
type TodoImageRow = {
  id: number;
  todo_id: number;
  user_id: number;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size: number;
  created_at: string;
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

const toCategoryDto = (row: CategoryRow) => ({
  id: row.id,
  parentId: row.parent_id,
  name: row.name,
  color: row.color,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toTagDto = (row: TagRow) => ({
  id: row.id,
  name: row.name,
  color: row.color,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
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
  const { db, apiPrefix, authMiddleware, logInfo, logWarn, logError } = options;

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_todo_images_todo
    ON todo_images(todo_id, id)
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
  `);  const listCategoriesStmt = db.prepare(
    `SELECT id, user_id, parent_id, name, color, sort_order, created_at, updated_at
     FROM todo_categories WHERE user_id = ? ORDER BY sort_order ASC, id ASC`,
  );
  const getCategoryStmt = db.prepare(
    `SELECT id, user_id, parent_id, name, color, sort_order, created_at, updated_at
     FROM todo_categories WHERE id = ? AND user_id = ?`,
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

  const listTodoImagesStmt = db.prepare(
    `SELECT * FROM todo_images WHERE todo_id = ? AND user_id = ? ORDER BY id ASC`,
  );
  const getTodoImageStmt = db.prepare(
    `SELECT * FROM todo_images WHERE id = ? AND todo_id = ? AND user_id = ?`,
  );
  const getReadableTodoImageStmt = db.prepare(
    `SELECT i.* FROM todo_images i
     INNER JOIN todos t ON t.id = i.todo_id
     WHERE i.id = ? AND i.user_id = ? AND t.deleted_at IS NULL`,
  );
  const insertTodoImageStmt = db.prepare(
    `INSERT INTO todo_images
     (todo_id, user_id, original_name, stored_name, mime_type, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteTodoImageStmt = db.prepare(
    `DELETE FROM todo_images WHERE id = ? AND todo_id = ? AND user_id = ?`,
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
  );  const todoImagesDir = path.resolve("./src/output/todo-images");
  if (!fs.existsSync(todoImagesDir)) {
    fs.mkdirSync(todoImagesDir, { recursive: true });
  }

  const todoImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: 5 },
    fileFilter: (_req, file, callback) => {
      const mime = String(file.mimetype || "").toLowerCase();
      if (TODO_IMAGE_MIME_EXT[mime]) {
        callback(null, true);
        return;
      }
      callback(new TodoHttpError(400, "only jpeg/png/gif/webp/bmp/avif images are allowed"));
    },
  });

  const todoImageFields = todoImageUpload.fields([
    { name: "images", maxCount: 5 },
    { name: "file", maxCount: 1 },
  ]);

  const flattenUploadedFiles = (files: unknown): Express.Multer.File[] => {
    if (!files) return [];
    if (Array.isArray(files)) return files as Express.Multer.File[];
    if (typeof files !== "object") return [];
    return Object.values(files as Record<string, Express.Multer.File[]>).flat();
  };

  const toTodoImageDto = (row: TodoImageRow) => ({
    id: row.id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    size: row.size,
    url: `${apiPrefix}/todo-images/${row.id}`,
    createdAt: row.created_at,
  });

  const getTodoTags = (todoId: number, userId: number): TagRow[] =>
    listTodoTagsStmt.all(todoId, userId) as TagRow[];

  const toTodoDto = (row: TodoRow, selectedDate: string) => {
    const category = row.category_id
      ? (getCategoryStmt.get(row.category_id, row.user_id) as CategoryRow | undefined)
      : undefined;
    const tags = getTodoTags(row.id, row.user_id).map(toTagDto);
    const images = (listTodoImagesStmt.all(row.id, row.user_id) as TodoImageRow[])
      .map(toTodoImageDto);
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
      category: category ? toCategoryDto(category) : null,
      tags,
      images,
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
    };
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

  categoryRouter.get("/", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const rows = listCategoriesStmt.all(userId) as CategoryRow[];
      res.json({ res: true, categories: rows.map(toCategoryDto) });
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

  tagRouter.get("/", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const rows = listTagsStmt.all(userId) as TagRow[];
      res.json({ res: true, tags: rows.map(toTagDto) });
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

      let allowedCategoryIds: Set<number> | null = null;
      if (categoryId !== null) {
        ensureCategoryBelongsToUser(userId, categoryId);
        allowedCategoryIds = new Set(
          collectCategoryIds(userId, categoryId, includeDescendants),
        );
      }

      const rows = listActiveTodosStmt.all(userId) as TodoRow[];
      let todos = rows.map((row) => toTodoDto(row, selectedDate));

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
      if (viewRaw === "inbox") {
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
        todos = todos.filter((todo) => {
          if (todo.scheduleType === "daily") return todo.isActiveOnDate;
          if (todo.isCompleted) return todo.completionDate === selectedDate;
          return todo.dueDate === null || todo.dueDate <= selectedDate;
        });
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
      if (categoryId !== null) ensureCategoryBelongsToUser(userId, categoryId);
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
      ensureTagsBelongToUser(userId, tagIds);
      const sortOrder = parseSortOrder(body.sortOrder, 0);
      const now = localNow();
      const createTodo = db.transaction(() => {
        const info = insertTodoStmt.run(
          userId, categoryId, title, description, priority, scheduleType,
          dueDate, dueTime, repeatStartDate, repeatEndDate, sortOrder, now, now,
        );
        const todoId = Number(info.lastInsertRowid);
        for (const tagId of tagIds) insertTodoTagLinkStmt.run(todoId, tagId);
        return todoId;
      });
      const todoId = createTodo();
      const row = getTodoOrThrow(userId, todoId);
      res.status(201).json({ res: true, todo: toTodoDto(row, localToday()) });
    } catch (error) {
      sendRouteError(res, error, "create todo", logError);
    }
  });

  todoRouter.get("/:id", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      const row = getTodoOrThrow(userId, todoId);
      const dateRaw = String(req.query.date ?? "").trim();
      const selectedDate = dateRaw || localToday();
      if (!isValidDateOnly(selectedDate)) fail(400, "date must be YYYY-MM-DD");
      res.json({ res: true, todo: toTodoDto(row, selectedDate) });
    } catch (error) {
      sendRouteError(res, error, "get todo", logError);
    }
  });  todoRouter.patch("/:id", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      const current = getTodoOrThrow(userId, todoId);
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
      if (categoryId !== null) ensureCategoryBelongsToUser(userId, categoryId);
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
      if (tagIds) ensureTagsBelongToUser(userId, tagIds);
      const sortOrder = hasOwn(body, "sortOrder")
        ? parseSortOrder(body.sortOrder, current.sort_order)
        : current.sort_order;
      const now = localNow();
      const scheduleChanged = scheduleType !== current.schedule_type;
      const updateTodo = db.transaction(() => {
        updateTodoStmt.run(
          categoryId, title, description, priority, scheduleType,
          dueDate, dueTime, repeatStartDate, repeatEndDate, sortOrder, now,
          todoId, userId,
        );
        if (tagIds) {
          deleteTodoTagLinksStmt.run(todoId);
          for (const tagId of tagIds) insertTodoTagLinkStmt.run(todoId, tagId);
        }
        if (scheduleChanged) disableReminderForTodoStmt.run(now, todoId);
      });
      updateTodo();
      const updated = getTodoOrThrow(userId, todoId);
      const selectedDateRaw = String(req.query.date ?? "").trim();
      const selectedDate = selectedDateRaw || localToday();
      if (!isValidDateOnly(selectedDate)) fail(400, "date must be YYYY-MM-DD");
      res.json({ res: true, todo: toTodoDto(updated, selectedDate) });
    } catch (error) {
      sendRouteError(res, error, "update todo", logError);
    }
  });

  todoRouter.delete("/:id", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      getTodoOrThrow(userId, todoId);
      const now = localNow();
      const removeTodo = db.transaction(() => {
        softDeleteTodoStmt.run(now, now, todoId, userId);
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
      const todo = getTodoOrThrow(userId, todoId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const completionDate = normalizeRequiredDate(
        body.date ?? localToday(),
        "date",
      );

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
        touchTodoStmt.run(now, todoId, userId);
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
        todo: toTodoDto(getTodoOrThrow(userId, todoId), completionDate),
      });
    } catch (error) {
      sendRouteError(res, error, "complete todo", logError);
    }
  });

  todoRouter.delete("/:id/complete", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      const todo = getTodoOrThrow(userId, todoId);
      const rawDate = String(req.query.date ?? "").trim();
      let changed = 0;
      if (todo.schedule_type === "once" && !rawDate) {
        changed = Number(deleteAllCompletionsStmt.run(todoId).changes || 0);
      } else {
        const completionDate = normalizeRequiredDate(
          rawDate || localToday(),
          "date",
        );
        changed = Number(deleteCompletionForDateStmt.run(todoId, completionDate).changes || 0);
      }
      if (changed > 0) touchTodoStmt.run(localNow(), todoId, userId);
      res.json({
        res: true,
        message: "completion removed",
        todo: toTodoDto(getTodoOrThrow(userId, todoId), localToday()),
      });
    } catch (error) {
      sendRouteError(res, error, "uncomplete todo", logError);
    }
  });

  todoRouter.put("/:id/reminder", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      const todo = getTodoOrThrow(userId, todoId);
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
      touchTodoStmt.run(now, todoId, userId);
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
      getTodoOrThrow(userId, todoId);
      deleteReminderStmt.run(todoId);
      touchTodoStmt.run(localNow(), todoId, userId);
      res.json({ res: true, message: "reminder deleted" });
    } catch (error) {
      sendRouteError(res, error, "delete todo reminder", logError);
    }
  });  todoRouter.get("/:id/images", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      getTodoOrThrow(userId, todoId);
      const images = (listTodoImagesStmt.all(todoId, userId) as TodoImageRow[])
        .map(toTodoImageDto);
      res.json({ res: true, images });
    } catch (error) {
      sendRouteError(res, error, "list todo images", logError);
    }
  });

  todoRouter.post(
    "/:id/images",
    (req, res, next) => {
      todoImageFields(req, res, (error) => {
        if (error) {
          logWarn(`[todo] image upload rejected: ${error.message}`);
          res.status(400).json({ res: false, message: error.message });
          return;
        }
        next();
      });
    },
    (req, res) => {
      try {
        const userId = getRequestUserId(req);
        const todoId = parsePositiveId(req.params.id, "todo id");
        getTodoOrThrow(userId, todoId);
        const files = flattenUploadedFiles(req.files);
        if (files.length === 0) fail(400, "at least one image file is required");

        const userDir = path.join(todoImagesDir, String(userId));
        fs.mkdirSync(userDir, { recursive: true });
        const createdRows: TodoImageRow[] = [];
        const createdPaths: string[] = [];

        try {
          for (const file of files) {
            const mime = String(file.mimetype || "").toLowerCase();
            const extension = TODO_IMAGE_MIME_EXT[mime];
            if (!extension) {
              fail(400, "unsupported image type");
            }
            const storedName = `${crypto.randomUUID()}${extension}`;
            const fullPath = path.join(userDir, storedName);
            fs.writeFileSync(fullPath, file.buffer);
            createdPaths.push(fullPath);
            const now = localNow();
            const info = insertTodoImageStmt.run(
              todoId,
              userId,
              String(file.originalname || "image").slice(0, 255),
              storedName,
              mime,
              file.size,
              now,
            );
            const row = getTodoImageStmt.get(
              Number(info.lastInsertRowid),
              todoId,
              userId,
            ) as TodoImageRow | undefined;
            if (!row) throw new Error("failed to read uploaded image metadata");
            createdRows.push(row);
          }
        } catch (uploadError) {
          for (const row of createdRows) {
            deleteTodoImageStmt.run(row.id, todoId, userId);
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

        touchTodoStmt.run(localNow(), todoId, userId);
        res.status(201).json({
          res: true,
          images: createdRows.map(toTodoImageDto),
          todo: toTodoDto(getTodoOrThrow(userId, todoId), localToday()),
        });
      } catch (error) {
        sendRouteError(res, error, "upload todo images", logError);
      }
    },
  );

  todoRouter.delete("/:id/images/:imageId", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const todoId = parsePositiveId(req.params.id, "todo id");
      const imageId = parsePositiveId(req.params.imageId, "image id");
      getTodoOrThrow(userId, todoId);
      const image = getTodoImageStmt.get(imageId, todoId, userId) as
        | TodoImageRow
        | undefined;
      if (!image) fail(404, "image not found");
      deleteTodoImageStmt.run(imageId, todoId, userId);
      touchTodoStmt.run(localNow(), todoId, userId);
      try {
        fs.unlinkSync(path.join(todoImagesDir, String(userId), image.stored_name));
      } catch {
        // Metadata is authoritative; a missing file should not block deletion.
      }
      res.json({ res: true, message: "image deleted" });
    } catch (error) {
      sendRouteError(res, error, "delete todo image", logError);
    }
  });

  const todoImageRouter = express.Router();
  todoImageRouter.use(authMiddleware);
  todoImageRouter.get("/:id", (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const imageId = parsePositiveId(req.params.id, "image id");
      const image = getReadableTodoImageStmt.get(imageId, userId) as
        | TodoImageRow
        | undefined;
      if (!image) fail(404, "image not found");
      const fullPath = path.join(
        todoImagesDir,
        String(userId),
        image.stored_name,
      );
      if (!fs.existsSync(fullPath)) fail(404, "image file not found");
      res.type(image.mime_type);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.sendFile(fullPath, (error) => {
        if (error && !res.headersSent) {
          res.status(404).json({ res: false, message: "image not found" });
        }
      });
    } catch (error) {
      sendRouteError(res, error, "read todo image", logError);
    }
  });
  app.use(`${apiPrefix}/todo-categories`, categoryRouter);
  app.use(`${apiPrefix}/todo-tags`, tagRouter);
  app.use(`${apiPrefix}/todos`, todoRouter);
  app.use(`${apiPrefix}/todo-images`, todoImageRouter);

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



