/**
 * 文章列表 —— 设计文档 §6.2 第 5 条 / §6.5
 *
 * 「待同步」计数挂在这里提醒作者 R2 有积压；两个渲染操作（全站/增量）
 * 在独立的 /admin/render 维护页里，列表只留入口。
 */

import type { AdminPostRow } from '../models/content';
import type { TermRecord } from '../publish/types';
import { formatDate } from '../../theme/layout';
import { AdminLayout } from './layout';

export interface PostListPageProps {
	posts: AdminPostRow[];
	needsSync: number;
	/** 分类下拉选项（筛选用） */
	categories: TermRecord[];
	/** 当前生效的筛选（回填表单；空串 = 没筛） */
	filters: { q: string; status: string; categoryMid: number | '' };
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
	const hasFilter = Boolean(props.filters.q || props.filters.status || props.filters.categoryMid);
	return (
		<AdminLayout title="文章 · 博客后台" user={props.user} message={props.message} error={props.error}>
			<div class="actions" style="margin-bottom:1rem">
				<a class="button" href="/admin/posts/new">
					写文章
				</a>
				<a class="button" href="/admin/render">
					渲染维护
				</a>
				<span class="hint">
					{props.needsSync > 0 ? (
						<a class="badge dirty" href="/admin/render">
							待同步 {props.needsSync}
						</a>
					) : null}
				</span>
				<span class="hint">
					{hasFilter ? `筛出 ${props.posts.length} 条` : `共 ${props.posts.length} 条`}
				</span>
			</div>

			<form method="get" action="/admin" class="filter-bar">
				<input type="text" name="q" placeholder="标题 / 缩略名" value={props.filters.q ?? ''} />
				<select name="status" aria-label="按状态筛选">
					<option value="">全部状态</option>
					<option value="publish" selected={props.filters.status === 'publish'}>已发布</option>
					<option value="draft" selected={props.filters.status === 'draft'}>草稿</option>
					<option value="waiting" selected={props.filters.status === 'waiting'}>待发布</option>
					<option value="hidden" selected={props.filters.status === 'hidden'}>隐藏</option>
					<option value="private" selected={props.filters.status === 'private'}>私密</option>
				</select>
				<select name="category" aria-label="按分类筛选">
					<option value="">全部分类</option>
					{props.categories.map((term) => (
						<option value={term.mid} selected={props.filters.categoryMid === term.mid}>
							{term.name}
						</option>
					))}
				</select>
				<button type="submit">筛选</button>
				{hasFilter ? (
					<a class="button" href="/admin">
						清除
					</a>
				) : null}
			</form>

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
									<a class="button" href={`/admin/posts/${post.cid}/edit`}>
										修改
									</a>
									<a class="button" href={`/preview/${post.cid}`} target="_blank">
										预览
									</a>
									<form
										method="post"
										action={`/admin/posts/${post.cid}/delete`}
										onsubmit="return confirm('确定删除？删除后文章页与旧地址一起失效，不可恢复')"
									>
										<button class="danger" type="submit">删除</button>
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
