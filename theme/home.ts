/**
 * 前台主题 · 首页与分页（设计文档 §5.1 / §5.3）
 *
 * 输出首页（R2 key `""`，即 URL `/`）与分页（R2 key `page/<n>/`）的完整 HTML。
 * 零依赖，见 layout.ts 顶部的三条纪律。
 *
 * **URL 不在这一层拼**：分页的 prev/next href 由调用方（`src/publish/render.ts`）传进来，
 * 保证 URL 形状只有 `src/lib/url.ts` 一个来源。
 */

import { renderLayout } from './layout';
import type { NavLink, SiteInfo } from './layout';
import { renderPagination, renderPostList } from './components/list';
import type { ListPost } from './components/list';

/** 列表项类型（转发 components/list 的定义，调用方从主题入口拿类型即可） */
export type HomePost = ListPost;

export interface HomeContext {
	site: SiteInfo;
	posts: ListPost[];
	/** 当前页码，从 1 开始 */
	page: number;
	/** 总页数 */
	totalPages: number;
	/** 上一页链接（第 1 页为空） */
	prevUrl?: string;
	/** 下一页链接（最后一页为空） */
	nextUrl?: string;
	/**
	 * canonical 用的相对路径。
	 * **首页（`/`）与 `page/1/` 副本都必须传 `/`** —— 两者内容重复，要把权重归并到首页，
	 * 且 `page/1/` 不写进 sitemap（§5.1）。调用方不传时按首页处理。
	 */
	canonicalPath?: string;
	nav?: NavLink[];
}

export function renderHome(context: HomeContext): string {
	const { site, posts, page, totalPages, prevUrl, nextUrl } = context;

	const list = renderPostList(posts, site);
	const pagination = renderPagination({ page, totalPages, prevUrl, nextUrl });
	const content = pagination ? `${list}\n${pagination}` : list;

	return renderLayout({
		site,
		content,
		// 第 1 页的标题就是站点名；第 2 页起必须区分，否则每页 <title> 完全相同
		title: page > 1 ? `第 ${page} 页` : undefined,
		canonicalPath: context.canonicalPath ?? '/',
		nav: context.nav,
		// 首页只有列表，没有侧栏 —— 限宽居中，别让摘要一行铺满 1080px
		width: 'narrow',
		// 首页自己的 h1 就是站点名，避免页头再出一个 h1
		siteTitleTag: 'h1',
	});
}
