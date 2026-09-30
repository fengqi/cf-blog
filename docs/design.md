# Cloudflare Workers 博客系统 · 设计文档

> 目标：完全基于 Cloudflare Workers 搭建博客，最大化利用免费额度承载流量，  
> 功能对照 PHP 版 Typecho 的核心子集。
>
> 本文档只覆盖设计，不含实现代码。配套的建表脚本见 `docs/schema.sql`。



---

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
| Workers       | **10 万请求/天**   | CPU **10ms/请求**、128MB 内存、**50 子请求/请求**    |
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
3. **动态接口避免 N+1，查询次数保持可控。** 免费版有 50 次查询/调用的硬限，N+1 会让列表页失控。评论与搜索移除后，动态接口只剩后台（请求量每天几十次计），这条从硬性指标降为**代码纪律** —— 新增接口时数一下查询次数，别把查询写进循环里。
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

**主域名（R2）：`blog.fengqi.me`**

| 路径                                                    | 内容                           |
| ----------------------------------------------------- | ---------------------------- |
| `/`、`/page/<n>/`                                      | 预渲染的首页与分页（当前 12 页）           |
| `/<category>/<slug>.html`                             | 预渲染的文章页                      |
| `/<slug>.html`                                        | 预渲染的独立页面（单段，如 `/about.html`） |
| `/category/<slug>/`、`/tag/<slug>/`、`/<year>/<month>/` | 预渲染的分类 / 标签 / 年月归档           |
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
| GET      | `/`                       | `index`       | 首页                      |
| GET      | `/page/<n>/`              | `page/<n>/`   | 首页分页（当前 12 页）           |
| GET      | `/<category>/<slug>.html` | 同左            | 文章；`<slug>` 未填缩略名时即 cid |
| GET      | `/<slug>.html`            | 同左            | 独立页面，如 `/about.html`    |
| GET      | `/category/<slug>/`       | 同左            | 分类归档                    |
| GET      | `/tag/<slug>/`            | 同左            | 标签归档                    |
| GET      | `/<year>/<month>/`        | 同左            | 年月归档                    |
| GET      | `/feed/`                  | `feed/`       | RSS（带末尾斜杠）              |
| GET      | `/sitemap.xml`            | `sitemap.xml` | 站点地图                    |
| GET      | `/usr/uploads/*`          | 同左            | 附件（路径已确认，见 §9）          |
| GET/POST | `/admin/*`                | —（Worker）     | 后台                      |

**段数不同，天然不冲突**：独立页面是单段（`/about.html`），文章是两段（`/<category>/<slug>.html`）。即使有个分类叫 `about`，`/about/760.html` 和 `/about.html` 也是两个不同的 key。

**`/page/1/` 与 `/` 是重复内容，必须交代清楚。** 已确认 `/page/1/` 真实存在，且渲染的就是首页内容。URL 已经存在、可能有外链与索引，**不能删**，所以：

- `/page/1/` 照常生成 R2 对象、返回 200
- 页面内输出 `<link rel="canonical" href="https://blog.fengqi.me/">`，把权重归并到首页
- **`/page/1/` 不写进 sitemap** —— sitemap 只列 `/` 与 `/page/2/` … `/page/12/`

不处理的话，同一份内容会被当成两个页面，互相稀释。

**文章 URL 里的分类段是个先天缺陷**，必须认清。

`/<category>/<slug>.html` 把分类 slug 编进了 URL。这是 Typecho 支持的 permalink 格式，你已经在用，只能沿用。但后果是：**文章改分类，URL 就变了，旧 URL 直接 404。**

而静态方案下 R2 **无法返回 301**（对象响应状态码不可自定义）。两个选择：

- **A（推荐）：保留旧对象不删**，在旧页面里输出 `<link rel="canonical" href="新URL">`。旧 URL 仍返回 200，搜索引擎自行归并权重。这是静态站处理 URL 变更的标准做法。
- **B：删除旧对象**，用 Cloudflare 的 Redirect Rules 补 301。需要额外维护规则，且免费版规则条数有限。

> 走 A 方案的前提是**发布时记下文章改动前的 slug 和分类**，否则改完之后就无从知道该保留哪个旧 URL。  
> 需要在 `contents` 或单独一张表里留痕，见 §4.2 第 ⑤ 项。

**末尾斜杠必须严格一致**。`/category/go/`、`/2012/12/` 这类 URL 以 `/` 结尾，而 R2 是精确 key 匹配——写入时 key 就必须带末尾斜杠，否则整片 404。

为降低风险，建议写入时**同时写带斜杠和不带斜杠两个 key**（成本翻倍，但可忽略），或者配 1 条 URL Rewrite 规则做规范化。这是 §13.1 的待验证项之一。

**静态方案的一个隐形收益**：R2 是精确 key 匹配，不存在"`/:slug` 会吃掉一切单段路径"的优先级问题。  
原来的路由分发逻辑（需要正则判定模式 B/C）直接消失 —— permalink 模式只在**发布时**决定写入哪个 key。

**content-type 不需要 URL Rewrite 解决**：R2 支持写入时指定 `httpMetadata.contentType`，  
所以 key 可以不带 `.html` 后缀，URL 保持干净：

```ts
await env.BUCKET.put(`${categorySlug}/${slug}.html`, html, {
  httpMetadata: { contentType: 'text/html; charset=utf-8' },
});
```

这样一条 Transform Rule 都不需要（免费版只有 10 条，能省则省）。

> 根路径 `/` 是唯一需要留意的：R2 不做目录索引，不会自动找 `index.html`。  
> 把首页对象直接写成 key `index`，并确认 R2 对 `/` 的处理（可能需要 1 条 URL Rewrite  
> 把 `/` 重写为 `/index`）。这是 §13 的待验证项之一。

### 5.2 动态请求的查询预算

静态方案下，前台的查询全部发生在**发布时**，请求期是 0 次查询。剩下的动态接口只有后台。

目标：**避免 N+1，查询次数保持可控**。后台请求量极小（每天几十次），这条主要是代码纪律，不是性能压力。

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

按你站点的实际规模（12 页分页、约 120 篇可见文章）估算：

| R2 对象 | 数量 | 为什么变了 |
|---|---|---|
| `<category>/<slug>.html` | 1 | 文章本体 |
| `index` | 1 | 首页 |
| `page/1/` … `page/12/` | 12 | 偏移分页，内容全部顺移（`page/1/` 需输出 canonical 指向首页，见 §5.1） |
| `category/<slug>/` | 1 | 该文章所属分类的归档 |
| `tag/<slug>/` | n | 每个标签的归档 |
| `<year>/<month>/` | 1 | 当月归档 |
| `feed/` | 1 | RSS |
| `sitemap.xml` | 1 | URL 集合变了 |
| **合计** | **约 20 个** | |

**结论：这个规模根本不需要优化。**

20 次 R2 写入，占免费版 100 万 Class A/月的 **0.002%**，墙钟不到 1 秒。

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

注意：**渲染完整页面比渲染片段更吃 CPU**（要套骨架、算分页、串相关文章），
所以 §13.1 第 4 项（发布流水线的实际 CPU 与墙钟耗时）的验收阈值，必须按**完整页面**来测，不能只测渲染片段。

### 6.5 渲染器要锁版本

markdown-it 的版本升级可能改变输出，所有文章共用一套渲染配置。

必须准备一个**「全站重新渲染」**的后台入口，用来在改模板 / 样式 / 渲染器版本后刷新历史文章。

按当前规模（约 120 篇文章，每篇还要顺带重建列表与归档）约几百次 R2 写入，
**必须分批** —— 单次请求撞 50 子请求/请求 的硬限。每批 20 篇左右，配合 Cron 逐批推进。

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
  ]
}
```

上面是**绑定相关的最小集**。脚手架生成的 `wrangler.jsonc` 还带 `$schema`、`observability`、`upload_source_maps`，都是 C3 默认值，保留即可。

后台 Worker 不需要 `assets` 绑定（前台资源全部在 R2），也不需要 Workers Cache。

> 顺带说明为什么不用 Workers Cache：它命中时确实跳过脚本执行，但官方明确"所有发往 Worker
> 的请求都按标准请求费率计费"——省 CPU 不省额度。而我们的目标恰恰是省额度，所以静态直出才是解。

### 7.2 R2 对象的缓存头

主域名由 R2 直出，缓存行为完全由对象自身的 `Cache-Control` 决定 —— **必须在写入时就设好**。

| 对象 | Cache-Control |
|---|---|
| `<category>/<slug>.html`、`<slug>.html` | `public, max-age=300, stale-while-revalidate=600` |
| `index`、`page/<n>/` | `public, max-age=60, stale-while-revalidate=300` |
| `category/<slug>/`、`tag/<slug>/`、`<year>/<month>/` | `public, max-age=120` |
| `feed/`、`sitemap.xml` | `public, max-age=600` |
| `theme/*`、`usr/uploads/*` | `public, max-age=31536000, immutable` |

主题资源要做到 `immutable`，文件名必须带指纹（如 `style.a1b2c3.css`），否则改了样式老用户拿不到新的。

> **待验证**：R2 对象被覆盖写入后，Cloudflare 边缘缓存是否自动失效（见 §13）。
> 如果不自动失效，发布时就要主动 purge 相关 URL。

### 7.3 站点配置缓存（后台）

后台每渲染一个页面都要读 `options`（40+ 行），仍值得做两层缓存：

1. **模块级内存缓存**：isolate 全局变量，命中零成本，但 isolate 重启即失效
2. **Cache API 兜底**：配置序列化成 JSON 存 `caches.default`，TTL 300s

**失效**：保存设置时清两层（`caches.default.delete()` + 用自增的 `config_version` 让内存缓存失效）。

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

> 不要为此引入 Durable Object。为一个登录接口加一套 DO 是明显的过度设计，而且 DO 的请求
> 也要占额度、还要维护额外状态。这里的问题用降迭代数就能解决。

**默认管理员密码是 `admin`，首次登录必须强制修改。**

### 8.3 XSS

- 文章 HTML：`rendered` 写入前用白名单清洗（`script`/`iframe`/`on*` 属性全部剔除，`a[href]` 校验协议）
- 后台表单：所有输出走统一的 `escapeHtml()` 工具

去掉评论后，全站唯一的用户输入入口就是后台，XSS 面收缩到"作者自己写的文章内容"。
但**清洗仍不能省**：Markdown 里嵌入的原生 HTML 会原样进 `rendered`，不洗就是给自己留后门。

### 8.4 后台登录防护

评论移除后，后台登录成了**全站唯一的外部写入入口**，防护强度反而要比原来更高。

1. **Turnstile**：登录表单挂上，免费，没有理由不加
2. **失败频率限制**：同 IP 15 分钟内失败 10 次 → 锁定
3. **强制口令强度**：初始密码 `admin` 必须首次登录即改，并校验长度与复杂度

**IP 存哈希不存明文**（`SHA-256(ip + IP_SALT)`），既能做频率统计又不落隐私数据。

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

**存量规模（已核实）**：约 **10 个文件、6MB**，路径确认为 `/usr/uploads/`。

结论：**R2 的 10GB 存储额度完全不构成约束**，占用率不到 0.1%。附件这一块在设计上不需要任何容量优化——真正的约束只有 Class B 读操作数（§7.2）。

> 一个值得注意的观察：**约 120 篇文章却只有 10 个本地附件**，说明绝大多数配图是外链图床，而不是本地上传。这有两层含义：
>
> 1. 内存/额度角度是好消息——要搬的东西几乎可以忽略
> 2. 但外链图床是**脆弱依赖**：图床挂掉、防盗链策略变更、域名过期，都会让历史文章批量碎图。这是内容资产问题，不是架构问题 —— **计划后续把这些外链图片回收到 R2**，不阻塞本次迁移，可以用外部工具一次性处理

**存量附件搬迁**：Typecho 的文件在服务器 `usr/uploads/` 目录，整目录搬到 R2：

```bash
# R2 key 必须与服务器上的相对路径完全一致
rclone copy ./usr/uploads r2:blog-content/usr/uploads
```

> ⚠️ 迁完要逐个抽查：**文件名里的中文、空格、特殊字符**容易被 URL 编码搞乱。
> 存量附件的原始文件名很可能含中文，必须保证 R2 的 key 与浏览器实际请求的编码形式能对上。

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
| 归档（时间 / 分类 / 标签） | ✅ | 不含作者归档，单作者站点无意义 |
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
│   ├── layout.ts                  # 页面骨架（唯一主题）
│   ├── home.ts
│   ├── post.ts
│   ├── page.ts
│   ├── archive.ts
│   ├── components/                # 侧栏、分页器、标签云
│   └── assets/                    # CSS / JS / 字体，构建时打指纹
│       ├── style.css
│       └── app.js
├── src/
│   ├── index.ts                   # Worker 入口（后台）
│   ├── types.ts                   # Env 绑定类型、模型类型
│   ├── views/                     # ★ 后台页面组件（Hono JSX，.tsx）
│   │   ├── layout.tsx             # 后台骨架
│   │   ├── login.tsx
│   │   ├── post-editor.tsx
│   │   ├── post-list.tsx
│   │   └── settings.tsx
│   ├── routes/
│   │   ├── admin.ts               # 后台页面与操作
│   │   ├── auth.ts                # 登录 / 登出
│   │   └── preview.ts             # 草稿预览（R2 里还不存在的对象）
│   ├── publish/                   # ★ 发布流水线，本方案的核心
│   │   ├── pipeline.ts            # 编排：渲染 → 写 D1 → 写 R2 → 异步重建
│   │   ├── targets.ts             # 一次发布要重建哪些对象，见 §5.3
│   │   ├── render.ts              # 完整页面渲染（套模板骨架）
│   │   └── sync.ts                # needs_sync 对账与重试，见 §6.2
│   ├── models/
│   │   ├── content.ts             # 含聚合查询，禁止在别处裸写 SQL
│   │   ├── meta.ts
│   │   ├── user.ts
│   │   └── option.ts
│   ├── lib/
│   │   ├── db.ts                  # D1 封装 + 查询计数器（dev 模式告警）
│   │   ├── r2.ts                  # R2 读写封装 + 缓存头 + 批量删除
│   │   ├── markdown.ts            # markdown-it 配置
│   │   ├── sanitize.ts            # HTML 白名单清洗
│   │   ├── auth.ts                # 签名 Cookie + PBKDF2
│   │   └── url.ts                 # permalink → R2 key 映射
│   └── middleware/
│       └── auth.ts
├── scripts/
│   ├── import-typecho.ts          # Typecho 迁移（含全量渲染 + 写入 R2）
│   └── hash-password.ts           # 生成 PBKDF2 串
└── docs/
    ├── design.md                  # 本文档
    └── schema.sql
```

**两套渲染机制，各管一边**：`theme/`（`.ts`）是前台，纯字符串拼接，发布时渲染完写进 R2；`src/views/`（`.tsx`）是后台，Hono JSX，直接当 HTTP 响应返回。不要互相串用 —— 前台那套必须零依赖、能在发布流水线里裸跑。

后台 JSX 的两条纪律：

1. **只 import `hono/jsx`。** `hono/jsx/dom` 是客户端渲染（带虚拟 DOM 与 hydration），本项目不用 —— 后台是纯 SSR + 少量原生 JS
2. **唯一的转义出口是 `dangerouslySetInnerHTML`**，只允许用在文章正文 `rendered`（那是清洗过的 HTML，见 §8.3）。其余任何地方都不该出现

**两条硬约束**：

1. SQL 只允许写在 `models/` 和 `lib/db.ts` 里。`routes/` 和 `theme/` 不碰数据库。
2. **R2 写入只允许发生在 `src/publish/` 里。** 别的地方碰 R2 会让缓存策略和对象一致性失控 —— 这是静态直出方案唯一的纪律要求，也是最容易在维护中被破坏的一条。

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

# 4. 密钥
wrangler secret put SESSION_SECRET
wrangler secret put IP_SALT
wrangler secret put TURNSTILE_SECRET

# 5. 本地开发（D1 走本地 SQLite，不消耗线上额度）
wrangler dev

# 6. 部署后台 Worker
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
> 顺带一提，R2 对象自身返回不了 301（§5.1 讲过的限制），需要改地址的 301 只能用 Redirect Rules 做。

### 12.2 首次全量发布

数据库建好时 R2 是空的，前台会全线 404。必须有一步初始发布：

```bash
npx tsx scripts/import-typecho.ts --full-publish
```

全量发布要写入：每篇文章、每个独立页面、每个分类/标签归档、全部分页、Feed、Sitemap、主题资源。

按实际规模（约 120 篇文章）估算，总量在**几百个 R2 对象**量级，占免费版 100 万 Class A/月不到 0.1%，额度上毫无压力。

**但不要在一次 Worker 请求里做完** —— 会撞两个硬限：50 子请求/请求、以及 CPU 时间。正确做法是用 `scripts/import-typecho.ts` **在本地分批执行**（`npx tsx` 跑在本机，完全不受 Worker 的子请求与 CPU 限制），这才是这个脚本存在的意义。

### 12.3 Cron Triggers

免费版账号共 5 个额度，本方案只用 **1 个**（每小时触发一次）：

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

### 13.1 静态直出特有的验证项（新增，优先级最高）

| # | 待验证 | 影响 | 验证方式 |
|---|---|---|---|
| 1 | R2 自定义域名对根路径 `/` 的行为 | 首页可能 404，决定要用 1 条 URL Rewrite 还是别的办法 | 上传 key `index` 后访问 `/` |
| 2 | R2 对象被覆盖写入后，边缘缓存是否自动失效 | 决定"发布即生效"能否成立，以及要不要主动 purge | 覆盖一个对象，观察响应变化 |
| 3 | R2 自定义域名的响应是否经 Cloudflare CDN 缓存 | 直接决定 Class B 消耗是 300 万还是更少 | 看响应头 `cf-cache-status` |
| 4 | 发布流水线（渲染完整页面 + 写 10–30 个 R2 对象）的实际 CPU 与墙钟耗时 | 决定同步/异步切分点，以及是否必须上 Queues | 用最长文章压测 |
| 5 | R2 自定义域名与 Worker Custom Domain 的隔离是否彻底 | 万一互相干扰，整套架构要重来 | 两个域名配好后交叉验证 |
| 6 | **带末尾斜杠的 URL 在 R2 上的 key 匹配** | `/category/go/`、`/2012/12/` 若被规范化成无斜杠，整片归档页 404 | 上传 key `category/go/`，访问该 URL 验证 |

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

```bash
# 抓现有站点的 sitemap，导出全部被索引的 URL
curl -s https://你的域名/sitemap.xml | grep -o '<loc>[^<]*</loc>' > urls-old.txt
```

迁移完成后对新站点跑同样的命令，**两个清单逐条 diff，差集必须为空**。
这是唯一能系统性发现 URL 遗漏的办法，靠人眼核对不可能做到。

> ⚠️ **先确认 sitemap 是不是分页的。** Typecho 的 sitemap 插件通常会生成一个**索引**文件 ——
> `sitemap.xml` 里只有指向 `sitemap-post-1.xml`、`sitemap-page-1.xml` 之类的 `<loc>`，
> 真正的文章 URL 在子文件里。这种结构下上面的命令抓到的是子 sitemap 的地址，**必须递归抓一层**。
>
> 判断方法很直接：看 `urls-old.txt` 的行数，和实际内容量（约 120 篇 + 分类标签归档 + 分页）对不对得上。差太远就是分页了。

### 数据迁移步骤

1. 导出 MySQL 数据（`mysqldump`）
2. `scripts/import-typecho.ts` 做转换：
   - 表名与字段按 §4.1 映射
   - `typecho_contents.text` → 新 `body`，并调用 markdown 渲染填充 `rendered`
   - `typecho_contents.type` 的 `post_draft` / `page_draft` 拆成 `type` + `status='draft'`
   - `typecho_metas.count` 需要重算
   - **`type='attachment'` 的记录**：这些是附件，`text` 字段存的是 JSON 元信息。已确认仅约 **10 条**（不是 cid 差值的大头，大头是草稿）。全量导入即可，不值得做筛选逻辑
   - `typecho_users.password` 是 `$P$` 开头的 phpass 哈希，**在 Workers 里无法校验**，存量用户只能重置密码。个人博客通常只有 1 个管理员账号，直接重设即可
3. **附件搬迁**：`usr/uploads/` 整目录同步到 R2，路径保持原样（详见 §9）
4. 用 `wrangler d1 execute --file` 批量导入（单文件 ≤ 5GB）

### 迁移中的坑

**① 导入计入 D1 写入额度**

每条 INSERT 都算 rows written（免费版 10 万/天）。`contents` 表 760 行（含草稿与约 10 条附件记录），加上 `metas` / `relationships` / `options`，总量在千行级，一次导完完全没问题。**不需要分批，也不需要临时升级到 Paid。**

**② 域名变更会打断正文里的绝对 URL —— 本项目不适用**

已确认**继续沿用原域名**，正文里写死的 `https://你的域名/usr/uploads/...` 依然有效，无需改写。

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
