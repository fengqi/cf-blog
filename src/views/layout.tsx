/**
 * 后台骨架 —— 设计文档 §11 / §0（后台无单独构建链，样式内联）
 *
 * 只 import `hono/jsx`（§11 纪律 1）。
 * ⚠️ STYLE 必须走 dangerouslySetInnerHTML：Hono JSX 会把字符串子节点转义，
 * 而 <style> 是 raw text 元素、浏览器不还原实体 —— 转义后的 &quot; 会让
 * font-family 声明整条失效，正文落回默认衬线字体（看起来像裸 HTML）。
 * STYLE 是本文件写死的常量、不含任何用户内容，这里用它是安全的；
 * 业务视图里仍然不要出现 dangerouslySetInnerHTML。
 *
 * 设计变量（配色/字体/圆角）与前台 `theme/assets/style.css` §1 逐字对齐，
 * 改前台变量时这里跟着改。差别只有两点：后台不做主题切换按钮（暗色跟系统
 * 走），没有代码高亮那组 token 变量。
 */

import type { Child } from 'hono/jsx';

const STYLE = `
:root {
	--bg: #ffffff;
	--bg-soft: #f6f7f9;
	--border: #e4e7eb;
	--border-strong: #d3d8de;
	--text: #1f2328;
	--text-soft: #4a5259;
	--text-muted: #79838d;
	--accent: #1a63c8;
	--accent-hover: #114a99;
	--accent-soft: rgba(26, 99, 200, 0.1);
	--danger: #cf222e;
	--danger-soft: rgba(207, 34, 46, 0.1);
	--font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC",
		"Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", sans-serif;
	--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
		"Liberation Mono", "Courier New", monospace;
	--radius: 8px;
	--radius-sm: 4px;
	color-scheme: light;
}

@media (prefers-color-scheme: dark) {
	:root {
		--bg: #14171b;
		--bg-soft: #1b1f24;
		--border: #2b3138;
		--border-strong: #3a424b;
		--text: #e3e6e9;
		--text-soft: #b6bcc3;
		--text-muted: #8b949e;
		--accent: #6cb0ff;
		--accent-hover: #93c5fd;
		--accent-soft: rgba(108, 176, 255, 0.15);
		--danger: #ff7b72;
		--danger-soft: rgba(255, 123, 114, 0.14);
		color-scheme: dark;
	}
}

* { box-sizing: border-box; }
/* hidden 属性靠 display:none 生效 —— 任何给元素设了 display 的类都会把它盖掉
   （.side-pane 的 display:grid 就中过招：tab 切了，两个面板却同时可见） */
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body {
	margin: 0;
	background: var(--bg);
	color: var(--text);
	font-family: var(--font-sans);
	font-size: 0.9375rem;
	line-height: 1.7;
	-webkit-font-smoothing: antialiased;
}

a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-hover); text-decoration: underline; }

:focus-visible {
	outline: 2px solid var(--accent);
	outline-offset: 2px;
	border-radius: var(--radius-sm);
}

h1 { margin: 0 0 1.25rem; font-size: 1.375rem; line-height: 1.4; font-weight: 700; letter-spacing: -0.01em; }
h2 { margin: 1.75rem 0 0.6rem; font-size: 1.0625rem; font-weight: 650; }

/* --- 页面标题：后台每页第一行都是它（全宽靠左、字号行高一档） ---
   以前各页首元素各不相同（按钮行 / 带内联 margin 的 h2 / form.stack 的 label），
   左右或上下错开，切页时整块内容看着一会儿靠上一会儿靠下。
   现在统一：每个 view 都以 <h1 class="page-head"> 开头，标题同高，
   下面的内容自然就有同一个起点。note 是右侧的辅助信息（条数、页次）。 */
.page-head {
	display: flex;
	align-items: baseline;
	gap: 0.75rem;
	margin: 0 0 1.25rem;
}
.page-head .note {
	margin-left: auto;
	font-size: 0.8125rem;
	font-weight: 400;
	letter-spacing: 0;
	color: var(--text-muted);
	white-space: nowrap;
}

/* --- 页头：内容与 main 的 62rem 容器对齐，宽屏上导航不贴屏幕左边缘 --- */

header.top { border-bottom: 1px solid var(--border); background: var(--bg); }

header.top .top-inner {
	max-width: 82rem;
	margin: 0 auto;
	padding: 0.7rem 1.25rem;
	display: flex;
	gap: 0.35rem 1.1rem;
	align-items: center;
	flex-wrap: wrap;
}

header.top .brand { font-weight: 700; color: var(--text); margin-right: 0.35rem; }
header.top a.brand:hover { color: var(--accent); text-decoration: none; }
header.top a { color: var(--text-soft); }
header.top a:hover { color: var(--accent); text-decoration: none; }
header.top .spacer { flex: 1; }

/* 行内小按钮（退出）：贴着导航文字的尺寸，别压过一行 */
header.top form { margin: 0; }
header.top button {
	padding: 0.1rem 0.55rem;
	font-size: 0.8438rem;
	font-weight: 400;
}

/* --- 主容器 --- */

main { max-width: 82rem; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; }

/* --- 表格 --- */

table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td { text-align: left; padding: 0.55rem 0.6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
th {
	color: var(--text-muted);
	font-size: 0.8125rem;
	font-weight: 600;
	border-bottom-color: var(--border-strong);
	white-space: nowrap;
}
tbody tr:hover td { background: var(--bg-soft); }

/* --- 徽标 / 提示 / 消息 --- */

.badge {
	display: inline-block;
	padding: 0.05rem 0.5rem;
	border-radius: 999px;
	font-size: 0.75rem;
	line-height: 1.7;
	border: 1px solid var(--border-strong);
	color: var(--text-soft);
	background: var(--bg-soft);
	white-space: nowrap;
}
.badge.publish { background: rgba(46, 125, 50, 0.13); border-color: rgba(46, 125, 50, 0.35); color: #2e7d32; }
.badge.draft { background: rgba(128, 128, 128, 0.13); }
.badge.waiting { background: rgba(249, 168, 37, 0.13); border-color: rgba(249, 168, 37, 0.4); }
.badge.dirty { background: var(--danger-soft); border-color: var(--danger); color: var(--danger); }
@media (prefers-color-scheme: dark) {
	.badge.publish { color: #7bc47f; }
}

.hint { font-size: 0.8438rem; color: var(--text-muted); }

.message {
	padding: 0.6rem 0.9rem;
	border-radius: var(--radius-sm);
	border-left: 3px solid #2e7d32;
	background: rgba(46, 125, 50, 0.1);
	margin: 0 0 1rem;
}
.message.error { border-left-color: var(--danger); background: var(--danger-soft); }

/* --- 表单 --- */

/* 窄表单居中：容器加宽到 82rem 后，46rem 的表单贴左很难看（设置/口令/分类创建等） */
form.stack { display: grid; gap: 1rem; max-width: 46rem; margin-inline: auto; }
/* 与窄表单同宽的区块：46rem 的表单下面接一张撑满 82rem 的表，左右不齐 */
.stack-block { max-width: 46rem; margin-inline: auto; }
/* 单元格 padding 会把首/末列往里推 0.6rem，跟上面贴着容器边的输入框对不齐 */
.stack-block table th:first-child,
.stack-block table td:first-child { padding-left: 0; }
.stack-block table th:last-child,
.stack-block table td:last-child { padding-right: 0; }
label { display: block; font-weight: 600; margin-bottom: 0.3rem; }

input[type=text], input[type=password], input[type=datetime-local], input[type=number], textarea, select {
	width: 100%;
	padding: 0.45rem 0.6rem;
	font: inherit;
	color: var(--text);
	background: var(--bg);
	border: 1px solid var(--border-strong);
	border-radius: var(--radius-sm);
	transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
input:hover, textarea:hover, select:hover { border-color: var(--text-muted); }
input:focus, textarea:focus, select:focus {
	outline: none;
	border-color: var(--accent);
	box-shadow: 0 0 0 3px var(--accent-soft);
}
input[readonly] { color: var(--text-muted); background: var(--bg-soft); }
textarea.body { min-height: 24rem; font-family: var(--font-mono); font-size: 0.875rem; line-height: 1.7; }

.row { display: flex; gap: 1rem; flex-wrap: wrap; }
.row > * { flex: 1 1 14rem; }

/* --- 按钮：表单主操作实心，行内/次要操作描边 --- */

button, a.button {
	padding: 0.42rem 0.95rem;
	font: inherit;
	font-weight: 600;
	cursor: pointer;
	text-decoration: none;
	border: 1px solid var(--border-strong);
	border-radius: var(--radius-sm);
	background: var(--bg);
	color: var(--text-soft);
	transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}
button:hover, a.button:hover {
	border-color: var(--accent);
	color: var(--accent);
	text-decoration: none;
}

/* 表单里的主提交（保存/上传/登录/创建/改口令） */
form.stack .actions button[type=submit] {
	background: var(--accent);
	border-color: var(--accent);
	color: #ffffff;
}
form.stack .actions button[type=submit]:hover {
	background: var(--accent-hover);
	border-color: var(--accent-hover);
	color: #ffffff;
}
@media (prefers-color-scheme: dark) {
	form.stack .actions button[type=submit] { color: #0b1c33; }
	form.stack .actions button[type=submit]:hover { color: #0b1c33; }
}

/* 危险操作（删除）：描边带红，hover 才加底色。
   不限定在 .actions 里 —— 媒体库的删除按钮独占一格，没有 .actions 包着 */
button.danger, a.button.danger { border-color: var(--danger); color: var(--danger); }
button.danger:hover, a.button.danger:hover {
	background: var(--danger-soft);
	border-color: var(--danger);
	color: var(--danger);
}

.actions { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
.actions button, .actions a.button { padding: 0.35rem 0.8rem; font-weight: 400; }
/* 表格操作列：列宽被压窄时两枚按钮会换行叠成两行（行高一倍），宽屏下锁死横排。
   手机（<34rem）靠换行压窄，锁横排会让整张表横向溢出 */
@media (min-width: 34rem) {
	td.ops { white-space: nowrap; }
	td.ops .actions { flex-wrap: nowrap; }
}
/* actions 行里的表单是布局单元，不是文档流里的块 —— 否则按钮和文字对不齐 */
.actions form, .filter-bar form { margin: 0; }

/* 列表筛选条：一行排开，窄屏换行 */
.filter-bar {
	display: flex;
	gap: 0.6rem;
	align-items: center;
	flex-wrap: wrap;
	margin: 0 0 1rem;
}
.filter-bar input[type=text] { flex: 1 1 12rem; width: auto; }
.filter-bar select { flex: 0 1 auto; width: auto; }
.filter-bar button, .filter-bar a.button { padding: 0.35rem 0.8rem; font-weight: 400; }

/* 渲染维护页：两块独立操作 */
.render-block {
	margin: 0 auto 1.25rem;
	max-width: 46rem;
}
.render-block h2 { margin-top: 0; }
.render-block .actions { margin-top: 0.75rem; }
.badge.dirty:hover { text-decoration: none; filter: brightness(1.1); }

/* 分组独立渲染的一排小按钮 */
.group-buttons { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.6rem; }
.group-buttons button { padding: 0.25rem 0.7rem; font-size: 0.8438rem; font-weight: 400; }

/* 列表分页条 */
.admin-pagination {
	display: flex;
	gap: 1rem;
	align-items: center;
	justify-content: center;
	margin-top: 1.5rem;
}
.admin-pagination .button[aria-disabled='true'] { opacity: 0.45; pointer-events: none; }

/* --- 登录页 --- */

.login {
	max-width: 22rem;
	margin: 12vh auto;
	padding: 1.75rem 1.5rem 1.5rem;
	border: 1px solid var(--border);
	border-radius: var(--radius);
}
.login h1 { font-size: 1.1875rem; margin-bottom: 0.5rem; }

/* --- 文章编辑器（仿 Typecho write-post：左内容 / 右「选项 + 附件」） --- */

/* 两栏：左写内容，右是选项与附件。窄屏（<64rem）堆成一栏 */
.editor-grid {
	display: grid;
	grid-template-columns: minmax(0, 1fr) 20rem;
	gap: 1.5rem;
	align-items: start;
}
.editor-main { display: grid; gap: 1rem; min-width: 0; }
@media (max-width: 64rem) {
	.editor-grid { grid-template-columns: minmax(0, 1fr); }
}

/* 右栏：跟着页面滚（正文很长时不用来回翻），自身超高时内部滚动 */
.editor-side {
	position: sticky;
	top: 1rem;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	background: var(--bg);
	overflow: hidden;
}
.side-tabs { display: flex; border-bottom: 1px solid var(--border); }
.side-tabs button {
	flex: 1;
	border: 0;
	border-radius: 0;
	border-bottom: 2px solid transparent;
	background: var(--bg-soft);
	padding: 0.45rem 0.5rem;
	text-align: center;
}
.side-tabs button.active {
	background: var(--bg);
	border-bottom-color: var(--accent);
	color: var(--accent);
}
.side-tabs .balloon {
	display: inline-block;
	margin-left: 0.25rem;
	padding: 0 0.35rem;
	border-radius: 999px;
	background: var(--accent-soft);
	color: var(--accent);
	font-size: 0.75rem;
}

.side-pane { padding: 0.9rem 1rem; display: grid; gap: 0.9rem; }
.side-field > label:first-child { margin-bottom: 0.3rem; }
.side-field .hint { margin: 0.3rem 0 0; }
/* 左栏底部的操作行（保存/预览/返回）：主提交实心。
   上面 form.stack 那条规则管不到这里（编辑器的 form 是 editor-grid），所以补一条 */
.editor-main .actions {
	justify-content: flex-end;
	padding-top: 1rem;
	border-top: 1px solid var(--border);
}
.editor-main .actions button[type=submit] {
	background: var(--accent);
	border-color: var(--accent);
	color: #ffffff;
}
.editor-main .actions button[type=submit]:hover {
	background: var(--accent-hover);
	border-color: var(--accent-hover);
	color: #ffffff;
}
@media (prefers-color-scheme: dark) {
	.editor-main .actions button[type=submit] { color: #0b1c33; }
	.editor-main .actions button[type=submit]:hover { color: #0b1c33; }
}

/* 附件 tab：上传区 + 文件列表（点文件名插入，点删除删附件） */
.upload-area {
	display: flex;
	gap: 0.5rem;
	align-items: center;
	justify-content: center;
	padding: 0.9rem 0.6rem;
	border: 1px dashed var(--border-strong);
	border-radius: var(--radius-sm);
	background: var(--bg-soft);
}
.upload-area.drag { border-color: var(--accent); background: var(--accent-soft); }

.file-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.35rem; }
.file-list li {
	display: flex;
	gap: 0.5rem;
	align-items: baseline;
	font-size: 0.875rem;
}
.file-list .insert { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.file-list .info { color: var(--text-muted); font-size: 0.8125rem; white-space: nowrap; }
.file-list .delete {
	padding: 0 0.4rem;
	font-size: 0.75rem;
	font-weight: 400;
	color: var(--danger);
	border-color: var(--border);
}
.file-list .delete:hover { border-color: var(--danger); background: var(--danger-soft); color: var(--danger); }
.file-list li.loading { color: var(--text-muted); }
.file-list li.error { color: var(--danger); font-size: 0.8125rem; }

.editor-tabs { display: flex; gap: 0.4rem; align-items: center; margin-bottom: 0.55rem; }
.editor-tabs button { padding: 0.18rem 0.85rem; font-weight: 400; }
.editor-tabs button.active {
	border-color: var(--accent);
	color: var(--accent);
	background: var(--accent-soft);
}
.editor-tabs .status { margin-left: auto; font-size: 0.8125rem; color: var(--text-muted); }

.editor-toolbar { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-bottom: 0.55rem; }
.editor-toolbar button { padding: 0.15rem 0.55rem; font-weight: 400; font-size: 0.8438rem; }

/* 预览面板：服务端用发布同款渲染器出 HTML 片段，这里只负责读感（代码/引用/图片宽度） */
.md-preview {
	border: 1px solid var(--border-strong);
	border-radius: var(--radius-sm);
	padding: 0.9rem 1.15rem;
	min-height: 24rem;
	overflow-wrap: break-word;
}
.md-preview > *:first-child { margin-top: 0; }
.md-preview h1, .md-preview h2, .md-preview h3, .md-preview h4 { margin: 1.3rem 0 0.45rem; line-height: 1.4; }
.md-preview h1 { font-size: 1.25rem; }
.md-preview h2 { font-size: 1.1rem; }
.md-preview h3 { font-size: 1rem; }
.md-preview p { margin: 0.65rem 0; }
.md-preview img { max-width: 100%; height: auto; }
.md-preview code {
	font-family: var(--font-mono);
	font-size: 0.85em;
	background: var(--bg-soft);
	border-radius: 3px;
	padding: 0.1em 0.3em;
}
.md-preview pre {
	background: var(--bg-soft);
	border: 1px solid var(--border);
	border-radius: var(--radius-sm);
	padding: 0.75rem 0.95rem;
	overflow: auto;
}
.md-preview pre code { padding: 0; background: none; }
.md-preview blockquote {
	margin: 0.8rem 0;
	padding: 0.1rem 0.9rem;
	border-left: 3px solid var(--border-strong);
	color: var(--text-soft);
}
.md-preview ul, .md-preview ol { margin: 0.65rem 0; padding-left: 1.5rem; }
.md-preview hr { border: 0; border-top: 1px solid var(--border-strong); margin: 1.4rem 0; }
.md-preview table { margin: 0.8rem 0; }

@media (prefers-reduced-motion: reduce) {
	* { transition: none !important; }
}
`;

export interface AdminLayoutProps {
	title: string;
	user?: { screen_name: string | null; username: string } | null;
	message?: string;
	error?: string;
	children: Child;
}

export function AdminLayout(props: AdminLayoutProps) {
	return (
		<html lang="zh-CN">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="robots" content="noindex" />
				<title>{props.title}</title>
				<style dangerouslySetInnerHTML={{ __html: STYLE }} />
			</head>
			<body>
				{props.user ? (
					<header class="top">
						<div class="top-inner">
							<a class="brand" href="/admin">博客后台</a>
							<a href="/admin">文章</a>
							<a href="/admin/media">媒体</a>
							<a href="/admin/categories">分类</a>
							<a href="/admin/settings">设置</a>
							<a href="/admin/password">口令</a>
							<a href="/admin/render">渲染</a>
							<span class="spacer" />
							<a href="/admin/front" target="_blank">前台 ↗</a>
							<form method="post" action="/admin/logout">
								<button type="submit">退出</button>
							</form>
						</div>
					</header>
				) : null}
				<main>
					{props.message ? <p class="message">{props.message}</p> : null}
					{props.error ? <p class="message error">{props.error}</p> : null}
					{props.children}
				</main>
			</body>
		</html>
	);
}

/** 只渲染登录页（没有导航） */
export function PlainLayout(props: { title: string; children: Child }) {
	return (
		<html lang="zh-CN">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="robots" content="noindex" />
				<title>{props.title}</title>
				<style dangerouslySetInnerHTML={{ __html: STYLE }} />
			</head>
			<body>
				<main>{props.children}</main>
			</body>
		</html>
	);
}
