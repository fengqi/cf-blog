# cf-blog

基于 Cloudflare Workers 的博客系统。前台是纯静态、由 R2 直出；后台是一个 Worker，提供写作与管理界面。

- 设计文档：[`docs/design.md`](docs/design.md)
- 建表脚本：[`docs/schema.sql`](docs/schema.sql) —— `migrations/0001_init.sql` 是它的副本，供 wrangler 使用

## 为什么这么搭

前台每一个页面（文章、首页、分页、分类、标签、归档、Feed、Sitemap）都在**发布时**渲染成完整 HTML 写入 R2，由 R2 直接对外服务。

**前台零 Worker 请求** —— 这是绕开 Workers 免费版 10 万请求/天 的唯一手段。注意边缘缓存省不了请求额度（命中缓存也照算），只有"不进 Worker"才行。

| | 域名 | 归谁服务 | 请求量 |
|---|---|---|---|
| 前台 | `blog.fengqi.me` | R2 自定义域名，直出 | 不消耗 Worker 额度 |
| 后台 | `admin-blog.fengqi.me` | Worker（全项目只有这一个） | 每天几十次 |

> 前台域名**不硬编码**：唯一来源是 `options.site_url`，由 `src/models/option.ts` 的 `getSiteInfo()` 读出来交给主题。
> 当前值是 `blog.fengqi.me`，而线上老站仍在 `fengqi.me` —— 正式切换只做三件事：改配置 → 配 R2 自定义域名 → 全站重渲。

由此得出一条判断标准：**任何"每个 PV 调一次 Worker"的设计都是退步** —— 客户端埋点、动态搜索、分页 JSON 动态加载都属于这一类。设计文档 §13.3 记录了为什么这些被排除。

## 目录结构

```
theme/            前台主题（字符串模板，发布时渲染后写入 R2）
src/
  routes/         后台路由
  views/          后台页面组件（Hono JSX，.tsx）
  models/         SQL 只允许写在这里
  publish/        ★ 发布流水线：渲染 → 写 D1 → 写 R2
  lib/            D1 / R2 / markdown / 认证 / URL 映射的封装
migrations/       D1 迁移（wrangler 默认目录，无需额外配置）
docs/             设计文档与建表脚本
scripts/          一次性脚本（Typecho 迁移、密码哈希）
```

## 本地开发

```bash
npm install
npm run dev          # 本地跑 Worker；D1 走本地 SQLite，不消耗线上额度
npm run typecheck    # tsc --noEmit，提交前跑一下
npm run bench:render # 渲染压测（合成 120 篇文章，不连数据库/R2），见 design.md §13.1 #4
npm run cf-typegen   # 改了 wrangler.jsonc 的绑定之后必须重跑，否则 c.env.xxx 没有类型
npm run deploy       # 手动部署（不碰数据库）
npm run deploy:ci    # 应用 D1 迁移 + 部署（Workers Builds 用的就是这个）
```

## 资源与绑定

`wrangler.jsonc` 里已配好，绑定名统一 UPPER_SNAKE：

| 类型 | 资源名 | 绑定名 |
|---|---|---|
| D1 | `blog-db` | `DB` |
| R2 | `blog-content` | `BUCKET` |
| KV | `LOGIN_KV` | `LOGIN_KV` |

> 改**绑定名**不影响已创建的资源 —— 真正生效的是 `database_name` / `bucket_name` / `id`。

Worker 用到的 secret：

```bash
wrangler secret put SESSION_SECRET   # openssl rand -base64 32
wrangler secret put IP_SALT
wrangler secret put TURNSTILE_SECRET
```

## 部署

用 **Cloudflare Workers Builds**（Cloudflare 原生的 Git 集成 CI/CD），不自己写工作流。

配置位置：控制台 → Workers & Pages → `cf-blog-admin` → Settings → Builds → 连接 GitHub 仓库。

| 字段 | 值 |
|---|---|
| 构建命令 | `npm ci` |
| 部署命令 | `npm run deploy:ci` |

`deploy:ci` 定义在 `package.json` 里，内容是「先应用 D1 迁移，再 `npm run deploy`」——
部署逻辑跟着代码走，可 review、可 diff，不散落在控制台的输入框里。

之后 push 到 `master` 自动构建 + 部署，构建日志在 **Worker → Deployments** 里看。

**两个必须知道的点：**

1. **Builds token 需要有 D1 编辑权限。** 部署命令里要跑迁移，而 Cloudflare 自动创建的那个 Builds token 可能**没有** D1: Edit 权限 —— 缺了迁移会失败。首次构建后看一眼日志，失败就自己建一个带该权限的 token 换上去。
2. **Build variables 和 Worker 运行时的 secret 不是一回事。** 前者只在构建时可见；后者才是代码里 `c.env.SESSION_SECRET` 那些。

免费额度：**3,000 构建分钟/月**、1 个并发构建、单次上限 20 分钟。本项目一次构建 1–2 分钟，够用。

> Workers Builds 只支持 GitHub / GitLab —— 自建 Gitea 用不了这条路。

### 代码之外的配置

这几项不在仓库里，要去 Cloudflare 控制台配：

1. R2 bucket `blog-content` → Settings → Custom Domains → 加 `blog.fengqi.me`
2. Workers → `cf-blog-admin` → Settings → Domains & Routes → 加 `admin-blog.fengqi.me`

**顺序不能反**：先确认 R2 自定义域名生效，再配 Worker 的 Custom Domain。两个 hostname 互相独立，是整套方案零冲突的基础。

## 两条硬约束

1. **SQL 只允许写在 `src/models/` 和 `src/lib/db.ts` 里。** `routes/` 和 `theme/` 不碰数据库。
2. **R2 写入只能由 `src/publish/` 触发。** 底层封装在 `src/lib/r2.ts`（缓存头也在那），但 `routes/`、`views/`、`models/` 不许调用写函数 —— 别的地方碰 R2 会让缓存策略和对象一致性失控，这是静态直出方案唯一的纪律要求。

## 两套渲染机制

- **`theme/`（`.ts`）**：前台主题，纯字符串拼接，发布时渲染完写进 R2。**必须零依赖**，因为它要在发布流水线里裸跑
- **`src/views/`（`.tsx`）**：后台页面，Hono JSX，直接当 HTTP 响应返回

不要互相串用。后台 JSX 另有两条规定：只 import `hono/jsx`（不用 `hono/jsx/dom`）；唯一的转义出口 `dangerouslySetInnerHTML` 只允许用在文章正文。
