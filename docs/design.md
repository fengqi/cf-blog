# Cloudflare Workers 博客系统 · 设计文档

> 目标：完全基于 Cloudflare Workers 搭建博客，最大化利用免费额度承载流量，  
> 功能对照 PHP 版 Typecho 的核心子集。
>
> 本文档只覆盖设计，不含实现代码。配套的建表脚本见 `docs/schema.sql`。



---

> 实现进度与待办清单见 [`todo.md`](todo.md)（这份文档只讲设计，进度以那份为准）。

## 0. 已确认的决策

| 决策项  | 选择                      | 影响                            |
| ---- | ----------------------- | ----------------------------- |
| 交付范围 | 设计文档                    | 本文档 + `schema.sql`            |
| 流量策略 | **静态直出（R2）+ 后台 Worker** | 前台不进 Worker，绕开请求数上限，见 §2 / §6 |
| 后台形态 | SSR 表单 + 少量原生 JS        | 无单独构建链，CPU 最省                 |
| 主题机制 | 固定一套主题                  | 模板即 TS 函数，不做主题切换              |

> **决策变更记录**：流量策略最初定为「纯 Worker 动态渲染 + 边缘缓存」。评论功能移除后，  
> 前台不再有任何动态内容，遂升级为「静态直出」——文章页在发布时渲染成完整 HTML 写入 R2，  
> 由 R2 直接对外服务，前台零 Worker 请求。原因见 §1.2 与 §1.5。
>
> **搜索功能随后也被移除**。原本 `/search?q=` 是前台唯一需要进 Worker 的路径，  
> 它一消失，前台就做到了**零 Worker 路由** —— §1.5 的静态直出论证因此完全闭合。

---

## 1. 硬约束：免费额度预算

### 1.1 额度账本（2026-09 官方数据）

| 资源            | 免费额度           | 关键限制                                      |
| ------------- | -------------- | ----------------------------------------- |
| Workers       | **10 万请求/天**   | CPU **10ms/请求**、128MB 内存（per-isolate，各计划相同）、**50 个外部 fetch 子请求 + 1000 个到 Cloudflare 服务的子请求/请求**（R2/KV/D1 binding 共用这 1000） |
| Static Assets | **请求免费无限**     | 2 万文件/版本、单文件 25MiB                        |
| D1            | 5GB 总量、500MB/库 | **5M 行读/天**、**10 万行写/天**、**50 次查询/调用**    |
| KV            | 1GB            | 10 万读/天、**1000 写/天**                      |
| R2            | 10GB           | 100 万 Class A/月、1000 万 Class B/月、**出口免费** |
| Turnstile     | 免费             | 无限验证（用于后台登录防护）                            |
| Cron Triggers | 5 个/账号         |                                           |

### 1.2 谁是第一个瓶颈

按"日均 10 万 PV"估算，两种架构的差距一目了然：

| 资源             | 纯 Worker 动态渲染            | **静态直出（当前方案）**             |
| -------------- | ------------------------ | -------------------------- |
| **Workers 请求** | 100,000 → **100% ⚠️ 撞墙** | **≈0（前台根本不进 Worker）**      |
| D1 行读          | ≈100 万 → 20%             | **≈0（只有发布时写/读一次）**         |
| D1 行写          | ≈0                       | ≈几十行/次发布                   |
| R2 Class B 读   | —                        | ≈300 万/月 → 占 1000 万额度的 30% |
| R2 Class A 写   | —                        | ≈几十次/次发布，可忽略               |

**结论：纯 Worker 方案下，Workers 请求数就是天花板，D1 反而有 5 倍余量。  
改成静态直出后，这个天花板被彻底绕过，瓶颈转移到 R2 的 1000 万 Class B/月 —— 也就是约 300 万 PV/月。**

所以整套优化的重心只有一句话：**让前台请求不要经过 Worker 脚本**。

这也解释了为什么下面 §1.3 的缓存误区值得反复强调 —— 缓存省不了请求额度，只有"绕开"才行。

### 1.3 一个必须澄清的误区

很多人以为"边缘缓存能省免费额度"。实测文档结论：

- **普通 Worker 路由：Worker 先于边缘缓存执行。** 缓存命中仍然算 1 次请求。
- **Workers Cache（`cache.enabled: true`）：命中时不运行脚本，但官方明确"所有发往 Worker 的请求都按标准请求费率计费"**，即仍占额度。
- **只有 Static Assets 的请求是真正免费无限的。**

所以本方案里缓存的价值是**省 CPU 和 D1 额度**，不是省请求额度。10 万/天就是硬顶，别指望缓存突破它。

> 另外注意：`run_worker_first` 匹配到的路径，免费版超限后直接返回 **429**，  
> 不会降级到静态资源。所以不要用 `run_worker_first` 覆盖全站路径。

### 1.4 由此推出的六条设计铁律

1. **前台不进 Worker。** 文章、列表、归档、Feed、Sitemap 全部在发布时渲染成静态对象写入 R2，由 R2 直出。这是绕开请求额度上限的唯一手段，其余都是次要优化。
2. **渲染发生在写入时，而且渲染的是完整页面。** Markdown 解析 + HTML 生成是 5–15ms 量级，放请求路径上必然撞 10ms CPU 上限（报 1102 / `exceededCpu`）。
3. **动态接口避免 N+1，查询次数保持可控。** 免费版单次调用到 Cloudflare 服务（R2/KV/D1 binding）的子请求上限是 **1000**，不是 50 —— 50 只针对外部 `fetch()`（见 §1.1）。D1 自己的 limits 页至今仍写「50（Free）」，是过时数据，别拿它当硬顶。评论与搜索移除后，动态接口只剩后台（请求量每天几十次计），这条从硬性指标降为**代码纪律** —— 新增接口时数一下查询次数，别把查询写进循环里。
4. **不做 N+1。** 一篇文章的分类、标签、作者必须在同一条 SQL 里用 `json_group_array` 聚合出来。
5. **KV 不能当缓存用。** 1000 写/天 连每天一次的缓存刷新都撑不起。
6. **静态资源不经 Worker 动态吐。** 主题 CSS/JS/字体/图标一律作为普通对象写入 R2、由 R2 直出（见 §2）。Static Assets 的请求虽然免费无限，但要为资源单独占一个域名，首版不划算 —— 留作 §14.2 的扩容手段。

### 1.5 为什么现在可以静态直出

这是两轮功能裁剪带来的连锁反应，值得单独说明。

**第一轮：评论移除。**

评论是前台唯一的用户输入。它一移除，前台的每一个页面——文章、首页、分页、分类、标签、归档、Feed、Sitemap——都变成**纯读，且只在后台发布时变化**。

没有用户输入，就没有实时性要求；没有实时性要求，就没有理由在请求期做任何计算。

**第二轮：搜索移除。** 服务端搜索是前台唯一需要动态渲染的路径。它一移除，前台连一条 Worker 路由都不剩。

于是整个系统只剩一处真正动态的部分：

- **后台管理**（放在独立子域名 `admin-blog.fengqi.me`）—— 作者一个人用，请求量按"每天几十次"计

把这唯一一处挪出主域名，主域名整体指向 R2，10 万请求/天 的限制对前台就**彻底失效**了 —— 不是靠缓存绕过，而是前台根本不再产生 Worker 请求。

---

## 2. 总体架构

**主域名整体指向 R2，后台独立子域名指向 Worker。** 两个域名，职责分离。

```
                    ┌──────────────────────────────────┐
                    │  blog.fengqi.me  →  R2           │  静态页直出
                    │  文章 / 列表 / 归档 / Feed       │  零 Worker 请求
                    └──────────────────────────────────┘
                                      ▲
                                      │ 发布时写入
                    ┌─────────────────┴────────────────┐
                    │  admin-blog.fengqi.me → Worker   │  后台（唯一入口）
                    │  Hono · D1 · R2 · KV             │  请求量极小
                    └──────────────────────────────────┘
```

**为什么要拆成两个域名**：

Cloudflare 的 URL Rewrite **不能改写 hostname**（只能改 path 和 query），而 R2 自定义域名必须独占一个 hostname。若想把静态前台和动态后台塞进同一个域名，就得依赖 "Worker Route 与 R2 自定义域名谁优先" 这个没有明确官方保证的行为——凭空引入风险。分子域名是零不确定性的做法，代价只有一条 DNS 记录。

> ✅ **前台域名：已定 —— 读配置，不硬编码（2026-09）**
>
> 域名只有一处来源：`options.site_url`，由 `src/models/option.ts` 的 `getSiteInfo()` 读出来
> 交给主题层（模板只认 `SiteInfo.url`）。**当前值 `https://blog.fengqi.me`。**
>
> 为什么这件事值得记一笔：线上真实站点在 `fengqi.me`（实测 200，Typecho），
> 而 `blog.fengqi.me` 是个空的 R2 自定义域名（实测返回 R2 自己的 404）。
> 所以只要前台还挂在 `blog.fengqi.me`，就是「新域名 + 老索引」的局面 ——
> **`fengqi.me` 必须继续可用（老站先别关）**，否则外链和搜索结果会打到 404。
>
> 将来切到 `fengqi.me` 的动作只有三步：① 改 `options.site_url`
> → ② 配 R2 自定义域名 / DNS → ③ **全站重渲**（§6.5）。
> 正文里写死的 `fengqi.me` 与 `img-typecho-r2.fengqi.me` 绝对链接（见 §9）不受影响，
> 前提是这两个 hostname 一直能解析到。

**主域名（R2）：`blog.fengqi.me`**

| 路径                                                    | 内容                           |
| ----------------------------------------------------- | ---------------------------- |
| `/`、`/page/<n>/`                                      | 预渲染的首页与分页（当前 12 页）           |
| `/<category>/<slug>.html`                             | 预渲染的文章页                      |
| `/<slug>.html`                                        | 预渲染的独立页面（单段，如 `/about.html`） |
| `/category/<slug>/`、`/tag/<slug>/`、`/<year>/<month>/` | 预渲染的分类 / 标签 / 年月归档           |
| `/categories/`、`/tags/`、`/archives/`                   | 预渲染的索引页（顶栏导航的落点，**新增**，见 §5.1） |
| `/feed/`                                              | 预渲染的 RSS（带末尾斜杠）              |
| `/sitemap.xml`                                        | 预渲染的站点地图                     |
| `/theme/*`                                            | 主题 CSS / JS / 字体             |
| `/usr/uploads/*`                                      | 附件（图片等）                      |

> 上表是架构层面的分组，**路由的完整口径以 §5.1 为准**（URL 结构完全沿用现有 Typecho 站点）。

**后台子域名（Worker）：`admin-blog.fengqi.me`**

| 路径              | 说明                          |
| --------------- | --------------------------- |
| `/admin/login`  | 登录（带 Turnstile）             |
| `/admin/*`      | 写作、内容管理、设置                  |
| `/preview/:cid` | 草稿预览（未发布的文章不存在于 R2，只能在这里渲染） |

**代价要说清楚**：

1. 主题资源从「Workers Static Assets（免费无限）」挪到了 R2（计入 1000 万 Class B/月）。缓解办法是给 R2 对象设长 `Cache-Control`，让 Cloudflare 边缘缓存承接。若实测下来 R2 额度吃紧，可以把 `/theme/*` 单独挂一个 Workers Static Assets 的子域名（做法见 §14.2）。
2. 这套方案**需要一个自己的域名**。只有 `*.workers.dev` 时无法绑定 R2 自定义域名，只能退回纯 Worker 动态渲染（见 §14 回退方案）。

**Worker 数量**：1 个（后台）。免费版 100 个 Worker 的额度绰绰有余。

---

## 3. 技术选型

| 层        | 选型                            | 理由                                                           |
| -------- | ----------------------------- | ------------------------------------------------------------ |
| 运行时      | Workers（TS）                   | 唯一选择                                                         |
| 路由       | **Hono**                      | 体积小（~15KB）、类型友好、生态成熟                                         |
| 数据库      | **D1**                        | SQL 语义贴合 Typecho 模型                                          |
| 对象存储     | **R2**                        | 双重角色：前台静态页直出 + 图片附件。出口免费                                     |
| 静态承载     | **R2 自定义域名**                  | 主域名指向 bucket，前台零 Worker 请求                                   |
| KV       | 仅存登录失败计数                      | 写额度太紧（1000 写/天），不缓存、也不存配置（配置走 isolate 内存 + Cache API，见 §7.3） |
| 前台主题模板   | **原生模板字符串 / tagged template** | 固定主题，不需要模板引擎。渲染只在发布时发生，不进请求路径 |
| 后台页面渲染   | **Hono JSX**（`hono/jsx`）         | 后台表单多。JSX 会**自动转义子节点**，并在序列化时校验标签名与属性名（额外一层防注入），避免手写 `escapeHtml()` 漏一处就成 XSS（§8.3）。编译期完成语法转换，运行时把 JSX 树序列化成字符串，开销可忽略 |
| Markdown | **markdown-it**（写入时用）         | 插件生态好；只在保存文章时执行                                              |
| HTML 清洗  | **自身白名单 + sanitize**          | 防后台 XSS                                                      |
| 密码       | **PBKDF2-SHA256（WebCrypto）**  | Workers 无原生 bcrypt/argon2                                    |
| 验证码      | **Turnstile**                 | 免费，后台登录防爆破                                                   |
| 校验       | **zod** 或 **valibot**         | 后台表单 / API 入参校验，valibot 更小                                   |

**不引入**：React/Vue、Prisma/Drizzle 全量 ORM（D1 的 prepared statement 已够用，ORM 反而难控查询次数）、任何**运行时**模板引擎 —— Hono JSX 是编译期转换，不算在内。

---

## 4. 数据模型

完整建表 SQL 见 **`docs/schema.sql`**。这里说设计意图。

### 4.1 沿用 Typecho 的表骨架

`users` / `contents` / `metas` / `relationships` / `fields` / `options`。

原 Typecho 的 `comments` 表整体移除——本方案不实现评论功能。

这套模型的价值：结构简单、被验证过、你熟悉、从 Typecho 迁移时字段一一对应。**不要重新发明。**

### 4.2 五处关键改造

**① `contents.rendered`——预渲染 HTML**

```
body     TEXT  -- Markdown 原文，编辑时用
rendered TEXT  -- 渲染好的 HTML，前台直接拼进页面
```

这是整个设计里最重要的一处改动。对应 §1.4 铁律 2。

**② `users.token_version`——无状态会话撤销**

会话用签名 Cookie，不查会话表（省一次 D1 查询）。改密码 / 登出全部设备时 `token_version += 1`，旧 token 自动失效。

**③ 冗余计数字段**

`metas.count`（该分类/标签下的文章数）、`contents.words`。  
代价是发布/删除文章时要同步更新，收益是归档页和列表页不用 `COUNT(*)` —— 每次 `COUNT(*)` 都是一次全表扫描并计入 rows read。

**④ `contents.synced_at` / `needs_sync`——D1 与 R2 的对账字段**

静态直出方案下，D1 是内容权威源，R2 是可重建的派生层，两者之间没有事务。  
`needs_sync = 1` 表示这篇文章还没成功写入 R2，由 Cron 定期扫描补发。详见 §6.2。

**⑤ `permalink_history`——URL 变更留痕**

因为文章 URL 里含分类 slug（`/<category>/<slug>.html`），**改分类会改变 URL**。  
要在旧 key 处保留 200 响应 + canonical（见 §5.1 方案 A），就必须知道"这篇文章以前用过哪些 URL"。

```sql
CREATE TABLE permalink_history (
  cid        INTEGER NOT NULL,
  permalink  TEXT    NOT NULL,   -- 旧路径，如 'default/760.html'
  retired_at INTEGER NOT NULL,
  PRIMARY KEY (cid, permalink),
  FOREIGN KEY (cid) REFERENCES contents(cid) ON DELETE CASCADE
) WITHOUT ROWID;
```

发布时若 slug 或分类变了：把旧 permalink 记入此表，然后在旧 key 处写入一个带 `<link rel="canonical">` 的页面，而不是直接删除它。

### 4.3 需要留意的两个坑

- **`metas.count` 的一致性**：文章改分类时要在同一个 `db.batch()` 里同时更新新旧两个 meta 的 count。漏了就长期偏差。
- **`WITHOUT ROWID` 表**：`relationships` / `fields` / `options` 用了它，因为是纯关联表，能省一层 B-tree。别在这几张表上依赖隐式 rowid。

---

## 5. 路由与查询预算

### 5.1 路由表

**URL 结构完全继承现有 Typecho 站点，一条都不改。** 这是迁移的生死线——任何一条 URL 变化都会让对应的搜索索引失效。

> ⚠️ 下表依据 Typecho 的 permalink 规则与你的实际配置整理，**实现前必须与生产站点逐条核对**。  
> 最可靠的方式：抓一份现有 `sitemap.xml`，与下表逐条比对。

| 方法       | 路径                        | R2 key        | 说明                      |
| -------- | ------------------------- | ------------- | ----------------------- |
| GET      | `/`                       | `""`（空 key）  | 首页；**不是 `index`**，见下方实测说明 |
| GET      | `/page/<n>/`              | `page/<n>/`   | 首页分页（当前 12 页）。`page/1/` 是 `/` 的副本，也要生成 |
| GET      | `/<category>/<slug>.html` | 同左            | 文章；`<slug>` 未填缩略名时即 cid |
| GET      | `/<slug>.html`            | 同左            | 独立页面，如 `/about.html`    |
| GET      | `/category/<slug>/`       | 同左            | 分类归档                    |
| GET      | `/category/<slug>/<n>/`   | 同左            | 分类归档分页（n≥1，含 `/1/` 副本）  |
| GET      | `/tag/<slug>/`            | 同左            | 标签归档（slug 可能是中文）         |
| GET      | `/tag/<slug>/<n>/`        | 同左            | 标签归档分页（n≥1，含 `/1/` 副本）  |
| GET      | `/<year>/<month>/`        | 同左            | 年月归档（**没有 `/<n>/` 变体**）  |
| GET      | `/categories/`            | `categories/` | 索引页：全部分类 + 文章数（**新增 URL**，见下） |
| GET      | `/tags/`                  | `tags/`       | 索引页：全部标签 + 文章数（**新增 URL**） |
| GET      | `/archives/`              | `archives/`   | 索引页：全部月份 + 文章数（**新增 URL**） |
| GET      | `/feed/`                  | `feed/`       | RSS（带末尾斜杠）              |
| GET      | `/sitemap.xml`            | `sitemap.xml` | 站点地图                    |
| GET      | `/usr/uploads/*`          | 同左            | 附件（路径已确认，见 §9）          |
| GET/POST | `/admin/*`                | —（Worker）     | 后台                      |

> **归档分页是补上的一行。** 原表只有裸归档 URL，实测 `/category/default/2/` = 200、
> `/category/ios/1/` = 200、`/tag/安卓/1/` = 200 —— 分类与标签归档**都有分页变体，
> 而且连「第 1 页副本」都返回 200**。这些 URL 会 404 还是保住，差别就是几行代码，
> 所以按「URL 一条都不改」的原则全部生成。
>
> 反过来，年月归档**没有**分页变体：`/2025/11/1/` 与 `/2025/11/2/` 实测都是 404。
> 代码里因此对年月归档不做分页（详见下方「年月归档的例外」）。

**段数不同，天然不冲突**：独立页面是单段（`/about.html`），文章是两段（`/<category>/<slug>.html`）。即使有个分类叫 `about`，`/about/760.html` 和 `/about.html` 也是两个不同的 key。

**三个索引页是新增的（2026-09-30）**：`/categories/`、`/tags/`、`/archives/`。
老站没有这三个 URL，**纯新增**，不违反「URL 一条都不改」—— 那条原则只要求老 URL 继续 200，不禁止新地址。

它们的存在理由是**把站内浏览入口从侧栏挪出去**（见 §11「导航与版式」）：

- 老版式里，分类/标签云/最新文章/归档全挤在每个页面的 17rem 侧栏里，正文右边永远挂着一列和这篇无关的东西；
- 更要紧的是**侧栏带全局可变数据**（各术语的文章数、最新文章列表）。它出现在文章页上，
  意味着理论上「发一篇文章要让 765 个文章页全部失效」—— 侧栏里的计数会陈旧到下一次全站重渲为止；
- 现在导航收进顶栏（`首页 / 分类 / 标签 / 归档 / 关于`，**不做下拉展开**，点进去就是清单页），
  可变数据只出现在这 3 个对象里。发一篇文章多重建 3 个对象，换来的是「文章页只依赖自己 + 主题」。

形状上不会和现有 URL 撞：分类归档是 `/category/<slug>/`（**单数**）、独立页面带 `.html` 后缀、
年月归档的段全是数字。三个索引页都**不做分页**（导航入口不该被拆成好几页），并进 sitemap。

> 「关于」指向独立页面 `about`（`src/publish/render.ts` 的 `ABOUT_SLUG`）。
> 站点里没有这个 slug 的页面时整条导航项不渲染 —— 顶栏挂一个指向 404 的链接比少一条更糟。

**线上逐条核对的结果（2026-09 实测，对着生产站点）**

URL 结构**全部对得上**：`/<cat>/<slug>.html`（含 `/php/awheel.html` 这种非数字 slug）、
`/about.html`、`/category/go/`、`/2025/11/`、`/feed/`、`/page/1/`…`/page/12/`（正好 12 页，
与 `posts_per_page=10`、约 120 篇可见文章一致）。`/page/1/` 确实与 `/` 同内容且返回 200 ——
上面那套 canonical + 不进 sitemap 的处理是**必须做**的，不是可选项。

但有几类 URL 在设计里没有位置，这里**显式列为本方案主动放弃**，迁移后会 404：

| URL | 线上状态 | 为什么放弃 |
|---|---|---|
| `/author/1/`、`/author/1/2/` … `/author/1/12/` | 200，共 12 页 | 单作者站点不做作者归档（§10） |
| `/feed/comments/` | 200，RSS XML | 评论功能整体移除；站点页脚与 `<head>` 里都有它的链接 |
| `/<cat>/<slug>.html/comment-page-N` | 评论分页路径，出现在评论 RSS 的 `<link>` 里 | 评论功能整体移除 |
| `/admin/login.php` | 老后台入口（页脚「登录」链接） | 后台迁到 `admin-blog` 子域名（§2） |

> 之所以要把这份清单写下来：§迁移 的原则是「URL 一条都不改」，**上面这些是唯一的例外**。
> 不写清楚，迁移后的 URL diff 会看起来像出了问题。
>
> 将来若想救回权重，成本最低的是用 Redirect Rules / Bulk Redirects 把 `/author/1/*` 301 到 `/`
> —— 但注意 §5.1 开头说过：R2 对象本身发不了 301，得靠规则层。

> ⚠️ **`/feed/` 现在就是坏的**（实测 HTTP 500 `Database Query Error`），迁移前先完整 dump 数据库。

**`/page/1/` 与 `/` 是重复内容，必须交代清楚。** 已确认 `/page/1/` 真实存在，且渲染的就是首页内容。URL 已经存在、可能有外链与索引，**不能删**，所以：

- `/page/1/` 照常生成 R2 对象、返回 200
- 页面内输出 `<link rel="canonical" href="https://blog.fengqi.me/">`，把权重归并到首页
- **`/page/1/` 不写进 sitemap** —— sitemap 只列 `/` 与 `/page/2/` … `/page/12/`

不处理的话，同一份内容会被当成两个页面，互相稀释。

> **同一套规则适用于归档的第 1 页副本**：`/category/<slug>/1/`、`/tag/<slug>/1/` 都真实存在
> （实测 200），所以同样「生成 + canonical 指向裸 URL + 不进 sitemap」。
> 代价是每个分类/标签多出一个对象 —— 这是为了 URL 保全付的固定成本，见 §5.3。

**年月归档的例外**：`/<year>/<month>/` **没有分页变体**（`/2025/11/1/`、`/2025/11/2/` 实测都是 404），
所以年月归档不分页，一个月份只有一个对象。
当前没有任何月份超过 `posts_per_page`，所以这个差异还没有实际影响；
万一将来某个月超过，页面会把该月文章全部列出（不丢内容），但**分页 URL 形态需要重新对着线上站点核对**。

**文章 URL 里的分类段是个先天缺陷**，必须认清。

`/<category>/<slug>.html` 把分类 slug 编进了 URL。这是 Typecho 支持的 permalink 格式，你已经在用，只能沿用。但后果是：**文章改分类，URL 就变了，旧 URL 直接 404。**

而静态方案下 R2 **无法返回 301**（对象响应状态码不可自定义）。两个选择：

- **A（推荐）：保留旧对象不删**，在旧页面里输出 `<link rel="canonical" href="新URL">`。旧 URL 仍返回 200，搜索引擎自行归并权重。这是静态站处理 URL 变更的标准做法。
- **B：删除旧对象**，用 Cloudflare 的 Redirect Rules 补 301。需要额外维护规则，且免费版规则条数有限。

> 走 A 方案的前提是**发布时记下文章改动前的 slug 和分类**，否则改完之后就无从知道该保留哪个旧 URL。  
> 需要在 `contents` 或单独一张表里留痕，见 §4.2 第 ⑤ 项。

**末尾斜杠必须严格一致**。`/category/go/`、`/2012/12/` 这类 URL 以 `/` 结尾，而 R2 是精确 key 匹配——写入时 key 就必须带末尾斜杠，否则整片 404。

**已实测（2026-09，见 §13.1）：尾斜杠不归一化，就是精确匹配。**
写入 `category/go/` 和 `category/go` 两个 key 后，`/category/go/` 与 `/category/go` 各返回各自的对象，
互不影响；而 `/category/go/index.html` 返回 404（再次证明没有目录索引）。

所以：**以带斜杠的 key 为准**（线上所有链接都带斜杠），要不要顺带写不带斜杠的版本只取决于
你想不想让手敲 URL 的人也能打开 —— 不是必须，成本是对象数翻倍。

**静态方案的一个隐形收益**：R2 是精确 key 匹配，不存在"`/:slug` 会吃掉一切单段路径"的优先级问题。  
原来的路由分发逻辑（需要正则判定模式 B/C）直接消失 —— permalink 模式只在**发布时**决定写入哪个 key。

**content-type 不需要 URL Rewrite 解决**：R2 支持写入时指定 `httpMetadata.contentType`，  
这样 `index`、`feed/`、`sitemap.xml` 这类**本来就不带扩展名（或扩展名不是 .html）的 key**
也能返回正确的 Content-Type，不需要为它们各加一条 Transform Rule。

> ⚠️ **但 `.html` 后缀不能省。** 它是现有 URL 的一部分（`/default/760.html`、`/about.html`），
> 去掉就违反本节开头的硬规则。这一段的结论只关于 Content-Type，不关于 URL 形状。

```ts
// 文章 key 带 .html —— 后缀是 URL 的一部分
await env.BUCKET.put(`${categorySlug}/${slug}.html`, html, {
  httpMetadata: { contentType: 'text/html; charset=utf-8' },
});

// 无扩展名的 key 靠 httpMetadata 决定类型：实测 /category/go/ 返回 text/html; charset=utf-8 ✓
await env.BUCKET.put('feed/', feedXml, {
  httpMetadata: { contentType: 'application/rss+xml; charset=utf-8' },
});
```

这样一条 Transform Rule 都不需要（免费版只有 10 条，能省则省）。

> ✅ **根路径 `/` 的答案（2026-09 实测）：首页对象写「空字符串 key」，不需要任何规则。**
>
> R2 自定义域名**不做目录索引** —— 实测即使 `index` 和 `index.html` 两个对象都存在，
> `GET /` 仍然返回 404。但把首页写成 key `""`（空字符串）后，`GET /` 立刻返回 200，
> 且 `httpMetadata.contentType` 生效。
>
> ```ts
> // 首页：key 是空字符串，对应 URL 就是 /
> await env.BUCKET.put('', homeHtml, {
>   httpMetadata: { contentType: 'text/html; charset=utf-8' },
> });
> // 兼容入口照旧单独生成
> await env.BUCKET.put('page/1/', sameHtmlAsHome, { httpMetadata: { ... } });
> ```
>
> 这条结论的价值在于：**原方案最担心的「首页要挂 1 条 URL Rewrite（还不知对 R2 自定义域名是否生效）」
> 这个不确定性直接消失了** —— 前台「零 Worker 请求 + 零规则依赖」成立。
>
> 残余风险很小但要知道：空 key 属于边缘用法，Wrangler 的 S3 通道实测可用；
> 写发布流水线时用 `env.BUCKET.put('')` 再确认一次即可（万一被拒，退路才是 URL Rewrite）。

> ⚠️ **404 页面无法自定义。** R2 没有 index document / error document 的概念
> （S3 兼容层里 `PutBucketWebsite` 是 ❌），缺 key 时返回 R2 自带的英文 404 页
> （实测 `cf-cache-status: DYNAMIC`，不缓存，开销可忽略）。
> 想要自定义 404，只能走规则层（Snippets / Worker），首版接受默认页。

### 5.2 动态请求的查询预算

静态方案下，前台的查询全部发生在**发布时**，请求期是 0 次查询。剩下的动态接口只有后台。

目标：**避免 N+1，查询次数保持可控**。后台请求量极小（每天几十次），这条主要是代码纪律，不是性能压力。

> **已实现并断言（2026-09）**：装配一份完整的站点快照（`src/publish/snapshot.ts`）**固定 6 次查询**，
> 与文章数、标签数无关；本地 e2e 里有一条断言盯着这个数字（`scripts/e2e-runner.ts`）。
> 6 次分别是：options、contents（文章+分类标签聚合）、contents（独立页面）、
> metas（分类标签+实时计数）、contents（年月分组）、permalink_history。
>
> 实现时踩过的反例：为了「列表别拉正文」把 `rendered` 从列表查询里去掉，
> 结果快照拿不到正文，文章页只剩骨架 —— **快照必须是「渲染完备」的**，详见 §13.4。

**渲染一篇文章（发布时，2 次）**

```sql
-- 查询 1：文章 + 作者 + 分类标签聚合，一次搞定
SELECT c.cid, c.title, c.slug, c.created, c.modified, c.body, c.rendered, c.excerpt,
       c.password, c.words,
       u.uid AS author_id, u.screen_name AS author_name, u.url AS author_url,
       (SELECT json_group_array(json_object(
                 'mid', m.mid, 'name', m.name, 'slug', m.slug, 'type', m.type))
          FROM relationships r JOIN metas m ON m.mid = r.mid
         WHERE r.cid = c.cid) AS metas
  FROM contents c
  JOIN users u ON u.uid = c.author_id
 WHERE c.cid = ?
 LIMIT 1;

-- 查询 2：渲染侧栏所需元数据（热门标签、归档月份、上一篇/下一篇）
-- 合成一条 UNION ALL，避免多次往返
```


### 5.3 发布一次要重建哪些对象

按你站点的实际规模（12 页分页、约 120 篇可见文章、7 个分类、若干标签）估算。
下表已按 **2026-09 实测的数字**修正（`npm run bench:render`，合成 120 篇文章 / 24 个标签）：

| R2 对象 | 数量 | 为什么变了 |
|---|---|---|
| `<category>/<slug>.html` | 1 | 文章本体 |
| `""`（空 key，即 `/`） | 1 | 首页 |
| `page/1/` … `page/12/` | 12 | 偏移分页，内容全部顺移（`page/1/` 需输出 canonical 指向首页，见 §5.1） |
| `categories/`、`tags/`、`archives/` | 3 | 索引页：上面带各术语的文章数，发一篇就会变（见 §5.1） |
| `category/<slug>/` + `category/<slug>/<n>/` | 2 ~ 4 | 该文章所属分类的归档**及其全部分页**（含 `/1/` 副本） |
| `tag/<slug>/` + `tag/<slug>/<n>/` | 2 × n | 每个标签 2 个起（裸 URL + `/1/` 副本） |
| `<year>/<month>/` | 1 | 当月归档（年月归档不分页） |
| `feed/` | 1 | RSS |
| `sitemap.xml` | 1 | URL 集合变了 |
| **合计** | **约 28 ~ 43 个** | 实测单篇发布 26 个（分类 3 页、5 个标签的文章），2026-09-30 起 +3 |

**结论：这个规模根本不需要优化。**

30 次上下的 R2 写入，占免费版 100 万 Class A/月的 **0.003%**，墙钟 1 毫秒量级（实测见 §13.1 #4）。

**删除也要按同一个范围重建（2026-09-30 修）**：`deletePost` 曾经直接调 `siteTargets(snapshot)`，
删一篇文章要重写**全站 800 个对象**，其中 700 多个和这次删除毫无关系。现在走
`postDeleteTargets()`：首页+分页、三个索引页、该文章自己挂的分类/标签归档、所在月份、feed、sitemap，
线上约 **35 个**（本地夹具实测 16 个 / 全站清单 32 个）。

> 术语要用**删除后的新快照**重新解析 —— 传进来的 `record` 拿的是删除前的 `count`，
> 按它算分页会多算一页。所以 `deletePost` 的调用顺序是「先删 D1 → 再删对象 → 再 `loadSnapshot` → 再重建」。
>
> **已知边界（未修，见 §13.4）**：如果删掉的是某个月最后一篇文章，`snapshot.months` 里就没有那个月了，
> 而重建清单是按快照算的 —— 于是那个月份对象会**永久留在 R2 上**（内容陈旧）。
> 旧实现同样有这个洞，不是这次改动引入的。

**全站重建的对象总量**（§6.5「全站重新渲染」与 §12.2 首次发布）：
实测 **292 个对象**（120 篇文章 + 13 个首页分页 + 2 个独立页面 + 96 个归档 + 59 个年月 + feed + sitemap），
渲染耗时 **稳态 5.0 ms**、产物 1.57 MB。你的真实站点标签更多（每个标签 2 个对象），
量级大概在 **400 ~ 900 个对象**，仍然只占免费额度的千分之一。

> **一个可调的取舍**：归档的 `/1/` 副本让「每个分类/标签」至少占 2 个对象。
> 它们今天在线上确实返回 200，删掉就等于放弃这些 URL（违反「一条都不改」）。
> 如果哪天对象数变成负担，这是第一个可以砍的东西 —— 但要在文档里登记成「主动放弃」。

**唯一需要异步的部分**：见 §6.3。

**配置读取**

站点配置在 `options` 表里 40+ 行。静态方案下只有发布时读一次，压力可忽略。
但后台每渲染一个页面都要读，仍建议做 isolate 内存缓存 + Cache API 兜底，见 §7.3。

---

## 6. 渲染策略：发布时渲染完整页面

这是本设计里最不能妥协的一环。整个方案的性能全部押在这里。

### 6.1 发布流程

```
用户点保存（admin-blog.fengqi.me）
   │
   ▼
Worker
   ├─ 1. Markdown → HTML（markdown-it）
   ├─ 2. XSS 清洗（白名单）
   ├─ 3. 生成摘要、统计字数
   ├─ 4. 写入 D1：contents（body 原文 + rendered 片段 + excerpt + words）
   ├─ 5. 用模板把 rendered 套进完整页面骨架
   ├─ 6. 批量写入 R2（对象清单见 §5.3）
   └─ 7. 清理失效对象：文章删除时删 key；slug / 分类变更时**不删旧 key**，
         改写为带 canonical 的页面（见 §5.1 方案 A）
   │
   ▼
返回「发布成功」

──────────── 前台请求 ────────────
R2 精确 key 查找 → 直接返回
不经过 Worker，CPU 消耗：0
```

### 6.2 D1 与 R2 的一致性

这是本方案新增的主要风险点：**D1 写成功但 R2 写失败，前台就看不到新文章**。

处理策略：

1. **先写 D1，后写 R2；R2 失败不回滚 D1** —— D1 是内容权威源，R2 是可重建的派生层
2. **在 D1 记同步状态**：给 `contents` 加 `synced_at`（时间戳）和 `needs_sync`（0/1）两个字段
3. **R2 写入失败时标记 `needs_sync = 1`**，并立刻用 `ctx.waitUntil()` 重试一次
4. **Cron 兜底对账**：每小时扫一遍 `needs_sync = 1` 的文章重新发布（频率见 §12.3）
5. **后台首页显示「待同步」数量**，让作者看见异常，而不是靠运气发现

> 这两个字段已加进 `docs/schema.sql`，并配了 `idx_contents_sync` 索引供 Cron 扫描。

### 6.3 发布的同步与异步

按 §5.3，一次发布约 20 个 R2 对象，墙钟不到 1 秒。所以**不需要复杂的分层**：

1. **同步**：写 D1 → 渲染文章页 → 写 `<category>/<slug>.html`，让作者立刻看到成功
2. **异步**：`ctx.waitUntil()` 重建首页、12 页分页、归档、Feed、Sitemap

`waitUntil()` 有 30 秒延长窗口，20 次写入绰绰有余。**Queues 现在不需要**，留到分页超过 50 页再考虑。

> ⚠️ `waitUntil()` 里的失败作者看不到。§6.2 的 `needs_sync` 对账机制就是为这种情况准备的，不能省。

### 6.4 大文章的处理

markdown-it 处理 1 万字约 3–8ms，再叠加模板套用和 XSS 清洗，可能逼近 10ms CPU 上限。

退路（按优先级）：

1. 保存拆两步：先落库 body，再用 `ctx.waitUntil()` 异步渲染回填 `rendered`
2. Cron 兜底：定期扫 `rendered = ''` 的文章补渲染

> **两条都已实现（2026-09）**：`publishPost` 的渲染与页面生成可以分开，
> Cron 对账里的 `ensureRendered()` 会在写 R2 之前把 `rendered` 为空的内容补渲染。
> 这不只是为了大文章 —— **定时文章（`waiting` → `publish`）从没走过「保存并发布」，
> 它的 body 一定没渲染过**，少了这一步就会写出一堆空壳页面（§13.4 第 3 条）。

注意：**渲染完整页面比渲染片段更吃 CPU**（要套骨架、算分页、串相关文章），
所以 §13.1 第 4 项（发布流水线的实际 CPU 与墙钟耗时）的验收阈值，必须按**完整页面**来测，不能只测渲染片段。

### 6.5 渲染器要锁版本

markdown-it 的版本升级可能改变输出，所有文章共用一套渲染配置。

必须准备一个**「全站重新渲染」**的后台入口，用来在改模板 / 样式 / 渲染器版本后刷新历史文章。

按当前规模（约 120 篇文章，每篇还要顺带重建列表与归档）约几百次 R2 写入，
**必须分批** —— 但瓶颈不是子请求数（R2 binding 走的是「1000 个到 Cloudflare 服务的子请求」
那一池，写几百个对象撞不上，见 §1.1），而是 **CPU 时间与墙钟**。每批 20 篇左右，配合 Cron 逐批推进。

这是静态直出方案必备的运维手段 —— 否则改了模板样式，历史文章不会自动更新。

---

## 7. 缓存策略

静态直出之后，缓存的角色变了：**前台不再需要 Worker 缓存**（R2 直接出）。
剩下两件事——R2 对象自身的边缘缓存，以及后台的配置读取。

### 7.1 wrangler.jsonc（后台 Worker）

```jsonc
{
  "name": "cf-blog-admin",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-26",
  "d1_databases": [
    { "binding": "DB", "database_name": "blog-db", "database_id": "<id>" }
  ],
  "r2_buckets": [
    { "binding": "BUCKET", "bucket_name": "blog-content" }
  ],
  "kv_namespaces": [
    { "binding": "LOGIN_KV", "id": "<id>" }
  ],
  // §12.3：每小时一次，做「定时发布 + needs_sync 对账」
  "triggers": { "crons": ["0 * * * *"] }
}
```

上面是**绑定相关的最小集**。脚手架生成的 `wrangler.jsonc` 还带 `$schema`、`observability`、`upload_source_maps`，都是 C3 默认值，保留即可。

后台 Worker 不需要 `assets` 绑定（前台资源全部在 R2），也不需要 Workers Cache。

> 顺带说明为什么不用 Workers Cache：它命中时确实跳过脚本执行，但官方明确"所有发往 Worker
> 的请求都按标准请求费率计费"——省 CPU 不省额度。而我们的目标恰恰是省额度，所以静态直出才是解。

### 7.2 R2 对象的缓存头

主域名由 R2 直出，缓存行为主要由对象自身的 `Cache-Control` 决定 —— **必须在写入时就设好**。
但有个必须知道的例外：**Cloudflare 会改写小于 4 小时的 max-age**（见下面的实测）。

| 对象 | Cache-Control |
|---|---|
| `<category>/<slug>.html`、`<slug>.html` | `public, max-age=300, stale-while-revalidate=600` |
| `""`（空 key）、`page/<n>/` | `public, max-age=60, stale-while-revalidate=300` |
| `category/<slug>/`、`tag/<slug>/`、`<year>/<month>/` | `public, max-age=120` |
| `feed/`、`sitemap.xml` | `public, max-age=600` |
| `theme/*`、`usr/uploads/*` | `public, max-age=31536000, immutable` |

主题资源要做到 `immutable`，文件名必须带指纹（如 `style.a1b2c3.css`），否则改了样式老用户拿不到新的。

#### 主题资源流水线怎么落地的（2026-09-30 实装）

| 环节 | 做法 |
| --- | --- |
| 打指纹 | `npm run build:assets` 读 `theme/assets/`，取内容 sha256 前 8 位，产出 `theme/assets.generated.ts` |
| 写对象 | 资源作为 `kind: 'asset'` 的目标进 `siteTargets()` 的**最前面**，走同一套发布流水线，缓存头取 `lib/r2.ts` 的 `asset` 档 |
| 页面引用 | `theme/layout.ts` 注入 `<link rel="stylesheet" href="/theme/style.<hash>.css">` 与 `<script src="…" defer>` |
| 更新 | 改样式 → 重跑构建（hash 变）→ 全站重渲。**改了文件不重跑构建 = 改了不生效** |

三条要记住的：

1. **资源不进「单篇发布」的清单。** 发一篇文章没必要重写几个 `immutable` 对象 ——
   只有 `siteTargets()`（全站重渲 / 分批重渲）里才有它们。e2e 有断言盯着这条。
2. **旧指纹对象不删。** 全站重渲后页面指向新 hash，但边缘与浏览器可能还握着旧 HTML
   （文章页是短缓存），它们会来请求旧文件名。与 §14.2 的告警是同一条纪律。
3. **`assets.generated.ts` 要提交。** e2e / bench / 迁移脚本都直接读它，仓库里必须有一份可用的；
   `deploy:ci` 里也会重跑一次构建，防止「改了 CSS 忘了构建」的漂移。

> 为什么生成 `.ts` 模块，而不是在代码里 `import './style.css'`：主题层要在 workerd（发布流水线）、
> tsx（bench / 迁移脚本）、tsc（类型检查）三种运行时里跑，而 wrangler 的 Text module rules
> 只在 workerd 那一路生效 —— `tsx scripts/bench-render.ts` 会直接炸在 CSS import 上。
> 生成字面量之后三条路径自然全部可用，也免了给三个 wrangler 配置各加一遍 rules。

> **已实测结案（2026-09，见 §13.1）**：R2 自定义域名的响应确实走 Cloudflare CDN 缓存
> （实测对象返回 `cf-cache-status: HIT`，`content-type` 来自写入时的 `httpMetadata`），
> 但**默认只缓存特定扩展名，`.html` 不在其中** —— 所以文章页「发布即生效」成立，不需要主动 purge。
>
> 反过来说：**不要给 HTML 开 Cache Everything。** 一旦开了，就要按 R2 官方 consistency 文档的
> 说法处理「对象被覆盖后，旧内容会继续被服务到 TTL 到期或 purge」这个问题。
>
> 另外注意：浏览器侧仍按上面的 `max-age` 缓存，所以「立即生效」只对没有本地缓存的客户端成立。

> ⚠️ **实测发现：小 max-age 会被 Cloudflare 抬到 4 小时，短缓存要求落不了地。**
>
> 官方文档（[Edge and Browser Cache TTL](https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/)）：
> 默认 Browser Cache TTL 是 **4 小时**，当源站的 `Cache-Control`/`Expires` **小于**该值、
> 或源站**完全不发**这两个头时，Cloudflare 会覆盖它们。三条实测正好对上：
>
> | 对象写入时的 Cache-Control | 实际返回 | `cf-cache-status` |
> |---|---|---|
> | `public, max-age=300`（.css） | **`public, max-age=14400`**（被抬高） | MISS → HIT |
> | 不设 | **`max-age=14400`**（被插入） | MISS |
> | `public, max-age=31536000, immutable`（.css） | 原样返回 ✓ | MISS → HIT |
>
> 两个后果：
>
> 1. **上表里那些小于 4h 的值，只对不走缓存的扩展名（`.html`）才有意义**；
>    对 `/theme/*`、`/usr/uploads/*` 这类可缓存扩展名，想要长缓存（`immutable`）必须**显式写 ≥ 4h**——实测能原样保留 ✓
> 2. 覆盖一个**已被缓存**的可缓存对象后，边缘会继续返回旧内容：实测把 `probe.css` 覆盖成 v2 后，
>    26 秒后再抓仍然返回 v1（`cf-cache-status: HIT`）。想立即生效只能 purge，或**改文件名**（指纹）——
>    这也是主题资源必须打指纹的第二个理由
>
> 另外 Free 版的 **Edge Cache TTL 最低 2 小时**（同页文档），所以别再指望把边缘缓存压到几分钟。

### 7.3 站点配置缓存（后台）

后台每渲染一个页面都要读 `options`（40+ 行），仍值得做两层缓存：

1. **模块级内存缓存**：isolate 全局变量，命中零成本，但 isolate 重启即失效
2. **Cache API 兜底**：配置序列化成 JSON 存 `caches.default`，TTL 300s

**失效**：保存设置时清两层（`caches.default.delete()` + 用自增的 `config_version` 让内存缓存失效）。

> `config_version` 是**运行时写入的一行 `options`**（`name='config_version'`），schema 不预置它 ——
> 读不到就按 `0` 处理。别指望 `migrations/0001_init.sql` 里有这个键。

> 不要用 KV 做这层——每次刷新就是一次写，1000 写/天 撑不住。

### 7.4 后台页面的缓存头

后台一律 `private, no-store`，响应带 `Set-Cookie`（会话）。

注意这和旧方案是反过来的：以前"响应带 `Set-Cookie` 会导致缓存绕过"是个要躲的坑；
现在前台根本不进 Worker，这个坑不存在了。后台本来就不该被缓存，`Set-Cookie` 正合适。

---

## 8. 认证与安全

### 8.1 会话方案

签名 Cookie，无状态：

```
payload = base64url({ uid, tv, exp })
token   = payload + "." + HMAC-SHA256(payload, SESSION_SECRET)
```

校验时比对 `tv === users.token_version`，只在这一步需要查用户行（本来也要查）。

- `HttpOnly` + `Secure` + `SameSite=Lax`
- 有效期 14 天
- `SESSION_SECRET` 用 `wrangler secret put` 存，**不要写进 wrangler.jsonc**

### 8.2 密码存储

Workers 没有原生 bcrypt/argon2，用 WebCrypto 的 PBKDF2：

```
格式：pbkdf2$<iterations>$<salt_b64>$<hash_b64>
算法：PBKDF2-SHA256
```

**这里有个待实测的风险**：PBKDF2 是 CPU 密集运算，10 万次迭代很可能让登录请求的 CPU 突破 10ms 上限。

处理方式：

1. 从 100,000 次迭代起步，在 `wrangler dev` 里看实际 CPU time
2. 超了就先降到 50,000 —— 单用户博客，这个强度够用
3. 降到 25,000 仍然超，再重新考虑方案

> **已实测（2026-09，本地 workerd）**：10 万次迭代的 PBKDF2-SHA256 耗时 **约 7 ms**
> （`scripts/e2e-runner.ts` 每次跑都会打印这个数）。10ms 预算下余量不大，但登录是
> 「每天几十次」的请求，且 CPU 超限只影响这一次请求（1102），不会拖垮站点 ——
> 所以**保持 10 万**，等线上 observability 能看到真实 CPU 时再决定要不要降到 5 万。

> 不要为此引入 Durable Object。为一个登录接口加一套 DO 是明显的过度设计，而且 DO 的请求
> 也要占额度、还要维护额外状态。这里的问题用降迭代数就能解决。

**不存在「默认口令」。** `docs/schema.sql` 末尾给 admin 写的是**不可用的占位哈希**，
照它建库是登不进去的 —— 这是刻意的 fail-closed，避免默认弱口令躺在那里。

上线前必须先 bootstrap 一次（`scripts/hash-password.ts` 见 §11 目录结构）：

```bash
# 1. 生成 PBKDF2 串
npx tsx scripts/hash-password.ts '你的口令'

# 2. 写进 D1（把上一步的输出原样替换 <hash>）
wrangler d1 execute blog-db --remote --command \
  "UPDATE users SET password='<hash>' WHERE username='admin'"
```

首次登录后仍**强制修改口令**，并校验长度与复杂度。

### 8.3 XSS

- 文章 HTML：`rendered` 写入前用白名单清洗（`script`/`iframe`/`on*` 属性全部剔除，`a[href]` 校验协议）
- 后台表单：所有输出走统一的 `escapeHtml()` 工具

> **实现记录（2026-09）**：清洗用 **js-xss**（白名单模型、零运行时依赖、纯 JS，Worker 里直接跑），
> 配置在 `src/lib/sanitize.ts`；Markdown 用 markdown-it，`html: true`。
>
> **为什么不干脆关掉 markdown 的 HTML 透传（`html: false`）**：那样确实最省事，但存量 Typecho
> 文章里有原生 HTML（`<img>`、`<div>`），关掉会把它们全部转义成文本，历史文章直接烂掉。
> 所以选择「放行 + 白名单清洗」，代价是要维护那份白名单。
>
> 实测覆盖的向量（见 `scripts/e2e-runner.ts`）：`<script>`、`<img onerror>`、
> 原生 `<a href="javascript:">`（href 被剥掉）、markdown 的 `[x](javascript:)`
> （markdown-it 自己就拒绝，输出为字面文本）。

去掉评论后，全站唯一的用户输入入口就是后台，XSS 面收缩到"作者自己写的文章内容"。
但**清洗仍不能省**：Markdown 里嵌入的原生 HTML 会原样进 `rendered`，不洗就是给自己留后门。

### 8.4 后台登录防护

评论移除后，后台登录成了**全站唯一的外部写入入口**，防护强度反而要比原来更高。

1. **Turnstile**：登录表单挂上，免费，没有理由不加
2. **失败频率限制**：同 IP 15 分钟内失败 10 次 → 锁定
3. **强制口令强度**：初始密码 `admin` 必须首次登录即改，并校验长度与复杂度

**IP 存哈希不存明文**（`SHA-256(ip + IP_SALT)`），既能做频率统计又不落隐私数据。

> **实现记录（2026-09）**：Turnstile 的 site key 存在 `options.turnstile_site_key`
> （不是 secret）。强制校验的条件是**密钥与 site key 都配了**；只配一半时只渲染控件、
> 不强制 —— 否则会出现「服务端要 token，而登录页因为缺 site key 不渲染控件」，
> 等于把自己锁在门外（口令与限流本来就在）。
>
> 失败计数用 KV（`LOGIN_KV`）：同 IP 15 分钟内失败 10 次锁定，`expirationTtl` 自动过期。

> ⚠️ **口径**：`/admin/login` 是**唯一公开路由**；`/admin/*`、`/preview/*` 都要登录。
> 注册顺序有讲究（公开路由必须在鉴权中间件之前），本地 e2e 里有断言盯着这条边界。

---

## 9. 附件与媒体

```
上传 → 后台 Worker（校验类型/大小）→ 写 R2 → 返回 URL
展示 → R2 直出（与文章页同一个 bucket，前缀 /usr/uploads/）
```

**附件路径必须保持 Typecho 原样**：`/usr/uploads/<year>/<month>/<filename>.<ext>`。

原因很直接：**存量文章的正文里已经写死了这些相对路径**。一旦改了附件路径，历史文章里的图片会**全部变成碎图**。

R2 里的 key 就是去掉前导斜杠的路径：`usr/uploads/2024/01/photo.jpg`。

好处是双重的：

- 存量文章正文一个字都不用改
- 存量附件的 URL 完全兼容，图片的外链权重不丢

**存量规模**：`/usr/uploads/` 目录约 **10 个文件、6MB**。但**这个数字不能直接当作「存量正文里
实际引用的图片规模」** —— 见下面的实测观察。

结论：**R2 的 10GB 存储额度完全不构成约束**，占用率不到 0.1%。附件这一块在设计上不需要任何容量优化——真正的约束只有 Class B 读操作数（§7.2）。

> **实测观察（2026-09，核对线上正文）**：存量文章里的配图并不在第三方图床，而是在**你自己的
> R2 域名** `img-typecho-r2.fengqi.me`（实测 200、`content-type: image/png`、
> `cf-cache-status: HIT`）—— 也就是 `typecho-cloudflare-r2` 插件上传的那套。据此修正三点：
>
> 1. **不再是「外链图床脆弱依赖」** —— 域名和 bucket 都在自己手里，风险降级为
>    「那个 bucket 与域名必须继续可用」
> 2. 正文里写死的是 `img-typecho-r2.fengqi.me`，**不是** `/usr/uploads/`。所以「10 个文件、6MB」
>    很可能只是更早的本地附件。迁移前应当用「正文里出现过的图片域名与本地上传路径」反查真实规模，
>    别拿 `/usr/uploads/` 的目录大小下结论
> 3. 「计划后续把外链图片回收到 R2」这个前提不成立 —— 它们已经在 R2 上了

**存量附件搬迁**：Typecho 的文件在服务器 `usr/uploads/` 目录，整目录搬到 R2：

```bash
# R2 key 必须与服务器上的相对路径完全一致
rclone copy ./usr/uploads r2:blog-content/usr/uploads
```

> ⚠️ 迁完要逐个抽查：**文件名里的中文、空格、特殊字符**容易被 URL 编码搞乱。
> 存量附件的原始文件名很可能含中文，必须保证 R2 的 key 与浏览器实际请求的编码形式能对上。

> ✅ **已实测（2026-09）**：key 直接写中文 + 空格（`usr/uploads/2024/01/测试 图片.txt`），
> 用浏览器风格的百分号编码路径请求
> （`/usr/uploads/2024/01/%E6%B5%8B%E8%AF%95%20%E5%9B%BE%E7%89%87.txt`）返回 **200**，
> `content-type` 与 `cache-control: immutable` 都按写入值返回。
> 所以编码不是拦路虎，抽查仍然要做，但不必为此设计特殊方案。

**新增附件**沿用同一路径规则（`<year>/<month>` 按上传时间生成）。文件名可以对新增的做随机化处理——存量文件**不能改名**，否则 URL 就变了。

上传校验：

- 白名单 MIME：`image/jpeg|png|webp|gif|avif`、`application/pdf`
- 单文件 ≤ 10MB（R2 免费 10GB）
- 注意 Worker 请求体大小限制（免费版 100MB）
- 图片若要用 Cloudflare Images 做缩放，注意 Images **不在免费额度内**

**缓存策略按前缀分开**：

| 前缀 | Cache-Control |
|---|---|
| `usr/uploads/*` | `public, max-age=31536000, immutable` |
| 文章页 / 归档页 | 短缓存，见 §7.2 |

附件用 `immutable` 是安全的——文件名一旦确定就不会变，要换图就换个文件名。

---

## 10. 功能对照表

| Typecho 功能 | 本方案 | 备注 |
|---|---|---|
| 文章 / 独立页面 / 草稿 | ✅ | 同表 `type` + `status` 区分 |
| Markdown 写作 | ✅ | 写入时渲染 |
| 自定义摘要 | ✅ | `excerpt` 字段 |
| 分类（含父子） | ✅ | `metas.parent` |
| 标签、多标签 | ✅ | `relationships` |
| 私密文章 | ⚠️ 降级为"不发布" | 静态直出后**无法做密码保护** —— 写进 R2 就是公开可读的。私密文章不生成 R2 对象，仅后台可读，等同于加密草稿 |
| 定时发布 | ✅ | `status='waiting'` + Cron 扫描（每小时，见 §12.3） |
| 评论（含嵌套 / 审核 / 反垃圾） | ❌ 整体移除 | 需求变更，前台不再有用户输入 |
| 固定链接 | ✅ **完全沿用现有 Typecho URL 结构** | 迁移生死线，见 §5.1 |
| 归档（时间 / 分类 / 标签） | ✅ | **不含作者归档** —— ⚠️ 线上 `/author/1/`、`/author/1/2/` … `/author/1/12/` 是真实存在的 12 页 URL，本方案**明确放弃**，迁移后会 404（见 §5.1 的豁免清单） |
| 分页 | ✅ | |
| 搜索 | ❌ 不做 | 已确认移除 |
| 单篇阅读量 | ❌ 不做 | 前台无服务端埋点。站点整体流量用 Cloudflare Web Analytics（外部面板，不占 Worker 额度） |
| RSS / Atom | ✅ | |
| Sitemap | ✅ | |
| 多用户 + 4 种角色 | ✅ | `users.role`；原 Typecho 的 subscriber 是评论用户角色，已随评论一并移除 |
| 后台（写作/管理/设置） | ✅ | SSR 表单 |
| 附件 / 媒体库 | ✅ | 存 R2 |
| 自定义字段 | ✅ | `fields` 表 |
| 文章修订历史 | ❌ 首版不做 | 需要额外表 + 写放大 |
| 主题切换 | ❌ 固定一套 | 已确认 |
| 插件系统 | ❌ | Workers 无法运行时加载代码 |
| XML-RPC | ❌ | 已过时 |
| Pingback / Trackback | ❌ | 已过时 |

---

## 11. 目录结构

```
cf-blog/
├── wrangler.jsonc                 # 只配置后台 Worker，见 §7.1
├── package.json
├── tsconfig.json
├── migrations/
│   └── 0001_init.sql              # 即 docs/schema.sql
├── theme/                         # ★ 主题源文件，发布时渲染并写入 R2
│   ├── layout.ts                  # 页面骨架（唯一主题）：顶栏导航、注入指纹资源、全站限宽 50rem
│   ├── html.ts                    # 转义与日期格式化（纯函数，谁都能引）
│   ├── toc.ts                     # 文章目录：抽 h2/h3、生成锚点 id、把 id 写回正文
│   ├── assets.ts                  # 主题资源访问器（路径 / `<link>` / `<script>` 标签）
│   ├── assets.generated.ts        # ★ 自动生成：资源清单 + 指纹，由 npm run build:assets 产出
│   ├── home.ts                    # 首页与分页
│   ├── post.ts                    # 文章 / 独立页面（共用：独立页面只是没有上一篇/下一篇）
│   ├── archive.ts                 # 分类 / 标签 / 年月归档
│   ├── overview.ts                # 索引页 /categories/、/tags/、/archives/
│   ├── components/
│   │   └── list.ts                # 已抽出：列表项 + 分页器（首页与归档共用）
│   └── assets/                    # CSS / JS / 字体源文件，**构建时打指纹**（§7.2）
│       ├── style.css
│       └── app.js                 # 暗色切换 + 目录滚动高亮 + 轻量代码高亮（纯增量）
├── src/
│   ├── index.ts                   # Worker 入口（后台）+ Cron
│   ├── types.ts                   # Env 绑定 + 运行时密钥类型（secret 生成不出来）
│   ├── views/                     # ★ 后台页面组件（Hono JSX，.tsx）
│   │   ├── layout.tsx             # 后台骨架（样式内联，无构建链）
│   │   ├── login.tsx
│   │   ├── post-editor.tsx
│   │   └── post-list.tsx
│   ├── routes/                    # 会渲染 JSX，所以是 .tsx
│   │   ├── admin.tsx              # 后台页面与操作（保存即发布）
│   │   ├── auth.tsx               # 登录 / 登出（Turnstile + 失败限流）
│   │   └── preview.ts             # 草稿预览（R2 里还不存在的对象）
│   ├── publish/                   # ★ 发布流水线，本方案的核心
│   │   ├── pipeline.ts            # 编排：渲染 → 写 D1 → 写 R2 → 异步重建
│   │   ├── snapshot.ts            # 从 D1 装配快照（6 次查询，与文章数无关）
│   │   ├── targets.ts             # 一次发布要重建哪些对象，见 §5.3
│   │   ├── render.ts              # 完整页面渲染（套模板骨架 + feed/sitemap）
│   │   ├── types.ts               # 数据契约：无 SQL、无 HTML，便于单测
│   │   └── sync.ts                # needs_sync 对账与定时发布，见 §6.2 / §12.3
│   ├── models/                    # ★ SQL 只允许写在这里（和 lib/db.ts）
│   │   ├── content.ts             # contents 读写 + 聚合查询
│   │   ├── meta.ts                # 分类 / 标签 + 实时计数
│   │   └── option.ts              # 站点配置（域名唯一来源）
│   ├── lib/
│   │   ├── db.ts                  # D1 封装 + 查询计数器（dev 模式告警）
│   │   ├── r2.ts                  # R2 读写封装 + 缓存头 + 批量删除
│   │   ├── markdown.ts            # markdown-it 配置 + 摘要/字数派生
│   │   ├── sanitize.ts            # HTML 白名单清洗（js-xss）
│   │   ├── auth.ts                # 签名 Cookie + PBKDF2
│   │   ├── time.ts                # 年月归属 / W3C 日期 / RFC822（不用 Intl）
│   │   └── url.ts                 # permalink → R2 key 映射（URL 形状的唯一来源）
│   └── middleware/
│       └── auth.ts
├── scripts/
│   ├── import-typecho.ts          # Typecho 迁移（含全量渲染 + 写入 R2）
│   ├── hash-password.ts           # 生成 PBKDF2 串
│   ├── build-assets.ts            # 主题资源打指纹 → theme/assets.generated.ts
│   ├── bench-render.ts            # 渲染压测（§13.1 #4）：npm run bench:render
│   ├── e2e-runner.ts              # 本地端到端断言集（142 项）
│   ├── e2e-worker.ts              # e2e 的 Worker 入口，只在 wrangler.e2e.jsonc 里跑
│   ├── upload-attachments.ts      # 附件迁移：按原路径把 usr/uploads 写进 R2
│   └── publish-worker.ts          # 生产发布专用（只有 /full、/keys），配 wrangler.publish.jsonc
├── wrangler.e2e.jsonc             # 本地 e2e 专用配置（**不要拿它部署**）
└── docs/
    ├── design.md                  # 本文档
    └── schema.sql
```

**两套渲染机制，各管一边**：`theme/`（`.ts`）是前台，纯字符串拼接，发布时渲染完写进 R2；`src/views/`（`.tsx`）是后台，Hono JSX，直接当 HTTP 响应返回。不要互相串用 —— 前台那套必须零依赖、能在发布流水线里裸跑。

### 11.1 导航与版式（2026-09-30 改版）

**全站零侧栏。** 站内导航只有顶栏一处：`首页 / 分类 / 标签 / 归档 / 关于` + 主题切换按钮。
**不做下拉展开** —— 顶栏只放链接，点进去是 `/categories/`、`/tags/`、`/archives/` 三个清单页。

改版动机不是审美，是**一致性边界**（详见 §5.1）：侧栏里的「最新文章」「分类/标签/月份的文章数」
是全局可变数据，挂在文章页上会让「发一篇文章」理论上失效 765 个页面。
去掉侧栏后，可变数据只活在 3 个索引页对象里。

**容器宽度全站一档**，唯一开关是 `style.css` 的 `--container-size`（当前 **50rem**；
`layout.ts` 的 `width` 选项 → `body` 上的类，所有页面都传 `narrow`）：

| 类 | 宽度 | 用在 | 为什么 |
|---|---|---|---|
| `.layout-narrow` | `--container-size` = 50rem | **所有页面**：首页 / 分页 / 归档 / 索引页 / 独立页面 / 文章页 | 容器 800px − 内边距 40px = 正文 **760px ≈ 44 个汉字一行**；再宽中文一行就累眼了 |
| （不加类） | 1080px | 暂无 | `width: 'default'` 时 `body` 上不输出类，走 `.container` 的基础值；留给将来真的需要宽幅的页面（图集、宽表） |

页头 / 页脚 / 正文 / 列表共用同一个容器，所以任意两个页面的左边缘、右边缘、正文宽度
**完全重合**（实测 1280px 下四类页面都是 页头 `x=240 w=800` / 正文列 `x=260 w=760`）。

宽度这块踩过三轮，值得记下来 —— 每一轮都是**同一个错误的不同表现：把宽度和别的东西耦合**：

1. 最初 `theme/post.ts` 恒给 `width: 'post'`（62rem）。于是 `/about.html` 这种独立页面和
   没写小标题的短文也顶着 62rem 的外壳：正文 672px 缩在 992px 里居中、页头比首页宽 288px。
2. 改成「按 `toc.length` 判断该不该 62rem」后 `/about.html` 对上了，但**仍是两档** ——
   有目录的文章页页头依然比列表页宽一截。根因是**宽度跟着「页面有几列」走**。
3. 废掉第二档，全站一个值。后来又调了一次数值（44rem → 50rem）：44rem 是照抄原来的列表页
   宽度来的，没人量过「一行几个字读起来舒服」，风息看完说「太窄了」。**数值该单独论证。**

结论：**正文宽度只由「一行多少个汉字读起来舒服」决定**，跟页型、跟有没有第二列都无关。

**文章目录（TOC）在服务端生成**（`theme/toc.ts`）：

- 渲染时用一条正则抽 `<h2>`/`<h3>`，把标题文本折成锚点 id 后**写回正文**，同时产出目录条目；
- 中文标题**直接保留汉字做 id**（`id="为什么动不动全站重渲"`）—— 比 `#section-3` 可读，
  HTML5 允许任意非空白字符做 id，浏览器跳转正常。重名标题按 `-2`/`-3` 去重；
- 只收 h2/h3：h1 是文章标题本身，h4 及更深在中文技术文里通常是补注，进目录只会让目录比正文还长；
- **不在客户端扫 DOM**：那样要等 JS 跑完才插入目录，首屏会先塌后撑（CLS），
  而且服务端产出的目录**没有 JS 也能看、也能点**。

**目录不占正文宽度，靠「只有 `.post-layout` 自己多溢出一列」实现**：

| 元素 | 出现条件 | 形态 |
|---|---|---|
| `.post-toc`（`<aside>`） | ≥80rem | `.post-layout--with-toc` 宽 `calc(100% + 15.5rem)`（目录 14rem + 间距 1.5rem），溢出到容器**右边的留白**里；目录本身 `position: sticky; top: 2rem` |
| `.post-toc-inline`（`<details>`） | <80rem | 正文顶部可折叠块，用原生 `<details>` |

⚠️ **页头 / 页脚宽度不受影响** —— 溢出的只有 `.post-layout` 这一个盒子，`main.container`
仍是 `--container-size`。所以正文列稳稳定在 760px，与页头左右边缘严格对齐。

断点是手算的（媒体查询读不了 CSS 变量）：

```
正文右边缘 = 50% + (--container-size/2 − 1.25rem 内边距)
再往右溢出 15.5rem 后要 ≤ 100%：
  50rem/2 − 1.25rem + 15.5rem = 39.25rem ≤ 50%  →  视口 ≥ 78.5rem
取 80rem（1280px），临界点上留 1.5rem 余量。
```

改 `--container-size`、目录宽度或那个间距，**都必须重算这个断点**，否则窄一点儿的视口上
目录会捅出横向滚动条。

**为什么是 `sticky` 而不是 `fixed`**：`fixed` 相对**视口**定位，页面一打开目录就和页头齐平、
压在页头下边框上（2026-09-30 实际被风息报过：「目录和顶部导航平齐了，压住了分割线」）。
`sticky` 让目录留在文章自己的流里 —— 从文章顶部（与标题同高）开始，滚动时才钉住，
位置天然跟着文章走，够不着页头。

为什么不做成一份：`<details>` 的展开由 `open` 属性控制，**CSS 盖不住它**，
想「宽屏强制展开」就得靠 JS 搬 DOM —— 两份静态 HTML 更可靠，代价是每篇多几百字节。

滚动高亮（当前小节变色）由 `theme/assets/app.js` 打类，纯增量：脚本不跑就只是普通链接。
它只处理宽屏那份目录。⚠️ 判断「目录到底看不看得见」用的是 `getClientRects()`，
**绝不能用 `offsetParent`** —— `position: fixed` 元素的 `offsetParent` 恒为 `null`，
拿它当显隐判据会在宽屏下静默关掉整个滚动高亮（不会报错，只是不亮）。
另外 `prefers-reduced-motion` 下所有过渡关闭。

后台 JSX 的两条纪律：

1. **只 import `hono/jsx`。** `hono/jsx/dom` 是客户端渲染（带虚拟 DOM 与 hydration），本项目不用 —— 后台是纯 SSR + 少量原生 JS
2. **唯一的转义出口是 `dangerouslySetInnerHTML`**，只允许用在文章正文 `rendered`（那是清洗过的 HTML，见 §8.3）。其余任何地方都不该出现

**两条硬约束**：

1. SQL 只允许写在 `models/` 和 `lib/db.ts` 里。`routes/` 和 `theme/` 不碰数据库。
2. **R2 写入只能由 `src/publish/` 触发。** 底层封装在 `src/lib/r2.ts`（缓存头也定义在那里），
   但 `routes/`、`views/`、`models/` 一律不许调用写函数 —— 只有发布流水线能决定「写什么、什么时候写」。
   别的地方碰 R2 会让缓存策略和对象一致性失控 —— 这是静态直出方案唯一的纪律要求，也是最容易在维护中被破坏的一条。

---

## 12. 部署

### 12.1 资源与域名

```bash
# 1. 创建资源
wrangler d1 create blog-db
wrangler r2 bucket create blog-content
wrangler kv namespace create LOGIN_KV

# 2. 把返回的 id 填进 wrangler.jsonc

# 3. 建表
wrangler d1 migrations apply blog-db --remote

# 4. 设置管理员口令（迁移里写的是不可用占位哈希，必须先 bootstrap，见 §8.2）
npx tsx scripts/hash-password.ts '你的口令'
wrangler d1 execute blog-db --remote --command "UPDATE users SET password='<hash>' WHERE username='admin'"

# 5. 密钥
wrangler secret put SESSION_SECRET
wrangler secret put IP_SALT
wrangler secret put TURNSTILE_SECRET

# 6. 本地开发（D1 走本地 SQLite，不消耗线上额度）
wrangler dev

# 7. 部署后台 Worker
wrangler deploy
```

**域名配置（关键步骤，都在 Cloudflare 控制台）**


1. **前台 → R2**：R2 bucket `blog-content` → Settings → Custom Domains → 添加 `blog.fengqi.me`
2. **后台 → Worker**：Workers → `cf-blog-admin` → Settings → Domains & Routes → 添加 Custom Domain `admin-blog.fengqi.me`
3. 确认两个 hostname 互不占用

> ⚠️ 顺序不能反：先确认 R2 自定义域名生效，再配 Worker 的自定义域名。
> 两个 hostname 互相独立，是这套方案零冲突的基础。

> **澄清一个容易混的点**：§2 说"URL Rewrite 不能改写 hostname"，指的是 **URL Rewrite** 这个产品。
> **Redirect Rules 是另一个产品，它可以跨 hostname 跳转**。两者的区别：**Rewrite** 改的是服务端
> 拿到的路径，用户地址栏不变；**Redirect** 返回 301，让浏览器换地址。
> 顺带一提，R2 对象自身返回不了 301（§5.1 讲过的限制：S3 兼容层没有
> `x-amz-website-redirect-location`，也没有 `PutBucketWebsite`）。但**要发 301 不止 Redirect Rules
> 一种手段** —— Bulk Redirects、Workers、Snippets 都能做，按维护成本挑一个。

### 12.2 首次全量发布

数据库建好时 R2 是空的，前台会全线 404。必须有一步初始发布：

```bash
npx tsx scripts/import-typecho.ts --full-publish
```

全量发布要写入：每篇文章、每个独立页面、每个分类/标签归档、全部分页、Feed、Sitemap、主题资源。

按实际规模（约 120 篇文章）估算，总量在**几百个 R2 对象**量级，占免费版 100 万 Class A/月不到 0.1%，额度上毫无压力。

**但不要在一次 Worker 请求里做完** —— 会撞 CPU 时间与墙钟（子请求额度不是瓶颈：R2 binding 用的是「1000 个到 Cloudflare 服务的子请求」那一池，见 §1.1）。正确做法是用 `scripts/import-typecho.ts` **在本地分批执行**（`npx tsx` 跑在本机，完全不受 Worker 的 CPU 与子请求限制），这才是这个脚本存在的意义。

### 12.3 Cron Triggers

免费版账号共 5 个额度（**按账号计，不按 Worker**；per-Worker 的 cron 上限 2023 年已取消），本方案只用 **1 个**（每小时触发一次）：

| 频率 | 任务 |
|---|---|
| 每小时 | ① 发布到期的定时文章（`status='waiting' AND created <= now`）并触发重建；② 扫 `needs_sync = 1` 的文章补发（§6.2 的一致性兜底） |

两个任务合并进同一次触发，顺序执行即可，没必要占两个额度。

**代价**：定时发布最多延迟约 1 小时 —— 定在 14:05 的文章，会在 15:00 前后上线。不能接受就把频率调回每 5 分钟，288 次/天，占请求额度 0.3%，不痛。

**原设计里的"清理过期会话"已删除，因为根本不需要**：会话是签名的无状态 Cookie（§8.1），**没有会话表可清**，过期由 payload 里的 `exp` 自然生效；登录失败计数存在 KV，靠 `expirationTtl` 自动过期。

> Cron 触发的 Worker 调用**计入请求额度**。每小时 1 次 = 24 次/天，可以忽略。

---

## 13. 待验证项与风险

实现前必须先实测这几条，否则方案有塌方风险。

> **§13.1 的第 1、2、3、6 项已于 2026-09 实测完毕并结案**（对 `blog.fengqi.me` 这个真实的
> R2 自定义域名写探针对象 + `curl` 验证，对象已删除）。结论分别落在 §5.1 / §7.2 / §9。
> 剩下的只有第 4、5 项 —— 都不阻塞写代码。

### 13.1 静态直出特有的验证项

| # | 状态 | 结论 |
|---|---|---|
| 1 | ✅ 已结案 | **R2 自定义域名不做目录索引**：`index` 与 `index.html` 两个对象都存在时，`GET /` 仍是 404。**但把首页写成空 key `""` 后，`GET /` 返回 200 且 contentType 生效** → §5.1 已改为「首页 = 空 key」，**不需要任何 URL Rewrite**。唯一残余项：写发布流水线时用 `env.BUCKET.put('')` 复核一次（Wrangler 的 S3 通道已实测可用） |
| 2 | ✅ 已结案 | `.html` 默认**不进** CDN 缓存（两次请求都是 `cf-cache-status: DYNAMIC`）→ 文章页覆盖即生效；而可缓存扩展名（`.css`/`.js`/图片）覆盖后**旧内容继续被服务**（实测覆盖成 v2 后仍返回 v1）。细节与对策见 §7.2 |
| 3 | ✅ 已结案 | **会缓存**：可缓存扩展名 MISS → HIT（`age` 递增）；`content-type` 来自写入时的 `httpMetadata` |
| 4 | 🟡 部分完成 | **渲染部分已实测**（`npm run bench:render`，合成 120 篇 / 24 标签）：全站 292 个对象稳态 **5.0 ms**、产物 1.57 MB；单篇发布 26 个对象 **0.8 ms**；物化只占 8%。→ §6.3 的「20 个对象、墙钟不到 1 秒、不需要 Queues」成立，且余量很大。<br>**还没测的**：真实 Workers（Free 版 isolate）的 CPU time、以及 30 次 R2 写入的墙钟 —— 等 `publish/pipeline.ts` 落地后在 `wrangler dev` / 线上 observability 里复核 |
| 5 | ⏳ 待做 | R2 自定义域名与 Worker Custom Domain 的隔离 —— 等 `admin-blog.fengqi.me` 配好之后交叉验证 |
| 6 | ✅ 已结案 | **尾斜杠是精确 key 匹配，不归一化**：`category/go/` 与 `category/go` 两个 key 各自独立命中，`/category/go/index.html` 404 → §5.1 的 key 表（`page/<n>/`、`category/<slug>/`、`<year>/<month>/`）成立 |

**实测顺带发现的第 7 项（不在原计划里）**：

| # | 状态 | 结论 |
|---|---|---|
| 6b | ✅ 已结案 | **Cloudflare 会把小于 4 小时的 `max-age` 抬到 14400**（默认 Browser Cache TTL），缺省时还会插入；≥4h 的值原样保留。这直接影响 §7.2 的缓存表，详见那里 |
| 6c | ⚠️ 需接受 | **404 页面无法自定义**：R2 没有 index/error document，缺 key 时返回 R2 自带的英文 404 页（DYNAMIC，不缓存）。首版接受 |

### 13.2 沿用项

| # | 待验证 | 影响 | 验证方式 |
|---|---|---|---|
| 7 | PBKDF2 迭代 10 万次的实际 CPU 时间 | 登录接口可能必超 10ms | `wrangler dev` 看 CPU time |
| 8 | 免费版请求超限后的 fail open / fail closed 默认行为 | 决定宕机时的表现 | 文档 + 实测 |
| 9 | `json_group_array` 在 D1 上的行为与长度上限 | 一篇文章标签过多时可能截断 | 实测 |

### 13.3 风险

- **一致性是新增的主要风险**。D1 与 R2 之间没有事务，靠 `needs_sync` 标记 + Cron 对账兜底（§6.2）。这个机制必须实现，不能省。
- **发布变成"重"操作**。一次发布要写几十个 R2 对象，比纯数据库写入慢得多，失败面也更大（§6.3）。
- **10 万请求/天仍然约束后台**，但后台请求量按每天几十次计，撞不上。真正要防的是有人拿脚本刷后台登录 —— 靠 Turnstile + 频率限制（§8.4）。
- **D1 单库 500MB**。纯文本能存几十万篇文章；把图片 base64 塞进正文会迅速撑爆，附件必须走 R2。
- **依赖自己的域名**。只有 `*.workers.dev` 时无法绑 R2 自定义域名，需回退到纯 Worker 方案（§14.1）。

### 13.4 实现阶段抓到的坑（本地 e2e 的产出）

发布流水线写完后，用「真实 workerd + 本地 D1/R2」跑了 68 项断言
（`wrangler dev -c wrangler.e2e.jsonc` → `scripts/e2e-runner.ts`），抓到 3 个**只有跑起来才会暴露**的 bug。
记在这里，因为它们都指向同一个设计教训：**快照必须是「渲染完备」的**。

| # | 症状 | 原因 | 修法 |
|---|---|---|---|
| 1 | 文章页有骨架、没正文 | 为了让列表查询别拉正文，`listPublishedPosts` 省掉了 `rendered`；而 `siteTargets()` 恰恰是从**这个列表**造文章对象的 | 列表查询带上 `rendered`（D1 按 rows read 计费，不按字节）。要精简就另开一个查询给后台用 |
| 2 | 文章页少了标签那一行、标签链接全丢 | 同一个原因：列表查询只聚合了分类，没聚合标签 | 列表查询聚合**分类 + 标签** |
| 3 | 定时发布上线后是空壳页面 | Cron 只把 `waiting` 改成 `publish`，但这类文章从没走过「保存并发布」，`rendered` 一直是空的 | 加 `ensureRendered()`：写 R2 之前把 `rendered` 为空的内容补渲染（§6.4 的 Cron 兜底） |

另外三个小的：

- **`deletePost` 必须先删 D1 行再删对象**，否则后面的全站重建会把文章又写回去。
- **独立页面不能复用文章的目标计算**：页面没有分类，`postKeyOf()` 会抛错；
  而且页面不出现在首页/归档/Feed 里，只有它自己和 sitemap 需要重建。
- **改缩略名后，旧 URL 的 canonical 必须一起写**：`postPublishTargets` 一开始没把
  「这篇文章自己的旧 URL」放进清单，结果旧地址继续以「自己就是规范地址」对外服务 ——
  方案 A 等于没做。修法：旧 URL 目标进**同步**批次，和正文一起落盘。

**2026-09-30 导航/版式改版又抓到两个**（都不是逻辑错，是**只有量出来才看得见**的）：

- **正文列被压成一半宽**：`.post-body` 上写了 `max-width: 42rem; margin-inline: auto;`。
  CSS Grid 里 grid item 带 `auto` 外边距会**放弃 stretch、退化成「内容宽度」** ——
  42rem 的正文列实际只有 340px，而 `computedStyle` 里的 `max-width` 依然是 `672px`，
  从样式面板完全看不出问题。修法：列宽交给网格轨道
  （当时是 `grid-template-columns: minmax(0, min(42rem, 100%)) 14rem`，第二列后来随目录
  `fixed` 化一起删掉了），`.post-body` 上不写外边距。
  **验证方式只能是量 `getBoundingClientRect`。**
- **无目录的文章漏了宽度包裹**：「有目录 / 无目录」两条模板分支里只有一条输出了 `.post-body`，
  于是 `/about.html` 这类没有 h2/h3 的页面正文直接铺满整个容器（当时 62rem）却读作「正常」。
  修法：两种版式都必须有这层包裹。
- **`offsetParent` 判显隐会在 `position: fixed` 上静默失效**（2026-09-30，目录改成浮层那次）：
  它原本只是用来跳过窄屏 `display:none` 的目录、不做无用的滚动监听。目录改成 `fixed` 之后
  `offsetParent` 恒为 `null`，于是**宽屏下整个滚动高亮被静默关掉** —— 不报错、不报警告，
  目录照常显示、照常可点，只是永远不亮。修法：用 `getClientRects().length > 0` 判「看得见吗」。
- **`position: fixed` 的目录会压住页头**（2026-09-30，同一次改动，风息报的）：
  `fixed` 相对视口定位，`top: 2.5rem` 让目录和页头齐平、正好压在页头的 `border-bottom` 上。
  修法：改回 `sticky`，并把「给目录腾位置」从**撑宽容器**改成**让 `.post-layout` 自己多溢出一列**
  —— 页头页脚宽度不受影响，目录留在文章的流里（见 §11.1）。
  **教训：「浮在留白里」不等于「相对视口定位」。**
- **改了 `theme/assets.generated.ts` 不重启 dev，重渲会用旧指纹**：`build:assets` 之后立刻
  调 `/__publish`，wrangler 的 bundle 还没重载完，于是页面被渲成旧指纹的 HTML，
  而 R2 上两个指纹都在、看起来「一切正常」，只有比对页面里的 `<link>` 才发现。
  **`build:assets` 之后等一两秒（或重启 dev）再重渲，渲完 `grep 'theme/[^"]*'` 核对一次。**

> 这几条是同一类：**模板分支和 CSS 都"看着对"，但实测行为不对**。
> 截图肉眼也不容易发现（差 2 倍宽度在整页截图里不明显；滚动高亮不亮更是要滚一下才知道），
> 只有量数字、或者真在浏览器里操作一次才暴露。

---

## 14. 回退与扩容

### 14.1 回退方案：纯 Worker 动态渲染

如果实测下来静态直出走不通（比如没有自己的域名，或 R2 自定义域名有意外的限制），退回纯 Worker 动态渲染：

- 前台恢复 SSR，文章页 1 次 D1 查询 + 拼接模板字符串
- 上限回到 10 万请求/天
- §4 数据模型、§6 的写入时渲染、§8 认证全部不变
- 只是 §5 路由表里的"服务方"从 R2 改回 Worker

**好消息是这是可回退的**，因为两种模式共享同一套数据模型和渲染逻辑。

为此，实现时建议把 `theme/` 层设计成**既能输出到 R2、也能直接作为 HTTP 响应体返回**——
`render()` 返回完整的 HTML 字符串，写 R2 还是当响应由调用方决定。这样回退只需改一个调用点。

### 14.2 扩容路径

如果 R2 的 1000 万 Class B/月 也不够用了（约 300 万 PV/月）：

1. **先确认边缘缓存真的生效**（§13.1 第 3 项）。如果 R2 响应没被 CDN 缓存，加一条 Cache Rule 让它缓存，这一步可能直接把 Class B 消耗降一个数量级。
2. **把主题资源拆到 Workers Static Assets** —— 挂一个子域名把 `/theme/*` 挪过去，请求免费无限。具体做法见下。
3. **升级 Workers Paid（$5/月）** —— 请求额度、CPU、R2 操作数全面放开。性价比最高的一刀。

**最不该做的事**：为了省额度把前台重新塞回 Worker。那等于把已经解决的问题又请回来。

**关于第 2 条的具体做法**（子域名已有的话）：

1. 建一个**纯 assets Worker** —— 不配 `main`，只配 `assets.directory`。没有脚本，请求就 100% 走资产通道，一个也不计费
2. 绑自定义域名 `static-blog.fengqi.me`（**不要用 `*.workers.dev`**，国内访问不稳定）
3. 主题层改为输出绝对 URL：`https://static-blog.fengqi.me/theme/<指纹>.css`
4. **全站重新渲染**（每页 HTML 都变了），然后从 R2 删掉 `/theme/*`
5. 加一行 `<link rel="preconnect" href="https://static-blog.fengqi.me">` 压掉新域名的 TLS 握手开销

> ⚠️ **别复用 `admin.` 子域名。** 挂在同一域名下，每个主题资源请求都会带上后台的会话 Cookie
> —— 白费带宽，还把会话令牌的暴露面扩大到每一个静态资源请求。单开一个干净子域名。

> ⚠️ **旧资源文件不能立刻删。** 主题资源按文件名打指纹，全站重建后页面指向新 hash，但浏览器
> 和边缘可能还握着**旧 HTML**（文章页是短缓存），它们会去请求**旧文件名**。assets 目录里
> 保留上一到两个版本再部署，等超过 HTML 缓存的 TTL 再清。

---

## 附：与 Typecho 迁移

迁移有一条不可退让的原则：**URL 必须逐条保持原样**。搜索索引是靠 URL 一点点攒出来的，改一条就丢一条。

### 迁移前的必做功课：URL 清单核对

> ⚠️ **原方案指定的「抓 sitemap」在线上跑不通（2026-09 实测）**：生产站点的
> `/sitemap.xml` 返回的是 Typecho 的 404 页（没装 sitemap 插件），`/feed/` 更是
> **HTTP 500 `Database Query Error`**。所以清单必须**从数据库生成**，不能从线上抓。

正确顺序：

1. **从 MySQL 生成权威清单**（URL 是 permalink 规则的函数，数据库才是权威源）：
   - 文章：`typecho_contents` 中 `type='post' AND status='publish'` → `/<category-slug>/<slug>.html`
   - 独立页面：`type='page' AND status='publish'` → `/<slug>.html`
   - 分类 / 标签：`typecho_metas` → `/category/<slug>/`、`/tag/<slug>/`
   - 年月归档：可见文章的 `created` 去重 → `/<year>/<month>/`
   - 分页：按 `posts_per_page` 算出的 `/page/1/` … `/page/N/`
2. **再爬线上站点交叉验证**：把第 1 步的清单逐条抓一遍状态码，全 200 才算对得上
   （`/feed/` 现在 500，属于老站本身的问题，先记下来）
3. 迁移完成后对新站点跑同一份清单，**逐条 diff，差集必须为空** —— 唯一的例外是
   §5.1 里显式放弃的那几类（作者归档、评论相关路径、老后台入口）

这是唯一能系统性发现 URL 遗漏的办法，靠人眼核对不可能做到。

> **sitemap 分页的坑已不适用**（本站在线根本没有 sitemap）。这段留给将来真装了 sitemap 插件的
> 情况：Typecho 的 sitemap 插件会生成一个**索引**文件，`sitemap.xml` 里只有指向
> `sitemap-post-1.xml` 之类的 `<loc>`，真正的文章 URL 在子文件里，要递归抓一层。

### 数据迁移步骤

1. **拿到老站的 SQLite 数据库文件**（线上是 Typecho + SQLite，不是 MySQL）——
   直接拷一份 `typecho.db` 即可，不需要 `mysqldump`
2. `scripts/import-typecho.ts` 做转换：
   - 表名与字段按 §4.1 映射
   - `typecho_contents.text` → 新 `body`，并调用 markdown 渲染填充 `rendered`
   - `typecho_contents.type` 的 `post_draft` / `page_draft` 拆成 `type` + `status='draft'`
   - `typecho_metas.count` 需要重算
   - **`type='attachment'` 的记录**：这些是附件，`text` 字段存的是 JSON 元信息。已确认仅约 **10 条**（不是 cid 差值的大头，大头是草稿）。全量导入即可，不值得做筛选逻辑
   - `typecho_users.password` 是 `$P$` 开头的 phpass 哈希，**在 Workers 里无法校验**，存量用户只能重置密码。
     ⚠️ **导入用户时不要覆盖现有 admin 的口令与 `token_version`** ——
     新库里的口令是刚 bootstrap 好的 PBKDF2 串，被 phpass 覆盖就再也登不进去了
3. **附件搬迁**：`usr/uploads/` 整目录同步到 R2，路径保持原样（详见 §9）
4. 用 `wrangler d1 execute --file` 批量导入（单文件 ≤ 5GB）

### 迁移实现记录（2026-09）

脚本：`scripts/import-typecho.ts`，四步走，**前三步都不动线上**：

```bash
# ① 只读体检：行数分布、异常清单、多分类双候选 URL、图片引用盘点
npx tsx scripts/import-typecho.ts --db .import/typecho.db
# ② 逐条核对老站（设计文档要求的「URL 逐条核对」，因为没有 sitemap）
npx tsx scripts/import-typecho.ts --db .import/typecho.db --verify-urls
# ③ 生成 SQL + 写入**本地** D1（彩排）
npx tsx scripts/import-typecho.ts --db .import/typecho.db --apply local
# ④ 生产导入（这一步才动线上）
npx tsx scripts/import-typecho.ts --db .import/typecho.db --apply remote
```

导入完成后，全量发布会写几百个对象，**不能放在一次请求里**（CPU/墙钟），
所以走分批入口（§6.5）：

```
POST /admin/rebuild/batch { limit: 20 }   # 返回 JSON：{rebuilt, objects, failed, needsSync}
# 循环调用直到 needsSync = 0
```

**必须先读目标库、按业务键复用 id**（本地彩排摔出来的）：

- `metas` 除 `mid` 外还有 `(type, slug)` 唯一索引 → 老站的「安卓」标签可能与新库已有行同名不同 mid，
  盲插会直接撞唯一约束。做法：按 `(type, slug)` 复用已有 mid，再把 `relationships` 一起重映射。
- `users` 的 `username` 是唯一索引，而**新库管理员叫 `admin`、老站作者叫 `fengqi`**：
  按用户名匹配会凭空多出一个拿不到口令的「幽灵管理员」，而文章 byline 还得靠它撑。
  做法：**单管理员场景直接把老站作者合并到现有管理员**（只更新 `screen_name`/`url`/`mail`）。
- 红线：**绝不覆盖现成管理员的 `password` 与 `token_version`** —— 那是刚 bootstrap 好的 PBKDF2 串，
  被 phpass 覆盖就再也登不进去（本地彩排专门设了一个已知哈希来验证这条）。

**真实数据体检结论（2026-09，对着线上库 `TnJehpNtTuc.db`）**

| 项 | 实测 | 处理 |
|---|---|---|
| Typecho 版本 / 表名 | **1.3.0，无表前缀**（`contents`/`metas`/…） | 脚本已改为**探测表名**，不再写死 `typecho_` 前缀 |
| `contents` | 238 行：`post/publish` **111**、`post/hidden` **36**、`post_draft/publish` 13、`page/publish` 1、`page/hidden` 4、`attachment/publish` **62**、`revision/*` **11** | revision 跳过（不是正文）；草稿照旧导成 draft |
| `users` | 1 行，列名是 **`name`**（1.3 不再叫 `username`） | 脚本已兼容 `name`/`username` |
| `metas` | 7 分类 + **277 标签**（其中 228 个只有 ≤1 篇文章） | 标签归档 = 277×2 个对象（含 `/1/` 副本），全站构建约 **850~900 个对象** |
| 附件 | **62 个、11.0 MB**（设计文档原先写「约 10 个、6MB」，**已过时**） | 元信息照搬；文件本体要搬到 R2，路径逐字保持 |
| 正文格式 | **122 篇带 `<!--markdown-->` 标记、30 篇不带** | 见下（保真关键） |
| 多分类文章 | 2 篇：cid=394 两种口径一致；cid=632 口径不同 | 线上 `/go/632.html` → **301** → `/default/632.html`，**canonical 与 mid 升序一致** ✓ |
| URL 逐条核对 | 由 DB 推导 **556 条 URL**，打老站：**551 条 200** | 5 条异常：`/feed/` 500、`/sitemap.xml` 404、`/go/632.html` 301、`/memos.html`+`/pocket.html` 500（这两个 hidden 页面在老站本身就是坏的，新站重渲后会正常） |
| 注释 / 自定义字段 | 128 条评论（丢弃）；`fields` 0 行 | 评论整体移除 ✓ |

**保真关键：正文格式要按 `<!--markdown-->` 标记分流**

Typecho 只在正文开头带 `<!--markdown-->` 标记时才走 Markdown（`Typecho_Abstract_Contents::filter`），
其余**原样当 HTML 输出**。本库 122 篇带标记、30 篇不带（2010 年前后是手写 HTML）。
一律跑 markdown-it 会把老文章的纯文本行包进 `<p>`、还可能吃掉 `*`/`_` —— 脚本已改为分流：
带标记 → `renderMarkdown`；不带 → 只做白名单清洗。

**两个待定项（需要人拍板，见下）**

1. **`hidden` 的 36 篇文章 + 4 个 hidden 页面**：线上**都返回 200**（只是不进列表）。
   若降级为草稿就会产生 40 个 404。建议支持为「可访问但不进列表/Feed/sitemap」——
   schema 里本来就有 `hidden`，要改的只是「页面生成包含 hidden、列表与 Feed 排除」。
2. **附件页面 `/attachment/<cid>/`（62 个，线上 200）**：Typecho 1.3 的路由表里确有
   `attachment → /attachment/[cid:digital]/`。要保住这些 URL 就得生成一个最简页面
   （文件 + 所属文章链接），否则它们会 404。

**已知保真风险：多分类文章的「第一个分类」口径**

Typecho 的 permalink 取「第一个分类」，那个「第一」是 `typecho_relationships` 的**插入顺序**；
而 `primaryCategory()` 按 `metas.mid` **升序**取。两者不一致时 URL 就变了。
脚本会把两种候选 URL 都算出来并标记差异，再用 `--verify-urls` 爬老站判定线上到底服务哪个。
Typecho 很可能对两个候选都返回 200（文章同时属于两个分类），那时需要人拍板选一个；
若与我们的口径不同，两条修法：给 `relationships` 加排序列（新增一次迁移），
或把老 URL 记进 `permalink_history` 走 §5.1 方案 A。

**附件文件**：`contents` 里 `type='attachment'` 的元信息照搬（`mime`/`size`/`r2_key`），
文件本体要单独搬 —— R2 key 必须与老站路径逐字一致（`usr/uploads/…`，含中文与空格，
实测编码可用，见 §9），且**附件行不进内容流水线的待办**（它的 `needs_sync` 是给文件上传看的）。

### 迁移执行结果（2026-09-30，已上线 blog.fengqi.me）

对着真实库跑了全流程，结果如下：

| 步骤 | 结果 |
|---|---|
| 导入 D1 | **227 contents**（111 publish + 36 hidden + 13 draft + 62 attachment + 5 page）/ **281 metas**（7 分类 + 274 标签，3 对同名 slug 合并）/ **529 relationships** / 1 用户（与现有 admin 合并，**口令与 token_version 未被覆盖**） |
| 全量发布 | **798 个对象**，16 批 × 50 写完，**0 失败** |
| 附件 | **67 个文件 / 10.9 MB** 按原路径写入 R2（key 与老站逐字一致，`immutable`） |
| **URL 对账** | 老站 556 条清单 → 新站：**494 条 200 + 62 条 404（全部是选定豁免的附件页）**，**0 条意外失败** |
| 保真抽查 | 手写 HTML 老文章 / markdown 近期文章 / hidden 文章 / 独立页面，逐句比对老站页面全部命中 |
| 净收益 | 老站上 500 的 `/memos.html`、`/pocket.html` 在新站正常渲染；`/feed/` 从 500 变 200；补上了老站没有的 `/sitemap.xml` |

已知取舍：

- **62 个 `/attachment/<cid>/` 页面 404**（人拍板豁免）。正文里的图片链接不受影响。
- **2 张图在迁移前就丢了**：`/usr/uploads/2012/02/135359723.png`、`/usr/uploads/2013/02/1324381562.png`
  在老站和本地 `usr/uploads` 里都不存在（其中一张还被正文引用着）—— 属于既成事实，不是迁移造成的。
- 作者 byline 链到 `https://fengqi.me`（老站用户资料里的 url 字段）。要改就改 `users.url`。
- **主题 CSS 已补齐**（2026-09-30）：指纹化写入 R2 + `<link>` 注入 + 暗色模式，见 §7.2。
- **导航与版式改版**（2026-09-30，见 §5.1 / §11.1）：全站去掉侧栏，导航收进顶栏，
  新增 `/categories/`、`/tags/`、`/archives/` 三个索引页（纯新增 URL），
  文章页加服务端生成的两级目录，容器宽度**全站一档 50rem**（§11.1）。
  删除路径从「全站重写 800 个对象」收敛到「按影响面约 35 个」（§5.3）。
- **索引页列为「已知边界」**：删掉某个月最后一篇文章时，那个月份对象会永久留在 R2 上（§5.3）。
  与旧实现一致，不是这次引入的。

### 迁移中的坑

**① 导入计入 D1 写入额度**

每条 INSERT 都算 rows written（免费版 10 万/天）。`contents` 表 760 行（含草稿与约 10 条附件记录），加上 `metas` / `relationships` / `options`，总量在千行级，一次导完完全没问题。**不需要分批，也不需要临时升级到 Paid。**

**② 域名变更会打断正文里的绝对 URL —— 现在要正视，因为前台暂时不在老域名上**

前台域名已定为**读配置**（`options.site_url`，当前值 `https://blog.fengqi.me`，见 §2），
但线上索引与正文里的绝对链接指向的是 `fengqi.me`。**在正式切到 `fengqi.me` 之前，
两个域名会同时存在**，所以要接受两件事：

1. 老站（`fengqi.me` 上的 Typecho）**不能关** —— 它是索引与外链的实际落点
2. `blog.fengqi.me` 上的 canonical 指向 `blog.fengqi.me`，与老站索引是两套；
   正式切换时按 §2 的三步走（改配置 → 配域名 → 全站重渲）

另外，实测正文里写死的图片地址是 `https://img-typecho-r2.fengqi.me/...`（自己的 R2 域名，见 §9），
**不是** `https://你的域名/usr/uploads/...`。任何域名变更都要连带评估这个域名。

代价是这是一次**硬切换**：域名只有一个，新旧站点不能并行跑。所以迁移前必须先备好回滚路径——老站的数据库和文件先完整保留，DNS 能快速切回。别等到出问题才想回滚。

> 方法备查（若将来换域名）：先全库搜一遍老域名，再决定是否批量替换。
>
> ```sql
> SELECT cid, title FROM typecho_contents WHERE text LIKE '%老域名%';
> ```

**③ 附件的 URL 编码**

中文文件名、空格、特殊字符在 R2 key 和浏览器请求之间容易编码不一致。存量附件只有 10 个左右，**逐个手工核对**比写脚本更快更可靠，见 §9。

### 迁移后立刻做

1. 对全部可见 URL 跑一遍状态码检查，确认没有 404
2. `urls-old.txt` 与 `urls-new.txt` diff，差集必须为空
3. 提交新的 sitemap 给搜索引擎
4. **老站的数据库与文件先别删**。域名沿用意味着没有过渡期，回滚只能靠切回 DNS，所以至少留一个月再清理。如果老站有空闲的独立域名，也可以挂一个临时 301 做兜底。
