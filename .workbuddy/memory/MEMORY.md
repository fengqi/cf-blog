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
- **容器宽度全站一档 44rem**（`layout.ts` 的 `width` → body 类；所有页面都传 `narrow`，
  `theme/post.ts` 也不例外）。页头 / 页脚 / 正文 / 列表共用同一个容器，任意两页的左边缘、
  右边缘、正文宽度**完全重合**（实测 1280px 下都是 `x=288 w=704`，正文列 `x=308 w=664`）。
  - 演进史（两轮踩坑）：① 最初 `post.ts` **恒给 `width: 'post'`**，`/about.html` 顶着 62rem
    外壳（正文缩中间、页头宽 288px）；② 改成按 `toc.length` 给档，`/about.html` 对上了但
    文章页仍是另一档、页头仍不齐；③ **62rem 那档整个废掉** —— 目录浮到容器右边的留白里，
    不再靠撑宽容器腾位置。`LayoutWidth` 现在只有 `'default' | 'narrow'`。
  - 教训：容器宽度一旦和「页面有几列」耦合，就会长出第二种宽度、永远对不齐。**宽度只跟可读性有关。**
- **文章目录在服务端生成**（`theme/toc.ts`）：渲染时抽 h2/h3、生成锚点 id 并写回正文。
  HTML 里故意出现两份（`<aside class="post-toc">` + `<details class="post-toc-inline">`），
  CSS 按 **76rem** 二选一 —— `<details>` 的展开由 `open` 属性控制，CSS 盖不住，所以不合并。
  - ≥76rem：`.post-toc` 是 **`position: fixed`**，浮在容器右边留白里
    （`top: 2.5rem`、`left: calc(50% + 23rem)`、宽 14rem、超高自己滚）。断点是算的：
    `50% + 23rem + 14rem ≤ 100%` → ≥74rem，留 2rem 余量。
  - 用 `fixed` 不用 `sticky`，因为 sticky 要求元素在文档流里 → 必须占一列 → 容器必须变宽。
  - ⚠️ **`offsetParent` 在 `position: fixed` 元素上恒为 `null`。** `app.js` 原本用它判目录显隐，
    目录改 fixed 后**宽屏下滚动高亮被静默关掉**（不报错、目录照常显示可点，只是永远不亮）。
    已改用 `tocBox.getClientRects().length > 0`。**改任何「元素可见性」判断前先想起这条。**
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
npx wrangler d1 migrations apply blog-db --local --persist-to .wrangler/e2e-state
npx wrangler dev -c wrangler.e2e.jsonc --port 8788 --persist-to .wrangler/e2e-state   # 另开终端
curl -s http://127.0.0.1:8788/ | grep '=== 结果'      # 「全部通过」= 142 项
```

⚠️⚠️ **e2e 会清空本地 D1 和整个 R2**（`e2e-runner.ts` 开头 `DELETE FROM contents/metas/
relationships/permalink_history` + `BUCKET.list()` 后全删）。本地 D1/R2 与 `preview:r2`
预览**共用**（所有 wrangler 配置同一个 `database_id`），所以：
**在导入过真实内容的本地状态上裸跑 e2e = 把真内容和 803 个渲染对象全删掉。**
跑 e2e 一律加 **`--persist-to .wrangler/e2e-state`**（单独一套 state）。`.wrangler/` 已在
`.gitignore` 里。只有「想看 fixture 界面」时才在共享 state 上跑，跑完要重新导入 + 重渲。

⚠️ **汇总行不在末尾**：报告最后还会附 `---FEED---` 和 `---SITEMAP---` 两段 XML，`tail` 只会看到
`</urlset>`。要判成败就 `grep '=== 结果'`，或者数 `✓` / `✗`（当前基线：142 ✓ / 0 ✗）。
HTTP 状态也是信号：有失败时 worker 返回 500。

生产（**会改线上**）：

```bash
npm run build:assets                                  # 必需：改了 theme/assets/ 之后
npx wrangler dev -c wrangler.publish.jsonc --remote --port 8799
# 循环 GET /full?offset=N&limit=50 到 nextOffset=null；GET /keys 对账
```

- ⚠️ **`/full` 必须从 `offset=0` 跑完整轮。** 只跑中间几批会同时造成两个线上事故
  （2026-09-30 实际发生过）：
  1. **资源目标排在 index 0**，跳过第 0 批 → 新渲出来的页面引用一个从未上传的指纹 →
     页面**完全无样式无 JS**；
  2. 跑一半 → 线上**新旧主题混着**（列表页新、文章页旧）。
  自查方法：`curl -sI https://blog.fengqi.me/<页面>` 比 `last-modified` 是否同批；
  `curl -s https://blog.fengqi.me/ | grep -oE 'theme/[^"]+'` 拿到的指纹，
  必须能在桶里取到 200（用 `preview:r2 --remote` 的 `/__keys` 对）。
- 注意：`--remote` 跑的是**上传上去的那份代码**，改了代码/资源必须重启 dev 进程再重渲。
- 线上基线：**805 个渲染对象**（2026-09-30 改版后）+ 67 个附件；另有迭代留下的旧指纹 CSS
  （`theme/` 下同时存在 4 个对象是正常的，见 ⑭）。

## 本地环境：e2e fixture ↔ 真实内容（`.import/`）

本地 D1/R2 平时装的是 **e2e fixture**（14 contents / 4 metas / 33 个对象）。跑一次 e2e 就会
把它重建成那个样子 —— 所以「本地预览全是假文章」是常态，不是坏了。想看真实内容要把
`.import/` 导进来，**六步，顺序不能乱**：

```bash
# ⚠️ 第 0 步最重要：先把所有 wrangler dev 停掉（preview:r2 / e2e 都算）
# 1) 备份 .wrangler/state/v3/{d1,r2}
# 2) 清 fixture，**保留 users**（管理员 PBKDF2 口令不能丢）
#    逐条 DELETE，别塞进一个 --command
# 3) tsx scripts/import-typecho.ts --db .import/TnJehpNtTuc.db --apply local   （约 4 分钟，后台跑）
# 4) 重渲进 R2：**用 preview:r2 的 /__publish，别再起 e2e worker**
#    curl "http://127.0.0.1:8790/__publish?confirm=local&offset=N&limit=200"
#    循环到 nextOffset=null（803 个对象 = 5 批：0/200/400/600/800，约 10 秒）
# 5) 补附件：**并发**跑 wrangler r2 object put，只传缺的（串行版要 25 分钟，见下）
```

三条硬规则：

1. ⛔ **`wrangler dev` 运行期间，外面用 `wrangler d1 execute --local` 改本地库会被冲掉。**
   实测：`DELETE FROM metas` 后连查三次都是 0，紧接着脚本自己读目标库却读到 3 行 —— 它因此走了
   「复用已有 mid」的分支。**动本地 D1 前必须停掉所有 dev 进程。**
2. **`import-typecho.ts` 只写 D1，不碰 R2。** 导完必须重渲（第 4 步），否则预览还是旧内容 ——
   这是风息说「import 不管用」的主因。
3. **导出/上传一律「只处理缺的」**：拿 `preview:r2` 的 `/__keys` 和线上清单（或 `--remote` 的
   `/__keys`）做差集。`upload-attachments.ts` 串行 spawn wrangler，67 个文件要 **25 分钟以上**，
   而且会重传已有的；并发 6 只补缺的，31 个文件约 9 分钟。

**真实内容导完后的验收数字**（应与线上一致）：contents 227（111 posts / 5 pages / 62 attachments）、
metas 281（7 分类 + 274 标签）、relationships 529、permalink_history 2、users 1、R2 **803** 个对象。
本地与线上逐 key 比，**只应差 theme 指纹**（本地是新构建）。附件的 content-type 要抽查
（`image/png` / `image/jpeg`）。

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

**本地预览一律走 `npm run preview:r2`**（http://127.0.0.1:8790，风息 17:10 收进仓库的
`scripts/preview-worker.ts` + `wrangler.preview.jsonc`）：它按真实 R2 规则把路径映射成 key 取对象，
`/theme/style.<hash>.css`、附件、相对链接全都能正常加载，比导到 `/tmp` 再起 `http.server` 干净得多。

```bash
npm run preview:r2                                               # 预览本地 R2（8790）
npx wrangler dev -c wrangler.preview.jsonc --remote --port 8791  # 只读线上桶（换个口，别抢 8790）
curl "http://127.0.0.1:8790/__keys"                              # 列对象对账
curl "http://127.0.0.1:8790/__publish?confirm=local&offset=0&limit=200"   # 重渲本地 R2：循环到 nextOffset=null
```

- ⛔ **`--remote` 模式下绝对不要碰 `/__publish`** —— 那时绑定指向线上桶，会写生产。
- 它和 `wrangler.e2e.jsonc` **共用同一个本地 R2**（`.wrangler/state/v3/r2`），所以 e2e 跑完
  预览看到的是 fixture 终态。注意 **e2e 末尾有 `deletePost`，会删掉 fixture 里带 h2/h3 的那篇** ——
  跑完 e2e 后本地预览里没有「有目录的文章」了，要验目录版式得先 `/__publish` 另想别的样本。
- **别再用我原先那套**（`wrangler r2 object get` 导到 `/tmp/cfsite` + `python3 -m http.server`）：
  `/tmp` 重启会清、导出还要一次只导 2~3 个 key（`npx wrangler` 一次导多个会被 SIGKILL）。
- 端口：生产 `--remote` 用 8799，`preview:r2` 用 8790，e2e 用 8788。**起之前先
  `lsof -nP -iTCP:<口> -sTCP:LISTEN` 看占没占**（风息的预览实例可能正跑着）。
  沙箱里 `ps` 被禁（`operation not permitted`）；`curl` 打关闭端口可能返回 **502** 而不是拒连，
  **不能用 curl 判断本机端口死活**。

**必须量数字，不能只截图。** 2026-09-30 又栽了一次：`.post-body` 上写了 `max-width: 42rem;
margin-inline: auto;` —— CSS Grid 里 grid item 带 `auto` 外边距会放弃 stretch、退化成「内容宽度」，
42rem 的正文列实际只有 340px，而 `computedStyle` 里的 `max-width` 依然是 `672px`。
**只有 `getBoundingClientRect()` 能发现。**

### 本地验收怎么把 R2 对象拿出来看

用 `preview:r2` 的 `/__keys`（见上）列对象、直接按路径 curl/Chrome 打开即可，
**不用再手动导出**。只有在要看线上桶时才用 `--remote` 模式。

## 环境坑

- **Bash 工具的 `grep` 对多字节 / 多模式几乎不可靠**（2026-09-30 又栽了一次：
  `grep -n "layout-post\|about"` 在 `scripts/e2e-runner.ts` 上返回空，换成内置的
  Grep 工具立刻找到 5 处）。**查代码一律用 Grep 工具，不要用 bash `grep`/`rg`。**
- `wrangler dev` 偶发 esbuild `The service is no longer running` 启动失败，重试即可。
- 端口被占时 `wrangler dev` 会抛 `Fatal uncaught kj::Exception: bind(): Address already in use`，
  报错栈很难看但意思就是端口占用 —— 换口。
