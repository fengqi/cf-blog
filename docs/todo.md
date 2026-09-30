# 项目进度 · TODO

> 本文件是**进度看板**：完成一项就标 ✅ 并补一行「结果」，开工中的标 🔄。
> 设计依据见 [`design.md`](design.md)，运维与命令见 [`../README.md`](../README.md)。
>
> 最后更新：2026-09-30

---

## 一句话现状

- **前台** <https://blog.fengqi.me/> —— 已是一个完整博客：Typecho 迁移完成，**803 个渲染对象 / 227 条内容 / 67 个附件**，556 条老站 URL 对账 **零意外失败**。
- **后台** <https://admin-blog.fengqi.me/admin> —— 可登录、写/改文章（保存即发布）、预览草稿、删除、站点设置页（标题/描述/关键词/域名/时区/每页篇数/Turnstile site key）、媒体库（上传/列表/复制链接）、改口令、全站重建入口（分批循环当场刷完）。
- **主题已上线** —— 指纹化 CSS/JS 写入 R2（`immutable`）、**全站零侧栏 + 顶栏导航**、文章页服务端目录、暗色模式、轻量代码高亮。
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
| ✅ | **导航/版式改版 + 删除路径修复** | 侧栏整站移除，导航收进顶栏（首页/分类/标签/归档/关于，不展开）；新增 `/categories/`、`/tags/`、`/archives/` 三个索引页（纯新增 URL，进 sitemap）；索引页排版：分类保持一行一条带描述，标签一行多个流式胶囊，归档按年份分组 + 月份流式；都不输出「共 N 个…」说明行。文章页服务端抽 h2/h3 生成锚点 + 目录（宽屏溢出到容器右侧留白里 `sticky` / 窄屏原生 `<details>`，零 JS，带滚动高亮）；容器宽度**全站一档**（唯一开关 `--container-size` = 50rem，目录不占正文宽度）；`deletePost` 从「全站重写 800 个对象」改为按影响面 **~35 个**。本地 e2e **145 项全过**；Chrome 实测（1280 / 1400 / 390 / 亮暗）版式与目录行为符合预期 |
| ✅ | **后台设置页** | `/admin/settings`（顶栏新增「设置」入口）：站点标题/描述/关键词/域名/时区/每页篇数/`turnstile_site_key` 一次 batch 写库（`saveSiteSettings`）。校验：域名必须完整 http(s) 且剥末尾斜杠、每页篇数 1~100、时区 -12~14 整数小时；**前台可见配置变动时自动把全站标脏**（走 Cron 逐批重建，消息里带篇数），只改 Turnstile key 不标脏。e2e **150 项全过**（+5） |
| ✅ | **后台媒体库（④）** | `/admin/media`（顶栏「媒体」）：multipart 上传到 R2 `usr/uploads/<年>/<月>/<文件名>`（站点时区、按扩展名白名单 jpg/png/webp/gif/avif/pdf、≤10MB）+ 列表（D1 `type='attachment'`，与迁移来的 62 个同清单）+ 链接一键复制（几行原生 JS）。**immutable 纪律：同 key 已存在拒绝覆盖**（R2 `head` 先查），要换图换文件名。R2 写入收在 `src/publish/attachments.ts`（§11 纪律 2）；附件 `needs_sync=0` 不进渲染流水线 |
| ✅ | **后台改口令页（⑤）** | `/admin/password`（顶栏「口令」）：校验当前口令 → PBKDF2（10 万次迭代）落库 → `token_version += 1`，**全部旧会话（含当前）立刻失效**，跳登录页用新口令重登 |
| ✅ | **「全站重渲」按钮改分批循环（⑥）** | 文章列表页按钮被几行原生 JS 拦截，循环调 `POST /admin/rebuild/full`（50 个/批）直到 `nextOffset=null`，实时显示 `x / total` 与失败数 —— 改模板/样式后**当场刷完**，不再等 Cron 慢磨。无 JS 时降级为原行为（标脏交给 Cron） |
| ✅ | 保真与语义验证 | 逐句比对老站页面（手写 HTML 老文章 / markdown 近期文章 / hidden 文章 / 独立页面）全部命中；`<font color>` 保留 9 处；hidden 页面 200 且不进首页/Feed/sitemap；老站上 500 的 `/memos.html`、`/pocket.html` 现在正常；`/sitemap.xml` 从无到有 |

---

## ⏳ 待办（按建议顺序）

| # | 事项 | 为什么 / 备注 | 状态 |
|---|---|---|---|
| ⑦ | Turnstile 真正启用 | 配 `options.turnstile_site_key`（设置页已可配）；当前服务端因缺 site key **不强制校验**（只渲染控件） | ⏳ |
| ⑧ | §13.1 #4 线上 CPU 复核 | 发布流水线 + PBKDF2 在生产 isolate 的实际 CPU（看 observability），决定迭代数要不要从 10 万降到 5 万 | ⏳ |
| ⑨ | §13.1 #5 域名隔离复核 | `blog.fengqi.me`（R2 自定义域名）与 `admin-blog.fengqi.me`（Worker Custom Domain）交叉验证互不干扰 | ⏳ |
| ⑩ | 迁移收尾小决策 | 62 个 `/attachment/<cid>/` 是否补齐；2 张迁移前就已丢失的图片；作者 byline 链接（现指向老站）；清理 `.import/` 里的敏感文件 | ⏳ |
| ⑫ | 备份与长期回归 | D1 定期导出 SQL；URL 清单脚本定期跑一遍（迁移后的长期回归） | ⏳ |
| ⑬ | 代码块语言标注补全 | 抽样 20 篇文章：**35 个 `<pre>` 里只有 8 个带 `language-` 标注**（全是 bash）→ 高亮只覆盖带标注的块（没标注的整块保持原样，不会乱上色）。要么写文章时补 ```bash / ```go，要么做一个「按内容猜语言」的启发式（猜错会让代码更乱，倾向不做） | ⏳ |
| ⑭ | 全站重渲后清理旧指纹资源 | 现在 R2 的 `theme/` 下有 1 个 `app.<hash>.js` + 4 个 `style.<hash>.css`。保留 1~2 个版本是对的（§14.2），但需要收尾：比照 `THEME_ASSETS` 列出 `theme/` 下的对象，删掉不在清单里、且已超过「最长 HTML 缓存窗口」的那些 | ⏳ |
| ⑮ | 删光某个月的文章后，月份归档对象会变孤儿 | `postDeleteTargets` 按**快照里的 months** 决定重建谁；某个月一篇不剩时快照里就没有它了，于是那个 `/<year>/<month>/` 对象永久留在 R2 上、内容陈旧（旧实现同样有这个洞，不是改版引入的）。**取舍已定（2026-09-30）：保留空归档页，不 404。** 修法：文章创建月份的 key **无条件**进重建集合（不再看新快照里还有没有这个月），归档渲染要能处理「快照 `months` 里不存在的月份」；该页会自然退出 `/archives/` 清单与 sitemap（那两处由 `months` 驱动），只保证 URL 仍 200、内容为空 | ⏳ |
| ⑪ | 老域名切换演练（**押后**：短时间不会切） | `fengqi.me` → 新站：改 `site_url` → 配 R2 自定义域名 → 全站重渲 → 提交 sitemap；**老站数据库与文件先别删**，保留回滚 | ⏳ |

---

## ⚠️ 协作注意（多 agent 同时改这个仓库）

- 2026-09-30：本仓库同时被 **WorkBuddy** 改动过。提交 `2c8c09b` 由我用 `git add -A` 提交，
  **里面混进了它尚未提交的工作**（主题资源流水线、`overview` 索引页、版式调整、`.workbuddy/memory/`），
  提交信息没描述这些内容 —— 内容没丢，但归因不准。以后提交前先 `git status` 确认范围。
- 同一次改动里 `wrangler types` 漏了 `--env-interface CloudflareBindings`，生成的接口名变成 `Env`，
  导致主分支 typecheck 报 4 个错。已用 `npm run cf-typegen` 修回。
  **改绑定后请一律用 `npm run cf-typegen`，别手敲 `wrangler types`。**
- `.workbuddy/`（agent 的私有记忆目录）**决定纳入版本控制**（2026-09-30）—— 这样换开发环境、
  换机器时记忆不丢。不写进 `.gitignore`。agent 侧也照此办理：笔记写完就随本次改动一起提交。

## 已知取舍与风险（迁移后）

- **62 个 `/attachment/<cid>/` 页面 404** —— 主动豁免（老站这些 URL 是 200）。正文里的图片链接不受影响。
- **2 张图在迁移前就丢了**：`/usr/uploads/2012/02/135359723.png`、`/usr/uploads/2013/02/1324381562.png` —— 老站与本地 `usr/uploads` 里都没有（其中一张还被正文引用），既成事实。
- **作者 byline 链到 `https://fengqi.me`**（老站用户资料 url 字段）。要改：`UPDATE users SET url=...`。
- **`.import/` 含老库敏感内容**（`plugin:CloudflareR2` 的 account_id 等、Typecho `secret`、整份 db 与 `usr/`）。已 gitignore、不会进仓库；**建议第 ⑪ 步切换完成后再删**。
- **PBKDF2 迭代 10 万次**本地约 6~7ms，与免费版 10ms CPU 上限余量不大 —— 见待办 ⑧。
- **R2 缓存口径**（design §7.2）：`.html` 不进 CDN 缓存（发布即生效）；可缓存扩展名的 `max-age` 若小于 4h 会被抬到 14400；主题资源与附件必须打指纹 + `immutable`。
- **主题资源改了必须重跑构建**：`theme/assets/` 改完不跑 `npm run build:assets`，指纹不变、页面仍指向旧文件，样式不会更新 —— 这是 ① 的流水线里最容易忘的一步。
- **索引页只列「有文章」的分类/标签**：库里有一批只挂在草稿上的标签（迁移遗留，线上 76 个：274 个标签里只有 198 个有文章），它们的归档页仍在、也进 sitemap，只是不进 `/categories/`、`/tags/` 的清单（清单不该列空气）。所以那几个页面上写的是「共 N 个（只列有文章的）」。
- **独立页面与导航（2026-09-30 定案）**：顶栏只保留 slug=`about` 的「关于」兜底，**不**自动列出独立页面 —— 导航写死在每个对象的 HTML 里，自动列页面意味着发/删/改一个页面就要全站重渲 ~800 个对象，而免费版单请求 50 个子请求封顶，一次请求根本写不完（生产全量发布实测 16 批 × 50）。其余独立页面没有站内入口，只能直输 URL 或从 sitemap 找。编辑器里已加提示。
- **R2 当前的 `theme/` 下有 5 个对象**（1 个 `app.<hash>.js` + 迭代出的 4 个 `style.<hash>.css`），旧指纹刻意保留 —— 见待办 ⑭。
- **改版前被量出来的一组数字**（2026-09-30，用于判断「要不要优化」）：全站 803 个对象；发一篇文章重建约 28~43 个；删一篇文章修复前 **800 个**、修复后 **约 35 个**；改一次主题样式仍然 **803 个**（指纹变 → 每个页面的 `<link>` 都变，这是不可省的）。

---

## 常用命令（做上面的事时会用到）

```bash
# 主题资源打指纹（改了 theme/assets/ 之后必跑）
npm run build:assets

# 本地端到端断言（真实 workerd + 本地 D1/R2/KV，167 项）
npx wrangler d1 migrations apply blog-db --local
npx wrangler dev -c wrangler.e2e.jsonc --port 8788
curl -s http://127.0.0.1:8788/ | tail -3          # 看到「全部通过」

# 渲染压测（不连数据库）
npm run bench:render

# 本地预览前台（R2 静态页）：起预览器 + 改了模板后重渲本地 R2
npm run preview:r2
npm run rebuild:local                                            # 循环 /__publish 重渲本地 R2（自动到 nextOffset=null）
curl "http://127.0.0.1:8790/__keys"                              # 列对象对账

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
