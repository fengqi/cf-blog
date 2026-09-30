/**
 * 文章列表 —— 设计文档 §6.2 第 5 条 / §6.5
 *
 * 两个必须出现在这里的东西：
 *   - **「待同步」数量**：让作者看见 R2 写失败，而不是靠运气发现
 *   - **「全站重新渲染」按钮**：改了模板/样式之后刷历史文章的唯一入口
 */

import type { AdminPostRow } from '../models/content';
import { formatDate } from '../../theme/layout';
import { AdminLayout } from './layout';

export interface PostListPageProps {
	posts: AdminPostRow[];
	needsSync: number;
	user: { screen_name: string | null; username: string };
	message?: string;
	error?: string;
	siteTimezoneOffset?: number;
}

const STATUS_LABEL: Record<string, string> = {
	publish: '已发布',
	draft: '草稿',
	waiting: '待发布',
	hidden: '隐藏',
	private: '私密',
};

export function PostListPage(props: PostListPageProps) {
	const offset = props.siteTimezoneOffset ?? 8;
	return (
		<AdminLayout title="文章 · 博客后台" user={props.user} message={props.message} error={props.error}>
			<div class="actions" style="margin-bottom:1rem">
				<a class="button" href="/admin/posts/new">
					写文章
				</a>
				<form method="post" action="/admin/rebuild">
					<button type="submit">全站重新渲染</button>
				</form>
				<span class="hint">
					共 {props.posts.length} 条
					{props.needsSync > 0 ? (
						<>
							{' · '}
							<span class="badge dirty">待同步 {props.needsSync}</span>
						</>
					) : null}
				</span>
			</div>

			<table>
				<thead>
					<tr>
						<th>标题</th>
						<th>状态</th>
						<th>分类</th>
						<th>时间</th>
						<th>操作</th>
					</tr>
				</thead>
				<tbody>
					{props.posts.map((post) => (
						<tr>
							<td>
								<a href={`/admin/posts/${post.cid}/edit`}>{post.title || '(无标题)'}</a>
								{post.needs_sync ? <span class="badge dirty">待同步</span> : null}
								<div class="hint">
									{post.type === 'page' ? '独立页面' : '文章'} · {post.slug} · {post.words} 字
								</div>
							</td>
							<td>
								<span class={`badge ${post.status}`}>{STATUS_LABEL[post.status] ?? post.status}</span>
							</td>
							<td class="hint">
								{post.categories.map((term) => term.name).join('、') || '—'}
							</td>
							<td class="hint">{formatDate(post.created, offset)}</td>
							<td>
								<div class="actions">
									<a class="button" href={`/preview/${post.cid}`} target="_blank">
										预览
									</a>
									<form method="post" action={`/admin/posts/${post.cid}/delete`}>
										<button type="submit">删除</button>
									</form>
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{props.posts.length === 0 ? <p class="hint">还没有内容。</p> : null}
		</AdminLayout>
	);
}
