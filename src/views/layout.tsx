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

/* --- 页头：内容与 main 的 62rem 容器对齐，宽屏上导航不贴屏幕左边缘 --- */

header.top { border-bottom: 1px solid var(--border); background: var(--bg); }

header.top .top-inner {
	max-width: 62rem;
	margin: 0 auto;
	padding: 0.7rem 1.25rem;
	display: flex;
	gap: 0.35rem 1.1rem;
	align-items: center;
	flex-wrap: wrap;
}

header.top .brand { font-weight: 700; color: var(--text); margin-right: 0.35rem; }
header.top a { color: var(--text-soft); }
header.top a:hover { color: var(--accent); text-decoration: none; }
header.top .spacer { flex: 1; }
header.top .hint { font-size: 0.8125rem; }

/* --- 主容器 --- */

main { max-width: 62rem; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; }

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

form.stack { display: grid; gap: 1rem; max-width: 46rem; }
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

/* 危险操作（删除）：描边带红，hover 才加底色 */
.actions button.danger { border-color: var(--danger); color: var(--danger); }
.actions button.danger:hover { background: var(--danger-soft); border-color: var(--danger); color: var(--danger); }

.actions { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
.actions button, .actions a.button { padding: 0.35rem 0.8rem; font-weight: 400; }

/* --- 登录页 --- */

.login {
	max-width: 22rem;
	margin: 12vh auto;
	padding: 1.75rem 1.5rem 1.5rem;
	border: 1px solid var(--border);
	border-radius: var(--radius);
}
.login h1 { font-size: 1.1875rem; margin-bottom: 0.5rem; }

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
							<span class="brand">博客后台</span>
							<a href="/admin">文章</a>
							<a href="/admin/posts/new">写文章</a>
							<a href="/admin/categories">分类</a>
							<a href="/admin/media">媒体</a>
							<a href="/admin/settings">设置</a>
							<a href="/admin/password">口令</a>
							<span class="spacer" />
							<span class="hint">{props.user.screen_name || props.user.username}</span>
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
