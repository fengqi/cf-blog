/**
 * 后台骨架 —— 设计文档 §11 / §0（后台无单独构建链，样式内联）
 *
 * 只 import `hono/jsx`（§11 纪律 1）；`dangerouslySetInnerHTML` 在这个文件里不出现。
 */

import type { Child } from 'hono/jsx';

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.6; }
header.top { display: flex; gap: 1rem; align-items: center; padding: .75rem 1.25rem; border-bottom: 1px solid #8883; flex-wrap: wrap; }
header.top a { text-decoration: none; }
header.top .spacer { flex: 1; }
main { max-width: 62rem; margin: 0 auto; padding: 1.25rem; }
table { width: 100%; border-collapse: collapse; font-size: .95rem; }
th, td { text-align: left; padding: .45rem .5rem; border-bottom: 1px solid #8882; vertical-align: top; }
.badge { display: inline-block; padding: 0 .4rem; border-radius: .35rem; font-size: .78rem; border: 1px solid #8886; }
.badge.publish { background: #2e7d3222; }
.badge.draft { background: #88888822; }
.badge.waiting { background: #f9a82522; }
.badge.dirty { background: #c6282822; border-color: #c6282866; }
.message { padding: .6rem .8rem; border-radius: .35rem; background: #2e7d3222; margin-bottom: 1rem; }
.message.error { background: #c6282822; }
form.stack { display: grid; gap: .9rem; max-width: 46rem; }
label { display: block; font-weight: 600; margin-bottom: .25rem; }
input[type=text], input[type=password], input[type=datetime-local], textarea, select { width: 100%; padding: .45rem .55rem; font: inherit; }
textarea.body { min-height: 24rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92rem; }
.row { display: flex; gap: 1rem; flex-wrap: wrap; }
.row > * { flex: 1 1 14rem; }
.actions { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
.actions button, .actions a.button { padding: .45rem .9rem; font: inherit; cursor: pointer; text-decoration: none; border: 1px solid #8886; border-radius: .3rem; background: transparent; color: inherit; }
.hint { font-size: .85rem; opacity: .75; }
.login { max-width: 22rem; margin: 12vh auto; }
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
				<style>{STYLE}</style>
			</head>
			<body>
				{props.user ? (
					<header class="top">
						<strong>博客后台</strong>
						<a href="/admin">文章</a>
						<a href="/admin/posts/new">写文章</a>
						<a href="/admin/media">媒体</a>
						<a href="/admin/settings">设置</a>
						<a href="/admin/password">口令</a>
						<span class="spacer" />
						<span class="hint">{props.user.screen_name || props.user.username}</span>
						<form method="post" action="/admin/logout">
							<button type="submit">退出</button>
						</form>
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
				<style>{STYLE}</style>
			</head>
			<body>
				<main>{props.children}</main>
			</body>
		</html>
	);
}
