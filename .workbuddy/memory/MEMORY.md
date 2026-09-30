# cf-blog 项目长期笔记

基于 Cloudflare Workers 的静态直出博客。前台 R2 直出（零 Worker 请求），后台一个 Worker。
设计依据 `docs/design.md`，进度看板 `docs/todo.md`，命令 `README.md`。

## 改东西前必读的三条

1. **主题资源是带指纹、`immutable` 的 R2 对象。** 改了 `theme/assets/` 下的文件：
   `npm run build:assets`（算新 hash）→ 生产全站重渲（HTML 里的 `<link>` 要跟着变）。
   少任何一步都会「改了不生效」，而且因为 `immutable` 老浏览器会一直吃旧文件。
2. **旧指纹对象不要立刻删**（design §14.2）。边缘/浏览器可能还握着旧 HTML。
3. **模板改了也要全站重渲**，否则前台还是旧结构。
4. ⚠️ **这个仓库会被风息在我干活的同时提交。** 2026-09-30 他一次 `git add -A`（`2c8c09b`）
   把我 12 分钟前落盘、尚未提交的工作全卷进了他那条讲 `.dev.vars` 的提交里 ——
   内容没丢，但归因不准，而且我下次 `git status` 时会看到"干净"的假象。
   **动手前先 `git status` + `git log -3` 对一下，别假定工作区里只有自己的改动。**
5. **`.workbuddy/` 是入库的**（2026-09-30 风息决定：换开发环境时记忆不丢，不写 `.gitignore`）。
   所以**笔记写完要随本次改动一起提交**，别留在工作区当脏文件 —— 否则他下次 `git add -A`
   会再扫走一次（已经发生过两次）。

## 主题层（`theme/`）

- 零依赖：不 import 任何 npm 包，不碰 D1/R2/Hono —— 要在发布流水线里裸跑。
  想让 `.css`/`.js` 参与构建，**不能**用 wrangler 的 Text module rules（只有 workerd 那一路生效，
  `tsx scripts/*.ts` 会炸），必须走 `build-assets.ts` 生成 TS 字面量。
- `theme/html.ts` 放转义与日期格式化（纯函数模块，谁都能引）。
- **全站零侧栏**（2026-09-30 改版）：导航只在顶栏，`首页 / 分类 / 标签 / 归档 / 关于`，
  不做下拉；清单落在 `/categories/`、`/tags/`、`/archives/`（新增 URL）。
  动机是一致性：侧栏里的计数/最新文章是**全局可变数据**，挂在文章页上会让「发一篇」理论上失效 765 个页面。
  `theme/components/sidebar.ts` 已删除。
- **容器宽度分档**（`layout.ts` 的 `width` → body 类）：`.layout-narrow` 44rem（列表类页面）、
  `.layout-post` 62rem（文章页）。去掉侧栏后按 1080px 排，中文一行能塞六十多个字。
- **文章目录在服务端生成**（`theme/toc.ts`）：渲染时抽 h2/h3、生成锚点 id 并写回正文。
  HTML 里故意出现两份（宽屏 `<aside>` + 窄屏 `<details>`），CSS 按 62rem 二选一 ——
  `<details>` 的展开由 `open` 属性控制，CSS 盖不住，所以不合并。滚动高亮在 `app.js`。
- 索引清单只列 `count > 0` 的分类/标签：274 个标签里只有 198 个有文章，
  剩下 76 个只挂在草稿上（归档页存在，但列进清单就是空页面）。

## 发布流水线（`src/publish/`）

- `siteTargets()` 里主题资源排**最前**，因为 `rebuildTargetsSlice` 按下标切片 ——
  只跑第一批也必须带上样式。`postPublishTargets` 不含资源（不为发一篇文章重写 immutable 对象，e2e 有断言）。
- 快照查询固定 7 次，与文章数无关。`renderTargets` 只算一次顶栏导航再往下传。
- **删除也要按影响面重建**（`postDeleteTargets`）：曾经直接调 `siteTargets()`，删一篇文章重写全站
  800 个对象，其中 700 多个无关。现在约 35 个（首页+分页、3 个索引页、该文章的分类/标签归档、月份、feed、sitemap）。
  ⚠️ 术语必须用**删除后的新快照**重新解析（旧 record 的 `count` 是删除前的，按它算分页会多一页）。
  已知边界：删光某个月之后，那个月份对象会变孤儿留在 R2（todo ⑮）。

## 验收方式（每次改完都跑）

```bash
npm run typecheck && npm run build:assets
npx wrangler d1 migrations apply blog-db --local
npx wrangler dev -c wrangler.e2e.jsonc --port 8788   # 另开终端
curl -s http://127.0.0.1:8788/ | tail -3             # 「全部通过」= 139 项
```

生产（**会改线上**）：

```bash
npx wrangler dev -c wrangler.publish.jsonc --remote --port 8799
# 循环 GET /full?offset=N&limit=50 到 nextOffset=null；GET /keys 对账
```

- 注意：`--remote` 跑的是**上传上去的那份代码**，改了代码/资源必须重启 dev 进程再重渲。
- 线上基线：**803 个渲染对象**（2026-09-30 改版后，比之前 +3 个索引页）+ 67 个附件（另有迭代留下的旧指纹 CSS）。

## 无头浏览器视觉验收（本机可用）

`playwright-core` 装在托管工作区（不在项目 node_modules），浏览器直接用系统 Chrome：

```js
import { chromium } from '/Users/liaoyongfa/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
```

`newContext({ colorScheme: 'dark' })` 可以模拟暗色偏好；`page.evaluate(getComputedStyle…)` 能量真实尺寸
（标签云 1071px 那个问题就是这么量出来的，靠肉眼看截图看不出来）。

**驱动方式用上面那行绝对路径 import，或把脚本写进
`/Users/liaoyongfa/.workbuddy/binaries/node/workspace/` 再跑（用完删掉）。**
别用 `NODE_PATH=... node /tmp/x.mjs` 配裸 import —— **node 的 ESM 解析器不读 `NODE_PATH`**，
只会按脚本所在目录往上找 `node_modules`，放 `/tmp` 必然报
`ERR_MODULE_NOT_FOUND: Cannot find package 'playwright-core'`。

**`nohup python3 -m http.server &` 起在 Bash 工具里的服务会随工具调用结束被连带杀掉**
（`curl` 当场 200，下一次工具调用就 `ERR_CONNECTION_REFUSED`）。
静态验收服务用工具的 `run_in_background: true` 起，`TaskStop` 关。
**端口别再用 8799** —— 那是生产 `wrangler dev --remote` 的口，本地静态预览换个号。
查端口用 `lsof -nP -iTCP:<端口> -sTCP:LISTEN`：沙箱里 `ps` 被禁（`operation not permitted`），
而 `curl` 打关闭端口可能返回 **502** 而不是拒连，**不能用 curl 判断本机端口死活**。

**必须量数字，不能只截图。** 2026-09-30 又栽了一次：`.post-body` 上写了 `max-width: 42rem;
margin-inline: auto;` —— CSS Grid 里 grid item 带 `auto` 外边距会放弃 stretch、退化成「内容宽度」，
42rem 的正文列实际只有 340px，而 `computedStyle` 里的 `max-width` 依然是 `672px`。
**只有 `getBoundingClientRect()` 能发现。**

### 本地验收怎么把 R2 对象拿出来看

`wrangler dev -c wrangler.e2e.jsonc` 跑出来的对象存在 `.wrangler/state/v3/r2/`，用
`node_modules/.bin/wrangler r2 object get blog-content/<key> --local --file=...` 导出
（空 key 的首页写成 `"blog-content/"`）。导完把 `theme/<指纹文件名>` 一起落盘，
用 `python3 -m http.server` 起个静态服务，就能让 Chrome 打开真实渲染结果。
**别用 `npx wrangler`，一次导出多个 key 时会被杀（试过，跑到第 5 个就 SIGKILL）** ——
用 `node_modules/.bin/wrangler` 并且一次只导 2~3 个。

## 环境坑

- 本会话的 `grep` 对多字节模式不可靠（`grep -c '✓'` 正常，`grep "中文\|x"` 会返回空），
  验证脚本尽量用 Node 写，别堆 shell 管道。
- `wrangler dev` 偶发 esbuild `The service is no longer running` 启动失败，重试即可。
