/**
 * 待办域工具。
 *
 * 全部走 /gitstatus/api 的既有接口：MCP 只负责「参数收敛 + 结果投影」，
 * 归属校验、共享权限、完成口径等业务规则仍由后端决定。
 */
import { defineTool, type ToolContext, type ToolDefinition } from "../define-tool.js";
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asText,
  categoryLine,
  shareLine,
  tagLine,
  todoDetail,
  todoLine,
} from "./format.js";

const PRIORITY_ENUM = ["high", "normal", "low"];

/** 把待办列表响应渲染成「一行一条」 */
const renderTodoPage = (payload: unknown): string => {
  const body = asRecord(payload);
  const todos = asArray(body.todos);
  const date = asText(body.date);
  const total = asNumber(body.total) ?? todos.length;
  if (todos.length === 0) {
    return `${date} 没有符合条件的待办。`;
  }
  const header = `${date} 共 ${total} 条，本页 ${todos.length} 条：`;
  return [header, ...todos.map((todo) => `- ${todoLine(todo)}`)].join("\n");
};

/** 待办创建/更新后的回执 */
const renderTodoChanged = (payload: unknown, verb: string): string => {
  const todo = asRecord(asRecord(payload).todo);
  return `${verb}：${todoLine(todo)}`;
};

/** 把 attachmentIds 收敛成去重后的正整数数组 */
const normalizeAttachmentIds = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  for (const item of value) {
    const id = Number(item);
    if (Number.isInteger(id) && id > 0) seen.add(id);
  }
  return [...seen];
};

/**
 * 附件编号必须落在本会话尚未绑定的附件里。
 * 越界通常意味着模型编了 id 或抄了别的会话的编号，直接报错让它改用正确来源。
 */
const assertAttachmentScope = (ctx: ToolContext, ids: number[]): void => {
  if (ids.length === 0) return;
  if (!ctx.attachments) {
    throw new Error("附件只能在内置 AI 助手的对话中使用：请先把文件拖进对话框再发消息。");
  }
  const available = new Set(ctx.attachments.availableIds);
  const unknown = ids.filter((id) => !available.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `附件编号 ${unknown.join("、")} 不在本会话可用范围内；只能引用对话消息里列出的附件编号。`,
    );
  }
};

/** 绑定附件并把逐条结果渲染成缩进行 */
const bindAttachments = async (
  ctx: ToolContext,
  todoId: number,
  ids: number[],
): Promise<string[]> => {
  if (ids.length === 0 || !ctx.attachments) return [];
  const results = await ctx.attachments.bind(todoId, ids);
  return results.map((item) => `  · ${item.name}：${item.message}`);
};

export const todoTools: ToolDefinition[] = [
  defineTool({
    name: "gitstatus_todo_list",
    title: "查询待办列表",
    description:
      "按日期、状态、分类、标签、关键词等条件列出当前账号可见的待办（含共享给我的任务）。"
      + "不传 date 时按后端当天日期统计；返回按未完成、逾期、优先级、截止时间排序。",
    readOnly: true,
    requiredRole: "readonly",
    parameters: {
      date: { type: "string", description: "统计基准日期，格式 YYYY-MM-DD，默认今天" },
      status: {
        type: "string",
        description: "按完成状态过滤",
        enum: ["pending", "completed"],
      },
      view: {
        type: "string",
        description: "视图：all 全部、today 仅当天可见、inbox 仅收件箱",
        enum: ["all", "today", "inbox"],
      },
      type: {
        type: "string",
        description: "按调度类型过滤：once 单次、daily 每日重复",
        enum: ["once", "daily"],
      },
      categoryId: { type: "integer", description: "按分类过滤，传分类 id" },
      tagId: { type: "integer", description: "按标签过滤，传标签 id" },
      overdue: {
        type: "boolean",
        description: "为 true 时只返回逾期未完成的任务",
      },
      inbox: {
        type: "boolean",
        description: "为 true 时只返回未归类到文件夹的收件箱任务",
      },
      search: { type: "string", description: "按标题或描述关键词搜索" },
      dueFrom: { type: "string", description: "截止日期下界，格式 YYYY-MM-DD" },
      dueTo: { type: "string", description: "截止日期上界，格式 YYYY-MM-DD" },
      page: { type: "integer", description: "页码，从 1 开始，默认 1" },
      pageSize: { type: "integer", description: "每页条数，默认 200，最大 500" },
    },
    async run(ctx, args) {
      const payload = await ctx.api.get("/todos", args);
      return { text: renderTodoPage(payload), structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_todo_get",
    title: "查询单个待办",
    description: "按 id 读取一条待办的完整信息，包含描述、提醒、附件与创建时间。",
    readOnly: true,
    requiredRole: "readonly",
    parameters: {
      id: { type: "integer", required: true, description: "待办 id" },
      date: { type: "string", description: "用于判断每日任务完成情况的基准日期" },
    },
    async run(ctx, args) {
      const id = asNumber(args.id) ?? 0;
      const payload = await ctx.api.get(`/todos/${id}`, {
        date: args.date,
      });
      const todo = asRecord(asRecord(payload).todo);
      return { text: todoDetail(todo), structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_todo_create",
    title: "新建待办",
    description:
      "新建一条待办。title 必填；单次任务用 dueDate/dueTime，每日任务用 scheduleType=daily 并给 repeatStartDate。",
    readOnly: false,
    requiredRole: "readwrite",
    parameters: {
      title: { type: "string", required: true, description: "标题，最多 200 字" },
      description: { type: "string", description: "描述，最多 5000 字" },
      categoryId: { type: "integer", description: "放入的分类 id，不传即收件箱" },
      priority: {
        type: "string",
        description: "优先级，默认 normal",
        enum: PRIORITY_ENUM,
      },
      scheduleType: {
        type: "string",
        description: "调度类型，默认 once",
        enum: ["once", "daily"],
      },
      dueDate: { type: "string", description: "截止日期 YYYY-MM-DD（单次任务）" },
      dueTime: { type: "string", description: "截止时刻 HH:mm（需同时给 dueDate）" },
      repeatStartDate: { type: "string", description: "每日任务开始日期 YYYY-MM-DD" },
      repeatEndDate: { type: "string", description: "每日任务结束日期 YYYY-MM-DD" },
      tagIds: { type: "integer[]", description: "标签 id 列表" },
      sortOrder: { type: "integer", description: "排序值，默认 0" },
      attachmentIds: {
        type: "integer[]",
        description:
          "要随待办一起保存的对话附件编号（消息里以 #编号 标注）。"
          + "只在「AI 助手」页的对话里有效，编号必须是本会话消息中列出的附件",
      },
    },
    async run(ctx, args) {
      const attachmentIds = normalizeAttachmentIds(args.attachmentIds);
      const { attachmentIds: _attachmentIds, ...body } = args;
      // 先校验再建待办：编号不合法时不要留下一条没有附件的待办
      assertAttachmentScope(ctx, attachmentIds);
      const payload = await ctx.api.post("/todos", body);
      const todoId = asNumber(asRecord(asRecord(payload).todo).id) ?? 0;
      const lines = todoId > 0 ? await bindAttachments(ctx, todoId, attachmentIds) : [];
      return {
        text: [renderTodoChanged(payload, "已新建待办"), ...(lines.length > 0 ? ["附件：", ...lines] : [])].join("\n"),
        structured: payload,
      };
    },
  }),

  defineTool({
    name: "gitstatus_todo_update",
    title: "修改待办",
    description:
      "按 id 修改待办，只传需要变更的字段；字段语义与新建一致。修改每日任务的重复区间会同时改变它的可见范围。",
    readOnly: false,
    requiredRole: "readwrite",
    parameters: {
      id: { type: "integer", required: true, description: "待办 id" },
      title: { type: "string", description: "新标题" },
      description: { type: "string", description: "新描述" },
      categoryId: { type: "integer", description: "移动到该分类；传 null 表示移回收件箱", nullable: true },
      priority: {
        type: "string",
        description: "新优先级",
        enum: PRIORITY_ENUM,
      },
      scheduleType: {
        type: "string",
        description: "新调度类型",
        enum: ["once", "daily"],
      },
      dueDate: { type: "string", description: "新截止日期 YYYY-MM-DD" },
      dueTime: { type: "string", description: "新截止时刻 HH:mm" },
      repeatStartDate: { type: "string", description: "每日任务开始日期" },
      repeatEndDate: { type: "string", description: "每日任务结束日期" },
      tagIds: { type: "integer[]", description: "替换后的标签 id 列表" },
      sortOrder: { type: "integer", description: "新排序值" },
      attachmentIds: {
        type: "integer[]",
        description: "追加到这条待办的对话附件编号；已有的附件不受影响",
      },
    },
    async run(ctx, args) {
      const id = asNumber(args.id) ?? 0;
      const attachmentIds = normalizeAttachmentIds(args.attachmentIds);
      const { id: _ignored, attachmentIds: _attachmentIds, ...body } = args;
      assertAttachmentScope(ctx, attachmentIds);
      const payload = await ctx.api.patch(`/todos/${id}`, body);
      const lines = await bindAttachments(ctx, id, attachmentIds);
      return {
        text: [renderTodoChanged(payload, "已修改待办"), ...(lines.length > 0 ? ["附件：", ...lines] : [])].join("\n"),
        structured: payload,
      };
    },
  }),

  defineTool({
    name: "gitstatus_todo_delete",
    title: "删除待办",
    description: "按 id 删除一条待办。删除不可恢复，对共享任务需要写权限。",
    readOnly: false,
    requiredRole: "readwrite",
    parameters: {
      id: { type: "integer", required: true, description: "待办 id" },
    },
    async run(ctx, args) {
      const id = asNumber(args.id) ?? 0;
      const payload = await ctx.api.del(`/todos/${id}`);
      return { text: `已删除待办 #${id}`, structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_todo_complete",
    title: "完成待办",
    description:
      "把待办标记为完成。单次任务以服务器当天为完成日期；每日任务可传 date 指定完成哪一天。",
    readOnly: false,
    requiredRole: "readwrite",
    parameters: {
      id: { type: "integer", required: true, description: "待办 id" },
      date: { type: "string", description: "每日任务的完成日期 YYYY-MM-DD" },
    },
    async run(ctx, args) {
      const id = asNumber(args.id) ?? 0;
      const payload = await ctx.api.post(`/todos/${id}/complete`, {
        date: args.date,
      });
      return { text: renderTodoChanged(payload, "已完成待办"), structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_todo_reopen",
    title: "取消完成",
    description:
      "取消待办的完成状态。单次任务始终清空完成记录；每日任务可传 date 只取消该天。",
    readOnly: false,
    requiredRole: "readwrite",
    parameters: {
      id: { type: "integer", required: true, description: "待办 id" },
      date: { type: "string", description: "每日任务要取消的日期 YYYY-MM-DD" },
    },
    async run(ctx, args) {
      const id = asNumber(args.id) ?? 0;
      const payload = await ctx.api.del(`/todos/${id}/complete`, {
        date: args.date,
      });
      return { text: renderTodoChanged(payload, "已取消完成"), structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_todo_set_reminder",
    title: "设置待办提醒",
    description:
      "给待办设置提醒。单次任务用 remindAt（YYYY-MM-DD HH:mm，必须是将来的时间）；"
      + "每日任务用 remindTime（HH:mm），按该任务的重复区间滚动触发。",
    readOnly: false,
    requiredRole: "readwrite",
    parameters: {
      id: { type: "integer", required: true, description: "待办 id" },
      remindAt: { type: "string", description: "单次任务的提醒时刻 YYYY-MM-DD HH:mm" },
      remindTime: { type: "string", description: "每日任务的提醒时刻 HH:mm" },
    },
    async run(ctx, args) {
      const id = asNumber(args.id) ?? 0;
      const payload = await ctx.api.put(`/todos/${id}/reminder`, {
        remindAt: args.remindAt,
        remindTime: args.remindTime,
      });
      const reminder = asRecord(asRecord(payload).reminder);
      return {
        text: `已设置提醒：${asText(reminder.nextTriggerAt) || asText(reminder.remindAt) || asText(reminder.remindTime)}`,
        structured: payload,
      };
    },
  }),

  defineTool({
    name: "gitstatus_todo_clear_reminder",
    title: "清除待办提醒",
    description: "删除待办已设置的提醒。",
    readOnly: false,
    requiredRole: "readwrite",
    parameters: {
      id: { type: "integer", required: true, description: "待办 id" },
    },
    async run(ctx, args) {
      const id = asNumber(args.id) ?? 0;
      const payload = await ctx.api.del(`/todos/${id}/reminder`);
      return { text: `已清除待办 #${id} 的提醒`, structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_category_list",
    title: "查询分类树",
    description: "列出当前账号可见的分类（含共享给我的分类），带父子关系与颜色。",
    readOnly: true,
    requiredRole: "readonly",
    parameters: {},
    async run(ctx) {
      const payload = await ctx.api.get("/todo-categories");
      const categories = asArray(asRecord(payload).categories);
      const text =
        categories.length === 0
          ? "还没有任何分类。"
          : [`共 ${categories.length} 个分类：`, ...categories.map((item) => `- ${categoryLine(item)}`)].join("\n");
      return { text, structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_category_create",
    title: "新建分类",
    description: "新建一个分类，可用 parentId 挂到已有分类下形成子树。",
    readOnly: false,
    requiredRole: "readwrite",
    parameters: {
      name: { type: "string", required: true, description: "分类名，最多 80 字" },
      parentId: { type: "integer", description: "父分类 id，不传为根分类" },
      color: { type: "string", description: "颜色值，如 #1f7a4d" },
      sortOrder: { type: "integer", description: "排序值，默认 0" },
    },
    async run(ctx, args) {
      const payload = await ctx.api.post("/todo-categories", args);
      const category = asRecord(asRecord(payload).category);
      return { text: `已新建分类：${categoryLine(category)}`, structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_category_update",
    title: "修改分类",
    description: "按 id 修改分类的名称、父分类、颜色或排序。",
    readOnly: false,
    requiredRole: "readwrite",
    parameters: {
      id: { type: "integer", required: true, description: "分类 id" },
      name: { type: "string", description: "新名称" },
      parentId: { type: "integer", description: "新父分类 id，传 null 表示改为根分类", nullable: true },
      color: { type: "string", description: "新颜色值" },
      sortOrder: { type: "integer", description: "新排序值" },
    },
    async run(ctx, args) {
      const id = asNumber(args.id) ?? 0;
      const { id: _ignored, ...body } = args;
      const payload = await ctx.api.patch(`/todo-categories/${id}`, body);
      return {
        text: `已修改分类：${categoryLine(asRecord(asRecord(payload).category))}`,
        structured: payload,
      };
    },
  }),

  defineTool({
    name: "gitstatus_category_delete",
    title: "删除分类",
    description: "按 id 删除分类。分类下的待办会按后端规则处理，操作前建议先确认分类内容。",
    readOnly: false,
    requiredRole: "readwrite",
    parameters: {
      id: { type: "integer", required: true, description: "分类 id" },
    },
    async run(ctx, args) {
      const id = asNumber(args.id) ?? 0;
      const payload = await ctx.api.del(`/todo-categories/${id}`);
      return { text: `已删除分类 #${id}`, structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_tag_list",
    title: "查询标签",
    description: "列出当前账号可用的全部标签。",
    readOnly: true,
    requiredRole: "readonly",
    parameters: {},
    async run(ctx) {
      const payload = await ctx.api.get("/todo-tags");
      const tags = asArray(asRecord(payload).tags);
      const text =
        tags.length === 0
          ? "还没有任何标签。"
          : [`共 ${tags.length} 个标签：`, ...tags.map((item) => `- ${tagLine(item)}`)].join("\n");
      return { text, structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_tag_create",
    title: "新建标签",
    description: "新建一个标签，名称在同一账号内唯一。",
    readOnly: false,
    requiredRole: "readwrite",
    parameters: {
      name: { type: "string", required: true, description: "标签名，最多 40 字" },
      color: { type: "string", description: "颜色值，默认 #0969da" },
    },
    async run(ctx, args) {
      const payload = await ctx.api.post("/todo-tags", args);
      return {
        text: `已新建标签：${tagLine(asRecord(asRecord(payload).tag))}`,
        structured: payload,
      };
    },
  }),

  defineTool({
    name: "gitstatus_tag_update",
    title: "修改标签",
    description: "按 id 修改标签名称或颜色。",
    readOnly: false,
    requiredRole: "readwrite",
    parameters: {
      id: { type: "integer", required: true, description: "标签 id" },
      name: { type: "string", description: "新名称" },
      color: { type: "string", description: "新颜色值" },
    },
    async run(ctx, args) {
      const id = asNumber(args.id) ?? 0;
      const { id: _ignored, ...body } = args;
      const payload = await ctx.api.patch(`/todo-tags/${id}`, body);
      return {
        text: `已修改标签：${tagLine(asRecord(asRecord(payload).tag))}`,
        structured: payload,
      };
    },
  }),

  defineTool({
    name: "gitstatus_tag_delete",
    title: "删除标签",
    description: "按 id 删除标签，待办上对该标签的引用会一并解除。",
    readOnly: false,
    requiredRole: "readwrite",
    parameters: {
      id: { type: "integer", required: true, description: "标签 id" },
    },
    async run(ctx, args) {
      const id = asNumber(args.id) ?? 0;
      const payload = await ctx.api.del(`/todo-tags/${id}`);
      return { text: `已删除标签 #${id}`, structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_share_list",
    title: "查询共享关系",
    description:
      "查询待办共享关系。scope=mine 我共享出去的、received 别人共享给我的、all 全部（仅管理员）。",
    readOnly: true,
    requiredRole: "readonly",
    parameters: {
      scope: {
        type: "string",
        description: "查询范围，默认 mine",
        enum: ["mine", "received", "all"],
      },
    },
    async run(ctx, args) {
      const payload = await ctx.api.get("/todo-shares", { scope: args.scope });
      const shares = asArray(asRecord(payload).shares);
      const text =
        shares.length === 0
          ? "没有共享记录。"
          : [`共 ${shares.length} 条共享：`, ...shares.map((item) => `- ${shareLine(item)}`)].join("\n");
      return { text, structured: payload };
    },
  }),

  defineTool({
    name: "gitstatus_today_summary",
    title: "今日待办汇总",
    description:
      "读取与桌宠挂件相同的今日汇总：未完成/逾期/已完成数量、前三条预览、临期提醒与下一次提醒时间。",
    readOnly: true,
    requiredRole: "readonly",
    parameters: {
      since: {
        type: "string",
        description: "提醒事件回溯起点 YYYY-MM-DD HH:mm，默认 5 分钟前",
      },
    },
    async run(ctx, args) {
      const payload = await ctx.api.get("/todo-widget/summary", args);
      const body = asRecord(payload);
      const stats = asRecord(body.stats);
      const preview = asArray(body.preview);
      const lines = [
        // now 是后端权威的当前时刻：不投影出来，模型就只能拿历史记录猜时间
        `服务器当前时间 ${asText(body.now)}`,
        `${asText(body.today)} 待办汇总：未完成 ${asText(stats.pending)}、逾期 ${asText(stats.overdue)}、已完成 ${asText(stats.completed)}，共 ${asText(stats.total)} 条`,
      ];
      if (preview.length > 0) {
        lines.push("优先处理：");
        for (const item of preview) {
          const todo = asRecord(item);
          const overdue = asBoolean(todo.isOverdue) ? "（逾期）" : "";
          const due = asText(todo.dueDate);
          lines.push(
            `- #${asText(todo.id)} ${asText(todo.title)}${overdue}${due ? ` · 截止 ${due}${asText(todo.dueTime) ? ` ${asText(todo.dueTime)}` : ""}` : ""}`,
          );
        }
      }
      const next = asRecord(body.nextReminder);
      if (asText(next.triggerAt)) {
        lines.push(`下一次提醒：${asText(next.title)} @ ${asText(next.triggerAt)}`);
      }
      return { text: lines.join("\n"), structured: payload };
    },
  }),
];
