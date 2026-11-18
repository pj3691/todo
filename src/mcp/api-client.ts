/**
 * GitStatus 接口客户端。
 *
 * MCP 服务不直接访问数据库，而是作为 /gitstatus/api 的普通客户端：
 * 鉴权、角色校验、业务规则、审计日志全部由后端原有链路负责，
 * 这里只做「拼 URL + 带上密钥 + 把错误翻译成人话」。
 */
import { compactArgs } from "./schema.js";

const API_PREFIX = "/gitstatus/api";

/** 接口返回非 2xx 或 res:false 时抛出 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export interface ApiClient {
  readonly baseUrl: string;
  get(path: string, query?: Record<string, unknown>): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  put(path: string, body?: unknown): Promise<unknown>;
  patch(path: string, body?: unknown): Promise<unknown>;
  del(path: string, query?: Record<string, unknown>): Promise<unknown>;
  /** multipart 上传：内置助手把对话附件转投到待办附件接口时使用 */
  postForm(path: string, form: FormData): Promise<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 后端出错时统一是 { res:false, message }，兜底再退到 HTTP 状态码 */
const messageOf = (payload: unknown): string => {
  if (isRecord(payload) && typeof payload.message === "string") {
    return payload.message;
  }
  return "";
};

const parseBody = (text: string): unknown => {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 落到 Express 默认 404 页之类时不是 JSON，截断一段文本便于定位
    return { message: text.slice(0, 300) };
  }
};

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    // AbortSignal.timeout 触发时是 TimeoutError
    if (error.name === "TimeoutError") return "request timed out";
    return error.message;
  }
  return String(error);
};

export const createApiClient = (options: ApiClientOptions): ApiClient => {
  const base = options.baseUrl.replace(/\/+$/, "");

  const buildUrl = (
    path: string,
    query?: Record<string, unknown>,
  ): string => {
    const url = new URL(`${base}${API_PREFIX}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(compactArgs(query))) {
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, String(item));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  };

  /** 统一的响应处理：HTTP 状态与 res:false 都翻译成 ApiError */
  const readResponse = async (response: Response): Promise<unknown> => {
    const payload = parseBody(await response.text());

    if (!response.ok) {
      throw new ApiError(
        messageOf(payload) || `HTTP ${response.status}`,
        response.status,
      );
    }
    // 部分接口 200 但仍以 res:false 表达失败
    if (isRecord(payload) && payload.res === false) {
      throw new ApiError(messageOf(payload) || "请求被后端拒绝", response.status);
    }
    return payload;
  };

  const request = async (
    method: string,
    path: string,
    query: Record<string, unknown> | undefined,
    body: unknown,
  ): Promise<unknown> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.apiKey}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await fetch(buildUrl(path, query), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      throw new ApiError(
        `无法连接 GitStatus 后端 ${base}：${describeError(error)}`,
        0,
      );
    }

    return readResponse(response);
  };

  /** multipart 请求：不设置 Content-Type，交给 fetch 生成 boundary */
  const requestForm = async (path: string, form: FormData): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(buildUrl(path), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          Accept: "application/json",
        },
        body: form,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      throw new ApiError(
        `无法连接 GitStatus 后端 ${base}：${describeError(error)}`,
        0,
      );
    }

    return readResponse(response);
  };

  return {
    baseUrl: base,
    get: (path, query) => request("GET", path, query, undefined),
    post: (path, body) => request("POST", path, undefined, body ?? {}),
    put: (path, body) => request("PUT", path, undefined, body ?? {}),
    patch: (path, body) => request("PATCH", path, undefined, body ?? {}),
    del: (path, query) => request("DELETE", path, query, undefined),
    postForm: (path, form) => requestForm(path, form),
  };
};
