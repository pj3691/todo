/**
 * 工具参数 DSL。
 *
 * 参考 deepseek-harness 的 defineTool：参数只写一份「属性表」，
 * 由 compileParameters 编译成标准 JSON Schema 供 MCP 客户端发现，
 * 再用同一份规格做服务端入参校验，避免 schema 与实际校验漂移。
 */

/** 单个参数的类型约束 */
export type ParamSpec = {
  type: "string" | "number" | "integer" | "boolean" | "string[]" | "integer[]";
  description: string;
  required?: boolean;
  /** 仅对 string 生效，限定允许的取值 */
  enum?: string[];
  /** 允许显式传 null（如「移回收件箱」这类语义），必填项不适用 */
  nullable?: boolean;
};

/** 工具参数表：键为参数名 */
export type ParameterSchemaSpec = Record<string, ParamSpec>;

/** 编译后的参数规格 */
export type CompiledParameters = {
  /** 传给 MCP 的 inputSchema */
  jsonSchema: Record<string, unknown>;
  /** 必填参数名 */
  required: string[];
  /** 原始属性表，校验时复用 */
  specs: ParameterSchemaSpec;
};

/** 把属性表编译成 MCP 使用的对象型 JSON Schema */
export const compileParameters = (
  specs: ParameterSchemaSpec,
): CompiledParameters => {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, spec] of Object.entries(specs)) {
    const node: Record<string, unknown> = { description: spec.description };
    switch (spec.type) {
      case "string[]":
        node.type = "array";
        node.items = { type: "string" };
        break;
      case "integer[]":
        node.type = "array";
        node.items = { type: "integer" };
        break;
      default:
        node.type = spec.type;
        break;
    }
    if (spec.enum && spec.type === "string") node.enum = spec.enum;
    if (spec.nullable) node.type = [node.type, "null"];
    properties[name] = node;
    if (spec.required) required.push(name);
  }

  return {
    jsonSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    required,
    specs,
  };
};

/** 一个参数取值不合规 */
const isTypeMatch = (spec: ParamSpec, value: unknown): boolean => {
  switch (spec.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "integer[]":
      return (
        Array.isArray(value) && value.every((item) => Number.isInteger(item))
      );
    default:
      return false;
  }
};

/**
 * 按规格校验入参。
 *
 * 只拦「类型/必填/枚举」这类模型容易犯的错，业务约束仍交给后端接口，
 * 避免 MCP 层复刻一遍与后端不一致的规则。
 */
export const validateArgs = (
  compiled: CompiledParameters,
  args: Record<string, unknown>,
): string[] => {
  const violations: string[] = [];

  for (const name of compiled.required) {
    const value = args[name];
    if (value === undefined || value === null || value === "") {
      violations.push(`${name} is required`);
    }
  }

  for (const [name, spec] of Object.entries(compiled.specs)) {
    const value = args[name];
    if (value === undefined || value === null) continue;
    if (!isTypeMatch(spec, value)) {
      violations.push(`${name} must be a ${spec.type}`);
      continue;
    }
    if (spec.enum && typeof value === "string" && !spec.enum.includes(value)) {
      violations.push(`${name} must be one of: ${spec.enum.join(", ")}`);
    }
  }

  return violations;
};

/** 去掉值为 undefined / null 的键，避免把空参数传给后端 */
export const compactArgs = (
  args: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    result[key] = value;
  }
  return result;
};
