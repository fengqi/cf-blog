/**
 * 文章编辑器 —— 设计文档 §6.1（保存即发布）/ §10（草稿、定时发布）
 *
 * 表单是纯 SSR + 浏览器原生控件，没有前端框架（§0「后台形态：SSR 表单 + 少量原生 JS」）。
 * 提交后由 `routes/admin.ts` 调发布流水线，而不是在这里拼 HTML。
 */

import type { EditorView } from '../models/content';
import type { TermRecord } from '../publish/types';
import { formatDateTimeLocal } from '../lib/time';
import { AdminLayout } from './layout';

export interface PostEditorPageProps {
	post?: EditorView;
	categories: TermRecord[];
	user: { screen_name: string | null; username: string };
	timezoneOffset: number;
	message?: string;
	error?: string;
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
	{ value: 'publish', label: '发布' },
	{ value: 'draft', label: '草稿' },
	{ value: 'waiting', label: '定时发布（到点由 Cron 转正）' },
	{ value: 'hidden', label: '隐藏（不进列表）' },
];

export function PostEditorPage(props: PostEditorPageProps) {
	const post = props.post;
	const isNew = !post;
	const action = isNew ? '/admin/posts' : `/admin/posts/${post.cid}`;
	// 新建时默认「草稿」：先落库再决定发布，比一上来就写 R2 稳
	const status = post?.status ?? 'draft';
	const created = post?.created ?? Math.floor(Date.now() / 1000);
	const type = post?.type ?? 'post';

	return (
		<AdminLayout
			title={isNew ? '写文章 · 博客后台' : `编辑：${post.title} · 博客后台`}
			user={props.user}
			message={props.message}
			error={props.error}
		>
			<form method="post" action={action} class="stack">
				<div>
					<label for="title">标题</label>
					<input type="text" id="title" name="title" value={post?.title ?? ''} required />
				</div>

				<div class="row">
					<div>
						<label for="slug">缩略名（URL 片段）</label>
						<input type="text" id="slug" name="slug" value={post?.slug ?? ''} />
						<p class="hint">留空则用 cid；改它会让旧链接变成 canonical 页（§5.1 方案 A）</p>
					</div>
					<div>
						<label for="type">类型</label>
						<select id="type" name="type">
							<option value="post" selected={type === 'post'}>
								文章（/&lt;分类&gt;/&lt;缩略名&gt;.html）
							</option>
							<option value="page" selected={type === 'page'}>
								独立页面（/&lt;缩略名&gt;.html）
							</option>
						</select>
					</div>
				</div>

				<div class="row">
					<div>
						<label for="status">状态</label>
						<select id="status" name="status">
							{STATUS_OPTIONS.map((option) => (
								<option value={option.value} selected={status === option.value}>
									{option.label}
								</option>
							))}
						</select>
					</div>
					<div>
						<label for="created">发布时间（站点时区）</label>
						<input
							type="datetime-local"
							id="created"
							name="created"
							value={formatDateTimeLocal(created, props.timezoneOffset)}
						/>
					</div>
				</div>

				<div>
					<label for="body">正文（Markdown）</label>
					<textarea id="body" name="body" class="body">
						{post?.body ?? ''}
					</textarea>
					<p class="hint">
						正文里的原生 HTML 会保留，但写入前会过一遍白名单清洗（§8.3）
					</p>
				</div>

				<div>
					<label for="excerpt">自定义摘要</label>
					<textarea id="excerpt" name="excerpt" rows={3}>
						{post?.excerpt ?? ''}
					</textarea>
					<p class="hint">留空则自动从正文生成（纯文本，落库）</p>
				</div>

				<div class="row">
					<div>
						<label>分类</label>
						{props.categories.map((term) => (
							<label class="hint" style="font-weight:400">
								<input
									type="checkbox"
									name="categories"
									value={String(term.mid)}
									checked={post?.categoryIds.includes(term.mid) ?? false}
								/>{' '}
								{term.name}
							</label>
						))}
						<p class="hint">
							文章 URL 里用的是<strong>第一个</strong>分类（按 mid 升序）
						</p>
					</div>
					<div>
						<label for="tags">标签（逗号分隔）</label>
						<input
							type="text"
							id="tags"
							name="tags"
							value={post?.tagNames.join(', ') ?? ''}
							placeholder="cloudflare, 踩坑记录"
						/>
					</div>
				</div>

				<label class="hint" style="font-weight:400">
					<input
						type="checkbox"
						name="allow_feed"
						value="1"
						checked={(post?.allow_feed ?? 1) === 1}
					/>{' '}
					允许进入 RSS
				</label>

				<div class="actions">
					<button type="submit">{isNew ? '保存' : '保存并发布'}</button>
					{post ? (
						<a class="button" href={`/preview/${post.cid}`} target="_blank">
							预览
						</a>
					) : null}
					<a class="button" href="/admin">
						返回列表
					</a>
				</div>
			</form>
		</AdminLayout>
	);
}
