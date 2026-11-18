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

export interface ToolContext {
  api: ApiClient;
  /** 当前密钥所属账号的角色 */
  role: UserRole;
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
