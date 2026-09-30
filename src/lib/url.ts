/**
 * permalink ↔ R2 key 映射 —— 设计文档 §5.1 / §11
 *
 * 三条纪律：
 *  1. 本文件是 URL 形状的**唯一来源**。主题层不自己拼 URL，只接收已经拼好的 href。
 *  2. **key 用「解码后的字面量」，URL 用「百分号编码」** —— 这两件事必须分开。
 *     实测依据：把 key 写成 `usr/uploads/2024/01/测试 图片.txt`，
 *     浏览器请求 `/usr/uploads/2024/01/%E6%B5%8B%E8%AF%95%20%E5%9B%BE%E7%89%87.txt`
 *     返回 200 —— R2 是先把 pathname 解码、再与 key 精确匹配的。
 *  3. 单个 path segment 用 encodeURIComponent；不要对整条路径编码，否则 `/` 会被编掉。
 *
 * 实测过的 URL 形状（2026-09，对着线上 Typecho 站点逐条核对）：
 *
 *   `/`                     → key `''`（空字符串。**不是** `index`，实测 `index`/`index.html` 都不服务 `/`）
 *   `/page/<n>/` (n≥1)      → key `page/<n>/`；`/page/1/` 是 `/` 的副本，必须单独生成
 *   `/<category>/<slug>.html` → 同左
 *   `/<slug>.html`          → 同左（独立页面，单段）
 *   `/category/<slug>/`     → 同左
 *   `/category/<slug>/<n>/` → 同左（n≥1；`/1/` 是裸 URL 的副本，实测 200）
 *   `/tag/<slug>/`、`/tag/<slug>/<n>/` → 同左（tag slug 可能是中文，实测 `/tag/安卓/1/` = 200）
 *   `/<year>/<month>/`      → 同左（**没有 `/<n>/` 变体**：`/2025/11/1/` 与 `/2025/11/2/` 实测都是 404）
 *   `/feed/`                → 同左（带末尾斜杠）
 *   `/sitemap.xml`          → 同左
 */

/** 站点根 URL 归一化：去掉末尾斜杠 */
export function normalizeBase(siteUrl: string): string {
	return siteUrl.trim().replace(/\/+$/, '');
}

/** 把一个 path segment 编码成 URL 里能用的形式（中文、空格都会被编码） */
export function encodeSegment(segment: string): string {
	return encodeURIComponent(segment);
}

/** 拼绝对 URL（canonical / feed / sitemap 用） */
export function absoluteUrl(siteUrl: string, path: string): string {
	return normalizeBase(siteUrl) + path;
}

// ---------------------------------------------------------------------------
// R2 key —— 解码后的字面量
// ---------------------------------------------------------------------------

/** 首页：空字符串 key（实测：写入后 `GET /` 返回 200） */
export const HOME_KEY = '';
export const FEED_KEY = 'feed/';
export const SITEMAP_KEY = 'sitemap.xml';

/** 首页分页。注意 page=1 对应的是 `page/1/` 这个**副本对象**，`/` 本身是 HOME_KEY */
export function indexPageKey(page: number): string {
	return `page/${page}/`;
}

/** 文章：`<主分类 slug>/<slug>.html` */
export function postKey(categorySlug: string, slug: string): string {
	return `${categorySlug}/${slug}.html`;
}

/** 独立页面：单段 `<slug>.html`（与文章靠段数区分，见 §5.1） */
export function standalonePageKey(slug: string): string {
	return `${slug}.html`;
}

/** 分类归档：裸 URL 与第 n 页 */
export function categoryKey(slug: string, page = 0): string {
	return page > 0 ? `category/${slug}/${page}/` : `category/${slug}/`;
}

/** 标签归档：形状同分类（slug 可能是中文） */
export function tagKey(slug: string, page = 0): string {
	return page > 0 ? `tag/${slug}/${page}/` : `tag/${slug}/`;
}

/** 年月归档：只有裸形式，没有 `/<n>/` 变体（实测 404） */
export function monthKey(year: number, month: number): string {
	return `${year}/${String(month).padStart(2, '0')}/`;
}

/** 附件：去掉前导斜杠就是 key（§9 要求路径与 Typecho 完全一致） */
export function uploadKey(pathname: string): string {
	return pathname.replace(/^\/+/, '');
}

// ---------------------------------------------------------------------------
// URL path —— 百分号编码后，用于 href / canonical
// ---------------------------------------------------------------------------

export function homePath(): string {
	return '/';
}

/** 首页分页的**链接**：第 1 页就是首页 `/`，不是 `/page/1/` */
export function indexPagePath(page: number): string {
	return page <= 1 ? '/' : `/page/${page}/`;
}

export function postPath(categorySlug: string, slug: string): string {
	return `/${encodeSegment(categorySlug)}/${encodeSegment(slug)}.html`;
}

export function standalonePagePath(slug: string): string {
	return `/${encodeSegment(slug)}.html`;
}

export function categoryPath(slug: string, page = 0): string {
	return page > 0 ? `/category/${encodeSegment(slug)}/${page}/` : `/category/${encodeSegment(slug)}/`;
}

export function tagPath(slug: string, page = 0): string {
	return page > 0 ? `/tag/${encodeSegment(slug)}/${page}/` : `/tag/${encodeSegment(slug)}/`;
}

export function monthPath(year: number, month: number): string {
	return `/${year}/${String(month).padStart(2, '0')}/`;
}

export function feedPath(): string {
	return '/feed/';
}

// ---------------------------------------------------------------------------
// 反查：请求 pathname → R2 key（迁移核对与旧链接排查用）
// ---------------------------------------------------------------------------

/** `/category/%E5%AE%89%E5%8D%93/` → `category/安卓/`；解码失败时原样返回 */
export function keyFromPathname(pathname: string): string {
	const raw = pathname.replace(/^\/+/, '');
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** 判断是不是「副本 URL」：`/page/1/`、`/category/x/1/`、`/tag/x/1/` —— 它们不进 sitemap */
export function isDuplicatePath(path: string): boolean {
	return /^\/page\/1\/$/.test(path) || /^\/(?:category|tag)\/[^/]+\/1\/$/.test(path);
}

/** 分页数：总数 / 每页条数，至少 1 页 */
export function pageCount(total: number, perPage: number): number {
	if (perPage <= 0) return 1;
	const pages = Math.ceil(total / perPage);
	return pages > 0 ? pages : 1;
}

/** 取第 n 页的数据切片（n 从 1 开始） */
export function pageSlice<T>(items: T[], page: number, perPage: number): T[] {
	const start = (page - 1) * perPage;
	return items.slice(start, start + perPage);
}
