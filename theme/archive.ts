/**
 * 前台主题 · 归档页（设计文档 §5.1 / §5.3）
 *
 * 覆盖三种归档，它们的 URL 形状并不一样（都已对着线上站点实测）：
 *
 *  - 分类：`/category/<slug>/`，第 n 页 `/category/<slug>/<n>/`（含 `/1/` 副本）
 *  - 标签：`/tag/<slug>/`，形状同分类（slug 可能是中文）
 *  - 年月：`/<year>/<month>/`，**没有分页变体**（`/2025/11/1/` 实测 404）
 *
 * 所以年月归档调用时 page/totalPages 恒为 1，分页器自然不渲染。
 * URL 由调用方传进来，本层不拼（见 components/list.ts 的说明）。
 */

import { escapeHtml, renderLayout } from './layout';
import type { NavLink, SiteInfo } from './layout';
import { renderPagination, renderPostList } from './components/list';
import type { ListPost } from './components/list';

export interface ArchiveContext {
	site: SiteInfo;
	/** 归档标题，如「分类 Other 下的文章」「2025 年 11 月」 */
	title: string;
	/** 分类/标签描述，可选 */
	description?: string;
	posts: ListPost[];
	page: number;
	totalPages: number;
	prevUrl?: string;
	nextUrl?: string;
	/** canonical 相对路径；默认由调用方给（归档没有「裸 URL 与 /1/ 谁优先」之外的歧义） */
	canonicalPath: string;
	nav?: NavLink[];
}

export function renderArchive(context: ArchiveContext): string {
	const { site, title, description, posts, page, totalPages, prevUrl, nextUrl } = context;

	const list = renderPostList(posts, site);
	const pagination = renderPagination({ page, totalPages, prevUrl, nextUrl });
	const descriptionHtml = description
		? `\n\t<p class="archive-description">${escapeHtml(description)}</p>`
		: '';
	const content = `	<h1 class="archive-title">${escapeHtml(title)}</h1>${descriptionHtml}\n${list}${
		pagination ? `\n${pagination}` : ''
	}`;

	return renderLayout({
		site,
		content,
		// 第 2 页起标题必须不同，否则一堆归档分页共用同一个 <title>
		title: page > 1 ? `${title} - 第 ${page} 页` : title,
		canonicalPath: context.canonicalPath,
		nav: context.nav,
	});
}
