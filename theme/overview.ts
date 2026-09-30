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
	/**
	 * 分组名（归档用年份，如 `2026 年`）。**只按原顺序切连续段，不在这里排序** ——
	 * 所以调用方必须保证同组相邻（归档的月份本来就是按年倒序出来的）。
	 * 所有 item 都不带 `group` 时，整份清单就是一组，不带小标题。
	 */
	group?: string;
}

/**
 * 清单的排布方式：
 *   - `list`（默认）一行一条，适合**条数少、每条还带一句描述**的情况 —— `/categories/` 只有 7 条，
 *     每条一句描述，摊成胶囊反而读不清；
 *   - `flow` 一行多个、宽度随内容走（不设固定宽度），适合几十上百条的情况 ——
 *     `/tags/` 198 个标签、`/archives/` 58 个月份，一行一条会拖成一屏半的竖直列表。
 *
 * 两种排布输出的是**同一份 `<li class="term-item">` 结构**，差别只在 `<ul>` 上的修饰类，
 * 具体样式见 style.css 的「9. 术语清单」。
 */
export type OverviewLayout = 'list' | 'flow';

export interface OverviewContext {
	site: SiteInfo;
	/** 页面标题，同时作为 <h1> 与 <title> 的前半段 */
	title: string;
	items: OverviewItem[];
	/** items 为空时的提示文案 */
	emptyText?: string;
	canonicalPath: string;
	nav?: NavLink[];
	/** 排布方式，默认 `list` */
	layout?: OverviewLayout;
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

/** 一组 `<li>` 包成一个 `<ul>` */
function renderList(items: OverviewItem[], className: string): string {
	return `	<ul class="${className}">\n${items.map(renderItem).join('\n')}\n	</ul>`;
}

/**
 * 按 `group` 把 items 切成**连续段**。刻意不排序：分组只负责「把相邻的同组项包起来」，
 * 顺序是调用方（快照查询）的事 —— 在这里再排一次会让同一份数据渲染出不稳定的结果。
 */
function groupItems(items: OverviewItem[]): { group?: string; items: OverviewItem[] }[] {
	const groups: { group?: string; items: OverviewItem[] }[] = [];
	for (const item of items) {
		const last = groups[groups.length - 1];
		if (last && last.group === item.group) last.items.push(item);
		else groups.push({ group: item.group, items: [item] });
	}
	return groups;
}

export function renderOverview(context: OverviewContext): string {
	const { site, title, items } = context;

	const listClass = context.layout === 'flow' ? 'term-list term-list--flow' : 'term-list';

	/**
	 * 有 `group` 的组套一层 `<section>` + 小标题（归档的年份），没有的就直接输出 `<ul>`。
	 * 年份小标题是 `<h2>`：页面已经有 `<h1 class="archive-title">`，层级正好接上。
	 * **年份本身不是链接** —— 站里只有 `/yyyy/mm/` 的月份归档页，没有「某年」这一层。
	 */
	const body =
		items.length === 0
			? `	<p class="post-empty">${escapeHtml(context.emptyText || '还没有内容。')}</p>`
			: groupItems(items)
					.map((group) =>
						group.group === undefined
							? renderList(group.items, listClass)
							: `	<section class="term-group">
		<h2 class="term-group-title">${escapeHtml(group.group)}</h2>
${renderList(group.items, listClass)}
	</section>`,
					)
					.join('\n');

	/**
	 * 这三个页面都**不输出一句「共 N 个…」的说明文字**：分类/标签的数量对读者没用
	 * （又不是统计报表），归档那边「按年份分组」扫一眼就明白，不必再用文字说一遍。
	 * 页面级说明留给 `theme/archive.ts`（分类/标签/月份归档页标题下面那句）。
	 */
	const content = `	<h1 class="archive-title">${escapeHtml(title)}</h1>\n${body}`;

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
