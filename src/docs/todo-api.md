# Todolist API

基础路径：`/gitstatus/api`

除注册、登录外，所有 Todolist 接口都需要：

```http
Authorization: Bearer <token>
```

任务、分类、标签、完成记录和图片默认按当前登录用户隔离；通过“数据共享”，其他用户可以在授权范围内访问这些数据（见第 7 节）。

## 1. 分类文件夹

分类支持多级父子目录，一个任务只能选择一个分类。

### 查询分类

```http
GET /todo-categories
```

返回平铺数组，通过 `parentId` 组成树：

```json
{
  "res": true,
  "categories": [
    {
      "id": 1,
      "parentId": null,
      "name": "学习",
      "color": "#2da44e",
      "sortOrder": 0,
      "createdAt": "2026-05-21 10:00:00",
      "updatedAt": "2026-05-21 10:00:00"
    }
  ]
}
```

### 新增分类

```http
POST /todo-categories
Content-Type: application/json

{
  "name": "英语",
  "parentId": 1,
  "color": "#0969da",
  "sortOrder": 0
}
```

### 修改分类

```http
PATCH /todo-categories/:id
```

支持修改 `name`、`parentId`、`color`、`sortOrder`。禁止把分类移动到自身或自己的子孙分类下。

### 删除分类

```http
DELETE /todo-categories/:id
```

只有空分类可以删除。存在子分类或未删除任务时返回 `409`。

## 2. 标签

### 查询标签

```http
GET /todo-tags
```

### 新增标签

```http
POST /todo-tags
Content-Type: application/json

{
  "name": "长期",
  "color": "#bf8700"
}
```

### 修改标签

```http
PATCH /todo-tags/:id
```

### 删除标签

```http
DELETE /todo-tags/:id
```

删除标签会自动解除任务关联，不删除任务。

## 3. 任务

### 查询任务列表

```http
GET /todos
```

查询参数：

| 参数 | 说明 |
|---|---|
| `date` | 计算每日任务完成状态的日期，默认今天，格式 `YYYY-MM-DD`；不等同于创建时间筛选 |
| `categoryId` | 分类 ID |
| `includeDescendants` | 传 `false` 时只查询当前文件夹；默认包含子文件夹 |
| `createdDate` | 按单日筛选创建时间，格式 `YYYY-MM-DD` |
| `createdFrom` | 创建时间起始值，格式 `YYYY-MM-DD HH:mm` 或 `YYYY-MM-DDTHH:mm`，精确到分钟（包含） |
| `createdTo` | 创建时间结束值，格式 `YYYY-MM-DD HH:mm` 或 `YYYY-MM-DDTHH:mm`，精确到分钟（包含） |
| `dueDate` | 按单日截止日期筛选，格式 `YYYY-MM-DD` |
| `dueFrom` | 截止日期范围起始值，格式 `YYYY-MM-DD`，包含 |
| `dueTo` | 截止日期范围结束值，格式 `YYYY-MM-DD`，包含 |
| `tagId` | 标签 ID |
| `type` | `once` / `daily` |
| `status` | `pending` / `completed` |
| `view` | `all` / `today` / `inbox` |
| `inbox` | 传 `1` 或 `true` 时只查询收件箱任务，可与 `view=today` 组合 |

`view=today` 会按 `date` 选择当天待办（可见性口径）：每日任务在有效区间内出现；未完成的单次任务从创建日期起每天出现，逾期后继续显示直到完成（后续日期用于提示超时）；已完成的单次任务只出现在完成日期，有截止日期时也会出现在截止日期。

「当日待办计数」是独立口径：没到截止日期的未完成单次任务不计入当天计数（不算当日未完成），只有到达截止日期当天及逾期后才计入，直到完成；每日任务仍按重复区间计数；已完成任务按完成日期/截止日期计数。

任务 DTO 的 `isOverdue` 始终按服务器当前时间判断（截止日期早于今天，或截止日期是今天且已过截止时刻），与 `date` / 日历选中日期无关。
| `search` | 搜索标题和描述 |
| `page` | 页码，默认 1 |
| `pageSize` | 每页数量，默认 200，最大 500 |

所有任务始终包含服务端生成的 `createdAt` 和 `updatedAt`。`updatedAt` 会在任务内容、完成状态、提醒或附件发生变化时更新。

响应示例：

```json
{
  "res": true,
  "total": 2,
  "page": 1,
  "pageSize": 200,
  "date": "2026-05-21",
  "todos": [
    {
      "id": 1,
      "title": "背 20 个单词",
      "description": "",
      "categoryId": 2,
      "category": { "id": 2, "name": "英语" },
      "tags": [{ "id": 1, "name": "长期", "color": "#bf8700" }],
      "images": [
        {
          "id": 1,
          "kind": "image",
          "originalName": "word.png",
          "mimeType": "image/png",
          "size": 12345,
          "url": "/gitstatus/api/todo-attachments/1",
          "createdAt": "2026-05-21 10:00:00"
        }
      ],
      "attachments": [
        {
          "id": 1,
          "kind": "image",
          "originalName": "word.png",
          "mimeType": "image/png",
          "size": 12345,
          "url": "/gitstatus/api/todo-attachments/1",
          "createdAt": "2026-05-21 10:00:00"
        },
        {
          "id": 2,
          "kind": "file",
          "originalName": "notes.pdf",
          "mimeType": "application/pdf",
          "size": 90210,
          "url": "/gitstatus/api/todo-attachments/2",
          "createdAt": "2026-05-21 10:00:01"
        }
      ],
      "priority": "normal",
      "scheduleType": "daily",
      "dueDate": null,
      "dueTime": null,
      "repeatStartDate": "2026-05-21",
      "repeatEndDate": null,
      "isCompleted": false,
      "completedAt": null,
      "completionDate": null,
      "isOverdue": false,
      "isActiveOnDate": true,
      "createdAt": "2026-05-21 10:00:00",
      "updatedAt": "2026-05-21 10:00:00",
      "reminder": {
        "id": 1,
        "type": "daily",
        "remindAt": null,
        "remindTime": "21:00",
        "enabled": true,
        "nextTriggerAt": "2026-05-21 21:00:00"
      }
    }
  ]
}
```

### 新增单次任务

截止日期和截止时间均可以省略。`dueTime` 使用 `HH:mm` 格式，精确到分钟；设置 `dueTime` 时必须同时设置 `dueDate`，否则返回 `400`。

```http
POST /todos
Content-Type: application/json

{
  "title": "整理照片",
  "description": "选 20 张冲印",
  "categoryId": 3,
  "tagIds": [1, 2],
  "priority": "high",
  "scheduleType": "once",
  "dueDate": "2026-05-22",
  "dueTime": "18:30"
}
```

### 新增每日任务

```http
POST /todos
Content-Type: application/json

{
  "title": "背 20 个单词",
  "categoryId": 2,
  "tagIds": [1],
  "priority": "normal",
  "scheduleType": "daily",
  "repeatStartDate": "2026-05-21",
  "repeatEndDate": null
}
```

`repeatEndDate` 可空，表示一直重复；有值时包含结束日期。

### 查询单个任务

```http
GET /todos/:id?date=2026-05-21
```

### 修改任务

```http
PATCH /todos/:id
```

请求体为部分字段，单次任务可通过 `dueDate` / `dueTime` 更新截止日期与分钟级截止时间。切换 `scheduleType` 时会自动停用原提醒，需重新设置提醒。

### 删除任务

```http
DELETE /todos/:id
```

任务采用软删除，默认不会出现在查询结果中。

## 4. 完成记录

### 标记完成

```http
POST /todos/:id/complete
Content-Type: application/json

{
  "date": "2026-05-21"
}
```

- 单次任务只会保留一条完成记录，重复调用保持幂等。
- 每日任务按日期分别记录，每天可独立完成。
- 每日任务的 `date` 必须位于任务重复区间内。

### 取消完成

```http
DELETE /todos/:id/complete?date=2026-05-21
```

单次任务可以省略 `date`，此时删除该任务的全部完成记录。

## 5. 提醒

一个任务 V1 最多配置一个提醒。提醒由后端每 30 秒扫描一次，直接弹出 Windows 系统通知，不依赖浏览器页面。

### 单次提醒

适用于 `scheduleType = once` 的任务。即使任务没有截止日期，也可以设置。

```http
PUT /todos/:id/reminder
Content-Type: application/json

{
  "reminderType": "once",
  "remindAt": "2026-05-22 20:00:00"
}
```

只触发一次；发送后会停用。若触发前任务已完成，则跳过并停用。

### 每日提醒

适用于 `scheduleType = daily` 的任务：

```http
PUT /todos/:id/reminder
Content-Type: application/json

{
  "reminderType": "daily",
  "remindTime": "21:00"
}
```

行为：

- 在每日任务的重复日期范围内，每天最多提醒一次。
- 如果当天已经有完成记录，跳过当天提醒，并安排下一次。
- 后端离线期间错过的每日提醒不补发。

### 删除提醒

```http
DELETE /todos/:id/reminder
```

提醒日志存放在 `todo_notification_logs`，状态包括：

- `sent`：Windows 通知已成功发送。
- `skipped`：已完成、任务已删除或错过每日提醒。
- `failed`：发送失败。

## 6. 附件

附件分两类：图片（可预览）与其他文件（只保存与下载，不做预览）。

| 类型 | 数量上限 | 单个大小上限 | 说明 |
|---|---:|---:|---|
| 图片 | 5 | 8 MB | JPEG、PNG、GIF、WebP、BMP、AVIF，读取时按图片内联返回 |
| 其他文件 | 10 | 32 MB | 不限制常见文档/压缩包格式，读取时强制下载 |

可执行文件后缀（`.exe`、`.msi`、`.bat`、`.cmd`、`.ps1`、`.js`、`.jar` 等）会被拒绝。

### 上传附件

字段名支持 `images`、`files` 或 `file`；通过 `images` 字段上传非图片会被拒绝。图片与其他文件可以放在同一个请求里：

```http
POST /todos/:id/attachments
Content-Type: multipart/form-data
Authorization: Bearer <token>

images=@photo1.png
files=@report.pdf
```

响应包含全部附件元数据和最新任务数据：

```json
{
  "res": true,
  "attachments": [
    {
      "id": 1,
      "kind": "image",
      "originalName": "photo1.png",
      "mimeType": "image/png",
      "size": 12345,
      "url": "/gitstatus/api/todo-attachments/1",
      "createdAt": "2026-05-21 10:00:00"
    },
    {
      "id": 2,
      "kind": "file",
      "originalName": "report.pdf",
      "mimeType": "application/pdf",
      "size": 90210,
      "url": "/gitstatus/api/todo-attachments/2",
      "createdAt": "2026-05-21 10:00:01"
    }
  ],
  "images": [],
  "todo": {}
}
```

### 查询任务附件列表

```http
GET /todos/:id/attachments
```

`GET /todos/:id/images` 仍然保留，只返回 `kind=image` 的附件。

### 读取附件

```http
GET /todo-attachments/:attachmentId
Authorization: Bearer <token>
```

- 图片：按原始 `Content-Type` 内联返回，可直接用于 `<img>`；
- 其他文件：`Content-Type: application/octet-stream` + `Content-Disposition: attachment`，浏览器会下载而不是内联执行。

附件接口同样需要认证。前端不能直接给 `<img src>` 设置 Authorization 请求头，应使用带 Token 的 `fetch` 获取 Blob，再通过 `URL.createObjectURL()` 展示或下载。旧的 `/todo-images/:id` 路径仍然可用。

### 用系统默认程序打开附件

```http
GET /todo-attachments/:attachmentId/open
Authorization: Bearer <token>
```

浏览器无法直接调用本地程序，因此由后端代劳：服务端把附件以原始文件名复制到系统临时目录（`<tmp>/gitstatus-open/`，超过 24 小时的副本会被自动清理），再交给系统默认程序打开（Windows 用 `cmd /c start`，macOS 用 `open`，Linux 用 `xdg-open`）。

注意事项：

- **只允许本机调用**：服务端检查连接来源，非 loopback（含 `X-Forwarded-For` 指向外部地址）返回 `403 system open is only available on the host machine`，避免远程设备触发宿主机打开程序；
- 前端通过 `/auth/me` 返回的 `local` 字段判断是否本机：本机点击用系统默认程序打开，其他设备改为浏览器内预览（PDF、文本、音视频）或下载；
- 只对 `kind=file` 的附件生效，图片请使用浏览器内预览（传图片 ID 返回 `400`）；
- 读取仍然校验任务访问权限，无权限的用户无法触发；
- 上传阶段已拒绝可执行文件后缀，降低误打开风险。

### 删除附件

```http
DELETE /todos/:id/attachments/:attachmentId
```

会同时删除数据库记录和磁盘文件；`DELETE /todos/:id/images/:imageId` 仍然兼容。

附件文件保存在 `src/output/todo-images/<userId>/`（目录名沿用历史命名），该目录已经被 `.gitignore` 中的 `src/output/*` 排除。

## 7. 数据共享

可以将自己的某个文件夹（含子文件夹）或收件箱共享给其他用户，并授予只读或可编辑权限。

| 权限 | 说明 |
|---|---|
| `readonly` | 只读：查看共享范围内的任务，不能修改 |
| `write` | 可编辑：对共享范围内的任务增删改 |

共享任务与共享分类的响应会额外包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ownerId` | number | 数据所有者 ID |
| `ownerUsername` | string \| null | 数据所有者用户名 |
| `permission` | `owner` \| `write` \| `readonly` | 当前用户对该数据的权限 |
| `shared` | boolean | 是否为共享数据 |

### 共享可选项

```http
GET /todo-shares/options
```

返回 `categories`（含 `path`、`taskCount`）、`inboxCount`、可共享的启用用户 `users`，以及 `isAdmin`。

### 共享列表

```http
GET /todo-shares?scope=mine|received|all
```

| scope | 说明 |
|---|---|
| `mine` | 我共享出去的（默认） |
| `received` | 共享给我的 |
| `all` | 全部共享（仅管理员） |

### 创建共享

```http
POST /todo-shares
Content-Type: application/json

{
  "granteeId": 2,
  "scope": "category",
  "categoryId": 10,
  "permission": "write"
}
```

`scope` 为 `category` 时必须提供自己的 `categoryId`；`scope` 为 `inbox` 时不需要 `categoryId`。
重复共享同一范围时直接更新权限并返回 200，新建返回 201。

### 修改共享权限

```http
PATCH /todo-shares/:id
Content-Type: application/json

{ "permission": "readonly" }
```

仅数据所有者或管理员可操作。

### 取消共享

```http
DELETE /todo-shares/:id
```

仅数据所有者或管理员可操作。

### 共享规则

- 只能共享自己的文件夹或收件箱；
- 文件夹共享包含所有子文件夹及其中的任务；
- 共享文件夹本身只能由所有者改名、移动或删除；
- 共享任务保持原所有者，不能移动到其他人的文件夹；
- 在共享文件夹中新建的任务归属文件夹所有者；
- 收件箱共享支持查看和编辑已有任务，但新建任务始终进入自己的收件箱；
- 只读共享禁止新增、修改、删除任务、切换完成状态、修改提醒和图片；
- 系统角色为 `readonly` 的账号仍然不能执行写操作，共享写权限对 `readwrite` 及以上角色生效；
- 管理员可以在 `scope=all` 中查看全部共享，并可调整权限或取消共享。

## 8. 桌宠挂件

页面右下角的桌宠挂件通过一个只读接口获取当天待办摘要与提醒事件，需要登录态。

```http
GET /todo-widget/summary?since=YYYY-MM-DD%20HH:mm
Authorization: Bearer <token>
```

| 参数 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `since` | string | 否 | 上次同步到的服务端时间（`YYYY-MM-DD HH:mm`），用于增量返回提醒事件；默认返回最近 5 分钟 |

**响应：**

```json
{
  "res": true,
  "now": "2026-10-23 13:11:18",
  "today": "2026-10-23",
  "settings": {
    "intervalEnabled": true,
    "intervalMinutes": 60,
    "intervalWithinWorkHours": true,
    "workStart": "09:00",
    "workEnd": "18:00",
    "workStartEnabled": true,
    "workEndEnabled": true,
    "dueLeadMinutes": 15,
    "updatedAt": "2026-10-23 13:05:00"
  },
  "stats": { "pending": 2, "overdue": 1, "completed": 1, "total": 3 },
  "preview": [
    {
      "id": 255,
      "title": "今天已逾期的事",
      "priority": "normal",
      "dueDate": "2026-10-23",
      "dueTime": "09:00",
      "isOverdue": true
    }
  ],
  "dueSoon": [
    {
      "key": "due|254|2026-10-23 18:00:00",
      "todoId": 254,
      "title": "今天要做的事",
      "dueAt": "2026-10-23 18:00:00",
      "minutesLeft": 12,
      "scheduleType": "once",
      "priority": "high"
    }
  ],
  "nextReminder": {
    "reminderId": 19,
    "todoId": 254,
    "title": "今天要做的事",
    "triggerAt": "2026-10-23 15:11:18",
    "type": "once",
    "dueDate": "2026-10-23",
    "dueTime": "18:00",
    "priority": "high"
  },
  "events": [
    {
      "key": "20|2026-10-23 13:09:18",
      "reminderId": 20,
      "todoId": 255,
      "title": "今天已逾期的事",
      "triggerAt": "2026-10-23 13:09:18",
      "status": "failed",
      "createdAt": "2026-10-23 13:11:18"
    }
  ]
}
```

说明：

- `stats` 只统计当前用户自己的任务，使用「当日待办计数」口径：每日任务按重复区间；未完成单次任务在到达截止日期当天及之后才计入（未到截止日期不计入、不算当日未完成），逾期后持续计入直到完成；已完成任务按完成日期/截止日期计入；
- `overdue` 与任务 DTO 的 `isOverdue` 一致：按服务器当前时间判断（日期已过，或当天已过截止时刻），与请求的 `date` 无关；
- `preview` 与 `stats` 同口径，最多返回 3 条待完成任务的标题与时间，逾期优先；
- `dueSoon` 是即将到达截止时间的任务，最多 5 条：
  - 单次任务按 `dueDate + dueTime` 计算截止时刻；
  - 重复任务按 `repeatEndDate + workEnd` 计算；
  - 只有日期没有具体时间的任务，按设置里的下班时间 `workEnd` 计算；
  - `dueLeadMinutes` 为 0 时返回空数组；前端用 `key` 去重；
- `nextReminder` 是下一条将要触发的提醒（未被启用或任务已完成时不返回）；
- `events` 来自 `todo_notification_logs`，只包含 `sent` / `failed` 的提醒记录，前端用 `key` 去重，避免同一提醒重复打扰；
- 前端轮询间隔默认 25 秒，页面隐藏时暂停。

### 桌宠提醒设置

设置按账号保存在 `pet_settings` 表，桌宠气泡内的设置面板直接读写这两个接口。

```http
GET /todo-widget/settings
Authorization: Bearer <token>
```

**响应：**

```json
{ "res": true, "settings": { "intervalEnabled": true, "intervalMinutes": 60, "...": "..." } }
```

完整字段：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `intervalEnabled` | boolean | `true` | 是否开启间隔提醒 |
| `intervalMinutes` | number | `60` | 间隔分钟数，5 - 480 |
| `intervalWithinWorkHours` | boolean | `false` | 间隔提醒是否只在工作时间内生效 |
| `workStart` | string | `"09:00"` | 上班时间，`HH:mm` |
| `workEnd` | string | `"18:00"` | 下班时间，`HH:mm`，必须晚于 `workStart` |
| `workStartEnabled` | boolean | `true` | 是否在上班时间提醒 |
| `workEndEnabled` | boolean | `true` | 是否在下班时间提醒 |
| `dueLeadMinutes` | number | `15` | 截止前提前提醒分钟数，0 - 1440，0 表示关闭 |
| `petImageUrl` | string \| null | `null` | 只读：当前账号角色素材地址（带版本参数），未上传时为 `null` |

`petImageUrl` 只出现在响应里，写入设置时不需要传。

```http
PUT /todo-widget/settings
Content-Type: application/json

{
  "intervalEnabled": true,
  "intervalMinutes": 30,
  "intervalWithinWorkHours": true,
  "workStart": "09:00",
  "workEnd": "18:30",
  "workStartEnabled": true,
  "workEndEnabled": true,
  "dueLeadMinutes": 15
}
```

可以只传需要修改的字段，未传的字段沿用当前值。校验失败返回 `400`：

- `intervalMinutes` 不在 5 - 480；
- `dueLeadMinutes` 不在 0 - 1440；
- 时间不是 `HH:mm`；
- `workEnd` 不晚于 `workStart`。

### 前端提醒逻辑

| 提醒 | 计算位置 | 规则 |
|---|---|---|
| 间隔提醒 | 前端 | 有未完成待办时按 `intervalMinutes` 计时；开启 `intervalWithinWorkHours` 时仅在工作时间内触发 |
| 上下班提醒 | 前端 | 到达 `workStart` / `workEnd` 后的 10 分钟窗口内，如仍有未完成待办则提醒一次，每天各一次 |
| 截止提醒 | 后端 | `dueSoon` 中返回即将截止的任务，前端按 `key` 去重后冒泡 |
| 任务自带提醒 | 后端 | 原有的 `todo_reminders` 调度器，通过 `events` 增量下发 |

### 角色素材

角色图片按账号保存在服务端 `src/output/pet-assets/`，文件名形如 `<userId>-<uuid>.<ext>`；读取需要登录态。

**上传 / 替换**

```http
POST /todo-widget/assets/pet
Content-Type: multipart/form-data
Authorization: Bearer <token>

file=@whale.png
```

| 限制 | 说明 |
|---|---|
| 大小 | 最大 2MB |
| 类型 | PNG / JPEG / WebP / GIF / BMP / AVIF |

成功返回 `201`，`settings.petImageUrl` 为新的素材地址（带文件名版本参数，替换后地址自动变化）：

```json
{ "res": true, "settings": { "petImageUrl": "/gitstatus/api/todo-widget/assets/pet?v=1-xxxx.png", "...": "..." } }
```

替换时会删除旧文件。

**读取**

```http
GET /todo-widget/assets/pet
Authorization: Bearer <token>
```

返回图片字节，`Cache-Control: private, no-store`；没有上传过素材时返回 `404`。前端需要用带 Token 的 `fetch` 取回 Blob 后再展示，不能直接给 `<img src>` 加请求头。

**恢复默认**

```http
DELETE /todo-widget/assets/pet
```

删除当前账号的素材文件并把 `pet_image` 置空，返回的 `settings.petImageUrl` 为 `null`，前端回退到内置造型。
