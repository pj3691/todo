/**
 * 项目管理工具（只读）。
 *
 * 刻意不暴露 start / stop / restart / 命令执行 / 端口 kill：
 * 那几项等于把任意命令执行能力交给调用方，必须由人工在页面或桌面端操作。
 */
import { defineTool, type ToolDefinition } from "../define-tool.js";
import { asArray, asNumber, asRecord, asText } from "./format.js";

/** 兜底投影：结构不确定的接口先给一段可读 JSON */
const rawText = (payload: unknown): string => {
  const text = JSON.stringify(payload ?? {}, null, 2);
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…[已截断]` : text;
};

const projectLine = (value: unknown): string => {
  const project = asRecord(value);
  const parts = [
    `#${asText(project.id)} ${asText(project.name)}（${asText(project.typeLabel) || asText(project.type)}）`,
    `状态 ${asText(project.status) || "stopped"}`,
  ];
  if (asNumber(project.pid) !== null) parts.push(`pid ${asText(project.pid)}`);
  if (asText(project.folder)) parts.push(`文件夹 ${asText(project.folder)}`);
  if (asText(project.command)) parts.push(`启动命令 ${asText(project.command)}`);
  if (asText(project.path)) parts.push(`路径 ${asText(project.path)}`);
  const runCommands = asArray(project.runCommands);
  if (runCommands.length > 0) {
    parts.push(
      `自定义命令 ${runCommands
        .map((item) => `[${asText(asRecord(item).id)}] ${asText(asRecord(item).command)}`)
        .join("、")}`,
    );
  }
  return parts.join(" · ");
};

/** 日志条目渲染，按 seq 升序 */
const renderLogs = (payload: unknown, tail: number): string => {
  const body = asRecord(payload);
  const logs = asArray(body.logs);
  const status = asText(body.status) || "stopped";
  const pid = asNumber(body.pid);
  const sliced = tail > 0 ? logs.slice(-tail) : logs;
  const header = `状态 ${status}${pid === null ? "" : `（pid ${pid}）`}，返回 ${sliced.length}/${logs.length} 条日志`;
  if (sliced.length === 0) return `${header}\n（暂无输出）`;
  const lines = sliced.map((item) => {
    const entry = asRecord(item);
    const time = asText(entry.at);
    const stream = asText(entry.stream) || "out";
    return `[${asText(entry.seq)}] ${time} ${stream}: ${asText(entry.text).replace(/\n+$/, "")}`;
  });
  return [header, ...lines].join("\n");
};

export const projectTools: ToolDefinition[] = [
  defineTool({
    name: "gitstatus_project_list",
    title: "查询项目列表",
    description:
      "列出项目管理中的全部项目（只读），包含运行状态、pid、启动命令、自定义命令与所属文件夹。"
      + "这里只能看，不能启停项目。",
    readOnly: true,
    requiredRole: "readonly",
    parameters: {},
    async run(ctx) {
      const payload = await ctx.api.get("/projects");
      const body = asRecord(payload);
      const projects = asArray(body.projects);
      const folders = asArray(body.folders);
      const lines =
        projects.length === 0
          ? ["还没有任何项目。"]
          : [`共 ${projects.length} 个项目：`, ...projects.map((item) => `- ${projectLine(item)}`)];
      if (folders.length > 0) {
        lines.push(
          `文件夹：${folders.map((item) => asText(asRecord(item).name)).filter(Boolean).join("、")}`,
        );
      }
      return { text: lines.join("\n"), structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_project_folders",
    title: "查询项目文件夹",
    description: "列出项目管理使用的项目文件夹及其路径与排序。",
    readOnly: true,
    requiredRole: "readonly",
    parameters: {},
    async run(ctx) {
      const payload = await ctx.api.get("/projects/folders");
      const folders = asArray(asRecord(payload).folders);
      const text =
        folders.length === 0
          ? "还没有项目文件夹。"
          : [
              `共 ${folders.length} 个项目文件夹：`,
              ...folders.map((item) => {
                const folder = asRecord(item);
                return `- ${asText(folder.name)} · ${asText(folder.path)}（排序 ${asText(folder.sortOrder)}）`;
              }),
            ].join("\n");
      return { text, structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_project_logs",
    title: "读取项目运行日志",
    description:
      "读取某个项目当前运行实例的日志（只读）。可用 after 做增量拉取：传上次返回的 nextSeq。",
    readOnly: true,
    requiredRole: "readonly",
    parameters: {
      id: { type: "integer", required: true, description: "项目 id" },
      after: { type: "integer", description: "只返回 seq 大于该值的日志，用于增量拉取" },
      tail: { type: "integer", description: "只显示最后 N 条，默认 100" },
    },
    async run(ctx, args) {
      const id = asNumber(args.id) ?? 0;
      const tail = asNumber(args.tail) ?? 100;
      const payload = await ctx.api.get(`/projects/${id}/logs`, {
        after: args.after,
      });
      return { text: renderLogs(payload, tail), structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_project_run_logs",
    title: "读取自定义命令日志",
    description: "读取项目中某次自定义命令运行（run）的日志输出。",
    readOnly: true,
    requiredRole: "readonly",
    parameters: {
      id: { type: "integer", required: true, description: "项目 id" },
      runId: { type: "string", required: true, description: "运行记录 id" },
      tail: { type: "integer", description: "只显示最后 N 条，默认 100" },
    },
    async run(ctx, args) {
      const id = asNumber(args.id) ?? 0;
      const runId = encodeURIComponent(asText(args.runId));
      const tail = asNumber(args.tail) ?? 100;
      const payload = await ctx.api.get(`/projects/${id}/runs/${runId}/logs`);
      return { text: renderLogs(payload, tail), structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_port_lookup",
    title: "查询端口占用",
    description: "查询某个本地端口当前被哪些连接占用（只读），用于排查端口冲突。",
    readOnly: true,
    requiredRole: "readonly",
    parameters: {
      port: { type: "integer", required: true, description: "端口号，1-65535" },
    },
    async run(ctx, args) {
      const port = asNumber(args.port) ?? 0;
      const payload = await ctx.api.get(`/projects/ports/${port}`);
      const connections = asArray(asRecord(payload).connections);
      const text =
        connections.length === 0
          ? `端口 ${port} 当前没有活动连接。`
          : [
              `端口 ${port} 有 ${connections.length} 条连接：`,
              ...connections.map((item) => {
                const conn = asRecord(item);
                return `- ${asText(conn.protocol)} ${asText(conn.localAddress)}:${asText(conn.localPort)} ← ${asText(conn.remoteAddress)}:${asText(conn.remotePort)} pid ${asText(conn.pid)} ${asText(conn.processName)}`;
              }),
            ].join("\n");
      return { text, structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_project_usage",
    title: "查询项目资源占用",
    description: "读取项目管理侧统计的进程占用信息（只读）。",
    readOnly: true,
    requiredRole: "readonly",
    parameters: {},
    async run(ctx) {
      const payload = await ctx.api.get("/projects/usage");
      return { text: rawText(payload), structured: payload };
    },
  }),
];
