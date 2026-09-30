/**
 * 主题共享组件：文章列表项与分页器 —— 设计文档 §11（`theme/components/`）
 *
 * 首页与归档页共用这一套列表渲染，避免两处各写一遍分页逻辑。
 *
 * **这里不拼 URL，只接收拼好的 href。** URL 形状的唯一来源是 `src/lib/url.ts`，
 * 主题层拿到什么就渲染什么 —— 这样以后换 permalink 规则不用改模板。
 */

import { escapeHtml, formatDate, formatDateTime } from '../layout';
import type { SiteInfo } from '../layout';
import type { TermLink } from '../post';

/** 列表项：首页、分类/标签/年月归档都用它 */
export interface ListPost {
	title: string;
	/** 已经拼好并编码过的相对路径，如 `/default/760.html` */
	url: string;
	/** Unix 秒 */
	created: number;
	/** **纯文本**摘要（调用方负责剥标签），转义由本模块负责 */
	excerpt?: string;
	categories?: TermLink[];
}

export function renderPostItem(post: ListPost, site: SiteInfo): string {
	const meta: string[] = [
		`<time datetime="${escapeHtml(formatDateTime(post.created))}">${escapeHtml(formatDate(post.created, site.timezoneOffset))}</time>`,
	];
	if (post.categories && post.categories.length > 0) {
		const links = post.categories
			.map((term) => `<a href="${escapeHtml(term.url)}">${escapeHtml(term.name)}</a>`)
			.join(', ');
		meta.push(`<span class="post-categories">${links}</span>`);
	}

	return `		<li class="post-item">
			<h2 class="post-item-title"><a href="${escapeHtml(post.url)}">${escapeHtml(post.title)}</a></h2>
			<p class="post-meta">
				${meta.join('\n\t\t\t\t')}
			</p>${post.excerpt ? `\n\t\t\t<p class="post-excerpt">${escapeHtml(post.excerpt)}</p>` : ''}
		</li>`;
}

export function renderPostList(posts: ListPost[], site: SiteInfo): string {
	if (posts.length === 0) return `	<p class="post-empty">还没有文章。</p>`;
	return `	<ul class="post-list">
${posts.map((post) => renderPostItem(post, site)).join('\n')}
	</ul>`;
}

export interface PaginationOptions {
	/** 当前页码，从 1 开始 */
	page: number;
	totalPages: number;
	/** 上一页链接；第 1 页不传（注意：第 2 页的上一页应是归档裸 URL，不是 `…/1/`） */
	prevUrl?: string;
	nextUrl?: string;
}

export function renderPagination(options: PaginationOptions): string {
	const { page, totalPages, prevUrl, nextUrl } = options;
	if (totalPages <= 1) return '';

	const parts: string[] = [];
	if (prevUrl) parts.push(`<a class="page-prev" href="${escapeHtml(prevUrl)}">上一页</a>`);
	parts.push(`<span class="page-status">第 ${page} / ${totalPages} 页</span>`);
	if (nextUrl) parts.push(`<a class="page-next" href="${escapeHtml(nextUrl)}">下一页</a>`);

	return `	<nav class="pagination">
		${parts.join('\n\t\t')}
	</nav>`;
}
