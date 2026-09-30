/**
 * 前台主题 · 全站索引页 —— 设计文档 §5.1 / §11
 *
 * `/categories/`、`/tags/`、`/archives/` 三个页面共用这一个模板：
 * 都是「标题 + 说明 + 一组带计数的链接」，差别只在数据。
 *
 * 它们是**侧栏消失之后的落点**：以前站内导航（分类/标签/归档）挤在文章页侧栏里，
 * 阅读正文时始终跟着一列「和这篇无关」的东西；现在导航收进顶栏，点进来才是清单。
 *
 * URL 不在这一层拼（同 `components/list.ts` 的说明），只接收拼好的 href。
 */

import { escapeHtml, renderLayout } from './layout';
import type { NavLink, SiteInfo } from './layout';

/** 一条索引项：一个分类 / 一个标签 / 一个月份 */
export interface OverviewItem {
	name: string;
	/** 已经拼好并编码过的相对路径 */
	url: string;
	/** 文章数；不传就不渲染计数 */
	count?: number;
	/** 术语描述，只有分类/标签可能有 */
	description?: string;
}

export interface OverviewContext {
	site: SiteInfo;
	/** 页面标题，同时作为 <h1> 与 <title> 的前半段 */
	title: string;
	/** 一行说明，如「共 12 个分类，按文章数排列」 */
	description?: string;
	items: OverviewItem[];
	/** items 为空时的提示文案 */
	emptyText?: string;
	canonicalPath: string;
	nav?: NavLink[];
}

/** 计数一律走这里：SQL 的 COUNT 理论上不会是负数或 undefined，但渲染层不该输出 "undefined" */
function formatCount(count: number): string {
	const value = Number.isFinite(count) ? Math.trunc(count) : 0;
	return String(Math.max(0, value));
}

function renderItem(item: OverviewItem): string {
	const count = typeof item.count === 'number' ? `<span class="term-count">${formatCount(item.count)}</span>` : '';
	const description = item.description
		? `\n\t\t\t<p class="term-description">${escapeHtml(item.description)}</p>`
		: '';
	return `		<li class="term-item">
			<div class="term-head"><a href="${escapeHtml(item.url)}">${escapeHtml(item.name)}</a>${count}</div>${description}
		</li>`;
}

export function renderOverview(context: OverviewContext): string {
	const { site, title, description, items } = context;

	const body =
		items.length === 0
			? `	<p class="post-empty">${escapeHtml(context.emptyText || '还没有内容。')}</p>`
			: `	<ul class="term-list">\n${items.map(renderItem).join('\n')}\n	</ul>`;

	const descriptionHtml = description
		? `\n	<p class="archive-description">${escapeHtml(description)}</p>`
		: '';

	const content = `	<h1 class="archive-title">${escapeHtml(title)}</h1>${descriptionHtml}\n${body}`;

	return renderLayout({
		site,
		content,
		title,
		canonicalPath: context.canonicalPath,
		nav: context.nav,
		// 清单页限宽居中：1080px 宽的清单一行能塞六十多个汉字，读起来很累
		width: 'narrow',
	});
}
