/**
 * 内置 AI 助手。
 *
 * 与 MCP 服务共用同一份工具定义（src/mcp/tools），走 OpenAI 兼容的
 * /chat/completions 协议跑工具调用循环，SSE 把结果推给页面。
 *
 * 设计要点：
 * - LLM 的 key 只存在后端，前端永远接触不到
 * - 工具执行仍走本机 HTTP 接口，鉴权用发起对话的用户 token，权限与页面完全一致
 * - 会话与消息落 SQLite，刷新不丢；中断时保留已生成内容
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import express from "express";
import multer from "multer";
import type Database from "better-sqlite3";
import { createApiClient } from "./mcp/api-client.js";
import {
  ToolRegistry,
  type ChatAttachmentBridge,
  type ToolContext,
  type UserRole,
} from "./mcp/define-tool.js";
import { allTools } from "./mcp/tools/index.js";
import { formatLocalDateTime, weekdayOf } from "./mcp/tools/time.js";
import { createLlmStore, type LlmConfig } from "./chat-llm.js";
import {
  BLOCKED_FILE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  attachmentKindOf,
  decodeUploadFileName,
  safeFileExtension,
  sanitizeUploadFileName,
} from "./todo.js";

type ChatFeatureOptions = {
  db: Database.Database;
  apiPrefix: string;
  authMiddleware: express.RequestHandler;
  configPath: string;
  serverPort: number;
  logInfo: (message: string) => void;
  logError: (message: string, error?: unknown) => void;
};

/** LLM 连接配置由 chat-llm 解析（页面保存 > 环境变量 > config.json） */

type ChatSessionRow = {
  id: string;
  user_id: number;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
};

type ChatMessageRow = {
  id: number;
  session_id: string;
  role: string;
  content: string;
  payload: string;
  created_at: string;
};

/** 一次工具调用在消息里留下的痕迹 */
type StoredToolCall = {
  id: string;
  name: string;
  title: string;
  arguments: string;
  content: string;
  isError: boolean;
};

type MessagePayload = {
  toolCalls?: StoredToolCall[];
  interrupted?: boolean;
  usage?: { prompt: number; completion: number } | null;
  /** 用户消息携带的附件快照，模型与页面都靠它拿到编号 */
  attachments?: ChatAttachmentRef[];
};

/** 对话附件：上传后先暂存，绑定到待办后打上标记 */
type ChatAttachmentRow = {
  id: number;
  user_id: number;
  session_id: string | null;
  kind: "image" | "file";
  original_name: string;
  stored_name: string;
  mime_type: string;
  size: number;
  bound_todo_id: number | null;
  bound_attachment_id: number | null;
  created_at: string;
};

/** 消息里保存的附件快照，只留页面展示与模型引用需要的字段 */
type ChatAttachmentRef = {
  id: number;
  name: string;
  size: number;
  kind: string;
};

/** 回填给模型的单个工具结果上限，避免日志类工具把上下文撑爆 */
const TOOL_CONTENT_LIMIT = 8000;
/** SSE 心跳间隔，防止长时间工具执行被中间层判为死连接 */
const SSE_PING_MS = 15_000;
/** 对话附件暂存目录：绑定到待办时由 todo 模块复制到自己的存储目录 */
const CHAT_UPLOAD_DIR = path.resolve("./src/output/chat-uploads");
const CHAT_ATTACH_MAX_FILES = 5;
const CHAT_ATTACH_MAX_BYTES = 32 * 1024 * 1024;
/** 未绑定的暂存附件保留天数，过期连文件一起清理 */
const CHAT_ATTACH_TTL_SQL = "-7 days";

const formatFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const SYSTEM_PROMPT = [
  "你是 GitStatus 工作区的助手，可以调用工具读写当前账号的待办、分类、标签、共享关系，以及查看项目与运行日志。",
  "规则：",
  "1. 需要事实时先调用工具，不要凭记忆或猜测回答。",
  "2. 修改或删除之前，先用查询工具确认目标（id 与标题），再执行；批量操作前说明影响范围。",
  "3. 只能访问当前账号有权限的数据。工具返回权限或不存在错误时如实告知，不要换一种说法重试。",
  "4. 回答用中文，简洁直接；涉及多条数据时用列表，不要复述工具的原始输出。",
  "5. 涉及「几小时后」「今天还剩多久」这类相对时间时，先调用 gitstatus_now 拿当前时刻，不要用登录时间或创建时间推算。",
  "6. 你没有启动/停止项目、执行命令的权限，被问到这类请求时说明需要人工在项目管理页操作。",
  "7. 用户消息带 [本条消息附带的文件] 清单时，如果要把这些文件一起存进待办，把对应编号填进 gitstatus_todo_create 或 gitstatus_todo_update 的 attachmentIds；不要编造编号，也不要把文件内容写进描述。",
].join("\n");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 截断过长的工具输出，保留首尾便于模型理解 */
const clampToolContent = (text: string): string => {
  if (text.length <= TOOL_CONTENT_LIMIT) return text;
  const head = text.slice(0, TOOL_CONTENT_LIMIT - 500);
  const tail = text.slice(-400);
  return `${head}\n…[已截断 ${text.length - TOOL_CONTENT_LIMIT} 字]\n${tail}`;
};

/** 配置解析与凭据存储已移到 chat-llm.ts，这里只负责调用 */

export const registerChatFeature = (
  app: express.Express,
  options: ChatFeatureOptions,
): void => {
  const { db, apiPrefix, authMiddleware, configPath, serverPort, logInfo, logError } = options;

  // 凭据独立存放：config.json 被 git 跟踪，把密钥写进去迟早会进仓库
  const llmStore = createLlmStore({
    configPath,
    storePath: path.resolve("./src/output/llm-credentials.json"),
    logWarn: (message) => logError(message),
  });

  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '新对话',
      model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user
    ON chat_sessions(user_id, updated_at DESC)
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session
    ON chat_messages(session_id, id)
  `);

  // 对话附件：先落在暂存目录，模型把编号写进工具参数后由宿主绑到待办
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_id TEXT,
      kind TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('image','file')),
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      bound_todo_id INTEGER,
      bound_attachment_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_attachments_session
    ON chat_attachments(session_id, id)
  `);

  const listSessionsStmt = db.prepare(
    "SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 100",
  );
  const getSessionStmt = db.prepare(
    "SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?",
  );
  const insertSessionStmt = db.prepare(
    "INSERT INTO chat_sessions (id, user_id, title, model) VALUES (?, ?, ?, ?)",
  );
  const renameSessionStmt = db.prepare(
    "UPDATE chat_sessions SET title = ?, updated_at = datetime('now','localtime') WHERE id = ? AND user_id = ?",
  );
  const touchSessionStmt = db.prepare(
    "UPDATE chat_sessions SET updated_at = datetime('now','localtime') WHERE id = ?",
  );
  const deleteSessionStmt = db.prepare(
    "DELETE FROM chat_sessions WHERE id = ? AND user_id = ?",
  );
  const listMessagesStmt = db.prepare(
    "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC",
  );
  const insertMessageStmt = db.prepare(
    "INSERT INTO chat_messages (session_id, role, content, payload) VALUES (?, ?, ?, ?)",
  );
  const countUserMessagesStmt = db.prepare(
    "SELECT COUNT(*) as count FROM chat_messages WHERE session_id = ? AND role = 'user'",
  );

  const insertChatAttachmentStmt = db.prepare(
    `INSERT INTO chat_attachments
     (user_id, session_id, kind, original_name, stored_name, mime_type, size)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const getChatAttachmentStmt = db.prepare(
    "SELECT * FROM chat_attachments WHERE id = ? AND user_id = ?",
  );
  const claimChatAttachmentStmt = db.prepare(
    "UPDATE chat_attachments SET session_id = ? WHERE id = ? AND user_id = ? AND bound_todo_id IS NULL",
  );
  const markChatAttachmentBoundStmt = db.prepare(
    "UPDATE chat_attachments SET bound_todo_id = ?, bound_attachment_id = ? WHERE id = ? AND user_id = ?",
  );
  const deleteChatAttachmentStmt = db.prepare(
    "DELETE FROM chat_attachments WHERE id = ? AND user_id = ?",
  );
  const listSessionAttachmentsStmt = db.prepare(
    "SELECT * FROM chat_attachments WHERE session_id = ? AND user_id = ?",
  );
  const listPendingAttachmentsStmt = db.prepare(
    `SELECT * FROM chat_attachments
     WHERE session_id = ? AND user_id = ? AND bound_todo_id IS NULL ORDER BY id ASC`,
  );
  const listStaleAttachmentsStmt = db.prepare(
    `SELECT * FROM chat_attachments
     WHERE bound_todo_id IS NULL AND created_at < datetime('now','localtime', ?)`,
  );

  /** 删除暂存目录里的物理文件；已绑定或已清理时忽略 */
  const removeAttachmentFile = (row: ChatAttachmentRow): void => {
    try {
      fs.unlinkSync(path.join(CHAT_UPLOAD_DIR, String(row.user_id), row.stored_name));
    } catch {
      /* 文件不存在或暂时被占用，留给下次清理 */
    }
  };

  /** 启动时清一次过期的未绑定暂存附件，避免目录无限增长 */
  const cleanupStaleAttachments = (): void => {
    const rows = listStaleAttachmentsStmt.all(CHAT_ATTACH_TTL_SQL) as ChatAttachmentRow[];
    for (const row of rows) {
      removeAttachmentFile(row);
      deleteChatAttachmentStmt.run(row.id, row.user_id);
    }
    if (rows.length > 0) logInfo(`[chat] cleaned ${rows.length} stale attachment(s)`);
  };
  cleanupStaleAttachments();

  // 工具定义与 MCP 服务共用，按角色过滤后再交给模型
  const registry = new ToolRegistry();
  registry.add(...allTools);

  const buildOpenAiTools = (role: UserRole) =>
    registry.visible(role).map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

  /** 消息 payload 解析；格式异常时退化成空对象 */
  const parseMessagePayload = (raw: string): MessagePayload => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isRecord(parsed) ? (parsed as MessagePayload) : {};
    } catch {
      return {};
    }
  };

  /**
   * 把附件清单拼进用户消息。
   * 模型看不到文件内容，唯一能引用附件的方式就是文本里这个编号，
   * 所以每条带附件的消息都要在上下文里保留一段清单。
   */
  const renderUserContent = (content: string, attachments: ChatAttachmentRef[]): string => {
    if (attachments.length === 0) return content;
    const lines = attachments.map(
      (item) => `- #${item.id} ${item.name}（${formatFileSize(Number(item.size) || 0)}）`,
    );
    return [
      content,
      "",
      "[本条消息附带的文件。需要随待办一起保存时，把编号填进 attachmentIds]\n",
      ...lines,
    ].join("\n");
  };

  /** 用已落库的消息重建 OpenAI 上下文 */
  const buildMessages = (sessionId: string): Array<Record<string, unknown>> => {
    // 模型自己没有时钟：system 里直接给一份当前时刻，省掉一次工具往返；
    // 每次发消息都会重建，所以时间始终是本次请求的
    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
    const timeLine = `当前服务器时间：${formatLocalDateTime(now)}（${weekdayOf(now)}），时区 ${timeZone}。`;
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n${timeLine}` },
    ];
    const rows = listMessagesStmt.all(sessionId) as ChatMessageRow[];

    for (const row of rows) {
      if (row.role === "user") {
        const payload = parseMessagePayload(row.payload);
        const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
        messages.push({ role: "user", content: renderUserContent(row.content, attachments) });
        continue;
      }
      if (row.role !== "assistant") continue;

      let payload: MessagePayload = {};
      try {
        const parsed = JSON.parse(row.payload) as unknown;
        if (isRecord(parsed)) payload = parsed as MessagePayload;
      } catch {
        payload = {};
      }
      const toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];

      messages.push({
        role: "assistant",
        content: row.content || null,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments || "{}" },
              })),
            }
          : {}),
      });

      // 中断的调用没有结果，补一条占位，否则上下文不成立
      for (const call of toolCalls) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: clampToolContent(call.content || "[本次调用被中断，没有结果]"),
        });
      }
    }

    return messages;
  };

  type LlmToolCall = { id: string; name: string; arguments: string };

  type LlmStreamResult = {
    content: string;
    toolCalls: LlmToolCall[];
    finishReason: string;
    usage: { prompt: number; completion: number } | null;
  };

  /** 调一次 LLM，按 SSE 增量回调文本；返回完整内容与工具调用 */
  const callLlm = async (
    config: LlmConfig,
    messages: Array<Record<string, unknown>>,
    tools: unknown[],
    onDelta: (text: string) => void,
    signal: AbortSignal,
  ): Promise<LlmStreamResult> => {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
        temperature: config.temperature,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`LLM 请求失败（HTTP ${response.status}）：${text.slice(0, 400)}`);
    }
    if (!response.body) throw new Error("LLM 没有返回流式响应体");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const slots: LlmToolCall[] = [];
    let buffer = "";
    let content = "";
    let finishReason = "";
    let usage: LlmStreamResult["usage"] = null;

    const handleLine = (line: string): boolean => {
      if (!line.startsWith("data:")) return false;
      const payload = line.slice(5).trim();
      if (!payload) return false;
      if (payload === "[DONE]") return true;

      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return false;
      }
      if (!isRecord(chunk)) return false;

      if (isRecord(chunk.usage)) {
        usage = {
          prompt: Number(chunk.usage.prompt_tokens) || 0,
          completion: Number(chunk.usage.completion_tokens) || 0,
        };
      }

      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : null;
      if (!choice) return false;
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        onDelta(delta.content);
      }

      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const raw of toolCalls) {
        if (!isRecord(raw)) continue;
        const index = Number(raw.index) || 0;
        const slot = (slots[index] ??= { id: "", name: "", arguments: "" });
        if (typeof raw.id === "string" && raw.id) slot.id = raw.id;
        const fn = isRecord(raw.function) ? raw.function : {};
        // 名称只在首个分片出现，赋值即可；参数是分片累积
        if (typeof fn.name === "string" && fn.name && !slot.name) slot.name = fn.name;
        if (typeof fn.arguments === "string" && fn.arguments) slot.arguments += fn.arguments;
      }
      return false;
    };

    let done = false;
    while (!done) {
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (handleLine(line)) {
          done = true;
          break;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) handleLine(buffer.trim());
    // 流已结束，显式释放底层连接
    await reader.cancel().catch(() => undefined);

    return {
      content,
      toolCalls: slots.filter((slot) => slot.name),
      finishReason,
      usage,
    };
  };

  const chatRouter = express.Router();
  chatRouter.use(authMiddleware);

  const chatUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: CHAT_ATTACH_MAX_BYTES, files: CHAT_ATTACH_MAX_FILES },
  });

  /**
   * 上传对话附件。
   * 只落到暂存区并返回编号，此时还不属于任何待办；
   * 真正绑定发生在模型调用 gitstatus_todo_create/update 时。
   */
  chatRouter.post("/attachments", (req, res) => {
    chatUpload.array("files", CHAT_ATTACH_MAX_FILES)(req, res, (error: unknown) => {
      if (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(400).json({ res: false, message });
        return;
      }
      try {
        const user = (req as express.Request & { user?: { userId: number } }).user;
        const userId = user?.userId ?? 0;
        if (!userId) {
          res.status(401).json({ res: false, message: "请先登录" });
          return;
        }
        const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
        if (files.length === 0) {
          res.status(400).json({ res: false, message: "至少需要一个文件" });
          return;
        }
        const sessionIdRaw = String((req.body as { sessionId?: unknown })?.sessionId ?? "").trim();
        if (sessionIdRaw && !getSessionStmt.get(sessionIdRaw, userId)) {
          res.status(404).json({ res: false, message: "session not found" });
          return;
        }

        // 先整体校验再落盘，避免部分文件写进去后才发现超限
        const prepared = files.map((file) => {
          const name =
            sanitizeUploadFileName(decodeUploadFileName(file.originalname || "")) || "attachment";
          const mime = String(file.mimetype || "").toLowerCase();
          if (BLOCKED_FILE_EXTENSIONS.has(path.extname(name).toLowerCase())) {
            throw new Error(`不支持的文件类型：${name}`);
          }
          if (mime.startsWith("image/") && file.size > MAX_IMAGE_BYTES) {
            throw new Error(`图片 ${name} 超过 8 MB`);
          }
          return { file, name, mime };
        });

        const userDir = path.join(CHAT_UPLOAD_DIR, String(userId));
        fs.mkdirSync(userDir, { recursive: true });

        const attachments: ChatAttachmentRef[] = [];
        for (const item of prepared) {
          const kind = attachmentKindOf(item.mime);
          const storedName = `${crypto.randomUUID()}${safeFileExtension(item.name, item.mime)}`;
          fs.writeFileSync(path.join(userDir, storedName), item.file.buffer);
          const info = insertChatAttachmentStmt.run(
            userId,
            sessionIdRaw || null,
            kind,
            item.name,
            storedName,
            item.mime,
            item.file.size,
          );
          attachments.push({
            id: Number(info.lastInsertRowid),
            name: item.name,
            size: item.file.size,
            kind,
          });
        }

        res.status(201).json({ res: true, attachments });
      } catch (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
        res.status(400).json({ res: false, message });
      }
    });
  });

  /** 删除尚未绑定到待办的对话附件 */
  chatRouter.delete("/attachments/:id", (req, res) => {
    const user = (req as express.Request & { user?: { userId: number } }).user;
    const userId = user?.userId ?? 0;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ res: false, message: "invalid attachment id" });
      return;
    }
    const row = getChatAttachmentStmt.get(id, userId) as ChatAttachmentRow | undefined;
    if (!row) {
      res.status(404).json({ res: false, message: "attachment not found" });
      return;
    }
    if (row.bound_todo_id !== null) {
      res.status(409).json({ res: false, message: "附件已绑定到待办，请到待办页面删除" });
      return;
    }
    removeAttachmentFile(row);
    deleteChatAttachmentStmt.run(id, userId);
    res.json({ res: true, message: "deleted" });
  });

  /** 当前用户在这次请求里用来调自己后端接口的凭据 */
  const tokenOf = (req: express.Request): string => {
    const header = String(req.headers.authorization || "");
    return header.startsWith("Bearer ") ? header.slice(7) : "";
  };

  /** ASGI 风格：把一条 SSE 事件写出去 */
  const makeSender = (res: express.Response) => {
    let closed = false;
    res.on("close", () => {
      closed = true;
    });
    return (event: string, data: unknown): void => {
      if (closed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
  };

  /** 模型配置是全局资源，只有管理员能改 */
  const requireAdmin = (req: express.Request, res: express.Response): boolean => {
    const user = (req as express.Request & { user?: { role: UserRole } }).user;
    if (user?.role !== "admin") {
      res.status(403).json({ res: false, message: "只有管理员可以修改模型配置" });
      return false;
    }
    return true;
  };

  /** 读模型配置：只给掩码与来源，不返回密钥明文 */
  chatRouter.get("/llm", (_req, res) => {
    res.json({ res: true, llm: llmStore.describe() });
  });

  /** 保存模型配置；apiKey 留空表示沿用已保存的密钥 */
  chatRouter.put("/llm", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const status = llmStore.save({
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
        model: typeof body.model === "string" ? body.model : "",
        apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
        temperature: typeof body.temperature === "number" ? body.temperature : undefined,
        maxToolRounds: typeof body.maxToolRounds === "number" ? body.maxToolRounds : undefined,
      });
      logInfo(`[chat] 模型配置已更新：source=${status.source} model=${status.model}`);
      res.json({ res: true, llm: status });
    } catch (error) {
      res.status(400).json({
        res: false,
        message: error instanceof Error ? error.message : "保存失败",
      });
    }
  });

  /** 清除保存的配置，回退到环境变量 / config.json */
  chatRouter.delete("/llm", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const status = llmStore.clear();
    logInfo(`[chat] 模型配置已清除，当前来源 ${status.source}`);
    res.json({ res: true, llm: status });
  });

  /** 测试连接：可以传还没保存的表单值，便于先测再存 */
  chatRouter.post("/llm/test", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await llmStore.test({
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
    });
    res.json({ res: true, ...result });
  });

  /** 助手能力与配置概况，前端据此决定是否禁用输入框 */
  chatRouter.get("/config", (req, res) => {
    const user = (req as express.Request & { user?: { role: UserRole } }).user;
    const role: UserRole = user?.role ?? "readonly";
    const config = llmStore.resolve();
    const visible = registry.visible(role);
    res.json({
      res: true,
      configured: config !== null,
      model: config?.model ?? "",
      tools: {
        total: registry.size,
        visible: visible.length,
        writable: visible.filter((tool) => !tool.readOnly).length,
      },
    });
  });

  chatRouter.get("/sessions", (req, res) => {
    const user = (req as express.Request & { user?: { userId: number } }).user;
    const rows = listSessionsStmt.all(user?.userId ?? 0) as ChatSessionRow[];
    res.json({
      res: true,
      sessions: rows.map((row) => ({
        id: row.id,
        title: row.title,
        model: row.model,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  });

  chatRouter.post("/sessions", (req, res) => {
    const user = (req as express.Request & { user?: { userId: number } }).user;
    const config = llmStore.resolve();
    const id = crypto.randomUUID();
    insertSessionStmt.run(id, user?.userId ?? 0, "新对话", config?.model ?? "");
    const row = getSessionStmt.get(id, user?.userId ?? 0) as ChatSessionRow;
    res.status(201).json({
      res: true,
      session: {
        id: row.id,
        title: row.title,
        model: row.model,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  });

  chatRouter.patch("/sessions/:id", (req, res) => {
    const user = (req as express.Request & { user?: { userId: number } }).user;
    const title = String((req.body as { title?: unknown })?.title ?? "").trim();
    if (!title) {
      res.status(400).json({ res: false, message: "title is required" });
      return;
    }
    if (title.length > 60) {
      res.status(400).json({ res: false, message: "title must be at most 60 characters" });
      return;
    }
    const info = renameSessionStmt.run(title, String(req.params.id), user?.userId ?? 0);
    if (info.changes === 0) {
      res.status(404).json({ res: false, message: "session not found" });
      return;
    }
    res.json({ res: true, message: "renamed" });
  });

  chatRouter.delete("/sessions/:id", (req, res) => {
    const user = (req as express.Request & { user?: { userId: number } }).user;
    const userId = user?.userId ?? 0;
    const sessionId = String(req.params.id);
    const session = getSessionStmt.get(sessionId, userId) as ChatSessionRow | undefined;
    if (!session) {
      res.status(404).json({ res: false, message: "session not found" });
      return;
    }
    // 未绑定的暂存文件随会话删除；已绑定的副本在待办目录里，不受影响
    const rows = listSessionAttachmentsStmt.all(sessionId, userId) as ChatAttachmentRow[];
    for (const row of rows) {
      if (row.bound_todo_id === null) removeAttachmentFile(row);
      deleteChatAttachmentStmt.run(row.id, userId);
    }
    deleteSessionStmt.run(sessionId, userId);
    res.json({ res: true, message: "deleted" });
  });

  chatRouter.get("/sessions/:id/messages", (req, res) => {
    const user = (req as express.Request & { user?: { userId: number } }).user;
    const session = getSessionStmt.get(String(req.params.id), user?.userId ?? 0) as
      | ChatSessionRow
      | undefined;
    if (!session) {
      res.status(404).json({ res: false, message: "session not found" });
      return;
    }
    const rows = listMessagesStmt.all(session.id) as ChatMessageRow[];
    res.json({
      res: true,
      session: { id: session.id, title: session.title, model: session.model },
      messages: rows.map((row) => {
        const payload = parseMessagePayload(row.payload);
        return {
          id: row.id,
          role: row.role,
          content: row.content,
          toolCalls: payload.toolCalls ?? [],
          interrupted: payload.interrupted ?? false,
          // 用户消息的附件快照，用于刷新后仍然展示原文件名与大小
          attachments: payload.attachments ?? [],
          createdAt: row.created_at,
        };
      }),
    });
  });

  /** 发一条用户消息并跑完整轮次，SSE 推送 */
  chatRouter.post("/sessions/:id/messages", async (req, res) => {
    const user = (req as express.Request & { user?: { userId: number; role: UserRole } }).user;
    const userId = user?.userId ?? 0;
    const role: UserRole = user?.role ?? "readonly";
    const sessionId = String(req.params.id);
    const body = (req.body ?? {}) as { content?: unknown; attachmentIds?: unknown };
    const content = String(body.content ?? "").trim();
    const requestedIds = Array.isArray(body.attachmentIds)
      ? [...new Set(body.attachmentIds.map((item) => Number(item)))]
          .filter((id) => Number.isInteger(id) && id > 0)
      : [];

    // 允许只发附件不发文字：拖完文件直接回车也能提交
    if (!content && requestedIds.length === 0) {
      res.status(400).json({ res: false, message: "content is required" });
      return;
    }
    if (content.length > 8000) {
      res.status(400).json({ res: false, message: "content must be at most 8000 characters" });
      return;
    }
    const session = getSessionStmt.get(sessionId, userId) as ChatSessionRow | undefined;
    if (!session) {
      res.status(404).json({ res: false, message: "session not found" });
      return;
    }

    // 附件必须是本人的、未绑定的；绑定过的不能再重复使用
    const attachmentRows: ChatAttachmentRow[] = [];
    for (const id of requestedIds) {
      const row = getChatAttachmentStmt.get(id, userId) as ChatAttachmentRow | undefined;
      if (!row || row.bound_todo_id !== null) {
        res.status(400).json({ res: false, message: `附件 #${id} 不可用或已经绑定到待办` });
        return;
      }
      attachmentRows.push(row);
    }
    const attachmentRefs: ChatAttachmentRef[] = attachmentRows.map((row) => ({
      id: row.id,
      name: row.original_name,
      size: row.size,
      kind: row.kind,
    }));

    const config = llmStore.resolve();
    if (!config) {
      res.status(400).json({
        res: false,
        message: "尚未配置 LLM，请在 config/config.json 的 llm 段填写 baseUrl、apiKey、model",
      });
      return;
    }

    // 先落用户消息：即使后面中断，也能看到自己发了什么
    const storedContent =
      content || `（附件：${attachmentRefs.map((item) => item.name).join("、")}）`;
    for (const row of attachmentRows) claimChatAttachmentStmt.run(sessionId, row.id, userId);
    insertMessageStmt.run(
      sessionId,
      "user",
      storedContent,
      JSON.stringify({ attachments: attachmentRefs } satisfies MessagePayload),
    );
    const isFirstMessage = (countUserMessagesStmt.get(sessionId) as { count: number }).count <= 1;
    if (isFirstMessage) {
      const title = (content || attachmentRefs[0]?.name || "新对话")
        .slice(0, 24)
        .replace(/\s+/g, " ");
      renameSessionStmt.run(title, sessionId, userId);
    }
    touchSessionStmt.run(sessionId);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 关掉 Nginx 之类中间层的缓冲，否则流式会被攒成一次性返回
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const send = makeSender(res);
    const controller = new AbortController();
    let finished = false;
    // 必须监听响应而不是 req：req 的 close 在请求体读完就会触发，会把正常请求误判成断开
    res.on("close", () => {
      if (!finished) controller.abort();
    });
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, SSE_PING_MS);

    const api = createApiClient({
      baseUrl: `http://127.0.0.1:${serverPort}`,
      // 复用发起者的 token：工具执行与页面点击的权限完全一致
      apiKey: tokenOf(req),
      timeoutMs: 30_000,
    });

    // 本会话还没绑到待办的附件，模型只能引用这些编号
    const pendingRows = listPendingAttachmentsStmt.all(sessionId, userId) as ChatAttachmentRow[];
    const attachmentBridge: ChatAttachmentBridge = {
      availableIds: pendingRows.map((row) => row.id),
      async bind(todoId, ids) {
        const results: Array<{ id: number; name: string; ok: boolean; message: string }> = [];
        for (const id of ids) {
          const row = getChatAttachmentStmt.get(id, userId) as ChatAttachmentRow | undefined;
          if (!row) {
            results.push({ id, name: `#${id}`, ok: false, message: "附件不存在" });
            continue;
          }
          if (row.bound_todo_id !== null) {
            results.push({
              id,
              name: row.original_name,
              ok: false,
              message: "该附件已经绑定到其他待办",
            });
            continue;
          }
          if (row.session_id !== sessionId) {
            results.push({
              id,
              name: row.original_name,
              ok: false,
              message: "该附件不属于当前会话",
            });
            continue;
          }

          // 走 todo 自己的附件接口：限额、kind 判定、文件落盘都由那一侧负责，
          // 这里只把暂存文件重新包成 multipart
          try {
            const buffer = fs.readFileSync(
              path.join(CHAT_UPLOAD_DIR, String(userId), row.stored_name),
            );
            const form = new FormData();
            form.append(
              "files",
              new Blob([buffer], { type: row.mime_type || "application/octet-stream" }),
              row.original_name,
            );
            const payload = await api.postForm(`/todos/${todoId}/attachments`, form);
            const created = isRecord(payload) ? payload.attachments : null;
            const first = Array.isArray(created) ? created[0] : null;
            const attachmentId = isRecord(first) ? Number(first.id) : NaN;
            markChatAttachmentBoundStmt.run(
              todoId,
              Number.isFinite(attachmentId) ? attachmentId : null,
              id,
              userId,
            );
            // 待办目录已有副本，暂存文件不再需要
            removeAttachmentFile(row);
            results.push({
              id,
              name: row.original_name,
              ok: true,
              message: `已加入待办 #${todoId}`,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({ id, name: row.original_name, ok: false, message });
          }
        }
        return results;
      },
    };

    const toolContext: ToolContext = { api, role, attachments: attachmentBridge };
    const tools = buildOpenAiTools(role);
    const messages = buildMessages(sessionId);

    const storedCalls: StoredToolCall[] = [];
    let answer = "";
    let usage: LlmStreamResult["usage"] = null;
    let interrupted = false;

    try {
      for (let round = 0; round < config.maxToolRounds; round += 1) {
        const result = await callLlm(
          config,
          messages,
          tools,
          (text) => send("delta", { text }),
          AbortSignal.any([controller.signal, AbortSignal.timeout(config.timeoutMs)]),
        );
        answer += result.content;
        if (result.usage) usage = result.usage;

        if (result.toolCalls.length === 0) break;

        // 模型要求调用工具：先把它这轮的发言与调用意图写进上下文
        messages.push({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments || "{}" },
          })),
        });

        for (const call of result.toolCalls) {
          const tool = registry.get(call.name);
          const toolTitle = tool?.title ?? call.name;
          send("tool_call", {
            id: call.id,
            name: call.name,
            title: toolTitle,
            arguments: call.arguments,
          });

          let toolContent = "";
          let isError = false;
          try {
            if (!tool) throw new Error(`未知工具：${call.name}`);
            let args: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(call.arguments || "{}") as unknown;
              if (isRecord(parsed)) args = parsed;
            } catch {
              throw new Error("工具参数不是合法 JSON");
            }
            const outcome = await tool.run(toolContext, args);
            toolContent = clampToolContent(outcome.text);
          } catch (error) {
            isError = true;
            toolContent = error instanceof Error ? error.message : String(error);
          }

          storedCalls.push({
            id: call.id,
            name: call.name,
            title: toolTitle,
            arguments: call.arguments,
            content: toolContent,
            isError,
          });
          send("tool_result", {
            id: call.id,
            name: call.name,
            title: toolTitle,
            content: toolContent,
            isError,
          });
          messages.push({ role: "tool", tool_call_id: call.id, content: toolContent });
        }
      }

      if (controller.signal.aborted) interrupted = true;

      const messageId = insertMessageStmt.run(
        sessionId,
        "assistant",
        answer,
        JSON.stringify({ toolCalls: storedCalls, interrupted, usage } satisfies MessagePayload),
      ).lastInsertRowid;
      touchSessionStmt.run(sessionId);
      send("done", {
        id: Number(messageId),
        content: answer,
        toolCalls: storedCalls.map((call) => ({
          id: call.id,
          name: call.name,
          title: call.title,
          arguments: call.arguments,
          content: call.content,
          isError: call.isError,
        })),
        interrupted,
        usage,
      });
      logInfo(`[chat] session ${sessionId} answered (tools=${storedCalls.length}, interrupted=${interrupted})`);
    } catch (error) {
      interruptFlag(controller);
      const message = error instanceof Error ? error.message : String(error);
      // 已经产出的内容仍要落库，避免用户看见的字消失
      if (answer || storedCalls.length > 0) {
        const wasAborted = controller.signal.aborted;
        insertMessageStmt.run(
          sessionId,
          "assistant",
          answer,
          JSON.stringify({
            toolCalls: storedCalls,
            interrupted: wasAborted,
            usage,
          } satisfies MessagePayload),
        );
        touchSessionStmt.run(sessionId);
      }
      const aborted = controller.signal.aborted;
      send("error", { message: aborted ? "已停止生成" : message });
      logError(`[chat] session ${sessionId} failed`, error);
    } finally {
      finished = true;
      clearInterval(ping);
      if (!res.writableEnded) res.end();
    }
  });

  app.use(`${apiPrefix}/chat`, chatRouter);
  logInfo(`[chat] routes registered at ${apiPrefix}/chat`);
};

/** 触发中断时不再重复 abort（AbortController 会抛错，这里静默处理） */
const interruptFlag = (controller: AbortController): void => {
  if (!controller.signal.aborted) controller.abort();
};
