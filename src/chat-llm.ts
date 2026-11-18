/**
 * LLM 凭据存储。
 *
 * 参考 deepseek-harness 的 credentials 实现，取了四条约束：
 * 1. 对 UI 暴露的视图里没有放密钥的字段，从结构上杜绝泄漏
 * 2. 优先级：页面保存 > 环境变量 > config.json 模板，并用 source 告诉调用方当前来自哪层
 * 3. 文件 0600；POSIX 下读取时校验权限，Windows 不做假检查
 * 4. 诊断只打印配置项名称，绝不打印值
 *
 * 落盘位置刻意避开 config/config.json：那个文件被 git 跟踪，写进密钥迟早会进仓库。
 */
import fs from "fs";
import path from "path";

export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxToolRounds: number;
  timeoutMs: number;
};

/** 当前生效值来自哪一层 */
export type LlmSource = "saved" | "env" | "config" | "none";

/** 给 UI 的状态视图：没有任何可以承载密钥明文的字段 */
export type LlmStatus = {
  configured: boolean;
  source: LlmSource;
  /** 页面是否可以覆盖当前来源（保存即覆盖，清除即回退） */
  writable: boolean;
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
  temperature: number;
  maxToolRounds: number;
};

export type LlmSaveInput = {
  baseUrl: string;
  model: string;
  /** 留空表示沿用已保存的密钥 */
  apiKey?: string | undefined;
  temperature?: number | undefined;
  maxToolRounds?: number | undefined;
};

/** 测试连接时可以只传部分字段，未传的用当前生效值 */
export type LlmTestInput = {
  baseUrl?: string | undefined;
  model?: string | undefined;
  apiKey?: string | undefined;
};

export type LlmTestResult = {
  ok: boolean;
  message: string;
};

const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOOL_ROUNDS = 6;
const DEFAULT_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 15_000;
/** 只有所有者可读写 */
const FILE_MODE = 0o600;
const GROUP_OTHER_BITS = 0o077;

type StoredDocument = {
  version: number;
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature?: number;
    maxToolRounds?: number;
    timeoutMs?: number;
  };
};

export interface LlmStoreOptions {
  /** config/config.json，作为部署默认值 */
  configPath: string;
  /** 页面保存的凭据文件，位于被 .gitignore 忽略的 output 目录 */
  storePath: string;
  logWarn: (message: string) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
};

/** 掩码：保留前缀三位与末四位，长度不足时整体隐藏 */
export const maskApiKey = (key: string): string => {
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
};

/** 只接受 http/https，避免页面把配置指到奇怪的协议上 */
const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, "");

const isValidBaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

/** POSIX 下拒绝 group/other 可读的凭据文件；Windows 没有对应语义，跳过 */
const assertOwnerOnly = (filename: string, logWarn: (message: string) => void): void => {
  if (process.platform === "win32") return;
  try {
    const mode = fs.statSync(filename).mode;
    if ((mode & GROUP_OTHER_BITS) !== 0) {
      logWarn(
        `[chat] ${path.basename(filename)} 的权限是 ${(mode & 0o777).toString(8)}，`
          + `其他用户可读；请执行 chmod 600 收紧`,
      );
    }
  } catch {
    /* 文件不存在时无需检查 */
  }
};

/** 原子写入：先写临时文件再改名，避免半截文件 */
const writeDocument = (filename: string, document: StoredDocument): void => {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: FILE_MODE });
  fs.renameSync(temp, filename);
  try {
    fs.chmodSync(filename, FILE_MODE);
  } catch {
    /* Windows 上 chmod 语义有限，忽略 */
  }
};

export const createLlmStore = (options: LlmStoreOptions) => {
  const { configPath, storePath, logWarn } = options;

  /** 读取页面保存的凭据；文件损坏时告警并当作未保存，绝不带着半截配置启动 */
  const readSaved = (): StoredDocument["llm"] | null => {
    if (!fs.existsSync(storePath)) return null;
    assertOwnerOnly(storePath, logWarn);
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, "utf-8")) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.llm)) throw new Error("缺少 llm 段");
      const llm = parsed.llm;
      const baseUrl = normalizeBaseUrl(asText(llm.baseUrl));
      const apiKey = asText(llm.apiKey);
      const model = asText(llm.model);
      if (!baseUrl || !apiKey || !model) throw new Error("baseUrl / apiKey / model 不完整");
      return {
        baseUrl,
        apiKey,
        model,
        temperature: clampNumber(llm.temperature, DEFAULT_TEMPERATURE, 0, 2),
        maxToolRounds: Math.round(
          clampNumber(llm.maxToolRounds, DEFAULT_MAX_TOOL_ROUNDS, 1, 20),
        ),
        timeoutMs: clampNumber(llm.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 600_000),
      };
    } catch (error) {
      // 只报告文件路径与原因，不引述文件内容（里面有密钥）
      logWarn(
        `[chat] ${path.basename(storePath)} 无法解析，已忽略：`
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  };

  /** 读取 config.json 的 llm 段，仅作为部署默认值 */
  const readConfigFile = (): StoredDocument["llm"] | null => {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.llm)) return null;
      const llm = parsed.llm;
      const baseUrl = normalizeBaseUrl(asText(llm.baseUrl));
      const apiKey = asText(llm.apiKey);
      const model = asText(llm.model);
      if (!baseUrl || !apiKey || !model) return null;
      return {
        baseUrl,
        apiKey,
        model,
        temperature: clampNumber(llm.temperature, DEFAULT_TEMPERATURE, 0, 2),
        maxToolRounds: Math.round(
          clampNumber(llm.maxToolRounds, DEFAULT_MAX_TOOL_ROUNDS, 1, 20),
        ),
        timeoutMs: clampNumber(llm.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 600_000),
      };
    } catch {
      return null;
    }
  };

  /** 环境变量构建完整配置；缺任意一项都不算命中 */
  const readEnv = (): StoredDocument["llm"] | null => {
    const baseUrl = normalizeBaseUrl(asText(process.env.GITSTATUS_LLM_BASE_URL));
    const apiKey = asText(process.env.GITSTATUS_LLM_API_KEY);
    const model = asText(process.env.GITSTATUS_LLM_MODEL);
    if (!baseUrl || !apiKey || !model) return null;
    return {
      baseUrl,
      apiKey,
      model,
      temperature: DEFAULT_TEMPERATURE,
      maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  };

  type ResolveResult = { config: LlmConfig; source: LlmSource; raw: StoredDocument["llm"] };

  /**
   * 按优先级解析当前生效配置。
   *
   * 顺序和 DSH 一致：页面保存 > 环境变量 > 配置文件。
   * 用户在界面上明确保存过的值必须一致生效，环境变量只在没有保存值时兜底；
   * 想回到部署默认值，在页面上点「清除」即可。
   */
  const resolveWithSource = (): ResolveResult | null => {
    const saved = readSaved();
    if (saved) return { config: toConfig(saved), source: "saved", raw: saved };
    const env = readEnv();
    if (env) return { config: toConfig(env), source: "env", raw: env };
    const file = readConfigFile();
    if (file) return { config: toConfig(file), source: "config", raw: file };
    return null;
  };

  const toConfig = (raw: StoredDocument["llm"]): LlmConfig => ({
    baseUrl: raw.baseUrl,
    apiKey: raw.apiKey,
    model: raw.model,
    temperature: raw.temperature ?? DEFAULT_TEMPERATURE,
    maxToolRounds: raw.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
    timeoutMs: raw.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  /**
   * 未配置时给表单一个建议值：config.json 里只填了 baseUrl/model（key 还空着）也能被利用，
   * 用户打开设置面板只需粘一个 key。
   */
  const readConfigDefaults = (): {
    baseUrl: string;
    model: string;
    temperature: number;
    maxToolRounds: number;
  } => {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
      const llm = isRecord(parsed) && isRecord(parsed.llm) ? parsed.llm : {};
      return {
        baseUrl: normalizeBaseUrl(asText(llm.baseUrl)),
        model: asText(llm.model),
        temperature: clampNumber(llm.temperature, DEFAULT_TEMPERATURE, 0, 2),
        maxToolRounds: Math.round(
          clampNumber(llm.maxToolRounds, DEFAULT_MAX_TOOL_ROUNDS, 1, 20),
        ),
      };
    } catch {
      return {
        baseUrl: "",
        model: "",
        temperature: DEFAULT_TEMPERATURE,
        maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
      };
    }
  };

  const describe = (): LlmStatus => {
    const resolved = resolveWithSource();
    const saved = readSaved();
    if (!resolved) {
      const defaults = readConfigDefaults();
      return {
        configured: false,
        source: "none",
        writable: true,
        baseUrl: defaults.baseUrl,
        model: defaults.model,
        apiKeyMasked: "",
        temperature: defaults.temperature,
        maxToolRounds: defaults.maxToolRounds,
      };
    }
    return {
      configured: true,
      source: resolved.source,
      // 页面总能覆盖：保存写入最高优先级，清除则回退到下一层
      writable: true,
      baseUrl: resolved.config.baseUrl,
      model: resolved.config.model,
      apiKeyMasked: maskApiKey(resolved.config.apiKey),
      temperature: saved?.temperature ?? resolved.config.temperature,
      maxToolRounds: saved?.maxToolRounds ?? resolved.config.maxToolRounds,
    };
  };

  /** 保存；apiKey 留空表示沿用已保存的密钥 */
  const save = (input: LlmSaveInput): LlmStatus => {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    if (!isValidBaseUrl(baseUrl)) {
      throw new Error("baseUrl 必须是 http:// 或 https:// 开头的地址");
    }
    const model = input.model.trim();
    if (!model) throw new Error("model 不能为空");

    const existing = readSaved();
    // 首次保存必须给 key；后续留空表示不修改
    const apiKey = input.apiKey?.trim() || existing?.apiKey || "";
    if (!apiKey) throw new Error("首次配置必须填写 apiKey");

    // 未传的数值项沿用已保存值，避免「只改模型名」把温度和轮数重置成默认
    const temperature = input.temperature !== undefined
      ? clampNumber(input.temperature, DEFAULT_TEMPERATURE, 0, 2)
      : existing?.temperature ?? DEFAULT_TEMPERATURE;
    const maxToolRounds = input.maxToolRounds !== undefined
      ? Math.round(clampNumber(input.maxToolRounds, DEFAULT_MAX_TOOL_ROUNDS, 1, 20))
      : existing?.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;

    writeDocument(storePath, {
      version: 1,
      llm: {
        baseUrl,
        apiKey,
        model,
        temperature,
        maxToolRounds,
        timeoutMs: existing?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
    });
    return describe();
  };

  /** 清除页面保存的配置，回退到环境变量或 config.json */
  const clear = (): LlmStatus => {
    try {
      fs.rmSync(storePath, { force: true });
    } catch {
      /* 文件不存在时忽略 */
    }
    return describe();
  };

  /**
   * 用给定配置发一次最小请求验证可用性。
   * 传参优先（便于「先测再存」），不传则用当前生效配置。
   */
  const test = async (override?: LlmTestInput): Promise<LlmTestResult> => {
    const resolved = resolveWithSource();
    const config = resolved?.config;
    const baseUrl = normalizeBaseUrl(override?.baseUrl ?? config?.baseUrl ?? "");
    const apiKey = override?.apiKey?.trim() || config?.apiKey || "";
    const model = (override?.model ?? config?.model ?? "").trim();

    if (!baseUrl || !apiKey || !model) {
      return { ok: false, message: "baseUrl、apiKey、model 都需要填写" };
    }
    if (!isValidBaseUrl(baseUrl)) {
      return { ok: false, message: "baseUrl 必须是 http:// 或 https:// 开头的地址" };
    }

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        // provider 的错误体里可能回显 key 片段，做一次掩码替换
        const safe = text.replaceAll(apiKey, maskApiKey(apiKey)).slice(0, 300);
        return { ok: false, message: `HTTP ${response.status}：${safe || "无响应体"}` };
      }
      return { ok: true, message: `连通正常，模型 ${model} 可用` };
    } catch (error) {
      const reason = error instanceof Error
        ? (error.name === "TimeoutError" ? "请求超时" : error.message)
        : String(error);
      return { ok: false, message: `连接失败：${reason}` };
    }
  };

  return {
    /** 工具执行用：拿不到就返回 null */
    resolve: (): LlmConfig | null => resolveWithSource()?.config ?? null,
    describe,
    save,
    clear,
    test,
    /** 供路由层判断保存文件位置，便于排错提示 */
    storePath,
  };
};

export type LlmStore = ReturnType<typeof createLlmStore>;
