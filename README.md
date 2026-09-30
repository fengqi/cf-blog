# cf-blog

基于 Cloudflare Workers 的博客系统。前台是纯静态、由 R2 直出；后台是一个 Worker，提供写作与管理界面。

- 设计文档：[`docs/design.md`](docs/design.md)
- **进度 / TODO：[`docs/todo.md`](docs/todo.md)** —— 已完成什么、下一步做什么、已知取舍
- 建表脚本：[`docs/schema.sql`](docs/schema.sql) —— `migrations/0001_init.sql` 是它的副本，供 wrangler 使用

## 为什么这么搭

前台每一个页面（文章、首页、分页、分类、标签、归档、索引页、Feed、Sitemap）都在**发布时**渲染成完整 HTML 写入 R2，由 R2 直接对外服务。

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
  assets/         CSS / JS 源文件 —— 由 build:assets 打指纹后写入 R2 的 theme/
  assets.ts       资源访问器（路径、<link>、<script> 标签）
  layout.ts       页面骨架：顶栏导航 + 全站限宽（50rem，见 style.css 的 --container-size）
  toc.ts          文章目录：抽 h2/h3、生成锚点 id、写回正文
  overview.ts     索引页 /categories/、/tags/、/archives/
src/
  routes/         后台路由
  views/          后台页面组件（Hono JSX，.tsx）
  models/         SQL 只允许写在这里
  publish/        ★ 发布流水线：渲染 → 写 D1 → 写 R2
  lib/            D1 / R2 / markdown / 认证 / URL 映射的封装
migrations/       D1 迁移（wrangler 默认目录，无需额外配置）
docs/             设计文档与建表脚本
scripts/          一次性脚本（Typecho 迁移、密码哈希、主题资源构建）
```

## 本地开发

```bash
npm install
npm run dev          # 本地跑 Worker；D1 走本地 SQLite，不消耗线上额度
npm run typecheck    # tsc --noEmit，提交前跑一下
npm run build:assets # 改了 theme/assets/ 之后必须跑：重新算指纹，产出 assets.generated.ts
npm run bench:render # 渲染压测（合成 120 篇文章，不连数据库/R2），见 design.md §13.1 #4
npm run cf-typegen   # 改了 wrangler.jsonc 的绑定之后必须重跑，否则 c.env.xxx 没有类型
npm run deploy       # 手动部署（不碰数据库）
npm run deploy:ci    # 构建主题资源 + 应用 D1 迁移 + 部署（Workers Builds 用的就是这个）
```

**本地开发要先有 `.dev.vars`**（模板 `/.dev.vars.example`，已 gitignore）。`SESSION_SECRET`
与 `IP_SALT` 缺一个，登录相关路由就会**故意返回 500**（fail-closed）：

```bash
cp .dev.vars.example .dev.vars              # 首次
npx wrangler d1 migrations apply blog-db --local
npm run hash-password -- '本地口令'          # 输出的命令把 --remote 换成 --local 执行
npm run dev                                 # http://127.0.0.1:8787
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"   # 本地手动触发 Cron
```

> ⚠️ **别用 `wrangler secret put` 做本地调试 —— 它写的是线上 Worker。** 三者区别：
>
> | 场景 | 放哪里 | 影响范围 |
> |---|---|---|
> | 本地开发 | 项目根 `.dev.vars`（gitignore） | 只影响本机 `wrangler dev` |
> | 线上 | `wrangler secret put X` | 直接写线上 Worker，下次请求生效 |
> | CI 构建期 | 控制台 Build variables | 只在构建时可见，运行时读不到 |

> **主题资源是带指纹的**（`theme/style.<hash>.css`，缓存头 `immutable`）：改了
> `theme/assets/` 下的文件却不跑 `build:assets`，页面里的 `<link>` 仍指向旧指纹，
> 样式不会更新。改完资源要 **构建 → 全站重渲**，两步都不能省（design.md §7.2）。

### 本地预览前台（R2 静态页）

线上前台是「R2 + 自定义域名」，本地没有这一层，所以 `npm run preview:r2` 起一个预览器
（`scripts/preview-worker.ts` + `wrangler.preview.jsonc`，**只绑本地 D1/R2**，不在任何部署路径里）。
它按 R2 的真实规则把请求路径映射成 key（先解码、再精确匹配，`/` → 空 key），
于是本地也能点着看：相对链接、`/theme/style.<hash>.css`、附件图片都能正常加载。

```bash
npm run preview:r2                     # http://127.0.0.1:8790
# 改了模板/资源之后，把当前 D1 重新渲进本地 R2（自动循环到 nextOffset 为 null）
npm run build:assets                                                    # 改了 theme/assets/ 才需要
npm run rebuild:local
curl "http://127.0.0.1:8790/__keys"                                     # 列对象，对账用
```

想预览**线上**桶里的对象（例如确认发布结果）：`npx wrangler dev -c wrangler.preview.jsonc --remote`。
⚠️ 该模式下**不要**调 `/__publish` —— 那时绑定指向线上桶，这一步会写生产。

### 本地端到端验证

跑的是**真实 workerd + 本地 D1/R2**，覆盖发布流水线、`needs_sync` 状态机、XSS 清洗、定时发布、删除：

```bash
npx wrangler d1 migrations apply blog-db --local      # 首次或改了迁移之后
npx wrangler dev -c wrangler.e2e.jsonc --port 8788    # 另开一个终端
curl -s http://127.0.0.1:8788/ | tail -3              # 看到「全部通过」即 OK
```

断言集在 `scripts/e2e-runner.ts`（202 项）。`wrangler.e2e.jsonc` 只给本地用，**不要拿它部署**。
（`wrangler dev` 需要写 `~/.wrangler/registry`，在受限沙箱里跑不起来。）

## 后台

登录地址：`https://admin-blog.fengqi.me/admin`（走 Worker，与前台 R2 完全分开）。

**首次使用必须先设置管理员口令。** `migrations/0001_init.sql` 给 admin 写的是**不可用的占位哈希**
（刻意的 fail-closed，不留默认弱口令），照它建库是登不进去的：

```bash
npm run hash-password -- '你的口令'    # 输出含已转义的 wrangler 命令，直接复制执行
```

后台能做的事：写/改文章与独立页面（**保存即发布**到 R2）、预览草稿、删除文章、
「全站重新渲染」（只标脏，由 Cron 每小时 20 篇逐批重建 —— 见 design.md §6.5）。

- 登录保护：Turnstile（`options.turnstile_site_key` + `TURNSTILE_SECRET`，**两者都配才强制**）+ 同 IP 15 分钟失败 10 次锁定
- `/admin/*`、`/preview/*` 需要登录；`/admin/login` 是唯一公开路由

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

> 这三条写的是**线上** Worker；本地开发用 `.dev.vars`（见「本地开发」一节），两者互不影响。

## 部署

用 **Cloudflare Workers Builds**（Cloudflare 原生的 Git 集成 CI/CD），不自己写工作流。

配置位置：控制台 → Workers & Pages → `cf-blog-admin` → Settings → Builds → 连接 GitHub 仓库。

| 字段 | 值 |
|---|---|
| 构建命令 | `npm ci` |
| 部署命令 | `npm run deploy:ci` |

`deploy:ci` 定义在 `package.json` 里，内容是「构建主题资源 → 应用 D1 迁移 → `npm run deploy`」——
部署逻辑跟着代码走，可 review、可 diff，不散落在控制台的输入框里。

之后 push 到 `master` 自动构建 + 部署，构建日志在 **Worker → Deployments** 里看。

**⚠️ `deploy:ci` 不重渲 R2。** 它只上传代码 + 应用迁移；桶里 800 个静态对象一个不动。
这次改动**会不会出现在前台 HTML 的字节里**，决定要不要在部署后补一步：

- 改了 `theme/assets/`（CSS/JS）、`theme/` 模板、`src/publish` 渲染逻辑 → **要**：
  本地跑 `npm run rebuild:prod`（自动：起 `--remote` 发布会话 → `/full` 从 0 循环到
  `nextOffset=null` → 自查主题指纹对象都在桶里，缺了就报错退出）。跳过这步或中途
  只跑一半，就会出现「页面引用的指纹在桶里不存在 → CSS/JS 404」的事故。
- 只改后台（`src/routes`、`src/views`、`src/models` 等不影响前台输出的）→ 不要，部署即生效。
- 内容增删改走后台，发布流水线自动增量处理，与 CI 无关。

`rebuild:prod` 用的是 `wrangler dev --remote`：跑的是**本地工作区这份代码**，所以跑之前
确保工作区就是刚部署上去的内容（干净、最新）。幂等，失败直接重跑。

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

- **`theme/`（`.ts`）**：前台主题，纯字符串拼接，发布时渲染完写进 R2。**必须零依赖**，因为它要在发布流水线里裸跑。
  同目录下的 `theme/assets/` 是 CSS/JS 源文件，不参与上面的字符串拼接 —— 它由 `build:assets`
  打指纹后作为**独立对象**写进 R2，页面里只留一个 `<link>` / `<script>`（design.md §7.2）
- **`src/views/`（`.tsx`）**：后台页面，Hono JSX，直接当 HTTP 响应返回

不要互相串用。后台 JSX 另有两条规定：只 import `hono/jsx`（不用 `hono/jsx/dom`）；唯一的转义出口 `dangerouslySetInnerHTML` 只允许用在文章正文。

## 导航与版式（速查）

**全站零侧栏。** 站内导航只有顶栏一处：`首页 / 分类 / 标签 / 归档 / 关于`，**不做下拉展开**，
点进去是 `/categories/`、`/tags/`、`/archives/` 三个索引页（索引页是新增 URL，老站没有）。

这么改不只是审美：侧栏里的「最新文章」「分类/标签/月份的文章数」是全局可变数据，
挂在文章页上意味着「发一篇文章理论上要让 765 个页面失效」。去掉之后，
可变数据只活在 3 个索引页对象里，文章页只依赖自己和主题（design.md §5.1 / §11.1）。

- 容器宽度**全站一档**，唯一开关是 `style.css` 的 `--container-size`（当前 50rem =
  正文 760px ≈ 44 个汉字一行；`layout.ts` 的 `width` 所有页面都传 `narrow`）：
  页头 / 页脚 / 正文 / 列表共用一个容器，任意两个页面的左边缘、右边缘、正文宽度都完全重合。
- 文章目录**不占正文宽度**（`theme/toc.ts` 服务端抽取）：≥80rem 时目录溢出到容器右边的留白里
  （`.post-layout--with-toc` 自己多一列，`position: sticky`），<80rem 折叠进正文顶部 `<details>`，
  两份静态 HTML 由 CSS 二选一，**零 JS**；滚动高亮是 `app.js` 的纯增量增强。
  ⚠️ 断点是从容器宽度手算的，改 `--container-size` 必须重算（算法在 style.css §11）
- 三个索引页：`/categories/` 一行一条（只有 7 个，每条带描述）；`/tags/` 一行多个的**流式胶囊**，
  宽度随内容；`/archives/` **按年份分组**，同一年的月份流式排列，年份之间用分隔线。
  都不输出「共 N 个…」的说明行（数量对读者没用，还容易和实际渲染对不上）
- 「关于」链到独立页面 `about`（`render.ts` 的 `ABOUT_SLUG`）；站点里没有这个 slug 时整条不渲染
- 一次发布重建约 30~40 个对象；**删除一篇文章同样只重建受影响的 ~35 个**（`postDeleteTargets`），
  不是全站 800 个 —— 这条曾经是纯浪费
