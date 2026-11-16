# 后端 API 说明

GitStatus 后端的完整接口手册：路径、参数、权限、响应示例与错误码。

- 启动方式见 [../README.md](../README.md)
- 桌面版如何调用这些接口见 [桌面端使用说明.md](./桌面端使用说明.md)

## 目录

- [通用约定](#一通用约定)
- [认证 API](#二认证-api)
- [用户管理 API](#三用户管理-api仅管理员)
- [仓库管理 API](#四仓库管理-api)
- [博客文章 API](#五博客文章-api)
- [待办 API](#六待办-api)
- [待办附件 API](#七待办附件-api)
- [数据共享 API](#八数据共享-api)
- [桌宠挂件 API](#九桌宠挂件-api)
- [项目管理 API](#十项目管理-api)
- [静态资源与页面路由](#十一静态资源与页面路由)
- [数据结构汇总](#十二数据结构汇总)
- [日志与配置](#十三日志与配置)

---

## 一、通用约定

### 基础地址

```
http://localhost:30012/gitstatus/api
```

下文所有接口路径都省略前缀 `/gitstatus/api`，写作 `/todos`、`/auth/login` 等。

### 响应包裹

所有 JSON 响应统一带 `res` 字段：

```json
{ "res": true, "...": "业务数据" }
```

```json
{ "res": false, "message": "错误描述" }
```

### 认证方式

需要登录的接口在请求头携带注册 / 登录返回的 token：

```
Authorization: Bearer <token>
```

Token 有效期由 `config.json` 的 `jwtExpiresIn` 决定（默认 `7d`）。

| 状态码 | 触发场景 |
|---|---|
| 401 | 未携带 `Authorization`（`missing or invalid token`）、token 失效或被篡改（`invalid or expired token`）、用户已被删除（`user no longer exists`） |
| 403 | 账号待审核（`account pending approval; ...`）或已禁用（`account is disabled`） |

### 角色与权限

角色等级 `readonly < readwrite < admin`，系统**有且只有一个管理员**。权限校验以数据库中的最新角色为准，改角色、禁用账号立即生效，不需要重新登录。

| 角色 | 能做什么 |
|---|---|
| `readonly` | 读：仓库、待办、博客、共享列表；不能执行任何写操作 |
| `readwrite` | 待办 / 博客 / 仓库 / 项目管理的全部读写 |
| `admin` | 读写权限 + 用户管理 |

账号状态：`pending`（待审核，只由注册产生）、`active`、`disabled`。只有 `active` 能登录和调用需认证接口。

各模块的守卫规则：

| 模块 | 读 | 写 |
|---|---|---|
| `/blogs` 查询 | 无需认证 | — |
| `/blogs` 增删改、`/blogs/refresh` | — | `readwrite` 及以上 |
| `/repos` 查询 | 任意登录角色 | — |
| `/repos` 新增、修改、刷新 | — | `readwrite` 及以上 |
| `/todo-*`、`/todos` | 任意登录角色 | `readwrite` 及以上，或对该数据有共享写权限 |
| `/todo-widget/*` | 任意登录角色 | 设置与素材写入随登录用户走 |
| `/projects/*` | `readwrite` 及以上 | `readwrite` 及以上 |
| `/users/*` | 仅 `admin` | 仅 `admin` |

> `/projects/local/quickstart` 是唯一的例外：不校验 token，但只接受本机（loopback）请求。

### 本机限定接口

后端会判断请求来源是否为本机（loopback），在响应里以 `local` 字段返回给前端。以下接口**只能本机调用**，远程访问直接 403：

- `GET /todo-attachments/:id/open`（用系统默认程序打开附件）
- `GET /projects/ports/:port`、`POST /projects/ports/:port/kill`
- `POST /projects/pick-folder`（弹出本机文件夹选择框）
- `POST /projects/folders/open-editor`、`POST /projects/:id/open-editor`
- `POST /projects/local/quickstart`

### 时间与分页格式

| 类型 | 格式 | 示例 |
|---|---|---|
| 日期 | `YYYY-MM-DD` | `2026-04-14` |
| 时刻 | `HH:mm` | `18:30` |
| 日期时间 | `YYYY-MM-DD HH:mm:ss`（服务器本地时区） | `2026-04-14 10:30:00` |

列表类接口普遍使用 `page`（默认 1）+ `pageSize` 分页，响应带回 `total` / `page` / `pageSize`。

### CORS

后端按 `config/config.json` 的 `allowedOrigins` 白名单回 `Access-Control-Allow-Origin`，允许方法 `GET,POST,PATCH,PUT,DELETE,OPTIONS`，允许头 `Content-Type, Authorization`，并开启 `Allow-Credentials`。预检请求不在白名单时返回 403。

---

## 二、认证 API

### 1. 注册

**POST** `/auth/register`

| 字段 | 类型 | 必需 | 校验 |
|---|---|---|---|
| `username` | string | **是** | 去除首尾空格后 3-32 个字符 |
| `password` | string | **是** | 至少 6 个字符 |

**首个注册用户**直接成为管理员并签发 token（`201`）：

```json
{
  "res": true,
  "user": { "id": 1, "username": "admin", "role": "admin", "status": "active", "createdAt": "2026-04-14 10:00:00", "lastLoginAt": null },
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "local": true
}
```

**后续注册用户**进入待审核状态，不返回 token：

```json
{
  "res": true,
  "user": { "id": 2, "username": "alice", "role": "readonly", "status": "pending", "createdAt": "2026-04-14 10:05:00", "lastLoginAt": null },
  "pending": true,
  "message": "registration pending approval"
}
```

| 状态码 | 场景 |
|---|---|
| 400 | 用户名或密码缺失、长度不合规 |
| 409 | 用户名已存在 |
| 429 | 待审核账号数已达 `maxPendingRegistrations` 上限（默认 20）。bcrypt 哈希后会二次校验，防并发突破上限 |

### 2. 登录

**POST** `/auth/login`

| 字段 | 类型 | 必需 |
|---|---|---|
| `username` | string | **是** |
| `password` | string | **是** |

**成功响应 `200`**（同时刷新 `last_login_at`）：

```json
{
  "res": true,
  "user": { "id": 1, "username": "admin", "role": "admin", "status": "active", "createdAt": "2026-04-14 10:00:00", "lastLoginAt": "2026-04-14 11:00:00" },
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "local": true
}
```

| 状态码 | 场景 |
|---|---|
| 400 | 缺少用户名或密码 |
| 401 | 用户不存在或密码错误（`invalid username or password`，不区分两者） |
| 403 | 账号待审核 / 已禁用 |

### 3. 当前用户信息

**GET** `/auth/me`

需要认证。

```json
{
  "res": true,
  "user": { "id": 1, "username": "admin", "role": "admin", "status": "active", "createdAt": "2026-04-14 10:00:00", "lastLoginAt": "2026-04-14 11:00:00" },
  "local": true
}
```

`local` 表示本次请求来自本机，前端据此决定非图片附件是「系统默认程序打开」还是「浏览器预览 / 下载」。

---

## 三、用户管理 API（仅管理员）

全部接口都需要 `admin` 角色。新注册用户以 `pending` 状态出现在列表最前方：

- 审核通过：`PATCH /users/:id`，body `{ "status": "active" }`
- 拒绝注册：`DELETE /users/:id`（该用户数据被删除，无法登录）

### 1. 用户列表

**GET** `/users`

| 参数 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `search` | string | 否 | 按用户名模糊搜索 |
| `role` | string | 否 | `admin` / `readwrite` / `readonly` |
| `status` | string | 否 | `pending` / `active` / `disabled` |
| `page` | string | 否 | 页码，默认 1 |
| `pageSize` | string | 否 | 每页条数，默认 20，最大 100 |
| `sort` | string | 否 | `id` / `username` / `role` / `status` / `created_at` / `last_login_at` |
| `order` | string | 否 | `asc` / `desc`，默认 `asc` |

未显式指定 `sort` 时，`pending` 账号始终排在最前面。

```json
{
  "res": true,
  "total": 4,
  "page": 1,
  "pageSize": 20,
  "pendingCount": 2,
  "users": [
    { "id": 2, "username": "alice", "role": "readonly", "status": "pending", "createdAt": "2026-01-01 10:00:00", "lastLoginAt": null }
  ]
}
```

### 2. 用户详情

**GET** `/users/:id`

响应 `{ "res": true, "user": { ... } }`；`:id` 非法返回 400，不存在返回 404。

### 3. 创建用户

**POST** `/users`

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `username` | string | **是** | 3-32 个字符，唯一 |
| `password` | string | **是** | 至少 6 个字符 |
| `role` | string | 否 | 默认 `readonly`；传 `admin` 返回 400 |
| `status` | string | 否 | 默认 `active` |

管理员创建的用户不占待审核名额，直接可用。成功返回 `201` 与 `{ "res": true, "user": { ... } }`。

### 4. 修改用户

**PATCH** `/users/:id`

可传字段：`username`、`password`（重置密码）、`role`、`status`。`status` 只接受 `active` / `disabled`；`pending` 只能由注册产生，审核时改为 `active`。

保护规则：

- 不能修改自己的角色或状态；
- 不支持把其他用户提升为 `admin`（返回 400）；
- 管理员账号必须保持 `active`；
- 系统必须至少保留一个可用管理员（不能降级、禁用或删除最后一个 active 管理员）。

### 5. 删除用户

**DELETE** `/users/:id`

- 不能删除当前登录账号；
- 级联清理该用户的待办、分类、标签、附件记录及磁盘文件、桌宠角色素材；
- 拒绝待审核注册同样走此接口。

响应 `{ "res": true, "message": "user deleted" }`。

### 6. 迁移用户数据

**POST** `/users/:id/transfer`

把 `:id` 用户的全部待办数据迁移给另一个用户。

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `targetUserId` | number | **是** | 目标用户 ID，不能与源用户相同 |

迁移规则：

- 迁移分类、标签、待办和附件；完成记录、提醒、通知日志随待办保留；
- 目标用户已有同名同级分类、同名标签时自动复用合并，不产生重复；
- 源用户的分类、标签、待办和附件被清空（账号本身保留）；
- 附件文件从源用户目录移动到目标用户目录。

```json
{
  "res": true,
  "message": "transferred",
  "stats": { "categories": 3, "tags": 2, "todos": 12, "images": 4 }
}
```

---

## 四、仓库管理 API

仓库数据来自后端对本机 Git 仓库的扫描（`git` 命令），结果以快照形式存在 SQLite 中，因此**仓库路径必须是运行后端的这台机器上的路径**。

### 1. 查询仓库列表 / 单个仓库

**GET** `/repos`

需要登录（任意角色可读）。

| 参数 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `id` | string | 否 | 传入时返回单个仓库详情，含 `data` 快照 |

列表响应：

```json
{
  "res": true,
  "repos": [
    { "id": 1, "name": "my-repo", "url": "D:/projects/my-repo", "branch": "main", "defaultBranch": "main" }
  ]
}
```

单仓库响应 `{ "res": true, "repo": { ..., "data": { "branches": ["main"], "commitsByBranch": { "main": [] } } } }`，`data` 结构见 [GitCommit](#gitcommit)。

| 状态码 | 场景 |
|---|---|
| 400 | `id` 不是正整数 |
| 404 | 仓库不存在 |

### 2. 新增仓库

**POST** `/repos`

需要 `readwrite` 及以上角色。

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `name` | string | **是** | 仓库显示名 |
| `url` | string | **是** | 本地仓库路径，入库前会 `path.resolve` 归一化 |
| `defaultBranch` | string | 否 | 期望默认分支；不在扫描结果中时回退到第一个分支 |

创建时立即扫描全部分支与提交历史，成功返回 `201` 与完整 `repo`（含 `data`）。

| 状态码 | 场景 |
|---|---|
| 400 | 缺少 `name` 或 `url` |
| 409 | 该路径已录入（`repo url already exists`） |
| 500 | 扫描失败（路径不是 Git 仓库、找不到 `git` 命令等） |

### 3. 修改仓库

**PATCH** `/repos/:id`

需要 `readwrite` 及以上角色。`name`、`url` 为**必填**（整体覆盖），`defaultBranch` 可选；改动路径或分支后会重新扫描并写入新快照。

### 4. 刷新仓库数据

**POST** `/repos/:id/refresh`

需要 `readwrite` 及以上角色。按仓库现有路径重新扫描所有分支与提交历史并覆盖快照，返回更新后的 `repo`。默认分支若在最新扫描结果中已不存在，会回退到第一个分支。

---

## 五、博客文章 API

博客元数据存在 SQLite，正文是 `src/docs/` 下的 Markdown 文件，`content` 字段存的是相对 `src/docs/` 的路径（如 `/技术/前端/我的文章.md`），可通过 `GET /gitstatus/api/docs/**` 直接取原文。

### 1. 查询列表 / 单篇（无需认证）

**GET** `/blogs`

| 参数 | 类型 | 必需 | 默认值 | 说明 |
|---|---|---|---|---|
| `id` | string | 否 | — | 传入时返回单篇，忽略其余筛选参数 |
| `search` | string | 否 | — | 全文搜索，匹配标题 / 摘要 / 正文内容 |
| `tags` | string / string[] | 否 | — | 标签筛选，多个取**交集** |
| `categories` | string / string[] | 否 | — | 分类筛选，递归匹配子分类 |
| `page` | string | 否 | `"1"` | 页码 |
| `pageSize` | string | 否 | `"20"` | 每页条数，范围 1-100 |
| `sort` | `"date"` / `"updated"` | 否 | `"date"` | 排序字段 |
| `order` | `"asc"` / `"desc"` | 否 | `"desc"` | 排序方向 |

**搜索行为：**

- 不区分大小写的模糊匹配，`%keyword%` 形式匹配 `title`、`excerpt`；
- 标题/摘要未命中的记录会逐条读取 md 文件正文（先剥掉 Markdown 标记）继续匹配；
- 正文命中时通过 `searchResult` 返回关键词前后各 20 字符的片段（两端截断时补 `...`），`content` 仍保持文件路径；
- 搜索可与 `tags` / `categories` / 分页 / 排序组合；带搜索时先在合并结果上排序再分页。

列表响应：

```json
{
  "res": true,
  "total": 42,
  "page": 1,
  "pageSize": 20,
  "blogs": [
    {
      "id": 1,
      "title": "我的文章",
      "date": "2025-01-01 10:00:00",
      "updated": "2025-01-02 12:00:00",
      "tags": ["React", "前端"],
      "categories": ["技术", "前端"],
      "excerpt": "摘要内容",
      "searchResult": "",
      "content": "/技术/前端/我的文章.md",
      "cover": "",
      "comment": []
    }
  ]
}
```

单篇响应 `{ "res": true, "blog": { ... } }`。

| 状态码 | 场景 |
|---|---|
| 400 | `id` 无效 |
| 404 | 博客不存在 |

### 2. 新增博客

**POST** `/blogs`

需要 `readwrite` 及以上角色，支持 JSON 与 `multipart/form-data` 两种。

**方式一：JSON**

```json
{
  "title": "React入门指南",
  "tags": ["React", "前端"],
  "categories": ["技术", "前端", "React"],
  "excerpt": "一篇React入门教程",
  "content": "# React入门\n\nReact 是一个 JavaScript 库。",
  "cover": "https://example.com/cover.jpg"
}
```

**方式二：文件上传**

```bash
curl -X POST http://localhost:30012/gitstatus/api/blogs \
  -H "Authorization: Bearer <token>" \
  -F "title=React入门指南" \
  -F 'tags=["React","前端"]' \
  -F 'categories=["技术","前端","React"]' \
  -F "excerpt=一篇React入门教程" \
  -F "file=@article.md"
```

| 字段 | 类型 | 必需 | 默认值 | 说明 |
|---|---|---|---|---|
| `title` | string | **是** | — | 标题，同时作为 md 文件名 |
| `date` | string | 否 | 当前时间 | `YYYY-MM-DD HH:mm:ss` |
| `tags` | string[] | 否 | `[]` | form-data 中传 JSON 字符串 |
| `categories` | string[] | 否 | `[]` | 按顺序构成多级文件夹 |
| `excerpt` | string | 否 | `""` | 摘要 |
| `content` | string | 否 | `""` | 正文（JSON 方式） |
| `file` | File | 否 | — | 上传的 `.md`，优先级高于 `content` |
| `cover` | string | 否 | `""` | 封面图 URL |
| `comment` | unknown[] | 否 | `[]` | 评论数据 |

**文件联动**：传入 `categories` 时自动在 `src/docs/` 下创建多级目录并生成 `{title}.md`：

```
src/docs/
└── 技术/
    └── 前端/
        └── React/
            └── React入门指南.md
```

分类段会做安全清洗（去掉路径分隔符、连续的点、开头的点），并校验最终路径仍在 `src/docs/` 内，防止路径穿越；标题中的非法文件名字符替换为 `_`。

成功返回 `201` 与完整 `blog` 对象。

| 状态码 | 场景 |
|---|---|
| 400 | 缺少标题 / 分类路径不合法 / 标题无法生成文件名 |
| 500 | 服务器内部错误（含上传非 `.md` 文件被 multer 拒绝：`only .md files are allowed`） |

### 3. 更新博客

**PATCH** `/blogs/:id`

需要 `readwrite` 及以上角色。部分更新，`updated` 自动刷为当前时间，同样支持 JSON 与 form-data。

| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 变化时自动重命名文件 |
| `tags` | string[] | 整体替换 |
| `categories` | string[] | 变化时把文件移动到新目录，旧的空目录逐级清理 |
| `excerpt` | string | 新摘要 |
| `content` | string | 写入 md 文件，不改变数据库里的路径 |
| `file` | File | 上传 `.md` 替代 `content`，优先级更高 |
| `cover` | string | 新封面 URL |
| `comment` | unknown[] | 新评论数据 |

响应 `{ "res": true, "blog": { ... } }`。

| 状态码 | 场景 |
|---|---|
| 400 | `id` 无效 / 路径不合法 |
| 404 | 博客不存在 / 对应 md 文件不存在 |

### 4. 删除博客

**DELETE** `/blogs/:id`

需要 `readwrite` 及以上角色。删除数据库记录，同时删除 md 文件并递归清理变空的父目录。

响应 `{ "res": true, "message": "deleted" }`。

### 5. 刷新博客（磁盘 ↔ 数据库双向同步）

**POST** `/blogs/refresh`

需要 `readwrite` 及以上角色。扫描 `src/docs/` 与数据库做双向对齐：

- 磁盘有文件、数据库无记录 → 新建博客记录；
- 数据库有记录、磁盘文件已不存在 → 删除该记录。

```json
{
  "res": true,
  "added": 2,
  "removed": 1,
  "addedFiles": ["/技术/新文章.md"],
  "removedFiles": ["/技术/已删除的文章.md"]
}
```

### 上传限制（博客）

| 项目 | 限制 |
|---|---|
| 最大文件大小 | 10 MB |
| 允许类型 | `.md`（`text/markdown`、`text/plain`） |
| 字段名 | `file` |

---

## 六、待办 API

待办数据按用户隔离，同时会把「共享给我」的文件夹与任务合并进同一份列表，并在 DTO 上用 `ownerId` / `ownerUsername` / `permission` / `shared` 标记来源。

读接口任意登录角色可用；写接口需要 `readwrite` 及以上角色，或对该数据持有共享写权限。

### 1. 文件夹（分类）

挂载在 `/todo-categories`。

#### 列表

**GET** `/todo-categories`

返回自己的全部文件夹，之后追加共享来的文件夹（父文件夹不可见时会顶为根节点）：

```json
{
  "res": true,
  "categories": [
    { "id": 1, "parentId": null, "name": "工作", "color": "#0969da", "sortOrder": 10,
      "createdAt": "2026-04-14 10:00:00", "updatedAt": "2026-04-14 10:00:00",
      "ownerId": 1, "ownerUsername": null, "permission": "owner", "shared": false }
  ]
}
```

#### 新增

**POST** `/todo-categories`

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `name` | string | **是** | 不能为空，最长 80 字符 |
| `parentId` | number \| null | 否 | 父文件夹，必须属于自己的文件夹 |
| `color` | string | 否 | 十六进制色值，非法时回退默认色 |
| `sortOrder` | number | 否 | 同层排序值，默认 0 |

同名同级冲突返回 409（`a category with this name already exists here`）。成功返回 `201` 与 `category`。

#### 修改

**PATCH** `/todo-categories/:id`

字段全部可选（按传入的键更新）：`name`、`parentId`、`color`、`sortOrder`。

额外校验：不能把自己设为父级（400 `a category cannot be its own parent`）；不能移动到自身后代（400 `cannot move a category into its descendant`）；同名同级冲突 409。

#### 删除

**DELETE** `/todo-categories/:id`

存在子文件夹或未完成待办时拒绝：

| 状态码 | 场景 |
|---|---|
| 400 | 文件夹 id 非法 / 不属于当前用户 |
| 409 | `category has subfolders; move or delete them first` |
| 409 | `category has tasks; move or delete them first` |

成功返回 `{ "res": true, "message": "category deleted" }`（删除时先把它名下的任务脱离归属，落入收件箱）。

### 2. 标签

挂载在 `/todo-tags`。

| 接口 | 说明 |
|---|---|
| **GET** `/todo-tags` | 自己的标签 + 共享所有者（用于筛选与编辑）的标签 |
| **POST** `/todo-tags` | `{ name, color? }`；`name` 必填、最长 40 字符，重名 409，成功 201 |
| **PATCH** `/todo-tags/:id` | 可改 `name`、`color`；重名 409，不存在 404 |
| **DELETE** `/todo-tags/:id` | 删除标签与任务关联；不存在 404 |

`color` 默认 `#0969da`。

### 3. 任务

挂载在 `/todos`。

#### 列表

**GET** `/todos`

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `date` | `YYYY-MM-DD` | 今天 | 「选中日期」，决定每日/单次任务的可见性与完成态取哪一天 |
| `categoryId` | number | — | 只看某个文件夹（自己的或共享来的） |
| `includeDescendants` | boolean | `true` | 配合 `categoryId`，是否包含子文件夹 |
| `tagId` | number | — | 按标签筛选 |
| `type` | `once` / `daily` | — | 调度类型 |
| `status` | `pending` / `completed` | — | 完成状态 |
| `overdue` | `1` / `true` | — | 只看逾期（未完成且已过截止） |
| `view` | `all` / `today` / `inbox` | `all` | `today` 按当天可见性规则过滤；`inbox` 只看无文件夹任务 |
| `inbox` | `1` / `true` | — | 等价于 `view=inbox` |
| `createdDate` | `YYYY-MM-DD` | — | 创建日期（按天） |
| `createdFrom` / `createdTo` | 日期时间 | — | 创建时间区间，精确到分钟；`from > to` 时 400 |
| `dueDate` | `YYYY-MM-DD` | — | 截止日期等于 |
| `dueFrom` / `dueTo` | `YYYY-MM-DD` | — | 截止日期区间；`from > to` 时 400 |
| `search` | string | — | 标题 / 描述不区分大小写模糊匹配 |
| `page` | number | `1` | 页码 |
| `pageSize` | number | `200` | 每页条数，最大 500 |

响应：

```json
{
  "res": true,
  "total": 12,
  "page": 1,
  "pageSize": 200,
  "date": "2026-04-14",
  "todos": [ { "id": 1, "title": "周报", "isCompleted": false, "isOverdue": false, "...": "见 Todo DTO" } ]
}
```

排序规则依次为：未完成在前 → 逾期优先 → 优先级（`high` < `normal` < `low`）→ 截止日期 → 截止时刻（无时刻按 `23:59`）→ 有截止日期优先 → `sortOrder` → `id`。

**当天可见性规则**（`view=today` 与前端日历计数共用同一口径）：

| 情况 | 选中日期是否可见 |
|---|---|
| 每日任务 | 落在 `repeatStartDate` ~ `repeatEndDate` 区间内 |
| 单次任务已完成 | 完成日期当天，或截止日期当天 |
| 单次任务未完成 | 从创建日期起持续可见；逾期后继续显示（直到完成） |
| 截止日期早于创建日期 | 不构成区间，从截止日期当天起持续显示 |

#### 新增

**POST** `/todos`

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `title` | string | **是** | 最长 200 字符 |
| `description` | string | 否 | 最长 5000 字符 |
| `categoryId` | number \| null | 否 | 为空表示进收件箱；可指向自己有写权限的共享文件夹 |
| `priority` | `high` / `normal` / `low` | 否 | 默认 `normal` |
| `scheduleType` | `once` / `daily` | 否 | 默认 `once` |
| `dueDate` | `YYYY-MM-DD` | 否 | 仅单次任务 |
| `dueTime` | `HH:mm` | 否 | 仅单次任务，必须与 `dueDate` 同时出现 |
| `repeatStartDate` | `YYYY-MM-DD` | 否 | 仅每日任务，缺省为今天 |
| `repeatEndDate` | `YYYY-MM-DD` | 否 | 仅每日任务，不能早于 `repeatStartDate` |
| `tagIds` | number[] | 否 | 必须属于任务所有者 |
| `sortOrder` | number | 否 | 手动排序值，默认 0 |

在共享文件夹中新建的任务**归属文件夹所有者**，响应里会带回 `ownerUsername`、`permission: "write"`、`shared: true`。成功返回 `201` 与 `todo`。

| 状态码 | 场景 |
|---|---|
| 400 | 标题缺失/超长、描述超长、`dueTime` 没有 `dueDate`、`repeatEndDate` 早于开始、枚举值非法、文件夹或标签不存在、无写入权限 |

#### 详情

**GET** `/todos/:id?date=YYYY-MM-DD`

返回单个 `todo`（`isCompleted` 等按 `date` 计算）。无权限或不存在返回 400 / 404。

#### 修改

**PATCH** `/todos/:id?date=`

字段全部可选，未传的沿用当前值（注意：`dueDate`、`categoryId` 等显式传 `null` 才会清空）。

特殊规则：

- 不能把任务移动到**不同所有者**的文件夹（400 `cannot move a task across different owners`）；
- 把共享任务移入收件箱时，要求该所有者的收件箱确实共享给了自己且有写权限，否则 400；
- 改动 `scheduleType` 时会自动禁用该任务的提醒。

#### 删除

**DELETE** `/todos/:id`

软删除（写 `deleted_at`）并禁用其提醒，返回 `{ "res": true, "message": "todo deleted" }`。

#### 完成 / 取消完成

**POST** `/todos/:id/complete`

| 字段 | 类型 | 说明 |
|---|---|---|
| `date` | `YYYY-MM-DD` | **仅每日任务生效**；单次任务的完成日期固定取服务器当天 |

每日任务的 `date` 不在重复区间内返回 400（`date is outside this daily task's active range`）。重复调用同一天的完成不会产生第二条记录（幂等）。

```json
{
  "res": true,
  "completion": { "id": 8, "todoId": 1, "completionDate": "2026-04-14", "completedAt": "2026-04-14 10:30:00" },
  "todo": { "...": "更新后的任务" }
}
```

**DELETE** `/todos/:id/complete?date=YYYY-MM-DD`

- 单次任务或未带 `date`：清空该任务全部完成记录；
- 每日任务带 `date`：只删除该天的完成记录。

响应 `{ "res": true, "message": "completion removed", "todo": { ... } }`。

#### 提醒

**PUT** `/todos/:id/reminder`

| 字段 | 类型 | 说明 |
|---|---|---|
| `reminderType` | `once` / `daily` | 必须与任务的 `scheduleType` 一致，否则 400 |
| `remindAt` | `YYYY-MM-DD HH:mm` | `once` 必填，且必须晚于当前时间 |
| `remindTime` | `HH:mm` | `daily` 必填，按每个生效日期推算下一次触发 |

| 状态码 | 场景 |
|---|---|
| 400 | 类型不匹配 / 时间格式错误 / `remindAt` 不是未来时间 / 每日任务已无未来触发日 |
| 409 | 给已完成的单次任务加提醒 |

成功返回 `reminder` DTO。任务本身没有 `dueDate` 时，挂件的截止提醒按设置里的下班时间计算。

**DELETE** `/todos/:id/reminder`

删除提醒，返回 `{ "res": true, "message": "reminder deleted" }`。

---

## 七、待办附件 API

附件文件落盘在 `src/output/todo-images/<userId>/<uuid><ext>`（目录沿用旧名，保证历史图片链接仍然有效），元数据在 `todo_attachments` 表。

### 1. 列表

**GET** `/todos/:id/attachments`

```json
{
  "res": true,
  "attachments": [
    { "id": 3, "kind": "image", "originalName": "截图.png", "mimeType": "image/png",
      "size": 20480, "url": "/gitstatus/api/todo-attachments/3", "createdAt": "2026-04-14 10:30:00" }
  ]
}
```

### 2. 上传

**POST** `/todos/:id/attachments`

`multipart/form-data`，字段名三种任选（可混用、可多文件）：

| 字段 | 数量上限 | 说明 |
|---|---|---|
| `images` | 5 | 图片 |
| `files` | 10 | 其他文件 |
| `file` | 1 | 单文件 |

上传前按类型分别校验，任一不通过整批拒绝：

| 类型 | 单个体积上限 | 允许内容 |
|---|---|---|
| 图片 | 8 MB | JPEG / PNG / GIF / WebP / BMP / AVIF（按 MIME 判定，扩展名取对应值） |
| 其他文件 | 32 MB | 常见文档与压缩包；可执行类后缀被拒绝：`.exe` `.msi` `.bat` `.cmd` `.com` `.scr` `.pif` `.ps1` `.vbs` `.vbe` `.js` `.jse` `.wsf` `.wsh` `.sh` `.jar` `.reg` `.lnk` |

数量超限返回 400（`a task can have at most 5 images` / `a task can have at most 10 files`）；原始文件名最长保留 255 字符。写盘过程中出错会回滚已写入的记录与文件。

成功返回 `201`：

```json
{
  "res": true,
  "attachments": [ "...该任务的全部附件" ],
  "images": [ "...其中图片子集" ],
  "todo": { "...更新后的任务" }
}
```

### 3. 删除附件

**DELETE** `/todos/:id/attachments/:attachmentId`

需要该任务的写权限。删除元数据即视为成功，磁盘文件缺失不阻塞。返回 `{ "res": true, "message": "attachment deleted" }`。

### 4. 读取附件内容

**GET** `/todo-attachments/:id`

需要登录，且对该附件所属任务有访问权限（自己的或共享来的）。响应是文件流：

| 情况 | 响应头 |
|---|---|
| 图片 | `Content-Type: <真实 MIME>`，浏览器内联显示 |
| 非图片 | `Content-Type: application/octet-stream` + `Content-Disposition: attachment; filename*=UTF-8''...`（强制下载，避免 HTML/SVG 被内联执行） |

统一带 `X-Content-Type-Options: nosniff` 与 `Cache-Control: private, max-age=3600`。

### 5. 用系统默认程序打开

**GET** `/todo-attachments/:id/open`

**仅限本机调用。** 只对 `kind = file` 的附件生效：图片走浏览器预览（400 `images are previewed in the browser`）；远程设备调用返回 403（`system open is only available on the host machine`）。成功返回 `{ "res": true, "message": "opened" }`。

### 6. 旧版图片接口（兼容保留）

| 接口 | 说明 |
|---|---|
| **GET** `/todos/:id/images` | 只返回图片类附件，字段名 `images` |
| **POST** `/todos/:id/images` | 只按图片规则校验（`imagesOnly`） |
| **DELETE** `/todos/:id/images/:imageId` | 等价于删除附件 |
| `GET /todo-images/:id` | 与 `/todo-attachments/:id` 挂同一个处理函数 |

---

## 八、数据共享 API

挂载在 `/todo-shares`，把某个文件夹（含其子文件夹）或收件箱共享给其他用户。

| 权限 | 说明 |
|---|---|
| `readonly` | 可查看共享范围内的任务，不能增删改 |
| `write` | 可对共享范围内的任务增删改 |

规则要点：

- 共享只能由数据所有者创建；管理员可在「全部共享」里查看并代为调整权限或取消；
- 系统角色 `readonly` 的账号仍然不能写，共享写权限只对 `readwrite` 及以上角色实际生效；
- 共享文件夹的重命名、移动、删除只属于所有者，被共享者只操作其中的任务；
- 在共享文件夹新建的任务归属文件夹所有者；
- 收件箱共享支持查看和编辑已有任务，但新建任务始终进自己的收件箱。

### 1. 共享可选项

**GET** `/todo-shares/options`

```json
{
  "res": true,
  "categories": [
    { "id": 1, "parentId": null, "name": "工作", "path": "工作", "taskCount": 6, "permission": "owner", "shared": false }
  ],
  "inboxCount": 3,
  "users": [ { "id": 2, "username": "alice", "role": "readonly" } ],
  "isAdmin": true
}
```

`categories` 是当前用户自己的文件夹（带完整路径与未完成任务数），`users` 是可共享的 `active` 用户（不含自己）。

### 2. 共享列表

**GET** `/todo-shares?scope=mine|received|all`

| scope | 说明 |
|---|---|
| `mine` | 我共享出去的（默认） |
| `received` | 共享给我的 |
| `all` | 全部共享，仅管理员，否则 403 |

```json
{
  "res": true,
  "scope": "mine",
  "shares": [
    { "id": 1, "ownerId": 1, "ownerUsername": "admin", "granteeId": 2, "granteeUsername": "alice",
      "scope": "category", "categoryId": 3, "categoryName": "周报", "categoryPath": "工作/周报",
      "permission": "write", "createdAt": "2026-04-14 10:00:00", "updatedAt": "2026-04-14 10:00:00" }
  ]
}
```

`scope` 为 `inbox` 时 `categoryId` / `categoryName` / `categoryPath` 为 `null`。

### 3. 创建共享

**POST** `/todo-shares`

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `granteeId` | number | **是** | 被共享用户 ID，不能是自己 |
| `scope` | string | **是** | `category` 或 `inbox` |
| `categoryId` | number | `scope=category` 时必填 | **自己的**文件夹 ID |
| `permission` | string | 否 | `readonly`（默认）或 `write` |

| 状态码 | 场景 |
|---|---|
| 400 | 共享给自己 / `scope` 或 `permission` 非法 / 目标用户已被禁用 |
| 404 | 目标用户不存在 / 文件夹不存在或不属于自己 |

同一范围重复共享时直接更新权限并返回 **200**；新建返回 **201**。响应均为 `{ "res": true, "share": { ... } }`。

### 4. 修改共享权限

**PATCH** `/todo-shares/:id`

```json
{ "permission": "write" }
```

仅数据所有者或管理员可操作，否则 403；共享不存在 404；`permission` 非法 400。

### 5. 取消共享

**DELETE** `/todo-shares/:id`

仅数据所有者或管理员可操作。返回 `{ "res": true, "message": "share removed" }`。

---

## 九、桌宠挂件 API

挂载在 `/todo-widget`，网页端挂件与 Electron 桌面版共用。所有接口需要登录（任意角色）。

### 1. 汇总数据（轮询）

**GET** `/todo-widget/summary?since=YYYY-MM-DD HH:mm:ss`

| 参数 | 说明 |
|---|---|
| `since` | 上次同步到的服务端时间，用于增量取提醒事件；缺省时回看最近 5 分钟 |

```json
{
  "res": true,
  "now": "2026-04-14 10:32:15",
  "today": "2026-04-14",
  "settings": { "intervalEnabled": true, "intervalMinutes": 60, "dueLeadMinutes": 15, "petImageUrl": null },
  "stats": { "pending": 3, "overdue": 1, "completed": 2, "total": 5 },
  "preview": [
    { "id": 1, "title": "周报", "priority": "high", "dueDate": "2026-04-14", "dueTime": "18:00", "isOverdue": false }
  ],
  "dueSoon": [
    { "key": "due|7|2026-04-14 10:40:00", "todoId": 7, "title": "交材料", "dueAt": "2026-04-14 10:40:00", "minutesLeft": 8, "scheduleType": "once", "priority": "normal" }
  ],
  "nextReminder": { "reminderId": 2, "todoId": 1, "title": "周报", "triggerAt": "2026-04-14 18:00:00", "type": "once", "dueDate": "2026-04-14", "dueTime": "18:00", "priority": "high" },
  "events": [
    { "key": "2|2026-04-14 09:00:00", "reminderId": 2, "todoId": 1, "title": "周报", "triggerAt": "2026-04-14 09:00:00", "status": "sent", "createdAt": "2026-04-14 09:00:01" }
  ]
}
```

口径说明：

- `stats` / `preview` 用「当日计数口径」：未到截止日期的单次任务不计入当天未完成，逾期未完成会持续计数直到完成；
- `preview` 最多 3 条，按 逾期 → 优先级 → 截止时刻 → id 排序；
- `dueSoon` 仅在 `dueLeadMinutes > 0` 时计算：单次任务看 `dueDate + dueTime`（无时刻按下班时间），每日任务看 `repeatEndDate + 下班时间`，最多 5 条；
- `events` 只返回状态为 `sent` / `failed` 的提醒日志，按时间升序最多 20 条，`key` 供前端去重（已读状态由前端本地保存）。

### 2. 提醒设置

**GET** `/todo-widget/settings`
**PUT** `/todo-widget/settings`

| 字段 | 类型 | 默认值 | 范围 | 说明 |
|---|---|---|---|---|
| `intervalEnabled` | boolean | `true` | — | 间隔提醒总开关 |
| `intervalMinutes` | number | `60` | 5 - 480 | 有未完成待办时每隔 N 分钟冒泡 |
| `intervalWithinWorkHours` | boolean | `false` | — | 是否仅在工作时间内间隔提醒 |
| `workStart` | `HH:mm` | `"09:00"` | — | 上班时间，必须早于 `workEnd` |
| `workEnd` | `HH:mm` | `"18:00"` | — | 下班时间，无具体截止时刻的任务按它计算 |
| `workStartEnabled` | boolean | `true` | — | 上班提醒开关 |
| `workEndEnabled` | boolean | `true` | — | 下班提醒开关 |
| `dueLeadMinutes` | number | `15` | 0 - 1440 | 截止前提醒提前量，`0` 表示关闭 |

上下班提醒各有一个 10 分钟的触发窗口（到点后窗口内若仍有未完成待办则提醒一次）。

`PUT` 为部分更新：未传的字段沿用当前值，非法值返回 400（如 `intervalMinutes must be an integer between 5 and 480`、`workEnd must be later than workStart`）。设置按账号存服务端，换设备登录同一账号即同步；桌宠大小、镜像、提醒音等纯视觉项只存本地（浏览器 `localStorage` / Electron `preferences.json`）。

响应 `{ "res": true, "settings": { ... } }`。

### 3. 角色素材

| 接口 | 说明 |
|---|---|
| **GET** `/todo-widget/assets/pet` | 返回当前账号上传的图片二进制（`Cache-Control: private, no-store`）；未上传或文件缺失 404 |
| **POST** `/todo-widget/assets/pet` | `multipart/form-data`，字段名 `file`，上传即替换旧图并删除旧文件；成功 `201` 返回新 `settings` |
| **DELETE** `/todo-widget/assets/pet` | 删除上传的素材、恢复内置造型 |

上传约束：最大 **2 MB**，仅接受 JPEG / PNG / GIF / WebP / BMP / AVIF；超限返回 400（`pet image must be 2MB or smaller`）。文件保存在 `src/output/pet-assets/<userId>-<uuid><ext>`。

设置响应里的 `petImageUrl` 形如 `/gitstatus/api/todo-widget/assets/pet?v=<文件名>`，文件名换掉即为新版本号，浏览器会自动取新图；为空时前端使用内置造型。读取素材需要登录态。

---

## 十、项目管理 API

挂载在 `/projects`，用于在本机登记项目、一键启停、跑多条命令并查看输出。除 `POST /projects/local/quickstart` 外，**全部接口需要 `readwrite` 及以上角色**。

项目类型 `node` / `python` / `java` / `go` / `rust` / `php` / `dotnet` / `custom`；运行状态 `stopped` / `starting` / `running` / `stopping` / `error`（后三者视为活跃）。

### 1. 列表

**GET** `/projects`

```json
{
  "res": true,
  "projects": [
    {
      "id": 1, "name": "my-app", "path": "D:/projects/my-app", "type": "node", "typeLabel": "Node.js",
      "command": "npm run dev", "startCommand": "npm run dev", "folder": "前端", "intro": "",
      "runCommands": [ { "name": "npm test", "command": "npm test" } ],
      "links": [ { "name": "localhost:5173", "url": "http://localhost:5173" } ],
      "status": "running", "pid": 12345,
      "activeRun": { "id": 3, "projectId": 1, "commandId": 2, "name": "npm test", "command": "npm test", "status": "running", "pid": 2001, "startedAt": "10:32:15", "finishedAt": null, "exitCode": null },
      "createdAt": "2026-04-14 10:00:00", "updatedAt": "2026-04-14 10:32:15"
    }
  ],
  "folders": [ { "name": "前端", "path": "D:/projects/web", "sortOrder": 10, "createdAt": "...", "updatedAt": "..." } ]
}
```

`command` 与 `startCommand` 是同一个值的两个别名（历史兼容）。`status` / `pid` / `activeRun` 来自内存中的运行时状态，进程随服务重启后归零。

### 2. 识别项目

**POST** `/projects/detect`

| 字段 | 类型 | 说明 |
|---|---|---|
| `path` | string | 本地目录，会被归一化并校验存在 |
| `type` | string | 可选，指定类型；非法或不传时按目录内容自动判定 |

```json
{
  "res": true,
  "detection": {
    "path": "D:/projects/my-app", "name": "my-app", "type": "node", "typeLabel": "Node.js",
    "command": "npm run dev", "startCommand": "npm run dev",
    "commands": [ { "name": "npm run dev", "command": "npm run dev" }, { "name": "npm test", "command": "npm test" } ],
    "detectedType": "node", "detectedTypeLabel": "Node.js"
  }
}
```

`detectedType` 是自动判定结果，`type` 是最终采用的类型。

### 3. 新增项目

**POST** `/projects`

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `path` | string | **是** | 项目目录 |
| `type` | string | 否 | 不传时自动识别 |
| `name` | string | 否 | 默认取目录名；最长 120 字符 |
| `startCommand` / `command` | string | 否 | 不传时用识别出的默认启动命令；最长 2000 字符 |
| `commands` | array | 否 | 运行命令列表 `[{ name, command }]`，不传则用识别建议；最多 50 条，重复命令去重 |
| `links` | array | 否 | 项目地址 `[{ name, url }]`，最多 50 条，必须是 `http(s)://`；不传 `name` 时用主机名 |
| `intro` | string | 否 | 项目介绍，最长 2000 字符 |
| `folder` | string | 否 | 分组文件夹名，最长 80 字符；不存在时自动建分组记录 |

成功返回 `201` 与 `project`。创建者记为当前用户。

### 4. 修改项目

**PATCH** `/projects/:id`

字段全部可选，按是否传入决定是否更新。`path` 或 `type` 变化时会重新识别并覆盖启动命令。

受运行状态限制的只有**启动相关配置**（`path` / `type` / `startCommand` / `command` / `commands`）；名称、分组、介绍、地址随时可改：

| 状态码 | 场景 |
|---|---|
| 409 | 项目处于 `starting` / `running` / `stopping` 时修改启动配置（`项目运行中，请先停止再修改启动配置`） |
| 409 | 存在正在运行的命令时修改启动配置 |
| 400 | 名称为空或超长、启动命令为空或超长、地址格式非法 |

### 5. 删除项目

**DELETE** `/projects/:id`

运行中或有活跃命令时返回 409（`请先停止项目再删除`）。删除会清理内存中的运行时与命令会话。

### 6. 启停与重启

| 接口 | 说明 |
|---|---|
| **POST** `/projects/:id/start` | 在项目目录内以后台方式启动 `startCommand`。返回 `{ res, project, status, pid }`；已在运行/切换中 409，未填命令 400 |
| **POST** `/projects/:id/stop` | 结束进程树（Windows 用 `taskkill /T /F`，其他平台 SIGKILL）。返回 `{ res, status, pid }` |
| **POST** `/projects/:id/restart` | 先停再起，返回 `{ res, project, status, pid }` |

启动前会切到 UTF-8 代码页，输出按块做编码探测，避免中文 cmd 的 GBK 乱码。

### 7. 运行日志（后台进程）

**GET** `/projects/:id/logs?after=<seq>`

```json
{
  "res": true,
  "logs": [ { "seq": 12, "stream": "stdout", "text": "ready in 312ms", "at": "10:32:16" } ],
  "nextSeq": 12,
  "status": "running",
  "pid": 12345
}
```

`after` 是上次读到的 `seq`，用于增量轮询；`stream` ∈ `stdout` / `stderr` / `system`。日志只在内存中保留，进程停止后仍可读最后状态，服务重启后清空。

### 8. 运行命令（多命令终端）

| 接口 | 说明 |
|---|---|
| **POST** `/projects/:id/commands/:commandId/run` | 触发一条「运行命令」，返回 `201` 与 `run` |
| **GET** `/projects/:id/runs/:runId/logs?after=<seq>` | 增量读取该次运行输出，返回 `{ res, logs, nextSeq, status, pid, run }` |
| **POST** `/projects/:id/runs/:runId/stop` | 结束该次运行，返回 `{ res, run }` |

`run` 对象：`{ id, projectId, commandId, name, command, status, pid, startedAt, finishedAt, exitCode }`。命令或记录不存在返回 404。

### 9. 进程占用与资源

**GET** `/projects/usage`

列出所有活跃项目的 CPU / 内存占用（Windows 走一次进程快照采集，按父子进程聚合）：

```json
{
  "res": true,
  "available": true,
  "sampledAt": "2026-04-14T02:32:15.000Z",
  "cpuCount": 16,
  "usage": [
    { "projectId": 1, "name": "my-app", "status": "running", "pid": 12345,
      "uptimeSeconds": 182, "cpuPercent": 3.27, "memoryBytes": 167772160, "memoryMb": 160, "processCount": 4 }
  ]
}
```

采集不到时 `cpuPercent` / `memoryBytes` / `memoryMb` 为 `null`，`available` 为 `false`。

### 10. 端口占用排查

**GET** `/projects/ports/:port` — **仅限本机**

```json
{
  "res": true,
  "port": 5173,
  "connections": [
    { "pid": 12345, "processName": "node.exe", "protocol": "TCP", "localAddress": "0.0.0.0:5173", "state": "LISTENING" }
  ]
}
```

Windows 用 `netstat -ano` 解析，macOS / Linux 用 `lsof`。

**POST** `/projects/ports/:port/kill` — **仅限本机**，body `{ "pid": 12345 }`

安全约束：只允许结束**当前确实占用该端口**的进程（否则 404）；`pid ≤ 4`、后端自身进程及其父进程被拒绝（400）；`System`、`Idle`、`csrss.exe` 等受保护进程名拒绝结束（400）。成功返回 `{ "res": true, "message": "已结束 node.exe (PID 12345)" }`；权限不足时 500。

### 11. 文件夹分组

分组是**实体文件夹**（有路径与排序值），不只是标签。

| 接口 | 说明 |
|---|---|
| **GET** `/projects/folders` | 按 `sortOrder` 返回 `{ res, folders }` |
| **POST** `/projects/folders` | body `{ name, path? }`，重名 409，成功 201 |
| **PATCH** `/projects/folders` | body `{ name, newName?, path? }`；`name` 是旧名，重命名会同步更新项目上的分组字段与磁盘目录 |
| **POST** `/projects/folders/reorder` | body `{ names: string[] }`，按数组顺序重排；含重复项 400 |
| **PATCH** `/projects/:id/folder` | body `{ folder }`，把项目移动到指定分组（空串为未分组） |
| **POST** `/projects/pick-folder` | **仅限本机**。body `{ initialPath? }` 弹出系统原生文件夹选择框，返回 `{ res, path }`（取消时为空串）；已有窗口未关闭时 409 |

文件夹名最长 80 字符，连续空白会被压缩。

### 12. 用编辑器 / 终端打开

**GET** `/projects/editors`

```json
{ "res": true, "editors": { "vscode": true, "qoder": true, "explorer": true, "powershell": true, "cmd": true } }
```

按本机是否找到对应 CLI 或可执行文件返回可用性，前端据此禁用不可用项。

| 接口 | 说明 |
|---|---|
| **POST** `/projects/:id/open-editor` | **仅限本机**。body `{ editor }`，取值 `vscode` / `qoder` / `explorer` / `powershell` / `cmd`，不支持的返回值 400 |
| **POST** `/projects/folders/open-editor` | **仅限本机**。body `{ name, editor }`，打开分组目录；未设置路径 400 |

两者成功都返回 `{ "res": true, "message": "已用 <编辑器> 打开项目" }`。

### 13. 一键启动后台

**GET** `/projects/quickstart` — 返回 `{ res, projectIds }`（勾选了「一键启动」的项目）

**PUT** `/projects/quickstart` — body `{ projectIds: number[] }`，整体覆盖，自动去重、忽略不存在的项目，返回保存后的列表

**POST** `/projects/local/quickstart` — **无需 token，仅限本机**，供桌面版托盘调用。逐个启动勾选的项目，已运行的跳过：

```json
{ "res": true, "started": [1, 4], "skipped": [2], "failed": [ { "id": 7, "message": "启动命令未配置" } ] }
```

---

## 十一、静态资源与页面路由

| 路径 | 说明 |
|---|---|
| `/`、`/gitstatus` | 重定向到 `/pages/index.html` |
| `/pages/index.html` | Git 全景洞察 |
| `/pages/todo.html` | 待办清单（含注册 / 登录表单） |
| `/pages/projects.html` | 项目管理 |
| `/pages/shares.html` | 数据共享（所有登录用户） |
| `/pages/account.html` | 账号管理（仅管理员） |
| `/pages/desktop-pet.html` | 桌面版渲染入口（历史页面，现由 `desktop/renderer/*` 承担） |
| `/pages/desktop-login.html` | 桌面版登录页 |
| `/pages/auth-test.html` | Auth API 测试页 |
| `/pages/assets/styles/*` | 共享样式：`theme.css`（设计令牌）、`components.css`（组件）、`pet-widget.css` |
| `/pages/assets/js/*` | 共享脚本：`auth-client.js`、`account.js`、`shares.js`、`projects.js`、`pet-widget.js`、`pet-preference.js`、`desktop-*.js` |
| `/pages/assets/vendor/*` | 本地第三方库（Chart.js、chartjs-plugin-zoom），页面不依赖外部 CDN |
| `/gitstatus/api/docs/*` | 博客 Markdown 原文（`src/docs/`） |
| `/gitstatus/api/models/*` | 已生成的模型文件（`src/output/models/`） |

HTML 统一带 `Cache-Control: no-cache, must-revalidate`，避免前端逻辑更新后浏览器仍用旧页面。

---

## 十二、数据结构汇总

### Category（文件夹）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | ID |
| `parentId` | number \| null | 父文件夹；共享来的任务父级不可见时会被顶为根 |
| `name` | string | 名称，同级唯一 |
| `color` | string | 十六进制色值 |
| `sortOrder` | number | 同层排序 |
| `createdAt` / `updatedAt` | string | 时间 |
| `ownerId` | number | 数据所有者 |
| `ownerUsername` | string \| null | 共享来源用户名，自己的数据为 `null` |
| `permission` | `owner` / `readonly` / `write` | 当前用户对该文件夹的权限 |
| `shared` | boolean | 是否来自共享 |

### Tag

`id`、`name`（最长 40）、`color`（默认 `#0969da`）、`createdAt`、`updatedAt`、`ownerId`、`ownerUsername`、`shared`。

### Todo

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | ID |
| `title` / `description` | string | 标题 / 描述 |
| `categoryId` | number \| null | 所属文件夹，`null` 为收件箱 |
| `category` | Category \| null | 文件夹详情 |
| `tags` | Tag[] | 标签 |
| `attachments` | TodoAttachment[] | 全部附件 |
| `images` | TodoAttachment[] | 附件中的图片子集（历史字段，保留兼容） |
| `priority` | `high` / `normal` / `low` | 优先级 |
| `scheduleType` | `once` / `daily` | 调度类型 |
| `dueDate` | `YYYY-MM-DD` \| null | 截止日期（单次） |
| `dueTime` | `HH:mm` \| null | 截止时刻（单次） |
| `repeatStartDate` / `repeatEndDate` | string \| null | 重复区间（每日） |
| `sortOrder` | number | 手动排序 |
| `isCompleted` | boolean | 按查询 `date` 计算的完成状态 |
| `completedAt` | string \| null | 完成时间 |
| `completionDate` | `YYYY-MM-DD` \| null | 完成归属日期 |
| `isOverdue` | boolean | 逾期，**按服务器当前时间判断**，与选中日期无关 |
| `isActiveOnDate` | boolean | 每日任务是否落在重复区间 |
| `createdAt` / `updatedAt` | string | 时间 |
| `reminder` | Reminder \| null | 提醒配置 |
| `ownerId` / `ownerUsername` / `permission` / `shared` | — | 归属与权限标记 |

### TodoAttachment

`id`、`kind`（`image` / `file`）、`originalName`、`mimeType`、`size`、`url`（`/gitstatus/api/todo-attachments/<id>`）、`createdAt`。

### Reminder

`id`、`type`（`once` / `daily`）、`remindAt`（单次触发的日期时间）、`remindTime`（每日触发时刻）、`enabled`、`nextTriggerAt`、`createdAt`、`updatedAt`。

### PetSettings

见 [桌宠挂件 API](#九桌宠挂件-api)：`intervalEnabled`、`intervalMinutes`、`intervalWithinWorkHours`、`workStart`、`workEnd`、`workStartEnabled`、`workEndEnabled`、`dueLeadMinutes`、`petImageUrl`、`updatedAt`。

### Share

`id`、`ownerId`、`ownerUsername`、`granteeId`、`granteeUsername`、`scope`（`category` / `inbox`）、`categoryId`、`categoryName`、`categoryPath`、`permission`（`readonly` / `write`）、`createdAt`、`updatedAt`。

### Repo

`id`、`name`、`url`（本机仓库路径）、`branch`、`defaultBranch`，单仓库查询时带 `data`：

```json
{ "branches": ["main", "dev"], "commitsByBranch": { "main": [ /* GitCommit[] */ ] } }
```

### GitCommit

| 字段 | 类型 | 说明 |
|---|---|---|
| `hash` | string | 提交哈希 |
| `date` | string | 提交时间 |
| `author` / `email` | string | 作者与邮箱 |
| `message` | string | 提交信息 |
| `additions` / `deletions` | number | 该提交增删行数 |
| `files` | `{ file, additions, deletions }[]` | 逐文件改动 |

### BlogPost

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | 博客 ID |
| `title` | string | 标题，同时是 md 文件名 |
| `date` / `updated` | string | 创建 / 更新时间 |
| `tags` | string[] | 标签 |
| `categories` | string[] | 分类，按顺序对应文件夹层级 |
| `excerpt` | string | 摘要 |
| `content` | string | md 相对 `src/docs/` 的路径 |
| `cover` | string | 封面 URL |
| `comment` | unknown[] | 评论数据 |
| `searchResult` | string | 搜索命中正文时的上下文片段，其余情况为 `""` |

### Project / ProjectRun / ProjectFolder

见 [项目管理 API](#十项目管理-api) 的响应示例：

- **Project**：`id`、`name`、`path`、`type`、`typeLabel`、`command`、`startCommand`、`folder`、`intro`、`runCommands[]`、`links[]`、`status`、`pid`、`activeRun`、`createdAt`、`updatedAt`
- **ProjectRun**：`id`、`projectId`、`commandId`、`name`、`command`、`status`、`pid`、`startedAt`、`finishedAt`、`exitCode`
- **ProjectFolder**：`name`、`path`、`sortOrder`、`createdAt`、`updatedAt`
- **ProjectLog**：`seq`、`stream`（`stdout` / `stderr` / `system`）、`text`、`at`

### User

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | 用户 ID（`/auth/me` 中为 `userId`） |
| `username` | string | 用户名 |
| `role` | `admin` / `readwrite` / `readonly` | 角色 |
| `status` | `pending` / `active` / `disabled` | 状态 |
| `createdAt` | string | 注册时间 |
| `lastLoginAt` | string \| null | 最近登录 |

---

## 十三、日志与配置

### 运行日志

按日期切分写入 `src/output/logs/YYYY-MM-DD.log`，同时输出到控制台，并记录每个请求的访问日志。

| 级别 | 说明 |
|---|---|
| `ACCESS` | HTTP 访问日志：方法、路径、状态码、耗时、IP |
| `INFO` | 常规信息：服务启动、注册尝试、共享变更、项目启停等 |
| `WARN` | 警告：配置加载失败回退、上传被拒、文件删除失败等 |
| `ERROR` | 错误：子进程 stderr、异常堆栈等 |

```
[2026-04-14 10:32:15.123] [INFO] server running: http://localhost:30012
[2026-04-14 10:32:20.456] [ACCESS] GET /gitstatus/api/blogs 200 12ms - ::1
[2026-04-14 10:32:25.789] [WARN] [config] failed to read ...
```

### 配置

`config/config.json`：

| 字段 | 说明 | 默认值 |
|---|---|---|
| `allowedOrigins` | CORS 白名单 | `["http://localhost:65123"]` |
| `jwtSecret` | JWT 签名密钥（生产环境请修改） | `"gitstatus-default-secret-please-change"` |
| `jwtExpiresIn` | Token 过期时间 | `"7d"` |
| `maxPendingRegistrations` | 同时待审核的最大注册数量（1-500） | `20` |

`maxPendingRegistrations` 可被环境变量 `MAX_PENDING_REGISTRATIONS` 覆盖，环境变量优先。端口固定为 30012，写在 `src/index.ts`。
