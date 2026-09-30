# cf-blog 项目长期笔记

基于 Cloudflare Workers 的静态直出博客。前台 R2 直出（零 Worker 请求），后台一个 Worker。
设计依据 `docs/design.md`，进度看板 `docs/todo.md`，命令 `README.md`。

## 改东西前必读的三条

1. **主题资源是带指纹、`immutable` 的 R2 对象。** 改了 `theme/assets/` 下的文件：
   `npm run build:assets`（算新 hash）→ 生产全站重渲（HTML 里的 `<link>` 要跟着变）。
   少任何一步都会「改了不生效」，而且因为 `immutable` 老浏览器会一直吃旧文件。
2. **旧指纹对象不要立刻删**（design §14.2）。边缘/浏览器可能还握着旧 HTML。
3. **模板改了也要全站重渲**，否则前台还是旧结构。

## 主题层（`theme/`）

- 零依赖：不 import 任何 npm 包，不碰 D1/R2/Hono —— 要在发布流水线里裸跑。
  想让 `.css`/`.js` 参与构建，**不能**用 wrangler 的 Text module rules（只有 workerd 那一路生效，
  `tsx scripts/*.ts` 会炸），必须走 `build-assets.ts` 生成 TS 字面量。
- `theme/html.ts` 放转义与日期格式化，独立成模块是为了打断 layout ↔ sidebar 的循环依赖。
- 侧栏的顺序与限高是**按真实数据量出来的**，别随手调：本库 198 个标签、58 个月份，
  全铺开会把侧栏撑到 2163px。长列表走 `.sidebar-scroll`，标签云排最后。
- 侧栏只列 `count > 0` 的分类/标签：有 76 个标签只挂在草稿上，归档页存在但作为导航是空页面。

## 发布流水线（`src/publish/`）

- `siteTargets()` 里主题资源排**最前**，因为 `rebuildTargetsSlice` 按下标切片 ——
  只跑第一批也必须带上样式。`postPublishTargets` 不含资源（不为发一篇文章重写 immutable 对象，e2e 有断言）。
- 快照查询固定 7 次，与文章数无关。`renderTargets` 只算一次侧栏再往下传。

## 验收方式（每次改完都跑）

```bash
npm run typecheck && npm run build:assets
npx wrangler d1 migrations apply blog-db --local
npx wrangler dev -c wrangler.e2e.jsonc --port 8788   # 另开终端
curl -s http://127.0.0.1:8788/ | tail -3             # 「全部通过」= 121 项
```

生产（**会改线上**）：

```bash
npx wrangler dev -c wrangler.publish.jsonc --remote --port 8799
# 循环 GET /full?offset=N&limit=50 到 nextOffset=null；GET /keys 对账
```

- 注意：`--remote` 跑的是**上传上去的那份代码**，改了代码/资源必须重启 dev 进程再重渲。
- 线上基线：800 个渲染对象 + 67 个附件 = 867（另有迭代留下的旧指纹 CSS）。

## 无头浏览器视觉验收（本机可用）

`playwright-core` 装在托管工作区（不在项目 node_modules），浏览器直接用系统 Chrome：

```js
import { chromium } from '/Users/liaoyongfa/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
```

`newContext({ colorScheme: 'dark' })` 可以模拟暗色偏好；`page.evaluate(getComputedStyle…)` 能量真实尺寸
（标签云 1071px 那个问题就是这么量出来的，靠肉眼看截图看不出来）。

## 环境坑

- 本会话的 `grep` 对多字节模式不可靠（`grep -c '✓'` 正常，`grep "中文\|x"` 会返回空），
  验证脚本尽量用 Node 写，别堆 shell 管道。
- `wrangler dev` 偶发 esbuild `The service is no longer running` 启动失败，重试即可。
