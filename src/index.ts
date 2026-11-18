import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import path from "path";
import fs from "fs";
import express from "express";
import multer from "multer";
import Database from "better-sqlite3";
import jwt from "jsonwebtoken";
import type { StringValue } from "ms";
import bcrypt from "bcryptjs";
import {
  registerTodoFeature,
  removeTodoAttachmentsForUser,
  removePetAssetsForUser,
  transferTodoData,
} from "./todo.js";
import { registerProjectFeature } from "./projects.js";

type GitCommit = {
  hash: string;
  date: string;
  author: string;
  email: string;
  message: string;
  additions: number;
  deletions: number;
  files: Array<{ file: string; additions: number; deletions: number }>;
};

type RepoRow = {
  id: number;
  name: string;
  url: string;
  branch: string;
  default_branch: string;
  data: string;
};

type RepoDataPayload = {
  branches: string[];
  commitsByBranch: Record<string, GitCommit[]>;
};

type BlogPost = {
  id: number;
  title: string;
  date: string;
  updated: string;
  tags: string;
  categories: string;
  excerpt: string;
  content: string;
  cover: string;
  comment: string;
};

/** 解析后的博客对象（JSON 字段已反序列化） */
type ParsedBlogPost = {
  id: number;
  title: string;
  date: string;
  updated: string;
  tags: string[];
  categories: string[];
  excerpt: string;
  content: string;
  cover: string;
  comment: unknown[];
  searchResult?: string;
};

// ========== Blog API 请求/响应类型 ==========

/** GET /blogs 查询参数 */
type BlogListQuery = {
  id?: string;
  search?: string;
  tags?: string | string[];
  categories?: string | string[];
  page?: string;
  pageSize?: string;
  sort?: "date" | "updated";
  order?: "asc" | "desc";
};

/** POST /blogs 请求体 */
type CreateBlogBody = {
  title: string;
  date?: string;
  tags?: string[];
  categories?: string[];
  excerpt?: string;
  content?: string;
  cover?: string;
  comment?: unknown[];
};

/** PATCH /blogs/:id 请求体 */
type UpdateBlogBody = {
  title?: string;
  tags?: string[];
  categories?: string[];
  excerpt?: string;
  content?: string;
  cover?: string;
  comment?: unknown[];
};

/** 路径参数 :id */
type IdParams = { id: string };

/** 通用错误响应 */
type ErrorResponse = { res: false; message: string };

/** 单篇博客响应 */
type SingleBlogResponse = { res: true; blog: ParsedBlogPost | null };

/** 博客列表响应（含分页） */
type BlogListResponse = {
  res: true;
  total: number;
  page: number;
  pageSize: number;
  blogs: ParsedBlogPost[];
};

/** 删除成功响应 */
type DeleteBlogResponse = { res: true; message: string };

// ========== Auth 类型 ==========

/** 角色等级：只读 < 读写 < 管理员 */
type UserRole = "readonly" | "readwrite" | "admin";

type UserStatus = "active" | "disabled" | "pending";

const ROLE_LEVEL: Record<UserRole, number> = {
  readonly: 1,
  readwrite: 2,
  admin: 3,
};

const USER_ROLES: UserRole[] = ["readonly", "readwrite", "admin"];
/** 管理员在用户管理页可设置的状态（pending 只由注册产生） */
const USER_STATUSES: UserStatus[] = ["active", "disabled"];
/** 用户列表筛选允许待审核状态 */
const USER_STATUS_FILTERS: UserStatus[] = ["active", "disabled", "pending"];

const isUserRole = (value: unknown): value is UserRole =>
  typeof value === "string" && (USER_ROLES as string[]).includes(value);

const isUserStatus = (value: unknown): value is UserStatus =>
  typeof value === "string" && (USER_STATUSES as string[]).includes(value);

const isUserStatusFilter = (value: unknown): value is UserStatus =>
  typeof value === "string" && (USER_STATUS_FILTERS as string[]).includes(value);

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  last_login_at: string | null;
};

type JwtPayload = {
  userId: number;
  username: string;
  role: UserRole;
};

/** 用户管理接口返回的用户信息（不含密码哈希） */
type UserDto = {
  id: number;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
};

/** API 密钥行：库里只保存摘要，明文仅在发行时返回一次 */
type ApiKeyRow = {
  id: number;
  user_id: number;
  name: string;
  key_prefix: string;
  key_hash: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
};

/** API 密钥对外 DTO，不含摘要 */
type ApiKeyDto = {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
};

type RuntimeConfig = {
  allowedOrigins: string[];
  jwtSecret: string;
  jwtExpiresIn: StringValue;
  /** 同时处于待审核状态的最大注册数量，超过后暂停注册 */
  maxPendingRegistrations: number;
};

const app = express();
// 注意：Windows 保留端口段 65050-65149（Hyper-V/WSL 动态保留）会导致 listen EACCES，
// 此处选用保留段之外的端口。可通过 `netsh interface ipv4 show excludedportrange protocol=tcp` 查看。
const port = 30012;
const apiPrefix = "/gitstatus/api";
const pagesDir = path.resolve("./src/pages");
const docsDir = path.resolve("./src/docs");
const outputDir = path.resolve("./src/output");
const dbPath = path.resolve(outputDir, "gitstatus.db");
const configPath = path.resolve("./config/config.json");
const logsDir = path.resolve(outputDir, "logs");
const modelsDir = path.resolve(outputDir, "models");

// better-sqlite3 不会自动创建父目录，src/output 被 .gitignore 忽略，
// 首次运行或目录被清理时需先创建，否则 new Database 会抛错
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const db = new Database(dbPath);

// ========== 日志模块 ==========
// 按日期写入 output/logs/YYYY-MM-DD.log，同时输出到控制台

type LogLevel = "INFO" | "WARN" | "ERROR" | "ACCESS";

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}
if (!fs.existsSync(modelsDir)) {
  fs.mkdirSync(modelsDir, { recursive: true });
}

/** 获取当前日期字符串 YYYY-MM-DD（本地时区） */
const getLogDateStr = (): string => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/** 获取当前时间字符串 YYYY-MM-DD HH:mm:ss.SSS */
const getLogTimeStr = (): string => {
  const d = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
};

/** 写入日志文件（异步 append），同时输出到控制台 */
const writeLog = (level: LogLevel, message: string): void => {
  const line = `[${getLogTimeStr()}] [${level}] ${message}\n`;
  // 控制台输出
  if (level === "ERROR") process.stderr.write(line);
  else process.stdout.write(line);
  // 文件写入
  const file = path.join(logsDir, `${getLogDateStr()}.log`);
  fs.appendFile(file, line, (err) => {
    if (err) process.stderr.write(`[logger] failed to write log: ${err.message}\n`);
  });
};

const logInfo = (msg: string) => writeLog("INFO", msg);
const logWarn = (msg: string) => writeLog("WARN", msg);
const logError = (msg: string, err?: unknown) => {
  let tail = "";
  if (err instanceof Error) tail = ` | ${err.message}\n${err.stack || ""}`;
  else if (err !== undefined) tail = ` | ${String(err)}`;
  writeLog("ERROR", msg + tail);
};
const logAccess = (msg: string) => writeLog("ACCESS", msg);

const loadRuntimeConfig = (): RuntimeConfig => {
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content) as Partial<RuntimeConfig>;
    const origins = Array.isArray(parsed.allowedOrigins)
      ? parsed.allowedOrigins.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const envMaxPending = Number(process.env.MAX_PENDING_REGISTRATIONS);
    const configMaxPending = Number(parsed.maxPendingRegistrations);
    const maxPendingRegistrations =
      Number.isInteger(envMaxPending) && envMaxPending > 0
        ? Math.min(envMaxPending, 500)
        : Number.isInteger(configMaxPending) && configMaxPending > 0
          ? Math.min(configMaxPending, 500)
          : 20;
    return {
      allowedOrigins: origins,
      jwtSecret: String(parsed.jwtSecret || "gitstatus-default-secret").trim(),
      jwtExpiresIn: String(parsed.jwtExpiresIn || "7d").trim() as StringValue,
      maxPendingRegistrations,
    };
  } catch (error) {
    logWarn(
      `[config] failed to read ${configPath}, fallback to defaults`,
    );
    return {
      allowedOrigins: [],
      jwtSecret: "gitstatus-default-secret",
      jwtExpiresIn: "7d" as StringValue,
      maxPendingRegistrations: 20,
    };
  }
};

const runtimeConfig = loadRuntimeConfig();
const corsAllowSet = new Set(runtimeConfig.allowedOrigins);

app.use(express.json());

// HTTP 访问日志中间件：记录请求方法、路径、状态码、耗时
app.use((req, res, next) => {
  const start = Date.now();
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "-");
  res.on("finish", () => {
    const ms = Date.now() - start;
    logAccess(
      `${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms - ${ip}`,
    );
  });
  next();
});

// multer 配置：内存存储，限制 10MB，仅允许 .md 文件
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (
      file.originalname.toLowerCase().endsWith(".md") ||
      file.mimetype === "text/markdown" ||
      file.mimetype === "text/plain"
    ) {
      cb(null, true);
    } else {
      cb(new Error("only .md files are allowed"));
    }
  },
});

// multer for model uploads 已随模型简化接口一并移除

app.use((req, res, next) => {
  const origin = String(req.headers.origin || "");
  const isAllowed = origin && corsAllowSet.has(origin);

  if (isAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    res.status(isAllowed ? 204 : 403).end();
    return;
  }

  next();
});

// 根路径与 /gitstatus 直接跳转到页面入口，
// 否则访问 http://host:port/ 会落到 Express 默认 404（页面实际托管在 /pages 下）
app.get(["/", "/gitstatus"], (_req, res) => {
  res.redirect("/pages/index.html");
});

app.use(
  "/pages",
  express.static(pagesDir, {
    setHeaders: (res, filePath) => {
      // HTML 页面只做协商缓存，避免前端逻辑更新后浏览器继续使用旧页面
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
      }
    },
  }),
);
app.use(`${apiPrefix}/docs`, express.static(docsDir));
// 静态托管已生成的模型文件
app.use(`${apiPrefix}/models`, express.static(modelsDir));

// 用户删除时需要依赖外键级联清理待办数据
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'readonly',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    last_login_at TEXT
  )
`);

// 兼容旧库：补充 status / last_login_at 字段（ALTER 只支持常量默认值）
const userTableCols = db.prepare("PRAGMA table_info(users)").all() as Array<{
  name: string;
}>;
if (!userTableCols.some((col) => col.name === "status")) {
  db.exec(
    "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
  );
}
if (!userTableCols.some((col) => col.name === "last_login_at")) {
  db.exec("ALTER TABLE users ADD COLUMN last_login_at TEXT");
}

// 旧版本只有 user/admin 两档，统一迁移为三档角色
db.prepare(
  "UPDATE users SET role = 'readwrite' WHERE role NOT IN ('readonly','readwrite','admin')",
).run();

// 系统有且只能有一个管理员：数据库层用部分唯一索引兜底
const existingAdminCount = (
  db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get() as {
    count: number;
  }
).count;
if (existingAdminCount <= 1) {
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_single_admin ON users(role) WHERE role = 'admin'",
  );
} else {
  logWarn(
    `[users] detected ${existingAdminCount} administrators; single-admin unique index not created`,
  );
}

db.exec(`
  CREATE TABLE IF NOT EXISTS repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    branch TEXT NOT NULL DEFAULT 'HEAD',
    default_branch TEXT NOT NULL DEFAULT 'HEAD',
    data TEXT NOT NULL DEFAULT '[]'
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS blog_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    tags TEXT NOT NULL DEFAULT '[]',
    categories TEXT NOT NULL DEFAULT '[]',
    excerpt TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    cover TEXT NOT NULL DEFAULT '',
    comment TEXT NOT NULL DEFAULT '[]'
  )
`);

// API 密钥：供 MCP / 脚本等非浏览器客户端长期鉴权。
// 明文只在发行响应里出现，库里只留 SHA-256 摘要，泄漏数据库也无法还原密钥

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    last_used_at TEXT,
    expires_at TEXT
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)");

const tableCols = db.prepare("PRAGMA table_info(repositories)").all() as Array<{
  name: string;
}>;
if (!tableCols.some((col) => col.name === "branch")) {
  db.exec(
    "ALTER TABLE repositories ADD COLUMN branch TEXT NOT NULL DEFAULT 'HEAD'",
  );
}
if (!tableCols.some((col) => col.name === "default_branch")) {
  db.exec(
    "ALTER TABLE repositories ADD COLUMN default_branch TEXT NOT NULL DEFAULT 'HEAD'",
  );
}

const getRepoListStmt = db.prepare(
  "SELECT id, name, url, branch, default_branch FROM repositories ORDER BY id DESC",
);
const getRepoByIdStmt = db.prepare(
  "SELECT id, name, url, branch, default_branch, data FROM repositories WHERE id = ?",
);
const insertRepoStmt = db.prepare(
  "INSERT INTO repositories (name, url, branch, default_branch, data) VALUES (?, ?, ?, ?, ?)",
);
const updateRepoStmt = db.prepare(
  "UPDATE repositories SET name = ?, url = ?, branch = ?, default_branch = ? WHERE id = ?",
);
const updateRepoSnapshotStmt = db.prepare(
  "UPDATE repositories SET branch = ?, default_branch = ?, data = ? WHERE id = ?",
);

const getBlogListStmt = db.prepare(
  "SELECT * FROM blog_posts ORDER BY date DESC",
);
const getBlogByIdStmt = db.prepare("SELECT * FROM blog_posts WHERE id = ?");
const insertBlogStmt = db.prepare(
  `INSERT INTO blog_posts (title, date, updated, tags, categories, excerpt, content, cover, comment)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const updateBlogStmt = db.prepare(
  `UPDATE blog_posts SET title=?, updated=?, tags=?, categories=?, excerpt=?, content=?, cover=?, comment=? WHERE id=?`,
);
const deleteBlogStmt = db.prepare("DELETE FROM blog_posts WHERE id = ?");

// ========== Auth 预编译语句 ==========

const getUserByNameStmt = db.prepare(
  "SELECT * FROM users WHERE username = ?",
);
const getUserByIdStmt = db.prepare(
  "SELECT * FROM users WHERE id = ?",
);
const insertUserStmt = db.prepare(
  "INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, ?, ?)",
);
const updateUserStmt = db.prepare(
  "UPDATE users SET username = ?, role = ?, status = ? WHERE id = ?",
);
const updateUserPasswordStmt = db.prepare(
  "UPDATE users SET password_hash = ? WHERE id = ?",
);
const deleteUserStmt = db.prepare("DELETE FROM users WHERE id = ?");
const touchLastLoginStmt = db.prepare(
  "UPDATE users SET last_login_at = datetime('now','localtime') WHERE id = ?",
);
const getUserCountStmt = db.prepare(
  "SELECT COUNT(*) as count FROM users",
);
const getPendingUserCountStmt = db.prepare(
  "SELECT COUNT(*) as count FROM users WHERE status = 'pending'",
);
const getActiveAdminCountStmt = db.prepare(
  "SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND status = 'active'",
);

// ========== API 密钥预编译语句 ==========

/** 密钥前缀：带固定前缀才能在鉴权时一眼区分 JWT 与 API Key */
const API_KEY_PREFIX = "gsk_";
const API_KEY_BYTES = 24;
/** 单账号密钥上限，避免密钥无限堆积 */
const MAX_API_KEYS_PER_USER = 10;
/** last_used_at 写库节流：单个密钥每分钟最多更新一次 */
const API_KEY_TOUCH_INTERVAL_MS = 60_000;

const hashApiKey = (key: string): string =>
  createHash("sha256").update(key).digest("hex");

const createApiKeyValue = (): string =>
  `${API_KEY_PREFIX}${randomBytes(API_KEY_BYTES).toString("base64url")}`;

const insertApiKeyStmt = db.prepare(
  "INSERT INTO api_keys (user_id, name, key_prefix, key_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
);
const getApiKeyByIdStmt = db.prepare("SELECT * FROM api_keys WHERE id = ?");
const listApiKeysStmt = db.prepare(
  "SELECT * FROM api_keys WHERE user_id = ? ORDER BY id DESC",
);
const countApiKeysStmt = db.prepare(
  "SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?",
);
// 过期判断交给 SQLite 的本地时间比较，避免 JS 侧再维护一套日期解析
const getActiveApiKeyByHashStmt = db.prepare(
  "SELECT * FROM api_keys WHERE key_hash = ? AND (expires_at IS NULL OR expires_at > datetime('now','localtime'))",
);
const deleteApiKeyStmt = db.prepare(
  "DELETE FROM api_keys WHERE id = ? AND user_id = ?",
);
const touchApiKeyStmt = db.prepare(
  "UPDATE api_keys SET last_used_at = datetime('now','localtime') WHERE id = ?",
);
const apiKeyTouchAt = new Map<number, number>();

/** api_keys 行 -> 对外 DTO，永不返回摘要 */
const toApiKeyDto = (row: ApiKeyRow): ApiKeyDto => ({
  id: row.id,
  name: row.name,
  prefix: row.key_prefix,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at ?? null,
  expiresAt: row.expires_at ?? null,
});

/** users 表行 -> 对外 DTO，永不返回密码哈希 */
const toUserDto = (row: UserRow): UserDto => ({
  id: row.id,
  username: row.username,
  role: row.role,
  status: row.status,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at ?? null,
});

/** 判断请求是否来自本机（用于仅本机可用的系统级操作） */
const isLoopbackClient = (req: express.Request): boolean => {
  const address = String(req.socket.remoteAddress || "");
  return (
    address === "::1" ||
    address === "127.0.0.1" ||
    address.startsWith("::ffff:127.")
  );
};

/** 角色是否达到指定等级 */
const hasRoleLevel = (role: UserRole | undefined, min: UserRole): boolean =>
  Boolean(role) && ROLE_LEVEL[role as UserRole] >= ROLE_LEVEL[min];

/** 当前是否只剩一个可用的管理员 */
const isLastActiveAdmin = (row: UserRow): boolean => {
  if (row.role !== "admin" || row.status !== "active") return false;
  const { count } = getActiveAdminCountStmt.get() as { count: number };
  return count <= 1;
};

// ========== Auth 中间件 ==========

/** 扩展 Request 以携带用户信息 */
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * 按 userId 载入数据库中的最新用户状态并写入 req.user。
 * 失败时已写好响应并返回 false，鉴权分支靠返回值决定是否继续。
 */
const attachAuthenticatedUser = (
  req: express.Request,
  res: express.Response,
  userId: number,
): boolean => {
  // 角色/状态可能已变化，始终以数据库为准，保证改角色、禁用账号立即生效
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(401).json({ res: false, message: "invalid or expired token" });
    return false;
  }
  const dbUser = getUserByIdStmt.get(userId) as UserRow | undefined;
  if (!dbUser) {
    res.status(401).json({ res: false, message: "user no longer exists" });
    return false;
  }
  if (dbUser.status === "pending") {
    res.status(403).json({
      res: false,
      message: "account pending approval; please wait for an administrator to review it",
    });
    return false;
  }
  if (dbUser.status !== "active") {
    res.status(403).json({ res: false, message: "account is disabled" });
    return false;
  }

  req.user = {
    userId: dbUser.id,
    username: dbUser.username,
    role: dbUser.role,
  };
  return true;
};

/** 认证中间件：接受 JWT 或 API Key，并以数据库中的最新角色/状态覆盖凭据内容 */
const authMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void => {
  const authHeader = String(req.headers.authorization || "");
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ res: false, message: "missing or invalid token" });
    return;
  }
  const token = authHeader.slice(7);

  // API Key 分支：MCP / 脚本等长期客户端，不走 JWT
  if (token.startsWith(API_KEY_PREFIX)) {
    const apiKey = getActiveApiKeyByHashStmt.get(hashApiKey(token)) as
      | ApiKeyRow
      | undefined;
    if (!apiKey) {
      res.status(401).json({ res: false, message: "invalid or expired api key" });
      return;
    }
    const now = Date.now();
    if (now - (apiKeyTouchAt.get(apiKey.id) ?? 0) > API_KEY_TOUCH_INTERVAL_MS) {
      apiKeyTouchAt.set(apiKey.id, now);
      touchApiKeyStmt.run(apiKey.id);
    }
    if (attachAuthenticatedUser(req, res, apiKey.user_id)) next();
    return;
  }

  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(token, runtimeConfig.jwtSecret) as JwtPayload;
  } catch {
    res.status(401).json({ res: false, message: "invalid or expired token" });
    return;
  }

  if (attachAuthenticatedUser(req, res, Number(decoded?.userId))) next();
};

/** 角色守卫中间件：要求精确匹配指定角色 */
const requireRole = (...roles: UserRole[]) => {
  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    if (!req.user) {
      res.status(401).json({ res: false, message: "not authenticated" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ res: false, message: "insufficient permissions" });
      return;
    }
    next();
  };
};

/** 角色等级守卫：要求达到指定等级（readonly < readwrite < admin） */
const requireMinRole = (min: UserRole) => {
  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    if (!req.user) {
      res.status(401).json({ res: false, message: "not authenticated" });
      return;
    }
    if (!hasRoleLevel(req.user.role, min)) {
      res.status(403).json({ res: false, message: "insufficient permissions" });
      return;
    }
    next();
  };
};

// ========== Auth API ==========

/** 注册: POST /gitstatus/api/auth/register */
app.post(`${apiPrefix}/auth/register`, async (req, res) => {
  try {
    const username = String(req.body?.username ?? "").trim();
    logInfo(`[auth] register attempt: ${username}`);
    const password = String(req.body?.password ?? "");
    if (!username || !password) {
      res.status(400).json({ res: false, message: "username and password are required" });
      return;
    }
    if (username.length < 3 || username.length > 32) {
      res.status(400).json({ res: false, message: "username must be 3-32 characters" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ res: false, message: "password must be at least 6 characters" });
      return;
    }

    const existing = getUserByNameStmt.get(username) as UserRow | undefined;
    if (existing) {
      res.status(409).json({ res: false, message: "username already exists" });
      return;
    }

    // 第一个用户自动成为管理员；其余注册需要管理员审核
    const { count } = getUserCountStmt.get() as { count: number };
    const isFirstUser = count === 0;
    const role: UserRole = isFirstUser ? "admin" : "readonly";

    // 限制同时待审核的注册数量，避免恶意注册堆积
    if (!isFirstUser) {
      const pending = (getPendingUserCountStmt.get() as { count: number }).count;
      if (pending >= runtimeConfig.maxPendingRegistrations) {
        res.status(429).json({
          res: false,
          message: "too many pending registrations; please try again later",
        });
        return;
      }
    }

    const hash = await bcrypt.hash(password, 10);

    // bcrypt 是异步操作，哈希完成后再次检查，防止并发请求突破上限
    if (!isFirstUser) {
      const pending = (getPendingUserCountStmt.get() as { count: number }).count;
      if (pending >= runtimeConfig.maxPendingRegistrations) {
        res.status(429).json({
          res: false,
          message: "too many pending registrations; please try again later",
        });
        return;
      }
    }

    const initialStatus: UserStatus = isFirstUser ? "active" : "pending";
    const info = insertUserStmt.run(username, hash, role, initialStatus);
    const user = getUserByIdStmt.get(Number(info.lastInsertRowid)) as UserRow;

    // 待审核用户不签发 token，必须由管理员审核通过后才能登录
    if (!isFirstUser) {
      logInfo(`[auth] registered user ${user.username} pending approval`);
      res.status(201).json({
        res: true,
        user: toUserDto(user),
        pending: true,
        message: "registration pending approval",
      });
      return;
    }

    const payload: JwtPayload = { userId: user.id, username: user.username, role: user.role };
    const token = jwt.sign(payload, runtimeConfig.jwtSecret, {
      expiresIn: runtimeConfig.jwtExpiresIn,
    });

    logInfo(`[auth] registered user ${user.username} (${user.role})`);
    res.status(201).json({
      res: true,
      user: toUserDto(user),
      token,
      local: isLoopbackClient(req),
    });
  } catch (error: any) {
    res.status(500).json({ res: false, message: error?.message || "register failed" });
  }
});

/** 登录: POST /gitstatus/api/auth/login */
app.post(`${apiPrefix}/auth/login`, async (req, res) => {
  try {
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    if (!username || !password) {
      res.status(400).json({ res: false, message: "username and password are required" });
      return;
    }

    const user = getUserByNameStmt.get(username) as UserRow | undefined;
    if (!user) {
      res.status(401).json({ res: false, message: "invalid username or password" });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ res: false, message: "invalid username or password" });
      return;
    }
    if (user.status === "pending") {
      res.status(403).json({
        res: false,
        message: "account pending approval; please wait for an administrator to review it",
      });
      return;
    }
    if (user.status !== "active") {
      res.status(403).json({ res: false, message: "account is disabled" });
      return;
    }

    touchLastLoginStmt.run(user.id);
    const fresh = getUserByIdStmt.get(user.id) as UserRow;

    const payload: JwtPayload = { userId: user.id, username: user.username, role: user.role };
    const token = jwt.sign(payload, runtimeConfig.jwtSecret, {
      expiresIn: runtimeConfig.jwtExpiresIn,
    });

    res.json({
      res: true,
      user: toUserDto(fresh),
      token,
      local: isLoopbackClient(req),
    });
  } catch (error: any) {
    res.status(500).json({ res: false, message: error?.message || "login failed" });
  }
});

/** 获取当前用户信息: GET /gitstatus/api/auth/me */
app.get(`${apiPrefix}/auth/me`, authMiddleware, (req, res) => {
  const row = getUserByIdStmt.get(req.user!.userId) as UserRow | undefined;
  if (!row) {
    res.status(404).json({ res: false, message: "user not found" });
    return;
  }
  // local 表示浏览器与服务在同一台机器上，前端据此决定是否提供“系统默认程序打开”
  res.json({ res: true, user: toUserDto(row), local: isLoopbackClient(req) });
});

// ========== 用户管理 API（仅管理员） ==========

/** 校验用户名：3-32 个字符 */
const validateUsername = (username: string): string | null => {
  if (!username) return "username is required";
  if (username.length < 3 || username.length > 32) {
    return "username must be 3-32 characters";
  }
  return null;
};

/** 校验密码：至少 6 个字符 */
const validatePassword = (password: string): string | null => {
  if (!password) return "password is required";
  if (password.length < 6) return "password must be at least 6 characters";
  return null;
};

// ========== API 密钥 API ==========
// 密钥属于账号自身资源，任何已登录账号都可以管理自己的密钥，
// 权限仍由账号当前角色决定（鉴权时实时查库）

/** 列出当前账号的 API 密钥: GET /gitstatus/api/auth/api-keys */
app.get(`${apiPrefix}/auth/api-keys`, authMiddleware, (req, res) => {
  const rows = listApiKeysStmt.all(req.user!.userId) as ApiKeyRow[];
  res.json({ res: true, apiKeys: rows.map(toApiKeyDto) });
});

/** 发行 API 密钥: POST /gitstatus/api/auth/api-keys —— 明文只在本响应中出现一次 */
app.post(`${apiPrefix}/auth/api-keys`, authMiddleware, (req, res) => {
  const body = (req.body ?? {}) as { name?: unknown; expiresInDays?: unknown };
  const name = String(body.name ?? "").trim();
  if (!name) {
    res.status(400).json({ res: false, message: "name is required" });
    return;
  }
  if (name.length > 50) {
    res.status(400).json({ res: false, message: "name must be at most 50 characters" });
    return;
  }

  let expiresAt: string | null = null;
  if (body.expiresInDays !== undefined && body.expiresInDays !== null && body.expiresInDays !== "") {
    const days = Number(body.expiresInDays);
    if (!Number.isInteger(days) || days <= 0 || days > 3650) {
      res.status(400).json({
        res: false,
        message: "expiresInDays must be an integer between 1 and 3650",
      });
      return;
    }
    const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    // 与 SQLite datetime('now','localtime') 保持同样的文本格式，便于直接比较
    expiresAt = `${expires.getFullYear()}-${pad(expires.getMonth() + 1)}-${pad(expires.getDate())} ${pad(expires.getHours())}:${pad(expires.getMinutes())}:${pad(expires.getSeconds())}`;
  }

  const { count } = countApiKeysStmt.get(req.user!.userId) as { count: number };
  if (count >= MAX_API_KEYS_PER_USER) {
    res.status(409).json({
      res: false,
      message: `each account can hold at most ${MAX_API_KEYS_PER_USER} api keys`,
    });
    return;
  }

  const key = createApiKeyValue();
  const info = insertApiKeyStmt.run(
    req.user!.userId,
    name,
    key.slice(0, API_KEY_PREFIX.length + 6),
    hashApiKey(key),
    expiresAt,
  );
  const row = getApiKeyByIdStmt.get(Number(info.lastInsertRowid)) as ApiKeyRow;
  logInfo(`[api-keys] issued key #${row.id} for user ${req.user!.userId} (${name})`);
  res.status(201).json({ res: true, apiKey: toApiKeyDto(row), key });
});

/** 吊销 API 密钥: DELETE /gitstatus/api/auth/api-keys/:id */
app.delete(`${apiPrefix}/auth/api-keys/:id`, authMiddleware, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ res: false, message: "invalid api key id" });
    return;
  }
  const info = deleteApiKeyStmt.run(id, req.user!.userId);
  if (info.changes === 0) {
    res.status(404).json({ res: false, message: "api key not found" });
    return;
  }
  apiKeyTouchAt.delete(id);
  logInfo(`[api-keys] revoked key #${id} for user ${req.user!.userId}`);
  res.json({ res: true, message: "api key revoked" });
});

/** 用户列表: GET /gitstatus/api/users?search=&role=&status=&page=&pageSize=&sort=&order= */
app.get(`${apiPrefix}/users`, authMiddleware, requireRole("admin"), (req, res) => {
  const search = String(req.query.search ?? "").trim();
  const roleFilter = String(req.query.role ?? "").trim();
  const statusFilter = String(req.query.status ?? "").trim();

  if (roleFilter && !isUserRole(roleFilter)) {
    res.status(400).json({ res: false, message: "invalid role filter" });
    return;
  }
  if (statusFilter && !isUserStatusFilter(statusFilter)) {
    res.status(400).json({ res: false, message: "invalid status filter" });
    return;
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const offset = (page - 1) * pageSize;

  const sortRaw = String(req.query.sort ?? "id");
  const sortableFields = ["id", "username", "role", "status", "created_at", "last_login_at"];
  const sortField = sortableFields.includes(sortRaw) ? sortRaw : "id";
  const sortOrder =
    String(req.query.order ?? "").toLowerCase() === "desc" ? "DESC" : "ASC";
  // 默认把待审核账号排在最前，方便管理员及时处理
  const explicitSort = Boolean(String(req.query.sort ?? "").trim());
  const orderClause = explicitSort
    ? `${sortField} ${sortOrder}`
    : `CASE status WHEN 'pending' THEN 0 ELSE 1 END, ${sortField} ${sortOrder}`;

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (search) {
    conditions.push("username LIKE ? COLLATE NOCASE");
    params.push(`%${search.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`);
  }
  if (roleFilter) {
    conditions.push("role = ?");
    params.push(roleFilter);
  }
  if (statusFilter) {
    conditions.push("status = ?");
    params.push(statusFilter);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const total = (
    db.prepare(`SELECT COUNT(*) as total FROM users ${whereClause}`).get(...params) as {
      total: number;
    }
  ).total;
  const rows = db
    .prepare(
      `SELECT * FROM users ${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as UserRow[];

  res.json({
    res: true,
    total,
    page,
    pageSize,
    pendingCount: (getPendingUserCountStmt.get() as { count: number }).count,
    users: rows.map(toUserDto),
  });
});

/** 用户详情: GET /gitstatus/api/users/:id */
app.get(`${apiPrefix}/users/:id`, authMiddleware, requireRole("admin"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ res: false, message: "invalid id" });
    return;
  }
  const row = getUserByIdStmt.get(id) as UserRow | undefined;
  if (!row) {
    res.status(404).json({ res: false, message: "user not found" });
    return;
  }
  res.json({ res: true, user: toUserDto(row) });
});

/** 创建用户: POST /gitstatus/api/users */
app.post(`${apiPrefix}/users`, authMiddleware, requireRole("admin"), async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    const roleRaw = body.role === undefined ? "readonly" : String(body.role);
    const statusRaw = body.status === undefined ? "active" : String(body.status);

    const usernameError = validateUsername(username);
    if (usernameError) {
      res.status(400).json({ res: false, message: usernameError });
      return;
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      res.status(400).json({ res: false, message: passwordError });
      return;
    }
    if (!isUserRole(roleRaw)) {
      res.status(400).json({ res: false, message: "role must be readonly, readwrite or admin" });
      return;
    }
    if (!isUserStatus(statusRaw)) {
      res.status(400).json({ res: false, message: "status must be active or disabled" });
      return;
    }
    if (roleRaw === "admin") {
      res
        .status(400)
        .json({ res: false, message: "administrator role cannot be created" });
      return;
    }

    const existing = getUserByNameStmt.get(username) as UserRow | undefined;
    if (existing) {
      res.status(409).json({ res: false, message: "username already exists" });
      return;
    }

    const hash = await bcrypt.hash(password, 10);
    const info = insertUserStmt.run(username, hash, roleRaw, statusRaw);
    const created = getUserByIdStmt.get(Number(info.lastInsertRowid)) as UserRow;
    logInfo(
      `[users] ${req.user!.username} created user ${created.username} (${created.role}, ${created.status})`,
    );
    res.status(201).json({ res: true, user: toUserDto(created) });
  } catch (error: any) {
    res.status(500).json({ res: false, message: error?.message || "create user failed" });
  }
});

/** 修改用户: PATCH /gitstatus/api/users/:id */
app.patch(`${apiPrefix}/users/:id`, authMiddleware, requireRole("admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ res: false, message: "invalid id" });
      return;
    }
    const row = getUserByIdStmt.get(id) as UserRow | undefined;
    if (!row) {
      res.status(404).json({ res: false, message: "user not found" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const has = (key: string): boolean =>
      Object.prototype.hasOwnProperty.call(body, key);
    if (!["username", "password", "role", "status"].some(has)) {
      res.status(400).json({ res: false, message: "no fields to update" });
      return;
    }

    let username = row.username;
    if (has("username")) {
      username = String(body.username ?? "").trim();
      const usernameError = validateUsername(username);
      if (usernameError) {
        res.status(400).json({ res: false, message: usernameError });
        return;
      }
      const sameName = getUserByNameStmt.get(username) as UserRow | undefined;
      if (sameName && sameName.id !== id) {
        res.status(409).json({ res: false, message: "username already exists" });
        return;
      }
    }

    let role = row.role;
    if (has("role")) {
      const roleRaw = String(body.role);
      if (!isUserRole(roleRaw)) {
        res.status(400).json({ res: false, message: "role must be readonly, readwrite or admin" });
        return;
      }
      role = roleRaw;
    }

    // 管理员角色不允许创建或转移：只允许保持原有管理员身份
    if (role === "admin" && row.role !== "admin") {
      res
        .status(400)
        .json({ res: false, message: "administrator role cannot be transferred" });
      return;
    }

    let status = row.status;
    if (has("status")) {
      const statusRaw = String(body.status);
      if (!isUserStatus(statusRaw)) {
        res.status(400).json({ res: false, message: "status must be active or disabled" });
        return;
      }
      status = statusRaw;
    }

    let passwordHash: string | null = null;
    if (has("password")) {
      const password = String(body.password ?? "");
      const passwordError = validatePassword(password);
      if (passwordError) {
        res.status(400).json({ res: false, message: passwordError });
        return;
      }
      passwordHash = await bcrypt.hash(password, 10);
    }

    // 自保护：不能修改自己的角色或状态，避免误操作导致无人可管理
    if (id === req.user!.userId) {
      if (role !== row.role) {
        res.status(400).json({ res: false, message: "cannot change your own role" });
        return;
      }
      if (status !== row.status) {
        res.status(400).json({ res: false, message: "cannot change your own status" });
        return;
      }
    }

    if (role === "admin" && status !== "active") {
      res.status(400).json({ res: false, message: "administrator must be active" });
      return;
    }

    // 系统必须保留至少一个可用的管理员
    if (isLastActiveAdmin(row) && (role !== "admin" || status !== "active")) {
      res
        .status(400)
        .json({ res: false, message: "cannot demote or disable the last active admin" });
      return;
    }

    const applyUpdate = db.transaction(() => {
      updateUserStmt.run(username, role, status, id);
      if (passwordHash) {
        updateUserPasswordStmt.run(passwordHash, id);
      }
    });
    applyUpdate();

    const updated = getUserByIdStmt.get(id) as UserRow;
    logInfo(
      `[users] ${req.user!.username} updated user ${row.username} -> username=${updated.username}, role=${updated.role}, status=${updated.status}${passwordHash ? ", password reset" : ""}`,
    );
    res.json({ res: true, user: toUserDto(updated) });
  } catch (error: any) {
    res.status(500).json({ res: false, message: error?.message || "update user failed" });
  }
});

/** 迁移用户数据: POST /gitstatus/api/users/:id/transfer */
app.post(`${apiPrefix}/users/:id/transfer`, authMiddleware, requireRole("admin"), (req, res) => {
  try {
    const sourceId = Number(req.params.id);
    const targetId = Number((req.body ?? {}).targetUserId);
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      res.status(400).json({ res: false, message: "invalid id" });
      return;
    }
    if (!Number.isInteger(targetId) || targetId <= 0) {
      res.status(400).json({ res: false, message: "invalid targetUserId" });
      return;
    }
    if (sourceId === targetId) {
      res.status(400).json({ res: false, message: "source and target user must differ" });
      return;
    }
    const source = getUserByIdStmt.get(sourceId) as UserRow | undefined;
    const target = getUserByIdStmt.get(targetId) as UserRow | undefined;
    if (!source) {
      res.status(404).json({ res: false, message: "source user not found" });
      return;
    }
    if (!target) {
      res.status(404).json({ res: false, message: "target user not found" });
      return;
    }

    const stats = transferTodoData(db, sourceId, targetId);
    logInfo(
      `[users] ${req.user!.username} transferred todo data from ${source.username} to ${target.username}: ` +
        `${stats.categories} categories, ${stats.tags} tags, ${stats.todos} todos, ${stats.attachments} attachments`,
    );
    res.json({ res: true, message: "transferred", stats });
  } catch (error: any) {
    res.status(500).json({ res: false, message: error?.message || "transfer user data failed" });
  }
});

/** 删除用户: DELETE /gitstatus/api/users/:id */
app.delete(`${apiPrefix}/users/:id`, authMiddleware, requireRole("admin"), (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ res: false, message: "invalid id" });
      return;
    }
    const row = getUserByIdStmt.get(id) as UserRow | undefined;
    if (!row) {
      res.status(404).json({ res: false, message: "user not found" });
      return;
    }
    if (id === req.user!.userId) {
      res.status(400).json({ res: false, message: "cannot delete your own account" });
      return;
    }
    if (isLastActiveAdmin(row)) {
      res.status(400).json({ res: false, message: "cannot delete the last active admin" });
      return;
    }

    // 待办、分类、标签、图片记录由外键级联删除，磁盘图片单独清理
    const removeUser = db.transaction(() => {
      // 先解除分类父子引用，避免 users 级联删除时触发 parent_id 的 RESTRICT 约束
      db.prepare("UPDATE todo_categories SET parent_id = NULL WHERE user_id = ?").run(id);
      deleteUserStmt.run(id);
    });
    removeUser();
    removeTodoAttachmentsForUser(id);
    removePetAssetsForUser(id);
    logInfo(`[users] ${req.user!.username} deleted user ${row.username} (id=${id})`);
    res.json({ res: true, message: "deleted" });
  } catch (error: any) {
    res.status(500).json({ res: false, message: error?.message || "delete user failed" });
  }
});

const listBranches = (repoPath: string): Promise<string[]> => {
  return new Promise((resolve, reject) => {
    const git = spawn(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      { cwd: repoPath },
    );
    let out = "";
    let err = "";
    git.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    git.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    git.on("error", (error) => reject(error));
    git.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err || "list branches failed"));
        return;
      }
      const branches = out
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      resolve(branches.length ? branches : ["HEAD"]);
    });
  });
};

const scanGitHistory = (
  repoPath: string,
  branch: string = "HEAD",
): Promise<GitCommit[]> => {
  const branchRef = String(branch || "HEAD").trim() || "HEAD";
  return new Promise((resolve, reject) => {
    const git = spawn(
      "git",
      [
        "log",
        branchRef,
        "--numstat",
        "--date=iso",
        "--pretty=format:%H|%ad|%an|%ae|%s",
      ],
      { cwd: repoPath },
    );

    const commits: GitCommit[] = [];
    let current: GitCommit | null = null;
    let buffer = "";

    git.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;

        if (line.includes("|")) {
          const [hash = "", date = "", author = "", email = "", message = ""] =
            line.split("|");
          const commit: GitCommit = {
            hash,
            date,
            author,
            email,
            message,
            additions: 0,
            deletions: 0,
            files: [],
          };
          current = commit;
          commits.push(commit);
          continue;
        }

        const parts = line.split("\t");
        if (parts.length >= 3 && current) {
          const [add = "", del = "", file = ""] = parts;
          const addNum = Number(add) || 0;
          const delNum = Number(del) || 0;
          current.additions += addNum;
          current.deletions += delNum;
          current.files.push({
            file,
            additions: addNum,
            deletions: delNum,
          });
        }
      }
    });

    git.on("error", (err) => reject(err));
    git.stderr.on("data", (err) => logError(`[git] stderr: ${err.toString()}`));
    git.on("close", (code) => {
      if (code === 0) resolve(commits);
      else reject(new Error("git process failed"));
    });
  });
};

const scanAllBranchesHistory = async (
  repoPath: string,
): Promise<RepoDataPayload> => {
  const branches = await listBranches(repoPath);
  const commitsByBranch: Record<string, GitCommit[]> = {};
  for (const branch of branches) {
    commitsByBranch[branch] = await scanGitHistory(repoPath, branch);
  }
  return { branches, commitsByBranch };
};

const parseRepoRow = (row: RepoRow | undefined) => {
  if (!row) return null;
  let normalizedData: RepoDataPayload = { branches: [], commitsByBranch: {} };
  try {
    const parsed = JSON.parse(row.data || "{}");
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.branches) &&
      parsed.commitsByBranch &&
      typeof parsed.commitsByBranch === "object"
    ) {
      normalizedData = {
        branches: parsed.branches.filter((x: unknown) => typeof x === "string"),
        commitsByBranch: parsed.commitsByBranch as Record<string, GitCommit[]>,
      };
    } else if (Array.isArray(parsed)) {
      const fallbackBranch = row.branch || "HEAD";
      normalizedData = {
        branches: [fallbackBranch],
        commitsByBranch: {
          [fallbackBranch]: parsed as GitCommit[],
        },
      };
    }
  } catch {
    normalizedData = { branches: [], commitsByBranch: {} };
  }
  if (!normalizedData.branches.length) {
    const fallbackBranch = row.default_branch || row.branch || "HEAD";
    normalizedData.branches = [fallbackBranch];
    if (!normalizedData.commitsByBranch[fallbackBranch]) {
      normalizedData.commitsByBranch[fallbackBranch] = [];
    }
  }
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    branch: row.branch,
    defaultBranch: row.default_branch || row.branch || "HEAD",
    data: normalizedData,
  };
};

// 查询接口: GET /gitstatus/api/repos 或 GET /gitstatus/api/repos?id=1
// 需要登录，任意角色可读
app.get(`${apiPrefix}/repos`, authMiddleware, (req, res) => {
  const idRaw = String(req.query.id ?? "").trim();
  if (idRaw) {
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ res: false, message: "invalid id" });
      return;
    }
    const row = getRepoByIdStmt.get(id) as RepoRow | undefined;
    if (!row) {
      res.status(404).json({ res: false, message: "repo not found" });
      return;
    }
    res.json({ res: true, repo: parseRepoRow(row) });
    return;
  }

  const repos = getRepoListStmt.all() as Array<{
    id: number;
    name: string;
    url: string;
    branch: string;
    default_branch: string;
  }>;
  res.json({
    res: true,
    repos: repos.map((x) => ({
      id: x.id,
      name: x.name,
      url: x.url,
      branch: x.branch,
      defaultBranch: x.default_branch || x.branch || "HEAD",
    })),
  });
});

// 新增接口: POST /gitstatus/api/repos
// 需要读写及以上角色
app.post(`${apiPrefix}/repos`, authMiddleware, requireMinRole("readwrite"), async (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const url = String(req.body?.url ?? "").trim();
    const requestedDefaultBranch = String(req.body?.defaultBranch ?? "").trim();
    if (!name || !url) {
      res
        .status(400)
        .json({ res: false, message: "name and url are required" });
      return;
    }

    const repoPath = path.resolve(url);
    const dataPayload = await scanAllBranchesHistory(repoPath);
    const defaultBranch =
      requestedDefaultBranch &&
      dataPayload.branches.includes(requestedDefaultBranch)
        ? requestedDefaultBranch
        : dataPayload.branches[0] || "HEAD";
    const info = insertRepoStmt.run(
      name,
      repoPath,
      defaultBranch,
      defaultBranch,
      JSON.stringify(dataPayload),
    );
    const created = getRepoByIdStmt.get(Number(info.lastInsertRowid)) as
      | RepoRow
      | undefined;

    res.status(201).json({ res: true, repo: parseRepoRow(created) });
  } catch (error: any) {
    const msg = String(error?.message || "create repo failed");
    if (msg.includes("UNIQUE")) {
      res.status(409).json({ res: false, message: "repo url already exists" });
      return;
    }
    res.status(500).json({ res: false, message: msg });
  }
});

// 修改接口: PATCH /gitstatus/api/repos/:id
// 需要读写及以上角色
app.patch(`${apiPrefix}/repos/:id`, authMiddleware, requireMinRole("readwrite"), (req, res) => {
  (async () => {
    const id = Number(req.params.id);
    const name = String(req.body?.name ?? "").trim();
    const url = String(req.body?.url ?? "").trim();
    const requestedDefaultBranch = String(req.body?.defaultBranch ?? "").trim();
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ res: false, message: "invalid id" });
      return;
    }
    if (!name || !url) {
      res
        .status(400)
        .json({ res: false, message: "name and url are required" });
      return;
    }

    const repoPath = path.resolve(url);
    const exists = getRepoByIdStmt.get(id) as RepoRow | undefined;
    if (!exists) {
      res.status(404).json({ res: false, message: "repo not found" });
      return;
    }

    const dataPayload = await scanAllBranchesHistory(repoPath);
    const preferred =
      requestedDefaultBranch ||
      exists.default_branch ||
      exists.branch ||
      "HEAD";
    const newDefaultBranch = dataPayload.branches.includes(preferred)
      ? preferred
      : dataPayload.branches[0] || "HEAD";
    updateRepoStmt.run(name, repoPath, newDefaultBranch, newDefaultBranch, id);
    updateRepoSnapshotStmt.run(
      newDefaultBranch,
      newDefaultBranch,
      JSON.stringify(dataPayload),
      id,
    );
    const updated = getRepoByIdStmt.get(id) as RepoRow | undefined;
    res.json({ res: true, repo: parseRepoRow(updated) });
  })().catch((error: any) => {
    const msg = String(error?.message || "update repo failed");
    if (msg.includes("UNIQUE")) {
      res.status(409).json({ res: false, message: "repo url already exists" });
      return;
    }
    res.status(500).json({ res: false, message: msg });
  });
});

// 刷新接口: POST /gitstatus/api/repos/:id/refresh
// 需要读写及以上角色
app.post(`${apiPrefix}/repos/:id/refresh`, authMiddleware, requireMinRole("readwrite"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ res: false, message: "invalid id" });
      return;
    }

    const row = getRepoByIdStmt.get(id) as RepoRow | undefined;
    if (!row) {
      res.status(404).json({ res: false, message: "repo not found" });
      return;
    }

    const dataPayload = await scanAllBranchesHistory(row.url);
    const preferred = row.default_branch || row.branch || "HEAD";
    const newBranch = dataPayload.branches.includes(preferred)
      ? preferred
      : dataPayload.branches[0] || "HEAD";
    updateRepoSnapshotStmt.run(
      newBranch,
      newBranch,
      JSON.stringify(dataPayload),
      id,
    );
    const updated = getRepoByIdStmt.get(id) as RepoRow | undefined;
    res.json({ res: true, repo: parseRepoRow(updated) });
  } catch (error: any) {
    res
      .status(500)
      .json({ res: false, message: error?.message || "refresh failed" });
  }
});

// ========== Blog Posts API ==========

// 解析查询参数为字符串数组
const parseQueryArray = (raw: unknown): string[] => {
  if (!raw) return [];
  if (Array.isArray(raw))
    return raw.map((x) => String(x).trim()).filter(Boolean);
  const str = String(raw).trim();
  return str ? [str] : [];
};

const parseBlogRow = (b: BlogPost): ParsedBlogPost => ({
  ...b,
  tags: JSON.parse(b.tags),
  categories: JSON.parse(b.categories),
  comment: JSON.parse(b.comment),
  searchResult: "",
});

/** 去除 Markdown 格式标记，保留纯文本 */
const stripMarkdown = (md: string): string =>
  md
    .replace(/^#{1,6}\s+/gm, "")         // 标题 # ## ###
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // 图片 ![alt](url)
    .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => m.replace(/\[([^\]]*)\]\([^)]*\)/, "$1")) // 链接保留文字
    .replace(/(`{1,3})[^`]*\1/g, "")      // 行内代码 / 代码块
    .replace(/[*_~]{1,3}/g, "")            // 加粗/斜体/删除线 ** * __ _ ~~
    .replace(/^>\s?/gm, "")               // 引用 >
    .replace(/^[-*+]\s+/gm, "")           // 无序列表
    .replace(/^\d+\.\s+/gm, "")           // 有序列表
    .replace(/^---+$/gm, "")              // 分割线
    .replace(/\|/g, " ")                   // 表格竖线
    .replace(/\n{2,}/g, "\n")             // 多余空行
    .trim();

/** 从纯文本中提取关键词前后各 N 个字符的片段 */
const extractSnippet = (
  text: string,
  keyword: string,
  around: number = 20,
): string | null => {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(keyword.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - around);
  const end = Math.min(text.length, idx + keyword.length + around);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";
  return snippet;
};

/** 尝试读取 content 路径指向的文件，返回纯文本（去 Markdown 格式） */
const readContentFileText = (contentPath: string): string | null => {
  if (!contentPath || !contentPath.startsWith("/")) return null;
  const absPath = path.join(docsDir, contentPath);
  if (!absPath.startsWith(docsDir)) return null;
  try {
    const raw = fs.readFileSync(absPath, "utf-8");
    return stripMarkdown(raw);
  } catch {
    return null;
  }
};

// 查询博客列表 / 单篇: GET /gitstatus/api/blogs
// 支持参数: id, tags, categories, page, pageSize, sort(date|updated), order(asc|desc)
app.get<
  Record<string, string>,
  SingleBlogResponse | BlogListResponse | ErrorResponse,
  unknown,
  BlogListQuery
>(`${apiPrefix}/blogs`, (req, res) => {
  // --- 单篇查询 ---
  const idRaw = String(req.query.id ?? "").trim();
  if (idRaw) {
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ res: false, message: "invalid id" });
      return;
    }
    const row = getBlogByIdStmt.get(id) as BlogPost | undefined;
    if (!row) {
      res.status(404).json({ res: false, message: "blog not found" });
      return;
    }
    res.json({ res: true, blog: parseBlogRow(row) });
    return;
  }

  // --- 列表查询（支持 tags / categories 筛选 + 全文搜索） ---
  const filterTags = parseQueryArray(req.query.tags);
  const filterCategories = parseQueryArray(req.query.categories);
  const searchKeyword = String(req.query.search ?? "").trim();

  // 动态构建 SQL
  const conditions: string[] = [];
  const params: unknown[] = [];

  // 标签筛选：博客的 tags JSON 数组中需包含所有指定标签
  for (const tag of filterTags) {
    conditions.push(
      `EXISTS (SELECT 1 FROM json_each(blog_posts.tags) WHERE json_each.value = ?)`,
    );
    params.push(tag);
  }

  // 分类筛选：博客的 categories 路径需以指定分类开头（递归匹配子分类）
  // 例如查询 "技术" 时，匹配 ["技术"], ["技术","前端"], ["技术","前端","React"] 等
  if (filterCategories.length > 0) {
    // 构建分类前缀匹配：将 filterCategories 转为 JSON 前缀字符串
    // 如 ["技术","前端"] -> categories 字段以 '["\u6280\u672f","\u524d\u7aef"' 开头
    const catConditions: string[] = [];
    for (const cat of filterCategories) {
      // 单个分类关键词：匹配 categories 数组中第一层包含该值的（即该分类或其子分类）
      // 使用 json_each 获取第一个元素与查询值比较，或者直接做前缀匹配
      catConditions.push(
        `EXISTS (SELECT 1 FROM json_each(blog_posts.categories) jc WHERE jc.value = ? AND jc.key = 0)` +
          ` OR blog_posts.categories LIKE ?`,
      );
      params.push(cat);
      // LIKE 模式：匹配数组中任意位置包含该分类值的记录（递归子分类）
      params.push(`%${cat.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`);
    }
    conditions.push(`(${catConditions.join(" OR ")})`);
  }

  // 全文搜索：标题 / 摘要的 SQL LIKE 匹配
  // content 字段存的是文件路径，需要在应用层处理
  if (searchKeyword) {
    conditions.push(
      `(blog_posts.title LIKE ? COLLATE NOCASE OR blog_posts.excerpt LIKE ? COLLATE NOCASE)`,
    );
    const likePattern = `%${searchKeyword.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
    params.push(likePattern, likePattern);
  }

  // 排序
  const sortField = req.query.sort === "updated" ? "updated" : "date";
  const sortOrder =
    String(req.query.order ?? "").toLowerCase() === "asc" ? "ASC" : "DESC";

  // 分页
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const offset = (page - 1) * pageSize;

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  // 如果有搜索关键词，需要额外扫描文件内容来补充匹配
  if (searchKeyword) {
    // 1. 先获取标题/摘要匹配的 ID 集合
    const sqlMatchedBlogs = db
      .prepare(`SELECT * FROM blog_posts ${whereClause} ORDER BY ${sortField} ${sortOrder}`)
      .all(...params) as BlogPost[];
    const sqlMatchedIds = new Set(sqlMatchedBlogs.map((b) => b.id));

    // 2. 获取不在 SQL 结果中的博客，扫描文件内容
    // 构建不含 search 条件的基础查询（保留 tags/categories 筛选）
    const baseConditions = conditions.slice(0, -1); // 移除最后一个 search 条件
    const baseParams = params.slice(0, -2); // 移除 search 的两个 LIKE 参数
    const baseWhere = baseConditions.length ? `WHERE ${baseConditions.join(" AND ")}` : "";
    const allFilteredBlogs = db
      .prepare(`SELECT * FROM blog_posts ${baseWhere} ORDER BY ${sortField} ${sortOrder}`)
      .all(...baseParams) as BlogPost[];

    // 扫描文件内容匹配
    const contentMatchMap = new Map<number, string>(); // id -> snippet
    for (const blog of allFilteredBlogs) {
      if (sqlMatchedIds.has(blog.id)) continue; // 已经通过标题/摘要匹配了
      const plainText = readContentFileText(blog.content);
      if (!plainText) continue;
      const snippet = extractSnippet(plainText, searchKeyword);
      if (snippet) {
        contentMatchMap.set(blog.id, snippet);
      }
    }

    // 3. 合并结果：SQL 匹配 + 内容匹配
    const contentMatchedBlogs = allFilteredBlogs.filter((b) => contentMatchMap.has(b.id));
    const merged = [...sqlMatchedBlogs, ...contentMatchedBlogs];

    // 重新排序
    merged.sort((a, b) => {
      const va = sortField === "updated" ? a.updated : a.date;
      const vb = sortField === "updated" ? b.updated : b.date;
      return sortOrder === "ASC" ? va.localeCompare(vb) : vb.localeCompare(va);
    });

    const total = merged.length;
    const paged = merged.slice(offset, offset + pageSize);

    res.json({
      res: true,
      total,
      page,
      pageSize,
      blogs: paged.map((b) => {
        const parsed = parseBlogRow(b);
        // 如果是内容匹配，替换 content 为片段
        const snippet = contentMatchMap.get(b.id);
        if (snippet) {
          parsed.searchResult = snippet;
        }
        return parsed;
      }),
    });
    return;
  }

  // 无搜索关键词时，正常分页查询
  const countSql = `SELECT COUNT(*) as total FROM blog_posts ${whereClause}`;
  const total = (db.prepare(countSql).get(...params) as { total: number })
    .total;

  const querySql = `SELECT * FROM blog_posts ${whereClause} ORDER BY ${sortField} ${sortOrder} LIMIT ? OFFSET ?`;
  const blogs = db
    .prepare(querySql)
    .all(...params, pageSize, offset) as BlogPost[];

  res.json({
    res: true,
    total,
    page,
    pageSize,
    blogs: blogs.map(parseBlogRow),
  });
});

// 安全地构建 docs 下的子路径，防止路径遍历攻击
const safeBuildDocsPath = (segments: string[]): string | null => {
  // 过滤每个路径片段，移除危险字符
  const cleaned = segments
    .map(
      (s) =>
        String(s)
          .trim()
          .replace(/[\\\/]/g, "") // 移除路径分隔符
          .replace(/\.\.+/g, "") // 移除连续的点
          .replace(/^\./g, ""), // 移除开头的点
    )
    .filter(Boolean);

  if (!cleaned.length) return null;

  const target = path.resolve(docsDir, ...cleaned);
  // 确保最终路径仍在 docsDir 内
  if (!target.startsWith(docsDir)) return null;
  return target;
};

// 安全地构建文件名
const safeFileName = (name: string): string => {
  return name
    .replace(/[\\\/:\*\?"<>\|]/g, "_") // 替换文件名非法字符
    .replace(/\.\.+/g, "_")
    .trim();
};

/** 从 multipart 请求中解析 JSON 字段（form-data 中字符串形式的 JSON） */
const parseFormJson = <T>(val: unknown, fallback: T): T => {
  if (val === undefined || val === null) return fallback;
  const str = String(val).trim();
  if (!str) return fallback;
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
};

// 新增博客: POST /gitstatus/api/blogs
// 支持 JSON 和 multipart/form-data（文件上传）两种方式
// 需要登录，读写及以上角色可操作
app.post(
  `${apiPrefix}/blogs`,
  authMiddleware,
  requireMinRole("readwrite"),
  upload.single("file"),
  async (req: express.Request, res: express.Response) => {
    try {
      const title = String(req.body?.title ?? "").trim();
      if (!title) {
        res.status(400).json({ res: false, message: "title is required" });
        return;
      }

      const now = formatDateTime(new Date());
      const date = String(req.body?.date ?? "").trim() || now;
      const updated = now;
      const rawCategories: string[] = Array.isArray(req.body?.categories)
        ? req.body.categories
        : parseFormJson<string[]>(req.body?.categories, []);
      const tags = JSON.stringify(
        Array.isArray(req.body?.tags)
          ? req.body.tags
          : parseFormJson<string[]>(req.body?.tags, []),
      );
      const categories = JSON.stringify(rawCategories);
      const excerpt = String(req.body?.excerpt ?? "").trim();
      const cover = String(req.body?.cover ?? "").trim();
      const comment = JSON.stringify(
        Array.isArray(req.body?.comment)
          ? req.body.comment
          : parseFormJson<unknown[]>(req.body?.comment, []),
      );

      // 获取内容：优先从上传文件读取，其次从 body.content 读取
      const rawContent = req.file
        ? req.file.buffer.toString("utf-8")
        : String(req.body?.content ?? "").trim();

      // 根据 categories 构建文件夹路径，在最深层创建 md 文件
      let contentPath = rawContent; // 默认：无 categories 时保留原始 content

      if (rawCategories.length > 0) {
        const dirPath = safeBuildDocsPath(rawCategories);
        if (!dirPath) {
          res.status(400).json({ res: false, message: "invalid categories path" });
          return;
        }

        const fileName = safeFileName(title);
        if (!fileName) {
          res.status(400).json({ res: false, message: "invalid title for file name" });
          return;
        }

        const mdFilePath = path.join(dirPath, `${fileName}.md`);
        if (!mdFilePath.startsWith(docsDir)) {
          res.status(400).json({ res: false, message: "invalid file path" });
          return;
        }

        fs.mkdirSync(dirPath, { recursive: true });
        fs.writeFileSync(mdFilePath, rawContent, "utf-8");

        contentPath = "/" + path.relative(docsDir, mdFilePath).replace(/\\/g, "/");
      }

      const info = insertBlogStmt.run(
        title, date, updated, tags, categories, excerpt, contentPath, cover, comment,
      );
      const created = getBlogByIdStmt.get(Number(info.lastInsertRowid)) as BlogPost | undefined;
      res.status(201).json({
        res: true,
        blog: created ? parseBlogRow(created) : null,
      });
    } catch (error: any) {
      res.status(500).json({ res: false, message: error?.message || "create blog failed" });
    }
  },
);

// 模型简化接口（/models/simplify）已移除；src/output/models 仍作为历史文件的静态目录保留

// 更新博客: PATCH /gitstatus/api/blogs/:id
// 支持 JSON 和 multipart/form-data（文件上传）两种方式
// 需要登录，读写及以上角色可操作
app.patch(
  `${apiPrefix}/blogs/:id`,
  authMiddleware,
  requireMinRole("readwrite"),
  upload.single("file"),
  (req: express.Request, res: express.Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ res: false, message: "invalid id" });
      return;
    }
    const existing = getBlogByIdStmt.get(id) as BlogPost | undefined;
    if (!existing) {
      res.status(404).json({ res: false, message: "blog not found" });
      return;
    }
    const title = String(req.body?.title ?? existing.title).trim();
    const now = formatDateTime(new Date());
    const tags = JSON.stringify(
      Array.isArray(req.body?.tags)
        ? req.body.tags
        : parseFormJson<string[]>(req.body?.tags, JSON.parse(existing.tags)),
    );
    const newCategoriesArr: string[] = Array.isArray(req.body?.categories)
      ? req.body.categories
      : parseFormJson<string[] | null>(req.body?.categories, null) ?? JSON.parse(existing.categories);
    const categories = JSON.stringify(newCategoriesArr);
    const excerpt =
      req.body?.excerpt !== undefined
        ? String(req.body.excerpt).trim()
        : existing.excerpt;
    const cover =
      req.body?.cover !== undefined
        ? String(req.body.cover).trim()
        : existing.cover;
    const comment = JSON.stringify(
      Array.isArray(req.body?.comment)
        ? req.body.comment
        : parseFormJson<unknown[] | null>(req.body?.comment, null) ?? JSON.parse(existing.comment),
    );

    // 获取上传文件内容（如有）
    const uploadedContent = req.file ? req.file.buffer.toString("utf-8") : null;
    const hasNewContent = uploadedContent !== null || req.body?.content !== undefined;
    const rawContent = uploadedContent ?? (req.body?.content !== undefined ? String(req.body.content) : null);

    // content 字段处理：路径由系统管理
    let content = existing.content;
    const oldCategories = existing.categories;
    const categoriesChanged = categories !== oldCategories;
    const titleChanged = title !== existing.title;
    const hasValidMdPath = content.trim().startsWith("/") && content.trim().endsWith(".md");

    // 如果 title 或 categories 发生变化且存在有效的 md 文件路径，则重命名/移动文件
    if ((categoriesChanged || titleChanged) && hasValidMdPath) {
      const oldAbsPath = path.resolve(docsDir, content.trim().slice(1));
      if (!oldAbsPath.startsWith(docsDir + path.sep)) {
        res.status(400).json({ res: false, message: "invalid existing content path" });
        return;
      }

      if (newCategoriesArr.length === 0) {
        res.status(400).json({ res: false, message: "categories cannot be empty when moving file" });
        return;
      }

      const newDirPath = safeBuildDocsPath(newCategoriesArr);
      if (!newDirPath) {
        res.status(400).json({ res: false, message: "invalid new categories path" });
        return;
      }

      const fileName = safeFileName(title);
      if (!fileName) {
        res.status(400).json({ res: false, message: "invalid title for file name" });
        return;
      }

      const newAbsPath = path.join(newDirPath, `${fileName}.md`);
      if (!newAbsPath.startsWith(docsDir + path.sep)) {
        res.status(400).json({ res: false, message: "invalid target file path" });
        return;
      }

      if (oldAbsPath !== newAbsPath) {
        fs.mkdirSync(newDirPath, { recursive: true });
        if (fs.existsSync(oldAbsPath)) {
          fs.renameSync(oldAbsPath, newAbsPath);
          cleanEmptyDirs(path.dirname(oldAbsPath));
        } else {
          fs.writeFileSync(newAbsPath, rawContent ?? "", "utf-8");
        }
      }

      content = "/" + path.relative(docsDir, newAbsPath).replace(/\\/g, "/");

      // 如果同时有新内容，写入移动后的文件
      if (hasNewContent && rawContent !== null && fs.existsSync(newAbsPath)) {
        fs.writeFileSync(newAbsPath, rawContent, "utf-8");
      }
    } else if (hasNewContent && rawContent !== null && hasValidMdPath) {
      // title 和 categories 均未变化，仅写入文件内容
      const contentVal = existing.content.trim();
      const absPath = path.resolve(docsDir, contentVal.slice(1));
      if (!absPath.startsWith(docsDir + path.sep)) {
        res.status(400).json({ res: false, message: "invalid content path" });
        return;
      }
      if (!fs.existsSync(absPath)) {
        res.status(404).json({ res: false, message: "md file not found on disk" });
        return;
      }
      fs.writeFileSync(absPath, rawContent, "utf-8");
    }

    updateBlogStmt.run(title, now, tags, categories, excerpt, content, cover, comment, id);
    const updated = getBlogByIdStmt.get(id) as BlogPost | undefined;
    res.json({
      res: true,
      blog: updated ? parseBlogRow(updated) : null,
    });
  },
);

/** 递归向上清理空目录（不超出 docsDir） */
const cleanEmptyDirs = (dir: string): void => {
  let current = path.resolve(dir);
  while (current.startsWith(docsDir + path.sep) && current !== docsDir) {
    const entries = fs.readdirSync(current);
    if (entries.length > 0) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
};

/** 删除文件并递归清理空父目录（不超出 docsDir） */
const removeFileAndCleanDirs = (filePath: string): void => {
  const resolved = path.resolve(filePath);
  // 安全检查：必须在 docsDir 内
  if (!resolved.startsWith(docsDir + path.sep) && resolved !== docsDir) return;

  // 删除文件
  if (fs.existsSync(resolved)) {
    fs.unlinkSync(resolved);
  }

  // 递归向上清理空目录
  let dir = path.dirname(resolved);
  while (dir.startsWith(docsDir + path.sep) && dir !== docsDir) {
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) break; // 非空目录，停止
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
};

const formatDateTime = (date: Date | string | number): string => {
  const d = new Date(date);

  const pad = (n: number) => n.toString().padStart(2, "0");

  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());

  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

// 删除博客: DELETE /gitstatus/api/blogs/:id
// 需要登录，读写及以上角色可操作
app.delete<IdParams, DeleteBlogResponse | ErrorResponse>(
  `${apiPrefix}/blogs/:id`,
  authMiddleware,
  requireMinRole("readwrite"),
  (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ res: false, message: "invalid id" });
      return;
    }
    const existing = getBlogByIdStmt.get(id) as BlogPost | undefined;
    if (!existing) {
      res.status(404).json({ res: false, message: "blog not found" });
      return;
    }

    // 删除对应的 md 文件及空目录
    const contentVal = existing.content.trim();
    if (contentVal.startsWith("/") && contentVal.endsWith(".md")) {
      const absPath = path.resolve(docsDir, contentVal.slice(1)); // 去掉开头的 /
      if (absPath.startsWith(docsDir + path.sep)) {
        try {
          removeFileAndCleanDirs(absPath);
        } catch (err) {
          logWarn(`[blog] failed to remove file: ${absPath} | ${String(err)}`);
        }
      }
    }

    deleteBlogStmt.run(id);
    res.json({ res: true, message: "deleted" });
  },
);

/** 递归扫描目录下所有 .md 文件，返回绝对路径数组 */
const scanMdFiles = (dir: string): string[] => {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanMdFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
};

/** 刷新博客: POST /gitstatus/api/blogs/refresh */
type RefreshBlogResponse = {
  res: true;
  added: number;
  removed: number;
  addedFiles: string[];
  removedFiles: string[];
};

app.post<Record<string, string>, RefreshBlogResponse | ErrorResponse>(
  `${apiPrefix}/blogs/refresh`,
  authMiddleware,
  requireMinRole("readwrite"),
  (req, res) => {
    try {
      const mdFiles = scanMdFiles(docsDir);

      // 文件系统中实际存在的相对路径集合
      const diskPaths = new Set<string>();
      for (const absPath of mdFiles) {
        if (!absPath.startsWith(docsDir + path.sep)) continue;
        diskPaths.add("/" + path.relative(docsDir, absPath).replace(/\\/g, "/"));
      }

      // 数据库中所有博客记录
      const dbRows = db.prepare("SELECT id, content FROM blog_posts").all() as { id: number; content: string }[];
      const dbPaths = new Map<string, number>(); // relPath -> id
      for (const row of dbRows) {
        const p = row.content.trim();
        if (p.startsWith("/") && p.endsWith(".md")) {
          dbPaths.set(p, row.id);
        }
      }

      const now = formatDateTime(new Date());
      const addedFiles: string[] = [];
      const removedFiles: string[] = [];

      // 1. 新增：文件存在但数据库中没有
      for (const relPath of diskPaths) {
        if (dbPaths.has(relPath)) continue;

        const absPath = path.resolve(docsDir, relPath.slice(1));
        const title = path.basename(absPath, ".md");
        if (!title) continue;

        const relDir = path.relative(docsDir, path.dirname(absPath));
        const categories = relDir ? relDir.split(path.sep).filter(Boolean) : [];

        insertBlogStmt.run(
          title, now, now,
          "[]",
          JSON.stringify(categories),
          "",
          relPath,
          "",
          "[]",
        );
        addedFiles.push(relPath);
      }

      // 2. 删除：数据库中有但文件已不存在
      for (const [relPath, id] of dbPaths) {
        if (diskPaths.has(relPath)) continue;
        deleteBlogStmt.run(id);
        removedFiles.push(relPath);
      }

      res.json({
        res: true,
        added: addedFiles.length,
        removed: removedFiles.length,
        addedFiles,
        removedFiles,
      });
    } catch (error: any) {
      res.status(500).json({ res: false, message: error?.message || "refresh blogs failed" });
    }
  },
);

registerTodoFeature(app, {
  db,
  apiPrefix,
  authMiddleware,
  requireWrite: requireMinRole("readwrite"),
  logInfo,
  logWarn,
  logError,
});

registerProjectFeature(app, {
  db,
  apiPrefix,
  authMiddleware,
  requireWrite: requireMinRole("readwrite"),
  logInfo,
  logWarn,
  logError,
});

const server = app.listen(port, () => {
  logInfo(`server running: http://localhost:${port}`);
});
server.on("error", (err: NodeJS.ErrnoException) => {
  logError(`[server] listen failed on port ${port}: ${err.code || ""} ${err.message}`, err);
  process.exit(1);
});
