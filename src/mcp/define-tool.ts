/**
 * 工具定义与注册表。
 *
 * 结构参考 deepseek-harness 的 defineTool + ctx.tools.register：
 * - 定义期：参数属性表编译成 JSON Schema
 * - 调用期：先按同一份规格校验入参，再执行
 * - 发现期：按账号角色过滤，模型看不到自己无权调用的工具
 */
import type { ApiClient } from "./api-client.js";
import {
  compileParameters,
  validateArgs,
  type ParameterSchemaSpec,
} from "./schema.js";

export type UserRole = "readonly" | "readwrite" | "admin";

/** 角色等级：只读 < 读写 < 管理员，与后端 ROLE_LEVEL 保持一致 */
export const ROLE_LEVEL: Record<UserRole, number> = {
  readonly: 1,
  readwrite: 2,
  admin: 3,
};

export const hasRoleLevel = (role: UserRole, min: UserRole): boolean =>
  ROLE_LEVEL[role] >= ROLE_LEVEL[min];

/**
 * 对话附件能力。
 *
 * 附件是二进制，不可能塞进工具参数里由模型“转述”；
 * 因此由内置助手在发起本轮对话时注入一个桥：模型只传编号，
 * 真正读文件、转投到待办附件接口的动作由宿主实现。
 * MCP 调用方没有这个字段，传 attachmentIds 会得到明确报错。
 */
export interface ChatAttachmentBridge {
  /** 本会话尚未绑定到待办的附件 id，模型只能引用这些编号 */
  availableIds: number[];
  /** 把附件绑定到指定待办，逐条返回结果 */
  bind(
    todoId: number,
    ids: number[],
  ): Promise<Array<{ id: number; name: string; ok: boolean; message: string }>>;
}

/**
 * 工具被谁调用。
 *
 * 两个通道的可靠性不同：内置助手有人在页面上，可以做人工确认；
 * MCP 客户端控制不了 UI，只能靠开关、白名单与角色门槛。审计里要能区分来源。
 */
export type ToolChannel = "web" | "mcp";

/** 项目启停能力策略，未开启时相关工具根本不会注册 */
export interface ProjectControlPolicy {
  /** 允许操作的项目 id；空数组表示全部允许 */
  allowedProjectIds: number[];
  /** 每个项目每分钟允许的动作次数，防模型循环重启 */
  maxActionsPerMinute: number;
}

/** 一次需要人工确认的项目动作 */
export interface ConfirmRequest {
  action: "start" | "stop" | "restart";
  projectId: number;
  projectName: string;
  /** 启动命令原文，让用户看清将要执行什么 */
  command: string;
  /** 一句话标题，如「请求启动项目」 */
  title: string;
  /** 多行明细，含当前状态与命令 */
  detail: string;
}

/** 审计条目：出问题时这是唯一的回溯依据 */
export interface ToolAuditEntry {
  channel: ToolChannel;
  tool: string;
  projectId: number;
  projectName: string;
  command: string;
  /** ok / denied / error */
  outcome: "ok" | "denied" | "error";
  message: string;
  durationMs: number;
}

export interface ToolContext {
  api: ApiClient;
  /** 当前密钥所属账号的角色 */
  role: UserRole;
  /** 调用来源，默认 web */
  channel?: ToolChannel;
  /** 仅在「AI 助手」页的对话中提供 */
  attachments?: ChatAttachmentBridge;
  /** 项目启停策略；没有它说明能力未开启 */
  projectControl?: ProjectControlPolicy;
  /** 人工确认；只有内置助手提供，MCP 通道为空 */
  confirm?: (request: ConfirmRequest) => Promise<boolean>;
  /** 审计钩子 */
  audit?: (entry: ToolAuditEntry) => void;
}

export interface ToolOutcome {
  /** 模型可读的文本结果 */
  text: string;
  /** 结构化结果，随 structuredContent 返回 */
  structured?: unknown;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** 只读工具会在 MCP 注解里标记 readOnlyHint */
  readOnly: boolean;
  requiredRole: UserRole;
  /** 已编译的对象型 JSON Schema */
  parameters: Record<string, unknown>;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome>;
}

export interface ToolSpec
  extends Omit<ToolDefinition, "parameters" | "run"> {
  parameters: ParameterSchemaSpec;
  run(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolOutcome>;
}

/** 入参不符合工具声明 */
export class ToolArgsError extends Error {
  readonly violations: string[];

  constructor(violations: string[]) {
    super(`invalid arguments: ${violations.join("; ")}`);
    this.name = "ToolArgsError";
    this.violations = violations;
  }
}

/**
 * 定义一个工具。
 *
 * 参数规格只写一遍：既生成给客户端看的 inputSchema，
 * 也作为调用前的校验依据，避免两边规则不一致。
 */
export const defineTool = (spec: ToolSpec): ToolDefinition => {
  const compiled = compileParameters(spec.parameters);
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    readOnly: spec.readOnly,
    requiredRole: spec.requiredRole,
    parameters: compiled.jsonSchema,
    async run(ctx, args) {
      const violations = validateArgs(compiled, args);
      if (violations.length > 0) throw new ToolArgsError(violations);
      return spec.run(ctx, args);
    },
  };
};

/** 进程内工具注册表 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  add(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`duplicate tool name: ${tool.name}`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  /** 当前角色可调用的工具；无权使用的工具不对客户端暴露 */
  visible(role: UserRole): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => hasRoleLevel(role, tool.requiredRole))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  get size(): number {
    return this.tools.size;
  }
}
