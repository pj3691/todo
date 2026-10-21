# Todolist API

基础路径：`/gitstatus/api`

除注册、登录外，所有 Todolist 接口都需要：

```http
Authorization: Bearer <token>
```

任务、分类、标签、完成记录和图片均按当前登录用户隔离。

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
| `search` | 搜索标题和描述 |
| `page` | 页码，默认 1 |
| `pageSize` | 每页数量，默认 200，最大 500 |

所有任务始终包含服务端生成的 `createdAt` 和 `updatedAt`。`updatedAt` 会在任务内容、完成状态、提醒或图片附件发生变化时更新。

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
          "originalName": "word.png",
          "mimeType": "image/png",
          "size": 12345,
          "url": "/gitstatus/api/todo-images/1",
          "createdAt": "2026-05-21 10:00:00"
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

## 6. 图片附件

图片以任务附件形式保存。单个任务最多上传 5 张，单张最大 8 MB，支持 JPEG、PNG、GIF、WebP、BMP、AVIF。

### 上传图片

字段名支持 `images` 或 `file`：

```http
POST /todos/:id/images
Content-Type: multipart/form-data
Authorization: Bearer <token>

images=@photo1.png
images=@photo2.jpg
```

响应包含图片元数据和最新任务数据：

```json
{
  "res": true,
  "images": [
    {
      "id": 1,
      "originalName": "photo1.png",
      "mimeType": "image/png",
      "size": 12345,
      "url": "/gitstatus/api/todo-images/1",
      "createdAt": "2026-05-21 10:00:00"
    }
  ],
  "todo": {}
}
```

### 查询任务图片列表

```http
GET /todos/:id/images
```

### 读取图片

```http
GET /todo-images/:imageId
Authorization: Bearer <token>
```

图片接口同样需要认证。前端不能直接给 `<img src>` 设置 Authorization 请求头，应使用带 Token 的 `fetch` 获取 Blob，再通过 `URL.createObjectURL()` 展示。

### 删除图片

```http
DELETE /todos/:id/images/:imageId
```

会同时删除数据库记录和磁盘文件。

图片文件保存在 `src/output/todo-images/<userId>/`，该目录已经被 `.gitignore` 中的 `src/output/*` 排除。




