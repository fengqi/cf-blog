# 项目进度 · TODO

> 本文件是**进度看板**：完成一项就标 ✅ 并补一行「结果」，开工中的标 🔄。
> 设计依据见 [`design.md`](design.md)，运维与命令见 [`../README.md`](../README.md)。
>
> 最后更新：2026-09-30

---

## 一句话现状

- **前台** <https://blog.fengqi.me/> —— 已是一个完整博客：Typecho 迁移完成，**800 个渲染对象 / 227 条内容 / 67 个附件**，556 条老站 URL 对账 **零意外失败**。
- **后台** <https://admin-blog.fengqi.me/admin> —— 可登录、写/改文章（保存即发布）、预览草稿、删除、全站重建入口。
- **主题已上线** —— 指纹化 CSS/JS 写入 R2（`immutable`）、两栏响应式布局、侧栏（分类/标签云/最新文章/归档）、暗色模式、轻量代码高亮。
- **老站 `fengqi.me` 仍在服务 Typecho**，两边并行；域名切换由 ⑪ 决定。

---

## ✅ 已完成

| # | 事项 | 结果 |
|---|---|---|
| ✅ | 设计文档 review 与订正 | 域名改为读 `options.site_url`（当前 blog.fengqi.me）；实测并订正：R2 自定义域名**不做目录索引**（首页要写空 key）、尾斜杠精确匹配、HTML 不进 CDN 缓存而 <4h 的 max-age 会被抬到 14400、附件 62 个 11MB（原文档写 10 个/6MB 已过时） |
| ✅ | 最简主题 + 发布层 + 查询层 | `theme/`（layout/post/home/archive/components）+ `publish/`（snapshot/targets/render/pipeline/sync）+ `models/`；本地 e2e **104 项断言**；全站渲染基准 798 对象 ≈ 5ms |
| ✅ | 后台认证与操作 | 签名 Cookie 会话（HMAC，无状态）、PBKDF2 口令（10 万次 ≈ 6~7ms）、Turnstile 挂钩、登录失败限流、保存即发布、草稿预览、删除、全站重建入口；`/admin/login` 是唯一公开路由 |
| ✅ | **Typecho 迁移上线** | 导入 D1：227 contents / 281 metas / 529 relationships / 1 用户合并（**口令与 token_version 未覆盖**）；全量发布 798 对象（16 批 × 50，0 失败）；附件 67 个 10.9MB 按原路径写入 R2；**556 条老 URL → 494×200 + 62×404（全部是选定豁免的附件页）** |
| ✅ | **主题 CSS/资源流水线** | `npm run build:assets` 取内容 sha256 前 8 位做指纹 → `theme/assets.generated.ts`；资源作为 `kind:'asset'` 目标排在 `siteTargets()` **最前**，走同一套流水线写 R2（`immutable`）；`layout.ts` 注入 `<link>` 与 `defer` 脚本；**单篇发布不重写资源**（有断言）；线上全站重渲 **800 对象 / 0 失败** |
| ✅ | 主题排版与响应式 | 两栏骨架（内容 + 17rem 侧栏，≤62rem 收成单栏）、亮/暗双主题（`prefers-color-scheme` + 手动切换 + localStorage，首屏内联脚本防闪白，**无 JS 也能进暗色**）、侧栏五段（关于/分类/最新文章/归档/标签云，空段不渲染，**顺序与限高是按真实数据量出来的**：198 个标签、58 个月份全铺开会把侧栏撑到 2163px，现在 1130px）、正文排版（17px / 1.85 行高 / 标题 / 列表 / 引用 / 表格 / 图片）、代码块与 `tok-*` 语法高亮、分页器 |
| ✅ | 保真与语义验证 | 逐句比对老站页面（手写 HTML 老文章 / markdown 近期文章 / hidden 文章 / 独立页面）全部命中；`<font color>` 保留 9 处；hidden 页面 200 且不进首页/Feed/sitemap；老站上 500 的 `/memos.html`、`/pocket.html` 现在正常；`/sitemap.xml` 从无到有 |

---

## ⏳ 待办（按建议顺序）

| # | 事项 | 为什么 / 备注 | 状态 |
|---|---|---|---|
| ③ | 后台设置页 | 站点标题/描述/关键词/域名/timezone/每页篇数/`turnstile_site_key` —— 目前改这些只能进 SQL | ⏳ |
| ④ | 后台媒体库 | 附件上传到 R2（`/usr/uploads/<年>/<月>/`，路径规则见 design §9）+ 列表 + 复制链接 | ⏳ |
| ⑤ | 后台改口令页 | PBKDF2 生成 + `token_version += 1`（改完自动登出全部设备） | ⏳ |
| ⑥ | 「全站重渲」按钮改分批循环 | 现在按钮只标脏，靠 Cron 每小时 20 篇慢磨；改成循环调 `/admin/rebuild/full` 立刻刷完 | ⏳ |
| ⑦ | Turnstile 真正启用 | 配 `options.turnstile_site_key`；当前服务端因缺 site key **不强制校验**（只渲染控件） | ⏳ |
| ⑧ | §13.1 #4 线上 CPU 复核 | 发布流水线 + PBKDF2 在生产 isolate 的实际 CPU（看 observability），决定迭代数要不要从 10 万降到 5 万 | ⏳ |
| ⑨ | §13.1 #5 域名隔离复核 | `blog.fengqi.me`（R2 自定义域名）与 `admin-blog.fengqi.me`（Worker Custom Domain）交叉验证互不干扰 | ⏳ |
| ⑩ | 迁移收尾小决策 | 62 个 `/attachment/<cid>/` 是否补齐；2 张迁移前就已丢失的图片；作者 byline 链接（现指向老站）；清理 `.import/` 里的敏感文件 | ⏳ |
| ⑪ | 老域名切换演练 | `fengqi.me` → 新站：改 `site_url` → 配 R2 自定义域名 → 全站重渲 → 提交 sitemap；**老站数据库与文件先别删**，保留回滚 | ⏳ |
| ⑫ | 备份与长期回归 | D1 定期导出 SQL；URL 清单脚本定期跑一遍（迁移后的长期回归） | ⏳ |
| ⑬ | 代码块语言标注补全 | 抽样 20 篇文章：**35 个 `<pre>` 里只有 8 个带 `language-` 标注**（全是 bash）→ 高亮只覆盖带标注的块（没标注的整块保持原样，不会乱上色）。要么写文章时补 ```bash / ```go，要么做一个「按内容猜语言」的启发式（猜错会让代码更乱，倾向不做） | ⏳ |
| ⑭ | 全站重渲后清理旧指纹资源 | 本次迭代在 R2 留了 3 个 `style.<hash>.css`。保留 1~2 个版本是对的（§14.2），但需要收尾：比照 `THEME_ASSETS` 列出 `theme/` 下的对象，删掉不在清单里、且已超过「最长 HTML 缓存窗口」的那些 | ⏳ |

---

## ⚠️ 协作注意（多 agent 同时改这个仓库）

- 2026-09-30：本仓库同时被 **WorkBuddy** 改动过。提交 `2c8c09b` 由我用 `git add -A` 提交，
  **里面混进了它尚未提交的工作**（主题资源流水线、`overview` 索引页、版式调整、`.workbuddy/memory/`），
  提交信息没描述这些内容 —— 内容没丢，但归因不准。以后提交前先 `git status` 确认范围。
- 同一次改动里 `wrangler types` 漏了 `--env-interface CloudflareBindings`，生成的接口名变成 `Env`，
  导致主分支 typecheck 报 4 个错。已用 `npm run cf-typegen` 修回。
  **改绑定后请一律用 `npm run cf-typegen`，别手敲 `wrangler types`。**
- `.workbuddy/` 是 agent 的私有记忆目录，**建议加进 `.gitignore`**（像 `.idea/` 那样），待确认。

## 已知取舍与风险（迁移后）

- **62 个 `/attachment/<cid>/` 页面 404** —— 主动豁免（老站这些 URL 是 200）。正文里的图片链接不受影响。
- **2 张图在迁移前就丢了**：`/usr/uploads/2012/02/135359723.png`、`/usr/uploads/2013/02/1324381562.png` —— 老站与本地 `usr/uploads` 里都没有（其中一张还被正文引用），既成事实。
- **作者 byline 链到 `https://fengqi.me`**（老站用户资料 url 字段）。要改：`UPDATE users SET url=...`。
- **`.import/` 含老库敏感内容**（`plugin:CloudflareR2` 的 account_id 等、Typecho `secret`、整份 db 与 `usr/`）。已 gitignore、不会进仓库；**建议第 ⑪ 步切换完成后再删**。
- **PBKDF2 迭代 10 万次**本地约 6~7ms，与免费版 10ms CPU 上限余量不大 —— 见待办 ⑧。
- **R2 缓存口径**（design §7.2）：`.html` 不进 CDN 缓存（发布即生效）；可缓存扩展名的 `max-age` 若小于 4h 会被抬到 14400；主题资源与附件必须打指纹 + `immutable`。
- **主题资源改了必须重跑构建**：`theme/assets/` 改完不跑 `npm run build:assets`，指纹不变、页面仍指向旧文件，样式不会更新 —— 这是 ① 的流水线里最容易忘的一步。
- **侧栏只列「有文章」的分类/标签**：库里有一批只挂在草稿上的标签（迁移遗留，线上 76 个），它们的归档页仍在、也进 sitemap，只是不进侧栏导航（导航不该列空气）。
- **R2 当前的 `theme/` 下有 4 个对象**（`app.<hash>.js` + 迭代出的 3 个 `style.<hash>.css`），旧的两个刻意保留 —— 见待办 ⑭。
- **侧栏的长列表都限高**（`.sidebar-scroll`，15rem 可滚动）：归档 58 条、标签云 198 个。窄屏（≤62rem）自动放开限高，因为那时侧栏在正文下方，不存在「被拉长」的问题。

---

## 常用命令（做上面的事时会用到）

```bash
# 主题资源打指纹（改了 theme/assets/ 之后必跑）
npm run build:assets

# 本地端到端断言（真实 workerd + 本地 D1/R2/KV，121 项）
npx wrangler d1 migrations apply blog-db --local
npx wrangler dev -c wrangler.e2e.jsonc --port 8788
curl -s http://127.0.0.1:8788/ | tail -3          # 看到「全部通过」

# 渲染压测（不连数据库）
npm run bench:render

# 生产全量重建（写了模板/样式之后）
npx wrangler dev -c wrangler.publish.jsonc --remote --port 8788
curl "http://127.0.0.1:8788/full?offset=0&limit=50"   # 循环到 nextOffset 为 null
curl "http://127.0.0.1:8788/keys"                     # 列举线上对象，用于对账

# 附件迁移（按原路径写 R2）
npx tsx scripts/upload-attachments.ts --root .import --dry-run
npx tsx scripts/upload-attachments.ts --root .import --target remote

# 老库体检 / URL 逐条核对（.import/typecho.db 那份老库还在时）
npx tsx scripts/import-typecho.ts --db .import/TnJehpNtTuc.db
npx tsx scripts/import-typecho.ts --db .import/TnJehpNtTuc.db --verify-urls
```
