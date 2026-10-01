/**
 * 文章列表 —— 设计文档 §6.2 第 5 条 / §6.5
 *
 * 「待同步」计数挂在这里提醒作者 R2 有积压；两个渲染操作（全站/增量）
 * 在独立的 /admin/render 维护页里，列表只留入口。
 */

import type { AdminPostRow } from '../models/content';
import type { TermChoice } from '../publish/types';
import { formatDate } from '../../theme/layout';
import { AdminLayout } from './layout';

export interface PostListPageProps {
	posts: AdminPostRow[];
	/** 当前筛选下的总条数（分页用） */
	total: number;
	page: number;
	totalPages: number;
	needsSync: number;
	/** 分类下拉选项（筛选用） */
	categories: TermChoice[];
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
	/** 分页链接要背着当前筛选走，不然翻一页筛选就丢了 */
	const pageUrl = (page: number): string => {
		const params = new URLSearchParams();
		if (props.filters.q) params.set('q', props.filters.q);
		if (props.filters.status) params.set('status', props.filters.status);
		if (props.filters.categoryMid) params.set('category', String(props.filters.categoryMid));
		params.set('page', String(page));
		return `/admin?${params.toString()}`;
	};
	return (
		<AdminLayout title="文章 · 博客后台" user={props.user} message={props.message} error={props.error}>
			{/* 页面标题的位置/字号全后台统一；条数与「待同步」挂到标题右侧 ——
			    原来没有标题，它们挤在下面的按钮行里，本页第一行因此比别的页低一截。
			    「待同步」留在标题行：它是站点级状态提醒，不是筛选条件 */}
			<h1 class="page-head">
				文章
				<span class="note">
					{hasFilter ? `筛出 ${props.total} 条` : `共 ${props.total} 条`}
					{props.needsSync > 0 ? (
						<a class="badge dirty" href="/admin/render">
							待同步 {props.needsSync}
						</a>
					) : null}
				</span>
			</h1>

			{/* 一行排开：主操作在左，筛选条件跟在后面（原来主操作独占一行，
			    搜索框又 flex-grow 撑满剩下的宽度，整行又空又长） */}
			<form method="get" action="/admin" class="filter-bar">
				<a class="button" href="/admin/posts/new">
					写文章
				</a>
				<a class="button" href="/admin/render">
					渲染维护
				</a>
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
			{props.posts.length === 0 ? (
				props.page > 1 ? (
					<p class="hint">
						这一页没有内容，<a href={pageUrl(1)}>回到第一页</a>。
					</p>
				) : (
					<p class="hint">还没有内容。</p>
				)
			) : null}

			{props.totalPages > 1 ? (
				<nav class="admin-pagination" aria-label="列表分页">
					{props.page > 1 ? (
						<a class="button" href={pageUrl(props.page - 1)}>
							上一页
						</a>
					) : (
						<span class="button" aria-disabled="true">
							上一页
						</span>
					)}
					<span class="hint">
						第 {props.page} / {props.totalPages} 页
					</span>
					{props.page < props.totalPages ? (
						<a class="button" href={pageUrl(props.page + 1)}>
							下一页
						</a>
					) : (
						<span class="button" aria-disabled="true">
							下一页
						</span>
					)}
				</nav>
			) : null}
		</AdminLayout>
	);
}
