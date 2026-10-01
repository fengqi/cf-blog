# cf-blog 项目长期笔记

Cloudflare Workers 静态直出博客：前台 R2 直出（零 Worker 请求），后台一个 Worker。
设计依据 `docs/design.md`，命令 `README.md`。详见按日日志。

## 动手前必读

1. **主题资源是带指纹、immutable 的 R2 对象。** 改 `theme/assets/` 后必须 `npm run build:assets` → 全站重渲；本地 build 后**等一两秒**让 dev 重载 bundle 再调 `/__publish`，否则重渲引用旧指纹（`curl / | grep -o 'theme/[^"]*'` 才能发现）。旧指纹别急着删；模板改了也要全站重渲。
2. ⚠️ **风息会在我干活时同时改/提交**（`git add -A` 卷走过我的未提交工作；e2e 编译过他改到一半的文件）。动手前 `git status` + `git log -3`；e2e 出现无关失败先 `git diff` 分清归属。
3. **`.workbuddy/` 是入库的**：笔记写完随改动一起提交，别留脏文件。

## 主题层（`theme/`）

- 零依赖（不 import npm、不碰 D1/R2/Hono）。css/js 参与构建**只能**走 `build-assets.ts` 生成 TS 字面量。
- 全站零侧栏，导航只在顶栏；清单页 `/categories/`（list）、`/tags/`（flow）、`/archives/`（按年分组）。
- 容器宽度全站一档，唯一开关 `--container-size`（50rem ≈ 44 汉字/行）：正文宽度只由「一行几个字舒服」决定。
- 文章目录服务端生成（`theme/toc.ts`），HTML 两份（aside + details），CSS 按 80rem 二选一；≥80rem 时目录溢出到右侧留白，`sticky; top: 2rem`。⚠️ 不用 `fixed`（压页头分割线）；断点要手算；判目录显隐用 `getClientRects().length`。
- 索引清单只列 `count > 0` 的分类/标签（274 标签中 76 个只挂草稿）。

## 发布流水线（`src/publish/`）

- `siteTargets()` 主题资源排最前（按下标切片，第一批必须带样式）；`postPublishTargets` 不含资源。
- 删除走 `postDeleteTargets`（约 35 个对象，不是全站）；术语用**删除后新快照**重解析。
- 生产重渲：`wrangler dev -c wrangler.publish.jsonc --remote --port 8799`，`/full` **必须从 offset=0 跑完整轮**（跳过第 0 批 → 页面无样式；跑一半 → 新旧混线）。线上基线 805 渲染对象 + 67 附件。

## e2e 与本地环境

- **e2e 会清空本地 D1 和整个 R2** —— 必须加 `--persist-to .wrangler/e2e-state`。判成败 `grep '=== 结果'`（汇总行不在末尾）；基线 243 ✓ / 0 ✗。有失败时 worker 返回 500。⚠️ **先单独跑 typecheck 再起 worker**：构建失败时 wrangler 会退回上一份 bundle，curl 拿到旧断言还显示"全部通过"。
- e2e worker 对**任何路径**都跑套件（`/admin/login` 返回的也是报告），浏览器没法登录 8788。
- 本地平时是 e2e fixture（假文章是常态）。导真实内容六步见 2026-09-30 日志；⚠️ dev 运行时外面 `d1 execute --local` 改库会被冲掉；import 只写 D1 不碰 R2，导完必须重渲；上传只补缺的。
- 端口：e2e 8788、preview:r2 8790、生产 remote 8799，起之前 `lsof -nP -iTCP:<口> -sTCP:LISTEN` 查占用；沙箱禁 `ps`。本地预览一律 `npm run preview:r2`；⛔ `--remote` 绝不碰 `/__publish`（写生产）。

## 后台（admin）版式与量法

- 后台样式内联在 `views/layout.tsx` 的 STYLE（TS 模板字符串）。坑：① 全局已有 `[hidden] { display:none !important }`（display 类会盖 hidden 属性）；② **CSS 注释里不能有反引号**（截断模板字符串，已踩两次）。
- 量版式：`npx tsx` 直接调 view 函数（当普通函数调，别写 JSX）写 `/tmp`，headless Chrome 开 `file://`；**必须量 `getBoundingClientRect()`**。playwright-core 在托管工作区 node_modules，脚本放那个目录跑（ESM 不读 NODE_PATH），用完删。
- main/页头容器 82rem；窄表单 `form.stack` 和 `.render-block` 46rem **居中**。媒体库**只有列表**（上传唯一入口是编辑器「附件」tab，`POST /admin/media` 已删）：列 = 文件 / 类型大小 / 时间 / 所属文章 / 删除（`/admin/media/delete` 表单 303，与编辑器 JSON 端点共用 `removeAttachment`）；每页 10 条。
- ⚠️ 后台 CSS 里 `.danger` 是**全局** `button.danger`（曾挂在 `.actions` 下，导致没包 .actions 的按钮不变红）。
- 编辑器仿 Typecho 左右栏：左内容+底部靠右按钮，右「选项/附件」tab。图片插入写**完整地址**，域名取 `options.static_url`（可空，回落 site_url）；该域名需能取同一桶 `/usr/uploads/...`。⚠️ `mdUrl()` 空格转 %20；存量 227 篇仍是相对路径。
- **整页预览 `/preview/:cid` 返回前台同款 HTML**（`renderPreview` → `renderTarget`），根相对路径 `/usr/*`、`/theme/*` 在后台域都必须有路由（都在 `routes/attachment.ts`，都要登录）；少哪条预览就少哪部分。主题带指纹 → immutable 长缓存。

## 环境坑

- **查代码用 Grep 工具**（bash grep 对多字节不可靠）。
- `wrangler dev` 偶发 esbuild "service is no longer running" → 重试；端口占用报 `bind()` → 换口。
