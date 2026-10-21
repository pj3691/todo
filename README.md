# GitStatus

用 AI 实现的一个用于离线查看本地 Git 历史记录的小工具，提供类似于 GitHub 首页提交热力图、提交历史查看、每日活跃度等功能，同时包含博客文章管理系统。

## 使用方法

1. `npm install`
2. `npm run dev`

服务运行在 `http://localhost:65123`

---

## API 接口文档

基础路径：`/gitstatus/api`

---

### 一、仓库管理 API

#### 1. 查询仓库列表 / 单个仓库

**GET** `/repos`

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

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `name` | string | **是** | 仓库名称 |
| `url` | string | **是** | 本地仓库路径 |
| `defaultBranch` | string | 否 | 默认分支 |

#### 3. 修改仓库

**PATCH** `/repos/:id`

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `name` | string | **是** | 仓库名称 |
| `url` | string | **是** | 本地仓库路径 |
| `defaultBranch` | string | 否 | 默认分支 |

#### 4. 刷新仓库数据

**POST** `/repos/:id/refresh`

重新扫描仓库的所有分支和提交历史。

---

### 二、认证 API

用户分为两种角色：`admin`（管理员）和 `user`（普通用户）。第一个注册的用户自动成为管理员。

博客的写操作（新增、更新、删除、刷新）仅管理员可操作，博客查询接口无需认证。

#### 1. 注册

**POST** `/auth/register`

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `username` | string | **是** | 用户名（3-32 个字符） |
| `password` | string | **是** | 密码（至少 6 个字符） |

**成功响应 `201`：**

```json
{
  "res": true,
  "user": { "id": 1, "username": "admin", "role": "admin" },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

| 错误码 | 场景 |
|---|---|
| 400 | 用户名或密码不符合要求 |
| 409 | 用户名已存在 |

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

#### 3. 获取当前用户信息

**GET** `/auth/me`

需要认证（携带 `Authorization: Bearer <token>`）。

**响应：**

```json
{
  "res": true,
  "user": { "userId": 1, "username": "admin", "role": "admin" }
}
```

#### 认证方式

在需要认证的接口，请求头中添加：

```
Authorization: Bearer <token>
```

---

### 三、博客文章 API

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

#### 2. 新增博客（需管理员权限）

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

#### 3. 更新博客（需管理员权限）

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

#### 4. 删除博客（需管理员权限）

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

### 四、模型简化 API

模型简化接口用于接收客户端上传的 3D 模型文件（例如 `.gltf` / `.glb` / `.obj`），调用 `gltfpack` 进行简化/打包，并将简化后的文件保存到服务器 `src/output/models`，返回可通过 API 访问的路径。

**POST** `/models/simplify`

| 字段 | 类型 | 必需 | 说明 |
|---|---:|---:|---|
| `file` | File | **是** | 要上传的模型文件，支持 `.gltf`, `.glb`, `.obj`, `.fbx` 等常见格式（multipart/form-data） |
| `args` | string | 否 | 传递给 `gltfpack` 的额外参数字符串（空格分隔）。服务器会强制使用内部指定的输入/输出路径，`-i` 和 `-o` 参数将被忽略或覆盖。|

**安全说明：**
- 默认情况下服务器会忽略/覆盖 `-i` 和 `-o`，并将输出写入受控目录 `src/output/models`，以防止路径遍历或覆盖系统文件。若允许传入完整参数，需要额外打开受信任模式或管理员权限。

**请求示例（curl）**：
```bash
curl -v \
  -F "file=@/full/path/to/model.glb" \
  -F "args=-b -q 80" \
  http://localhost:30012/gitstatus/api/models/simplify
```

**请求示例（fetch）**：
```javascript
const form = new FormData();
form.append('file', myFile); // 浏览器端的 File/Blob
form.append('args', '-b -q 80');

const resp = await fetch('http://localhost:30012/gitstatus/api/models/simplify', {
  method: 'POST',
  body: form,
});
const data = await resp.json();
console.log(data);
```

**成功响应示例**：
```json
{ "res": true, "path": "/gitstatus/api/models/model-simplified.glb" }
```

**错误响应**：
- 400: 上传失败或缺少 `file` 字段
- 500: 服务器内部错误或 `gltfpack` 执行失败（stderr 将记录在服务日志）

---



### 四、静态资源

| 路径 | 说明 |
|---|---|
| `/pages/*` | 页面静态文件 (`src/pages/`) |
| `/gitstatus/api/docs/*` | 博客文档静态文件 (`src/docs/`) |

---

### 五、数据结构

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

### 六、文件上传限制

| 项目 | 限制 |
|---|---|
| 最大文件大小 | 10MB |
| 允许文件类型 | `.md` 文件（text/markdown、text/plain） |
| 上传字段名 | `file` |

---

### 七、日志

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

### 八、配置文件

`config/config.json`：

| 字段 | 说明 | 默认值 |
|---|---|---|
| `allowedOrigins` | CORS 白名单 | `["http://localhost:65123"]` |
| `jwtSecret` | JWT 签名密钥（生产环境请修改） | `"gitstatus-default-secret-please-change"` |
| `jwtExpiresIn` | Token 过期时间 | `"7d"` |

---

### 九、通用错误响应格式

```json
{ "res": false, "message": "错误描述" }
```
