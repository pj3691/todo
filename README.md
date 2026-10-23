# GitStatus

用 AI 实现的一个用于离线查看本地 Git 历史记录的小工具，提供类似于 GitHub 首页提交热力图、提交历史查看、每日活跃度等功能，同时包含博客文章管理系统。

## 使用方法

1. `npm install`
2. `npm run dev`

服务运行在 `http://localhost:30012`

### 桌面版桌宠（Windows）

Electron 桌面版把网页桌宠放进覆盖所有显示器虚拟桌面的透明置顶层，可以直接拖到副屏，也可收进 Windows 托盘；桌面版默认在应用内窗口打开待办页，网页待办页的桌宠默认隐藏并可在账号信息卡片中开关。后端接口、角色素材和气泡样式完全复用当前项目。先启动后端，再执行：

```powershell
npm run desktop:install
npm run desktop
```

详细的使用、配置与打包说明见 [desktop/README.md](desktop/README.md)。

---

## API 接口文档

基础路径：`/gitstatus/api`

---

### 一、仓库管理 API

#### 1. 查询仓库列表 / 单个仓库

**GET** `/repos`

需要登录（任意角色可读）。

| 参数 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `id` | string | 否 | 传入时返回单个仓库详情（含 data） |

**响应示例（列表）：**

```json
{
  "res": true,
  "repos": [
    { "id": 1, "name": "my-repo", "url": "D:/projects/my-repo", "branch": "main", "defaultBranch": "main" }
  ]
}
```

#### 2. 新增仓库

**POST** `/repos`

需要 `readwrite` 及以上角色。

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `name` | string | **是** | 仓库名称 |
| `url` | string | **是** | 本地仓库路径 |
| `defaultBranch` | string | 否 | 默认分支 |

#### 3. 修改仓库

**PATCH** `/repos/:id`

需要 `readwrite` 及以上角色。

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `name` | string | **是** | 仓库名称 |
| `url` | string | **是** | 本地仓库路径 |
| `defaultBranch` | string | 否 | 默认分支 |

#### 4. 刷新仓库数据

**POST** `/repos/:id/refresh`

需要 `readwrite` 及以上角色，重新扫描仓库的所有分支和提交历史。

---

### 二、认证 API

用户分为三种角色：`admin`（管理员）、`readwrite`（读写）、`readonly`（只读）。第一个注册的用户自动成为管理员，之后注册的用户默认只读，由管理员按需提升。旧版本中的 `user` 角色会自动迁移为 `readwrite`。

系统有且只有一个管理员账号。除首个注册用户外，不支持创建其他管理员，也不支持通过编辑用户转移管理员角色。

新注册账号需要管理员审核：注册后状态为 `pending`（待审核），不会签发 token，也无法登录；管理员在账号管理页点击「通过」后状态变为 `active` 才能登录，点击「拒绝」会直接删除该用户数据。为避免恶意注册堆积，同时处于待审核状态的账号数量受 `maxPendingRegistrations` 限制（默认 20），达到上限后注册接口返回 `429`。

权限等级为 `readonly < readwrite < admin`。所有权限校验都以数据库中的最新角色为准，因此修改角色、禁用账号会立即生效，无需重新登录。

- `readonly`：可以查看数据（仓库、待办、博客），不能执行任何写操作。
- `readwrite`：可以使用待办、博客、仓库管理的全部读写功能。
- `admin`：在读写权限之上，额外拥有用户管理能力。

账号状态分为 `pending`（待审核）、`active`（已启用）、`disabled`（已禁用）。只有 `active` 账号可以登录和调用需要认证的接口。

博客的写操作（新增、更新、删除、刷新）需要 `readwrite` 及以上角色，博客查询接口无需认证。

#### 1. 注册

**POST** `/auth/register`

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `username` | string | **是** | 用户名（3-32 个字符） |
| `password` | string | **是** | 密码（至少 6 个字符） |

**成功响应 `201`：**

首个注册用户直接成为管理员并返回 token：

```json
{
  "res": true,
  "user": { "id": 1, "username": "admin", "role": "admin", "status": "active" },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

后续注册用户进入待审核状态，不返回 token：

```json
{
  "res": true,
  "user": { "id": 2, "username": "alice", "role": "readonly", "status": "pending" },
  "pending": true,
  "message": "registration pending approval"
}
```

| 错误码 | 场景 |
|---|---|
| 400 | 用户名或密码不符合要求 |
| 409 | 用户名已存在 |
| 429 | 待审核账号已达到 `maxPendingRegistrations` 上限 |

#### 2. 登录

**POST** `/auth/login`

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `username` | string | **是** | 用户名 |
| `password` | string | **是** | 密码 |

**成功响应：**

```json
{
  "res": true,
  "user": { "id": 1, "username": "admin", "role": "admin" },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

| 错误码 | 场景 |
|---|---|
| 400 | 缺少用户名或密码 |
| 401 | 用户名或密码错误 |
| 403 | 账号待审核（`account pending approval`）或已禁用（`account is disabled`） |

#### 3. 获取当前用户信息

**GET** `/auth/me`

需要认证（携带 `Authorization: Bearer <token>`）。

**响应：**

```json
{
  "res": true,
  "user": { "userId": 1, "username": "admin", "role": "admin" },
  "local": true
}
```

`local` 表示本次请求来自本机（loopback）。前端据此决定非图片附件是“系统默认程序打开”（本机）还是“浏览器预览 / 下载”（其他设备）。

#### 认证方式

在需要认证的接口，请求头中添加：

```
Authorization: Bearer <token>
```

---

### 三、用户管理 API（仅管理员）

所有接口都需要 `admin` 角色，并在请求头携带 `Authorization: Bearer <token>`。

新注册用户以 `pending` 状态出现在用户列表最前方，管理员可以：

- 审核通过：`PATCH /users/:id`，body `{ "status": "active" }`；
- 拒绝注册：`DELETE /users/:id`，该用户数据会被删除，无法登录。

#### 1. 用户列表

**GET** `/users`

| 参数 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `search` | string | 否 | 按用户名模糊搜索 |
| `role` | string | 否 | 角色筛选：`admin` / `readwrite` / `readonly` |
| `status` | string | 否 | 状态筛选：`pending` / `active` / `disabled` |
| `page` | string | 否 | 页码，默认 1 |
| `pageSize` | string | 否 | 每页条数，默认 20，最大 100 |
| `sort` | string | 否 | 排序字段：`id` / `username` / `role` / `status` / `created_at` / `last_login_at` |
| `order` | string | 否 | `asc` / `desc`，默认 `asc` |

未显式指定 `sort` 时，`pending` 账号始终排在列表最前面。

**响应：**

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

#### 2. 用户详情

**GET** `/users/:id`

#### 3. 创建用户

**POST** `/users`

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `username` | string | **是** | 3-32 个字符，唯一 |
| `password` | string | **是** | 至少 6 个字符 |
| `role` | string | 否 | 默认 `readonly`；不支持创建 `admin`（返回 400） |
| `status` | string | 否 | 默认 `active` |

#### 4. 修改用户

**PATCH** `/users/:id`

可传字段：`username`、`password`（重置密码）、`role`、`status`。

`status` 可取 `active` 或 `disabled`；`pending` 只由注册产生，审核通过时将其改为 `active`。

保护规则：

- 不能修改自己的角色或状态；
- 系统有且只有一个管理员：不支持把其他用户设为 `admin`（返回 400）；
- 管理员账号必须保持 `active`；
- 系统必须至少保留一个可用的管理员（不能降级、禁用或删除最后一个 active 管理员）。

#### 5. 删除用户

**DELETE** `/users/:id`

- 不能删除当前登录账号；
- 删除时会级联清理该用户的待办、分类、标签、附件记录及附件文件；
- 拒绝待审核注册申请同样使用此接口，删除后该账号无法登录。

#### 6. 迁移用户数据

**POST** `/users/:id/transfer`

把 `:id` 用户的全部待办数据迁移给另一个用户（仅管理员）。

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `targetUserId` | number | **是** | 目标用户 ID，不能与源用户相同 |

迁移规则：

- 迁移分类、标签、待办和附件；待办相关的完成记录、提醒、通知日志随待办一起保留；
- 目标用户已有同名同级分类、同名标签时自动复用并合并，不产生重复数据；
- 源用户的分类、标签、待办和附件会被清空（账号本身保留）；
- 附件文件会从源用户目录移动到目标用户目录。

**响应：**

```json
{
  "res": true,
  "message": "transferred",
  "stats": { "categories": 3, "tags": 2, "todos": 12, "images": 4 }
}
```

---

### 四、数据共享 API

待办数据支持按文件夹（含子文件夹）或收件箱共享给其他用户，共享分两档权限：

| 权限 | 说明 |
|---|---|
| `readonly` | 只读：可以查看共享范围内的任务，不能新增、修改、删除 |
| `write` | 可编辑：可以对共享范围内的任务执行增删改 |

说明：

- 共享只能由数据所有者创建；管理员可以在共享列表中查看全部共享，并可代为调整权限或取消共享；
- 系统角色为 `readonly` 的账号仍不能执行任何写操作，共享写权限对 `readwrite` 及以上角色生效；
- 共享任务在任务接口中会返回 `ownerId`、`ownerUsername`、`permission`、`shared` 字段，便于前端标记来源；
- 共享文件夹本身只能由所有者重命名、移动或删除，被共享者只操作其中的任务；
- 在共享文件夹中新建的任务归属文件夹所有者，被共享者不能把任务移动到其他人的文件夹；
- 收件箱共享支持查看和编辑已有任务，但新建任务始终进入自己的收件箱。

#### 1. 共享可选项

**GET** `/todo-shares/options`

返回当前用户可共享的文件夹（含 `path` 与 `taskCount`）、收件箱任务数、可共享的启用用户，以及当前用户是否为管理员（`isAdmin`）。

#### 2. 共享列表

**GET** `/todo-shares?scope=mine|received|all`

| scope | 说明 |
|---|---|
| `mine` | 我共享出去的（默认） |
| `received` | 共享给我的 |
| `all` | 全部共享（仅管理员） |

每条记录包含 `categoryPath`（文件夹路径）、`permission`、所有者与被共享者用户名。

#### 3. 创建共享

**POST** `/todo-shares`

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `granteeId` | number | **是** | 被共享用户 ID，不能是自己 |
| `scope` | string | **是** | `category` 或 `inbox` |
| `categoryId` | number | scope=category 时必填 | 自己的文件夹 ID |
| `permission` | string | 否 | `readonly`（默认）或 `write` |

重复共享同一范围时直接更新权限并返回 200；新建返回 201。

#### 4. 修改共享权限

**PATCH** `/todo-shares/:id`

```json
{ "permission": "write" }
```

仅数据所有者或管理员可操作。

#### 5. 取消共享

**DELETE** `/todo-shares/:id`

仅数据所有者或管理员可操作。

---

### 五、博客文章 API

#### 1. 查询博客列表 / 单篇（无需认证）

**GET** `/blogs`

支持按标签、分类筛选，以及分页和排序。

| 参数 | 类型 | 必需 | 默认值 | 说明 |
|---|---|---|---|---|
| `id` | string | 否 | — | 传入时返回单篇博客 |
| `search` | string | 否 | — | 全文搜索关键词，同时匹配标题/摘要/内容 |
| `tags` | string / string[] | 否 | — | 标签筛选，多个取交集 |
| `categories` | string / string[] | 否 | — | 分类筛选，递归匹配子分类 |
| `page` | string | 否 | `"1"` | 页码 |
| `pageSize` | string | 否 | `"20"` | 每页条数（1-100） |
| `sort` | `"date"` / `"updated"` | 否 | `"date"` | 排序字段 |
| `order` | `"asc"` / `"desc"` | 否 | `"desc"` | 排序方向 |

**请求示例：**

```
GET /gitstatus/api/blogs?tags=React&categories=技术&page=1&pageSize=10
GET /gitstatus/api/blogs?search=入门指南&page=1
GET /gitstatus/api/blogs?id=1
```

**搜索说明：**

- 不区分大小写，模糊匹配
- 同时搜索 title、excerpt 和文件内容（自动读取 .md 文件）
- 内容匹配时，通过 `searchResult` 字段返回关键词前后各 20 字符的摘要片段（已去除 Markdown 格式），`content` 保持原始路径
- 可与 tags、categories、分页、排序等参数组合使用

**列表响应：**

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
      "searchResult": ""，
      "content": "/技术/前端/我的文章.md",
      "cover": "",
      "comment": []
    }
  ]
}
```

**单篇响应：**

```json
{ "res": true, "blog": { ... } }
```

| 错误码 | 场景 |
|---|---|
| 400 | id 无效 |
| 404 | 博客不存在 |

---

#### 2. 新增博客（需读写及以上权限）

**POST** `/blogs`

支持两种方式：JSON 和 multipart/form-data 文件上传。

**方式一：JSON**

```json
POST /gitstatus/api/blogs
Content-Type: application/json

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
curl -X POST /gitstatus/api/blogs \
  -F "title=React入门指南" \
  -F 'tags=["React","前端"]' \
  -F 'categories=["技术","前端","React"]' \
  -F "excerpt=一篇React入门教程" \
  -F "file=@article.md"
```

| 字段 | 类型 | 必需 | 默认值 | 说明 |
|---|---|---|---|---|
| `title` | string | **是** | — | 博客标题，同时作为 md 文件名 |
| `date` | string | 否 | 当前时间 | 创建时间 `YYYY-MM-DD HH:mm:ss` |
| `tags` | string[] | 否 | `[]` | 标签数组（form-data 中传 JSON 字符串） |
| `categories` | string[] | 否 | `[]` | 分类数组，按顺序构成文件夹层级 |
| `excerpt` | string | 否 | `""` | 摘要 |
| `content` | string | 否 | `""` | 正文内容（JSON 方式） |
| `file` | File | 否 | — | 上传的 .md 文件（优先级高于 content） |
| `cover` | string | 否 | `""` | 封面图 URL |
| `comment` | unknown[] | 否 | `[]` | 评论数据 |

**文件系统效果：** 当传入 `categories` 时，自动在 `src/docs/` 下创建对应的多级文件夹，并生成 `{title}.md` 文件。

```
src/docs/
  └── 技术/
      └── 前端/
          └── React/
              └── React入门指南.md
```

**成功响应 `201`：**

```json
{
  "res": true,
  "blog": {
    "id": 2,
    "title": "React入门指南",
    "date": "2025-04-14 10:30:00",
    "updated": "2025-04-14 10:30:00",
    "tags": ["React", "前端"],
    "categories": ["技术", "前端", "React"],
    "excerpt": "一篇React入门教程",
    "content": "/技术/前端/React/React入门指南.md",
    "cover": "https://example.com/cover.jpg",
    "comment": []
  }
}
```

| 错误码 | 场景 |
|---|---|
| 400 | 缺少标题 / 分类路径不合法 / 标题无法生成文件名 |
| 500 | 服务器内部错误 |

---

#### 3. 更新博客（需读写及以上权限）

**PATCH** `/blogs/:id`

部分更新博客信息，`updated` 自动刷新为当前时间。支持 JSON 和 multipart/form-data 两种方式。

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `title` | string | 否 | 新标题（变化时自动重命名文件） |
| `tags` | string[] | 否 | 新标签数组（整体替换） |
| `categories` | string[] | 否 | 新分类数组（变化时自动移动文件到新目录） |
| `excerpt` | string | 否 | 新摘要 |
| `content` | string | 否 | 新正文内容（写入文件，不改变数据库路径） |
| `file` | File | 否 | 上传 .md 文件替代 content（优先级更高） |
| `cover` | string | 否 | 新封面 URL |
| `comment` | unknown[] | 否 | 新评论数据 |

**文件联动逻辑：**

- `title` 变化 → 文件重命名
- `categories` 变化 → 文件移动到新目录，旧空目录自动清理
- `content` / `file` 传入 → 内容写入对应 md 文件

**响应示例：**

```json
{ "res": true, "blog": { ... } }
```

| 错误码 | 场景 |
|---|---|
| 400 | id 无效 / 路径不合法 |
| 404 | 博客不存在 / md 文件不存在 |

---

#### 4. 删除博客（需读写及以上权限）

**DELETE** `/blogs/:id`

删除博客记录，同时删除对应的 md 文件并递归清理空目录。

**响应：**

```json
{ "res": true, "message": "deleted" }
```

| 错误码 | 场景 |
|---|---|
| 400 | id 无效 |
| 404 | 博客不存在 |

---

#### 5. 刷新博客（双向同步，需管理员权限）

**POST** `/blogs/refresh`

扫描 `src/docs/` 目录与数据库进行双向同步：

- 文件存在但数据库无记录 → 自动创建博客记录
- 数据库有记录但文件已不存在 → 自动删除博客记录

**响应：**

```json
{
  "res": true,
  "added": 2,
  "removed": 1,
  "addedFiles": ["/技术/新文章.md"],
  "removedFiles": ["/技术/已删除的文章.md"]
}
```

---

### 六、静态资源与前端页面

| 路径 | 说明 |
|---|---|
| `/pages/index.html` | Git 洞察页面 |
| `/pages/todo.html` | 待办清单页面 |
| `/pages/shares.html` | 数据共享页面（所有登录用户） |
| `/pages/account.html` | 账号管理页面（仅管理员） |
| `/pages/auth-test.html` | Auth API 测试页面 |
| `/pages/assets/styles/*` | 共享主题与组件样式（`theme.css` / `components.css` / `pet-widget.css`） |
| `/pages/assets/js/*` | 共享前端脚本（`auth-client.js` / `account.js` / `shares.js` / `pet-widget.js`） |
| `/pages/assets/vendor/*` | 本地第三方库（Chart.js、chartjs-plugin-zoom） |
| `/gitstatus/api/docs/*` | 博客文档静态文件 (`src/docs/`) |

所有页面均不依赖外部 CDN，第三方 JS 已放入 `src/pages/assets/vendor/`。页面统一使用 `theme.css` 中的设计令牌，以及 `components.css` 中的按钮、表单、卡片、表格、弹窗、Toast、账号信息卡等组件。

顶部导航（品牌、导航链接、账号图标）在业务页面中保持一致；将鼠标悬停在账号图标上会显示账号信息卡片，其中包含角色、状态、最近登录时间，以及退出登录和账号管理入口（仅管理员可见）。账号管理页支持审核新注册用户（通过 / 拒绝）、将某个用户的待办数据迁移给另一个用户（含分类、标签、待办、完成记录、提醒与附件）。待办页支持上传图片与其他文件：图片可预览、可粘贴截图或直接拖入上传，预览支持滚轮 / 双指缩放、拖拽平移、双击切换与快捷缩放（+ / - / 0），其他文件只保存与下载、不做预览。数据共享页支持管理「共享给我的」「我共享出去的」以及（管理员）「全部共享」；待办页会用共享标记展示来自其他用户的文件夹与任务，只读共享会自动禁用编辑入口。

#### 桌宠挂件

`pet-widget.css` + `pet-widget.js` 是一个通用的页面桌宠组件，`index / todo / shares / account` 四个页面均已引入：

- 默认停在右下角，可拖拽并吸附左右下边缘，吸附到左半屏时自动镜像转身；位置、静音、已读提醒都保存在 `localStorage`
- 左键点击桌宠只弹出小气泡：根据当天「总数 / 已完成 / 未完成 / 逾期」自动切换文案（如「今天没事喵，耍起喵～」「今天所有 5 条待办都完成啦喵！」「今天还有 3 条待办喵，一共 5 条待办喵」），带完成进度条与提醒时间，约 7 秒自动收起
- 桌宠右上角的菜单按钮才打开完整面板（当天统计、前 3 条待办、下一条提醒与设置入口），角标显示当天待完成数量
- 轮询 `GET /todo-widget/summary`：当天待办统计、下一条提醒与最近的提醒事件；触发提醒时桌宠抖动并弹出气泡，可选提示音（WebAudio 合成，无音频文件）
- 完整面板右上角「设置」打开气泡内嵌设置面板（无独立页面），按账号保存到 `pet_settings`：
  - **间隔提醒**：有未完成待办时每隔 N 分钟冒泡，文案如「老大还有 3 件事未完成喵～」；可选仅在工作时间内提醒（默认全天）
  - **上下班提醒**：到上班 / 下班时间后的 10 分钟窗口内，如仍有未完成待办则提醒一次
  - **截止提醒**：单次任务按截止日期 + 截止时间、重复任务按重复结束日期提前 X 分钟提醒；只有日期没有具体时间的任务按下班时间计算，0 表示关闭
- 已授予浏览器通知权限时同步发送系统通知；未授予时不会主动弹授权框
- 移动端：触摸拖拽不会带动页面滚动，气泡宽度自适应屏幕
- 角色素材：在气泡「设置 → 素材设置」里导入图片（PNG / JPG / WebP / GIF，最大 2MB），图片保存在服务端 `src/output/pet-assets/`，按账号同步，换设备登录同一账号也能看到；桌宠大小、镜像与提醒音只保存在当前浏览器（镜像默认关闭，导入素材保持原方向）
- 未上传账号素材时使用内置内联 SVG 造型；也可以用静态图片作为默认造型，二选一：
  - 在脚本标签上直接声明（四个页面各改一处）：`<script src="/pages/assets/js/pet-widget.js" data-pet-image="/pages/assets/pet/whale.png"></script>`
  - 或在引入脚本前设置全局配置：

```html
<script>
  window.GITSTATUS_PET_CONFIG = { petImage: '/pages/assets/pet/whale.png' };
</script>
<script src="/pages/assets/js/pet-widget.js"></script>
```

图片缺失或加载失败时会自动回退到内置 SVG 造型。还支持 `data-pet-api`、`data-pet-todo-url`（或对应的 `apiBase` / `todoUrl` 配置项）覆盖接口前缀与待办页地址。账号素材的读取需要登录态，挂件会带 Token 取回图片后再展示。

> 参考项目 `MeteorNOX/DeepSeek-Balance-Whale-Widget` 的代码为 MIT 协议，但其 `assets/` 下的美术素材（图片 / 动图 / 音效）明确不在 MIT 覆盖范围内、不授予再许可。若要使用其中素材，需先获得作者授权，或替换为自己的图片。

---

### 七、数据结构

#### BlogPost（API 返回格式）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | 博客 ID |
| `title` | string | 标题 |
| `date` | string | 创建时间 |
| `updated` | string | 更新时间 |
| `tags` | string[] | 标签数组 |
| `categories` | string[] | 分类数组（对应文件夹层级） |
| `excerpt` | string | 摘要 |
| `content` | string | md 文件相对路径 |
| `cover` | string | 封面 URL |
| `comment` | unknown[] | 评论数据 |
| `searchResult` | string? | 搜索时内容匹配的上下文片段（仅搜索命中文件内容时返回） |

---

### 八、文件上传限制

#### 博客文件

| 项目 | 限制 |
|---|---|
| 最大文件大小 | 10MB |
| 允许文件类型 | `.md` 文件（text/markdown、text/plain） |
| 上传字段名 | `file` |

#### 待办附件

| 类型 | 数量上限 | 单个大小上限 | 允许类型 |
|---|---:|---:|---|
| 图片 | 5 | 8 MB | JPEG / PNG / GIF / WebP / BMP / AVIF，可预览 |
| 其他文件 | 10 | 32 MB | 常见文档与压缩包；可执行文件后缀（`.exe`、`.msi`、`.bat`、`.cmd`、`.ps1`、`.js`、`.jar` 等）被拒绝 |

上传接口：`POST /todos/:id/attachments`，字段名 `images`、`files` 或 `file`；待办弹窗支持把文件直接拖入附件区、粘贴截图（Ctrl+V）上传，其他文件只保存与下载、不提供预览。附件详情中的点击行为按访问来源区分：本机访问时调用 `GET /todo-attachments/:id/open` 由后端用系统默认程序打开；其他设备上 PDF、文本、音视频在浏览器新标签预览，其余类型直接下载。旁边的下载按钮始终可保存文件。

---

### 九、日志

服务运行日志按日期自动切分，保存在 `src/output/logs/YYYY-MM-DD.log`，同时输出到控制台。

**日志级别：**

| 级别 | 说明 |
|---|---|
| `ACCESS` | HTTP 请求访问日志（方法、路径、状态码、耗时、IP） |
| `INFO` | 常规信息（服务启动、注册尝试等） |
| `WARN` | 警告（配置加载失败回退、文件删除失败等） |
| `ERROR` | 错误（子进程 stderr、异常堆栈等） |

**示例：**
```
[2026-04-14 10:32:15.123] [INFO] server running: http://localhost:65123
[2026-04-14 10:32:20.456] [ACCESS] GET /gitstatus/api/blogs 200 12ms - ::1
[2026-04-14 10:32:25.789] [WARN] [config] failed to read ...
```

---

### 十、配置文件

`config/config.json`：

| 字段 | 说明 | 默认值 |
|---|---|---|
| `allowedOrigins` | CORS 白名单 | `["http://localhost:65123"]` |
| `jwtSecret` | JWT 签名密钥（生产环境请修改） | `"gitstatus-default-secret-please-change"` |
| `jwtExpiresIn` | Token 过期时间 | `"7d"` |
| `maxPendingRegistrations` | 同时待审核的最大注册数量（1-500） | `20` |

`maxPendingRegistrations` 也可以通过环境变量 `MAX_PENDING_REGISTRATIONS` 覆盖，环境变量优先。

---

### 十一、通用错误响应格式

```json
{ "res": false, "message": "错误描述" }
```
