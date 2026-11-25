# MCP 工具说明

> 本文件的**工具清单部分**由 `npm run mcp:docs` 从 `src/mcp/tools/` 自动生成，改完工具定义重跑即可同步，请勿手改生成区。
> 机制说明与配置示例是手写的，可以直接编辑。

## 一、LLM 是怎么知道有哪些工具的

不需要它读这份文件。

MCP 是运行时发现协议：客户端连上服务端后会发一次 `tools/list`，服务端返回每个工具的

- `name`：工具标识
- `description`：一段自然语言说明，这段就是写给模型看的
- `inputSchema`：标准 JSON Schema 参数定义
- `annotations`：`readOnlyHint` / `destructiveHint`

客户端把这四项拼进模型上下文，模型就能像调用本地函数一样选择工具、填参数。所以**工具描述本身就是文档**，而且是运行时注入、永远与实现同步的那一份；本文件只是同一份信息给人查阅的镜像。

也正因为如此，决定调用准确率的是 `description` 的质量。本项目每个工具的说明都写了三件事：什么时候该用、参数是什么语义、边界在哪（比如项目启停工具明确写了「只接受项目 id，不能写命令」）。

如果客户端不支持 MCP，也可以把本文件连同 [后端API说明.md](./后端API说明.md) 一起交给模型，让它按工具语义直接拼 HTTP 请求。但那种方式没有 schema 约束、没有角色过滤，调用准确性和安全性都明显低于走 MCP。

## 二、连接配置

服务端入口是 `src/mcp/main.ts`，通过 stdio 通信。客户端配置示例：

```json
{
  "mcpServers": {
    "gitstatus": {
      "command": "node",
      "args": ["node_modules/tsx/dist/cli.mjs", "src/mcp/main.ts"],
      "cwd": "d:\\1-WorkFile\\program\\gitStatus",
      "env": {
        "GITSTATUS_API_URL": "http://localhost:30012",
        "GITSTATUS_API_KEY": "gsk_你的密钥"
      }
    }
  }
}
```

用 `node` + `tsx` 的 cli 路径而不是 `npx tsx`，是为了绕开 Windows 上 `.cmd` 的 PATH 解析问题。

| 环境变量 | 必填 | 说明 |
| --- | --- | --- |
| `GITSTATUS_API_KEY` | 是 | 账号页「我的 API 密钥」创建，`gsk_` 开头 |
| `GITSTATUS_API_URL` | 否 | 后端地址，默认 `http://127.0.0.1:30012` |
| `GITSTATUS_MCP_TIMEOUT_MS` | 否 | 单次调用超时，默认 20000 |
| `GITSTATUS_MCP_READONLY` | 否 | 设为 `1` 时只注册只读工具，进一步收窄权限 |
| `GITSTATUS_AGENT_PROJECT_CONTROL` | 否 | 设为 `1` 时为本客户端单独开启项目启停，覆盖 config.json |
| `GITSTATUS_AGENT_ALLOWED_PROJECT_IDS` | 否 | 逗号分隔的项目白名单，只放行列出的 id |
| `GITSTATUS_AGENT_MAX_ACTIONS_PER_MINUTE` | 否 | 每项目每分钟动作次数上限，默认 3 |
| `GITSTATUS_CONFIG_PATH` | 否 | 配置路径，默认 `./config/config.json` |

启动时服务端会先调一次 `/auth/me` 验证密钥并取出角色，密钥无效直接退出并在 stderr 给出原因，避免客户端拿到一屏必然失败的工具。

## 三、权限分级

工具可见性由密钥所属账号的**当前角色**决定，每次请求实时查库，改角色立即生效。无权使用的工具不会出现在 `tools/list` 里，而不是调用时才报错：只读账号看不到任何写工具，读写及以上才能看到写工具。各角色可见数量由自动生成区的总表给出。

项目启停工具还多两道门槛：

1. **开关**：`config/config.json` 的 `agent.projectControl` 为 `true`（或本进程设置了 `GITSTATUS_AGENT_PROJECT_CONTROL=1`）才会注册；关闭时这三个工具在 `tools/list` 里完全不存在。
2. **角色**：最低要求 `admin`，读写账号即使开关打开也看不到。

另有 `allowedProjectIds` 白名单（空表示全部）与每项目每分钟 3 次限流。MCP 通道无法做人工确认，所以真正的护栏是“默认关闭 + 管理员 + 白名单”；内置助手在页面上还会弹一次确认，展示将要执行的命令原文。

## 四、和 HTTP 接口的关系

MCP 服务不直接访问数据库，而是作为 `/gitstatus/api` 的普通客户端：

```
MCP 客户端 → stdio → src/mcp → HTTP(Bearer gsk_) → Express 路由 → SQLite
```

这样归属校验、共享权限、完成口径、审计日志全部沿用后端原有链路，MCP 层只做「参数收敛 + 结果投影」。各工具的接口前缀见每组标题下方。

要对照字段级细节，看 [后端API说明.md](./后端API说明.md)。

为什么项目启停默认关闭、为何命令执行与项目配置写入永远不开放，见 [AI能力边界与安全约定.md](./AI能力边界与安全约定.md)。

## 五、工具清单（自动生成）
共 30 个工具，按域名分组。`角色` 是最低可调用角色，低于该角色的账号完全看不到该工具。

### 角色可见性总表

| 角色 | 可见工具 | 可写工具 | 只读工具 |
| --- | --- | --- | --- |
| 只读（`readonly`） | 14 | 0 | 14 |
| 读写（`readwrite`） | 27 | 13 | 14 |
| 管理员（`admin`） | 30 | 16 | 14 |

### 账号（1 个）

对应接口：`/gitstatus/api/auth/me`

#### `gitstatus_whoami` · 查看当前身份

> 返回当前 API 密钥所属账号的用户名、角色（readonly/readwrite/admin）、状态与最后登录时间。在调用其他工具前可用它确认权限范围。

- 属性：只读 · 最低角色 只读（`readonly`）

无参数。

### 时间（1 个）

对应接口：本地时钟，不访问接口

#### `gitstatus_now` · 获取当前时间

> 返回服务器当前的本地日期与时刻（精确到秒），以及星期和时区。需要计算「两小时后」「今天还剩多久」「明天几点」这类相对时间时，必须先调用它；不要用账号登录时间、待办创建时间等历史记录推算当前时刻。

- 属性：只读 · 最低角色 只读（`readonly`）

无参数。

### 待办（9 个）

对应接口：`/gitstatus/api/todos`

#### `gitstatus_todo_list` · 查询待办列表

> 按日期、状态、分类、标签、关键词等条件列出当前账号可见的待办（含共享给我的任务）。不传 date 时按后端当天日期统计；返回按未完成、逾期、优先级、截止时间排序。

- 属性：只读 · 最低角色 只读（`readonly`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `date` | string | 否 | 统计基准日期，格式 YYYY-MM-DD，默认今天 |
| `status` | string | 否 | 按完成状态过滤；可选值：pending / completed |
| `view` | string | 否 | 视图：all 全部、today 仅当天可见、inbox 仅收件箱；可选值：all / today / inbox |
| `type` | string | 否 | 按调度类型过滤：once 单次、daily 每日重复；可选值：once / daily |
| `categoryId` | integer | 否 | 按分类过滤，传分类 id |
| `tagId` | integer | 否 | 按标签过滤，传标签 id |
| `overdue` | boolean | 否 | 为 true 时只返回逾期未完成的任务 |
| `inbox` | boolean | 否 | 为 true 时只返回未归类到文件夹的收件箱任务 |
| `search` | string | 否 | 按标题或描述关键词搜索 |
| `dueFrom` | string | 否 | 截止日期下界，格式 YYYY-MM-DD |
| `dueTo` | string | 否 | 截止日期上界，格式 YYYY-MM-DD |
| `page` | integer | 否 | 页码，从 1 开始，默认 1 |
| `pageSize` | integer | 否 | 每页条数，默认 200，最大 500 |

#### `gitstatus_todo_get` · 查询单个待办

> 按 id 读取一条待办的完整信息，包含描述、提醒、附件与创建时间。

- 属性：只读 · 最低角色 只读（`readonly`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 待办 id |
| `date` | string | 否 | 用于判断每日任务完成情况的基准日期 |

#### `gitstatus_todo_create` · 新建待办

> 新建一条待办。title 必填；单次任务用 dueDate/dueTime，每日任务用 scheduleType=daily 并给 repeatStartDate。

- 属性：可写 · 最低角色 读写（`readwrite`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 是 | 标题，最多 200 字 |
| `description` | string | 否 | 描述，最多 5000 字 |
| `categoryId` | integer | 否 | 放入的分类 id，不传即收件箱 |
| `priority` | string | 否 | 优先级，默认 normal；可选值：high / normal / low |
| `scheduleType` | string | 否 | 调度类型，默认 once；可选值：once / daily |
| `dueDate` | string | 否 | 截止日期 YYYY-MM-DD（单次任务） |
| `dueTime` | string | 否 | 截止时刻 HH:mm（需同时给 dueDate） |
| `repeatStartDate` | string | 否 | 每日任务开始日期 YYYY-MM-DD |
| `repeatEndDate` | string | 否 | 每日任务结束日期 YYYY-MM-DD |
| `tagIds` | integer[] | 否 | 标签 id 列表 |
| `sortOrder` | integer | 否 | 排序值，默认 0 |
| `attachmentIds` | integer[] | 否 | 要随待办一起保存的对话附件编号（消息里以 #编号 标注）。只在「AI 助手」页的对话里有效，编号必须是本会话消息中列出的附件 |

#### `gitstatus_todo_update` · 修改待办

> 按 id 修改待办，只传需要变更的字段；字段语义与新建一致。修改每日任务的重复区间会同时改变它的可见范围。

- 属性：可写 · 最低角色 读写（`readwrite`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 待办 id |
| `title` | string | 否 | 新标题 |
| `description` | string | 否 | 新描述 |
| `categoryId` | integer | null | 否 | 移动到该分类；传 null 表示移回收件箱（可传 null） |
| `priority` | string | 否 | 新优先级；可选值：high / normal / low |
| `scheduleType` | string | 否 | 新调度类型；可选值：once / daily |
| `dueDate` | string | 否 | 新截止日期 YYYY-MM-DD |
| `dueTime` | string | 否 | 新截止时刻 HH:mm |
| `repeatStartDate` | string | 否 | 每日任务开始日期 |
| `repeatEndDate` | string | 否 | 每日任务结束日期 |
| `tagIds` | integer[] | 否 | 替换后的标签 id 列表 |
| `sortOrder` | integer | 否 | 新排序值 |
| `attachmentIds` | integer[] | 否 | 追加到这条待办的对话附件编号；已有的附件不受影响 |

#### `gitstatus_todo_delete` · 删除待办

> 按 id 删除一条待办。删除不可恢复，对共享任务需要写权限。

- 属性：可写 · 最低角色 读写（`readwrite`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 待办 id |

#### `gitstatus_todo_complete` · 完成待办

> 把待办标记为完成。单次任务以服务器当天为完成日期；每日任务可传 date 指定完成哪一天。

- 属性：可写 · 最低角色 读写（`readwrite`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 待办 id |
| `date` | string | 否 | 每日任务的完成日期 YYYY-MM-DD |

#### `gitstatus_todo_reopen` · 取消完成

> 取消待办的完成状态。单次任务始终清空完成记录；每日任务可传 date 只取消该天。

- 属性：可写 · 最低角色 读写（`readwrite`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 待办 id |
| `date` | string | 否 | 每日任务要取消的日期 YYYY-MM-DD |

#### `gitstatus_todo_set_reminder` · 设置待办提醒

> 给待办设置提醒。单次任务用 remindAt（YYYY-MM-DD HH:mm，必须是将来的时间）；每日任务用 remindTime（HH:mm），按该任务的重复区间滚动触发。

- 属性：可写 · 最低角色 读写（`readwrite`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 待办 id |
| `remindAt` | string | 否 | 单次任务的提醒时刻 YYYY-MM-DD HH:mm |
| `remindTime` | string | 否 | 每日任务的提醒时刻 HH:mm |

#### `gitstatus_todo_clear_reminder` · 清除待办提醒

> 删除待办已设置的提醒。

- 属性：可写 · 最低角色 读写（`readwrite`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 待办 id |

### 分类（4 个）

对应接口：`/gitstatus/api/todo-categories`

#### `gitstatus_category_list` · 查询分类树

> 列出当前账号可见的分类（含共享给我的分类），带父子关系与颜色。

- 属性：只读 · 最低角色 只读（`readonly`）

无参数。

#### `gitstatus_category_create` · 新建分类

> 新建一个分类，可用 parentId 挂到已有分类下形成子树。

- 属性：可写 · 最低角色 读写（`readwrite`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 分类名，最多 80 字 |
| `parentId` | integer | 否 | 父分类 id，不传为根分类 |
| `color` | string | 否 | 颜色值，如 #1f7a4d |
| `sortOrder` | integer | 否 | 排序值，默认 0 |

#### `gitstatus_category_update` · 修改分类

> 按 id 修改分类的名称、父分类、颜色或排序。

- 属性：可写 · 最低角色 读写（`readwrite`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 分类 id |
| `name` | string | 否 | 新名称 |
| `parentId` | integer | null | 否 | 新父分类 id，传 null 表示改为根分类（可传 null） |
| `color` | string | 否 | 新颜色值 |
| `sortOrder` | integer | 否 | 新排序值 |

#### `gitstatus_category_delete` · 删除分类

> 按 id 删除分类。分类下的待办会按后端规则处理，操作前建议先确认分类内容。

- 属性：可写 · 最低角色 读写（`readwrite`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 分类 id |

### 标签（4 个）

对应接口：`/gitstatus/api/todo-tags`

#### `gitstatus_tag_list` · 查询标签

> 列出当前账号可用的全部标签。

- 属性：只读 · 最低角色 只读（`readonly`）

无参数。

#### `gitstatus_tag_create` · 新建标签

> 新建一个标签，名称在同一账号内唯一。

- 属性：可写 · 最低角色 读写（`readwrite`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 标签名，最多 40 字 |
| `color` | string | 否 | 颜色值，默认 #0969da |

#### `gitstatus_tag_update` · 修改标签

> 按 id 修改标签名称或颜色。

- 属性：可写 · 最低角色 读写（`readwrite`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 标签 id |
| `name` | string | 否 | 新名称 |
| `color` | string | 否 | 新颜色值 |

#### `gitstatus_tag_delete` · 删除标签

> 按 id 删除标签，待办上对该标签的引用会一并解除。

- 属性：可写 · 最低角色 读写（`readwrite`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 标签 id |

### 共享（1 个）

对应接口：`/gitstatus/api/todo-shares`

#### `gitstatus_share_list` · 查询共享关系

> 查询待办共享关系。scope=mine 我共享出去的、received 别人共享给我的、all 全部（仅管理员）。

- 属性：只读 · 最低角色 只读（`readonly`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `scope` | string | 否 | 查询范围，默认 mine；可选值：mine / received / all |

### 汇总（1 个）

对应接口：`/gitstatus/api/todo-widget/summary`

#### `gitstatus_today_summary` · 今日待办汇总

> 读取与桌宠挂件相同的今日汇总：未完成/逾期/已完成数量、前三条预览、临期提醒与下一次提醒时间。

- 属性：只读 · 最低角色 只读（`readonly`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `since` | string | 否 | 提醒事件回溯起点 YYYY-MM-DD HH:mm，默认 5 分钟前 |

### 项目（8 个）

对应接口：`/gitstatus/api/projects`

#### `gitstatus_project_list` · 查询项目列表

> 列出项目管理中的项目。默认只返回 id、名称、状态与 pid，够用来定位项目；只有用户明确问启动命令、目录路径或自定义命令时才传 verbose=true。启停需要 gitstatus_project_start / stop / restart（受开关控制，仅管理员）。

- 属性：只读 · 最低角色 只读（`readonly`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `verbose` | boolean | 否 | 返回启动命令、路径、文件夹与自定义命令；默认 false |

#### `gitstatus_project_folders` · 查询项目文件夹

> 列出项目管理使用的项目文件夹及其路径与排序。

- 属性：只读 · 最低角色 只读（`readonly`）

无参数。

#### `gitstatus_project_logs` · 读取项目运行日志

> 读取某个项目当前运行实例的日志。可用 after 做增量拉取：传上次返回的 nextSeq。默认只回最后 40 条，够看启动过程；要更多再传 tail。

- 属性：只读 · 最低角色 只读（`readonly`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 项目 id |
| `after` | integer | 否 | 只返回 seq 大于该值的日志，用于增量拉取 |
| `tail` | integer | 否 | 只显示最后 N 条，默认 100 |

#### `gitstatus_project_run_logs` · 读取自定义命令日志

> 读取项目中某次自定义命令运行（run）的日志输出。

- 属性：只读 · 最低角色 只读（`readonly`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 项目 id |
| `runId` | string | 是 | 运行记录 id |
| `tail` | integer | 否 | 只显示最后 N 条，默认 40 |

#### `gitstatus_project_usage` · 查询项目资源占用

> 读取项目管理侧统计的进程占用信息（只读）。

- 属性：只读 · 最低角色 只读（`readonly`）

无参数。

#### `gitstatus_project_start` · 启动项目

> 启动项目管理中某个已配置启动命令的项目（按 id）。该工具需要 config/config.json 的 agent.projectControl 开启后才存在，且仅管理员可用。启动前先确认项目当前状态，已经运行的项目不要重复启动。内置助手会在执行前请用户在页面上确认，并展示将要执行的命令；传入的只有项目 id，不能指定或修改命令内容。

- 属性：可写 · 最低角色 管理员（`admin`）
- 开关：需 `agent.projectControl` 开启后才会注册，默认关闭

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 要启动的项目 id |

#### `gitstatus_project_stop` · 停止项目

> 停止某个正在运行的项目（按 id），会结束该项目当前实例及其子进程。该工具需要 config/config.json 的 agent.projectControl 开启后才存在，且仅管理员可用。启动前先确认项目当前状态，已经运行的项目不要重复启动。停止前建议先用 gitstatus_project_logs 看看它在做什么。

- 属性：可写 · 最低角色 管理员（`admin`）
- 开关：需 `agent.projectControl` 开启后才会注册，默认关闭

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 要停止的项目 id |

#### `gitstatus_project_restart` · 重启项目

> 重启某个项目（先停止再启动，按 id）。该工具需要 config/config.json 的 agent.projectControl 开启后才存在，且仅管理员可用。启动前先确认项目当前状态，已经运行的项目不要重复启动。改完配置或端口被占用时用这个；不要连续反复调用。

- 属性：可写 · 最低角色 管理员（`admin`）
- 开关：需 `agent.projectControl` 开启后才会注册，默认关闭

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 要重启的项目 id |

### 端口（只读）（1 个）

对应接口：`/gitstatus/api/projects/ports/:port`

#### `gitstatus_port_lookup` · 查询端口占用

> 查询某个本地端口当前被哪些连接占用（只读），用于排查端口冲突。

- 属性：只读 · 最低角色 只读（`readonly`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `port` | integer | 是 | 端口号，1-65535 |
