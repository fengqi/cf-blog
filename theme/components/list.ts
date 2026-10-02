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
import { renderIcon } from '../icons';
import type { TermLink } from '../post';

/** 列表项：首页、分类/标签/年月归档都用它 */
export interface ListPost {
	title: string;
	/** 已经拼好并编码过的相对路径，如 `/default/760.html` */
	url: string;
	/** Unix 秒 */
	created: number;
	/** **已渲染的摘要 HTML**（发布流水线已按 Markdown 渲染并白名单清洗），原样输出 */
	excerptHtml?: string;
	categories?: TermLink[];
	tags?: TermLink[];
}

/**
 * 列表项的「底栏」：日期在左下角（带日历图标），分类 + 标签在右下角（胶囊按钮）。
 * 两者都做**可选**：没有分类/标签的文章只出日期那一侧，不留空壳容器。
 *
 * 按钮带图标：分类是文件夹、标签是标签形（theme/icons.ts），icon 用主题色、
 * 文字保持灰 —— 与左侧「粉 icon + 灰日期」同一模式（见 style.css 的 .term-btn）。
 */
function renderTermBtn(term: TermLink, icon: string): string {
	return `<a class="term-btn" href="${escapeHtml(term.url)}">${renderIcon(icon)}${escapeHtml(term.name)}</a>`;
}

function renderItemFoot(post: ListPost, site: SiteInfo): string {
	const termButtons =
		[...(post.categories ?? []).map((term) => renderTermBtn(term, 'categories')),
			...(post.tags ?? []).map((term) => renderTermBtn(term, 'tags'))].join('');
	return `
			<div class="post-item-foot">
				<span class="post-item-date">${renderIcon('calendar')}<time datetime="${escapeHtml(formatDateTime(post.created))}">${escapeHtml(formatDate(post.created, site.timezoneOffset))}</time></span>${termButtons ? `\n				<span class="post-item-terms">${termButtons}</span>` : ''}
			</div>`;
}

/**
 * 列表项整体可点：标题链接用 ::after 铺满整个卡片（CSS 的「stretched link」，
 * 见 style.css），所以 <a> 里只有标题文字；分类/标签按钮要能单独点，
 * 由 .post-item-terms 抬到铺满层之上。
 */
export function renderPostItem(post: ListPost, site: SiteInfo): string {
	return `		<li class="post-item">
			<h2 class="post-item-title"><a href="${escapeHtml(post.url)}">${escapeHtml(post.title)}</a></h2>${post.excerptHtml ? `\n\t\t\t<div class="post-excerpt">${post.excerptHtml}</div>` : ''}${renderItemFoot(post, site)}
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
	if (prevUrl) parts.push(`<a class="page-prev" href="${escapeHtml(prevUrl)}">${renderIcon('arrow-left')}上一页</a>`);
	parts.push(`<span class="page-status">第 ${page} / ${totalPages} 页</span>`);
	if (nextUrl) parts.push(`<a class="page-next" href="${escapeHtml(nextUrl)}">下一页${renderIcon('arrow-right')}</a>`);

	return `	<nav class="pagination">
		${parts.join('\n\t\t')}
	</nav>`;
}
