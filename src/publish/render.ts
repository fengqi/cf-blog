/**
 * 发布时渲染完整页面 —— 设计文档 §6.1 / §6.5 / §11
 *
 * **渲染发生在写入时，而且渲染的是完整页面**（铁律 2）：Markdown 解析与 HTML 生成
 * 放请求路径上必然撞 10ms CPU 上限，所以前台页面一律在这里一次性拼好。
 *
 * 本文件的角色是「适配器」：
 *   - 数据来自 `src/publish/types.ts` 的 `SiteSnapshot`（无 SQL、无 HTML）
 *   - HTML 来自 `theme/`（零依赖，只做字符串拼接）
 *   - URL 形状全部来自 `src/lib/url.ts`
 * 所以它能脱离数据库与网络单测，也能直接用来跑全站重建（§6.5）。
 */

import { renderArchive } from '../../theme/archive';
import { themeAsset } from '../../theme/assets';
import { renderHome } from '../../theme/home';
import type { ListPost } from '../../theme/components/list';
import type { NavLink } from '../../theme/layout';
import { renderOverview } from '../../theme/overview';
import type { OverviewItem, OverviewLayout } from '../../theme/overview';
import { renderPost } from '../../theme/post';
import type { TermLink } from '../../theme/post';
import { makeExcerpt, summaryView } from '../lib/markdown';
import { HTML_CONTENT_TYPE } from '../lib/r2';
import type { RenderedObject } from '../lib/r2';
import { formatDateOnly, formatRfc822, monthOf } from '../lib/time';
import {
	OVERVIEW_SECTIONS,
	absoluteUrl,
	categoryPath,
	homePath,
	indexPagePath,
	monthPath,
	overviewPath,
	pageCount,
	pageSlice,
	postPath,
	standalonePagePath,
	tagPath,
} from '../lib/url';
import { primaryCategory, siteTargets } from './targets';
import type { PostRecord, SiteSnapshot, Target, TermRecord } from './types';

const FEED_CONTENT_TYPE = 'application/rss+xml; charset=utf-8';
const SITEMAP_CONTENT_TYPE = 'application/xml; charset=utf-8';

/** feed 里最多放多少条（RSS 惯例，跟分页大小无关） */
const FEED_ITEMS = 20;

/**
 * 顶栏「关于」指向的独立页面 slug。
 *
 * 它是**兜底约定**，不是配置项：站点里没有这个 slug 的页面时整条导航项不渲染 ——
 * 顶栏挂一个指向 404 的「关于」比少一条链接糟得多。
 */
const ABOUT_SLUG = 'about';

// ---------------------------------------------------------------------------
// 数据 → 主题视图模型
// ---------------------------------------------------------------------------

function toTermLinks(terms: TermRecord[]): TermLink[] {
	return terms.map((term) => ({
		name: term.name,
		url: term.type === 'category' ? categoryPath(term.slug) : tagPath(term.slug),
	}));
}

function articlePath(post: PostRecord): string {
	return postPath(primaryCategory(post).slug, post.slug);
}

function toListPost(post: PostRecord): ListPost {
	// 摘要在渲染期现算：手写摘要（Markdown）> `<!--more-->` 分界前半段 > 全文
	return {
		title: post.title,
		url: articlePath(post),
		created: post.created,
		excerptHtml: summaryView(post),
		categories: toTermLinks(post.categories),
		// 标签也进列表项：底栏右下角和分类一起做成胶囊按钮（theme/components/list.ts）
		tags: toTermLinks(post.tags),
	};
}

/**
 * 顶栏导航 —— **全站唯一的一套站内导航**（侧栏已经整站移除）。
 *
 * 「不展开」是刻意的：这几条不做下拉菜单，点进去就是清单页
 * （`/categories/`、`/tags/`、`/archives/`，见 `renderOverviewPage`）。
 * 好处是导航里不再有任何**随发布而变**的内容 —— 计数只出现在清单页的 HTML 里，
 * 也就是 3 个对象，而不是每个页面一份。
 *
 * 独立页面只有 slug=about 的那条兜底约定；其余页面不进导航（发一个页面
 * 仍然只写 2 个对象：页面自己 + sitemap）。2026-09-30 评估过「顶栏自动列出
 * 全部页面」，因每次发/删页面都要全站重渲 ~800 个对象而否决，维持现状。
 */
function toNav(snapshot: SiteSnapshot): NavLink[] {
	// icon 是 theme/icons.ts 的 key；导航文案与图标的对应关系只在这一处
	const nav: NavLink[] = [
		{ text: '首页', url: homePath(), icon: 'home' },
		{ text: '分类', url: overviewPath('categories'), icon: 'categories' },
		{ text: '标签', url: overviewPath('tags'), icon: 'tags' },
		{ text: '归档', url: overviewPath('archives'), icon: 'archives' },
	];
	const about = snapshot.pages.find((page) => page.slug === ABOUT_SLUG);
	if (about) nav.push({ text: '关于', url: standalonePagePath(about.slug), icon: 'about' });
	return nav;
}

/**
 * 术语 → 索引项。**只列还有文章的分类/标签**：库里有一批只挂在草稿上的标签
 * （本库 76 个，它们的归档页确实存在、也进 sitemap），列进清单只会把人带到空页面。
 *
 * 排序必须**确定性**：文章数降序 → 名称升序 → mid 升序。名称可能重复，
 * 用 mid 兜底才能保证同一份数据每次渲染出的顺序一致（否则对象内容会无谓地漂）。
 */
function termItems(terms: TermRecord[], path: (slug: string) => string): OverviewItem[] {
	return terms
		.filter((term) => term.count > 0)
		.sort((a, b) => {
			if (b.count !== a.count) return b.count - a.count;
			if (a.name !== b.name) return a.name < b.name ? -1 : 1;
			return a.mid - b.mid;
		})
		.map((term) => ({
			name: term.name,
			url: path(term.slug),
			count: term.count,
			description: term.description,
		}));
}

// ---------------------------------------------------------------------------
// 各类型对象
// ---------------------------------------------------------------------------

function renderArticleOrPage(
	snapshot: SiteSnapshot,
	target: Extract<Target, { kind: 'post' | 'page' }>,
	nav: NavLink[],
): RenderedObject {
	const { post } = target;

	// 独立页面没有上一篇/下一篇；文章按 created 倒序取相邻两条
	let prev: { title: string; url: string } | undefined;
	let next: { title: string; url: string } | undefined;
	if (target.kind === 'post') {
		const index = snapshot.posts.findIndex((item) => item.cid === post.cid);
		if (index >= 0) {
			// 上一篇 = 更旧（倒序里的后一条），下一篇 = 更新（前一条）—— 与线上站点一致
			const older = snapshot.posts[index + 1];
			const newer = index > 0 ? snapshot.posts[index - 1] : undefined;
			if (older) prev = { title: older.title, url: articlePath(older) };
			if (newer) next = { title: newer.title, url: articlePath(newer) };
		}
	}

	const canonicalPath =
		target.canonicalPath ?? (target.kind === 'page' ? standalonePagePath(post.slug) : articlePath(post));

	const html = renderPost({
		site: snapshot.site,
		post: {
			cid: post.cid,
			title: post.title,
			url: canonicalPath,
			created: post.created,
			modified: post.modified,
			html: post.html,
			author: post.author,
			categories: toTermLinks(post.categories),
			tags: toTermLinks(post.tags),
			words: post.words,
		},
		// 渲染真正的文章页时，canonical 就是它自己的地址；
		// 渲染旧 URL 页时，target.canonicalPath 会把它指向新地址（§5.1 方案 A）
		canonicalPath,
		prev,
		next,
		nav,
	});

	return { key: target.key, kind: 'post', body: html, contentType: HTML_CONTENT_TYPE };
}

function renderIndex(
	snapshot: SiteSnapshot,
	target: Extract<Target, { kind: 'index' }>,
	nav: NavLink[],
): RenderedObject {
	const perPage = snapshot.postsPerPage;
	const totalPosts = snapshot.posts.length;
	const totalPages = pageCount(totalPosts, perPage);
	const page = target.page === 0 ? 1 : target.page;

	const html = renderHome({
		site: snapshot.site,
		posts: pageSlice(snapshot.posts, page, perPage).map(toListPost),
		page,
		totalPages,
		prevUrl: page > 1 ? indexPagePath(page - 1) : undefined,
		nextUrl: page < totalPages ? indexPagePath(page + 1) : undefined,
		// `/` 与 `/page/1/` 内容重复：两者的 canonical 都指向 `/`，且 `page/1/` 不进 sitemap
		canonicalPath: page === 1 ? '/' : indexPagePath(page),
		nav,
	});

	return { key: target.key, kind: 'index', body: html, contentType: HTML_CONTENT_TYPE };
}

function termPaths(term: TermRecord): { bare: string; page: (page: number) => string } {
	return term.type === 'category'
		? { bare: categoryPath(term.slug), page: (page: number) => categoryPath(term.slug, page) }
		: { bare: tagPath(term.slug), page: (page: number) => tagPath(term.slug, page) };
}

function postsOfTerm(snapshot: SiteSnapshot, term: TermRecord): PostRecord[] {
	return snapshot.posts.filter((post) =>
		term.type === 'category'
			? post.categories.some((item) => item.mid === term.mid)
			: post.tags.some((item) => item.mid === term.mid),
	);
}

function renderTermArchive(
	snapshot: SiteSnapshot,
	target: Extract<Target, { kind: 'archive' }>,
	nav: NavLink[],
): RenderedObject {
	const { term } = target;
	const perPage = snapshot.postsPerPage;
	const totalPages = pageCount(term.count, perPage);
	const page = target.page === 0 ? 1 : target.page;
	const paths = termPaths(term);

	const title = term.type === 'category' ? `分类 ${term.name} 下的文章` : `标签 ${term.name} 下的文章`;

	const html = renderArchive({
		site: snapshot.site,
		title,
		description: term.description,
		posts: pageSlice(postsOfTerm(snapshot, term), page, perPage).map(toListPost),
		page,
		totalPages,
		// 第 2 页的「上一页」回到裸 URL，而不是 `…/1/`（后者是副本）
		prevUrl: page > 1 ? (page - 1 === 1 ? paths.bare : paths.page(page - 1)) : undefined,
		nextUrl: page < totalPages ? paths.page(page + 1) : undefined,
		canonicalPath: page === 1 ? paths.bare : paths.page(page),
		nav,
	});

	return { key: target.key, kind: 'archive', body: html, contentType: HTML_CONTENT_TYPE };
}

function renderMonthArchive(
	snapshot: SiteSnapshot,
	target: Extract<Target, { kind: 'month' }>,
	nav: NavLink[],
): RenderedObject {
	const { year, month } = target;
	const timezoneOffset = snapshot.site.timezoneOffset;
	const posts = snapshot.posts.filter((post) => {
		const created = monthOf(post.created, timezoneOffset);
		return created.year === year && created.month === month;
	});

	/**
	 * 年月归档**不分页** —— 实测 `/2025/11/1/` 与 `/2025/11/2/` 都是 404，
	 * 说明线上这个 permalink 形态没有分页变体。当前没有任何月份超过一页，
	 * 万一将来某个月超过 `posts_per_page`，这里会把该月全部列出（不丢内容），
	 * 但分页 URL 形态需要重新核对线上站点。
	 */
	const html = renderArchive({
		site: snapshot.site,
		title: `${year} 年 ${month} 月`,
		posts: posts.map(toListPost),
		page: 1,
		totalPages: 1,
		canonicalPath: monthPath(year, month),
		nav,
	});

	return { key: target.key, kind: 'archive', body: html, contentType: HTML_CONTENT_TYPE };
}

/**
 * 全站索引页：`/categories/`、`/tags/`、`/archives/`（顶栏导航的落点）。
 *
 * 它们承担的是原来侧栏那份「浏览入口」的职责，但**只在这三个对象里**出现计数 ——
 * 这正是「文章页去掉侧栏」换来的收益：可变数据从 765 个页面收敛到 3 个。
 */
function renderOverviewPage(
	snapshot: SiteSnapshot,
	target: Extract<Target, { kind: 'overview' }>,
	nav: NavLink[],
): RenderedObject {
	const { section } = target;

	let title: string;
	let items: OverviewItem[];
	/**
	 * 排布方式：分类只有 7 条、每条还带一句描述，一行一条最好读；
	 * 标签 198 条、归档 58 个月份，一行一条会拖成一屏半的竖直列表，改成流式排列。
	 */
	let layout: OverviewLayout;
	switch (section) {
		case 'categories':
			title = '分类';
			items = termItems(snapshot.categories, categoryPath);
			layout = 'list';
			break;
		case 'tags':
			title = '标签';
			items = termItems(snapshot.tags, tagPath);
			layout = 'flow';
			break;
		case 'archives':
			title = '归档';
			// `snapshot.months` 已经是倒序（最近的月份在前），这里不再排一次 ——
			// 同一年天然相邻，`group` 正是靠这个切连续段的（见 theme/overview.ts）
			items = snapshot.months.map((month) => ({
				name: `${month.month} 月`,
				url: monthPath(month.year, month.month),
				count: month.count,
				group: `${month.year} 年`,
			}));
			layout = 'flow';
			break;
	}

	/**
	 * 刻意**不传页面说明**（原先这里是「共 7 个分类（只列有文章的），按文章数排列」这类）：
	 * 数量对读者没用，扫一眼清单本身就够了；而且措辞很容易和实际渲染不一致
	 * （`termItems` 会滤掉计数为 0 的术语 —— 本库有 76 个只挂在草稿上的标签）。
	 * 少一句话就少一个「说明和内容对不上」的机会。
	 */
	const html = renderOverview({
		site: snapshot.site,
		title,
		items,
		layout,
		emptyText: section === 'archives' ? '还没有文章，所以没有归档。' : `还没有任何${title}。`,
		canonicalPath: overviewPath(section),
		nav,
	});

	return { key: target.key, kind: 'overview', body: html, contentType: HTML_CONTENT_TYPE };
}

// ---------------------------------------------------------------------------
// Feed 与 Sitemap
// ---------------------------------------------------------------------------

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/** 包进 CDATA，顺手拆掉正文里可能出现的 `]]>` */
function cdata(value: string): string {
	return `<![CDATA[${value.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

function renderFeed(snapshot: SiteSnapshot): string {
	const base = snapshot.site.url;
	const items = snapshot.posts.slice(0, FEED_ITEMS);
	const lastBuild = items[0]?.modified ?? items[0]?.created;

	const itemXml = items
		.map((post) => {
			const link = absoluteUrl(base, articlePath(post));
			return `	<item>
		<title>${xmlEscape(post.title)}</title>
		<link>${xmlEscape(link)}</link>
		<guid isPermaLink="true">${xmlEscape(link)}</guid>
		<pubDate>${formatRfc822(post.created)}</pubDate>
		<description>${xmlEscape(makeExcerpt(summaryView(post)))}</description>
		<content:encoded>${cdata(post.html)}</content:encoded>
	</item>`;
		})
		.join('\n');

	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
	<title>${xmlEscape(snapshot.site.title)}</title>
	<link>${xmlEscape(absoluteUrl(base, '/'))}</link>
	<description>${xmlEscape(snapshot.site.description ?? '')}</description>
	<language>zh-CN</language>
	<atom:link href="${xmlEscape(absoluteUrl(base, '/feed/'))}" rel="self" type="application/rss+xml" />
${lastBuild ? `	<lastBuildDate>${formatRfc822(lastBuild)}</lastBuildDate>\n` : ''}${itemXml}
</channel>
</rss>
`;
}

/**
 * sitemap 只列「规范 URL」：
 *  - 首页 + `page/2/`…（**不列 `page/1/`**，它与首页重复，§5.1）
 *  - 文章、独立页面
 *  - 分类/标签的裸 URL + 第 2 页起（**不列 `…/1/` 副本**）
 *  - 年月归档
 * 旧 permalink（§5.1 方案 A）有 canonical 指向新地址，所以不列。
 */
function renderSitemap(snapshot: SiteSnapshot): string {
	const base = snapshot.site.url;
	const perPage = snapshot.postsPerPage;
	const entries: { loc: string; lastmod?: string }[] = [];

	const newest = snapshot.posts[0];
	entries.push({ loc: absoluteUrl(base, '/'), lastmod: newest ? formatDateOnly(newest.modified) : undefined });

	const totalIndexPages = pageCount(snapshot.posts.length, perPage);
	for (let page = 2; page <= totalIndexPages; page++) {
		entries.push({ loc: absoluteUrl(base, indexPagePath(page)) });
	}

	// 索引页：三个固定 URL，不做分页（导航入口，不该被拆成好几页）
	for (const section of OVERVIEW_SECTIONS) {
		entries.push({ loc: absoluteUrl(base, overviewPath(section)) });
	}

	for (const post of snapshot.posts) {
		entries.push({ loc: absoluteUrl(base, articlePath(post)), lastmod: formatDateOnly(post.modified) });
	}
	for (const page of snapshot.pages) {
		entries.push({ loc: absoluteUrl(base, standalonePagePath(page.slug)), lastmod: formatDateOnly(page.modified) });
	}

	for (const term of [...snapshot.categories, ...snapshot.tags]) {
		const paths = termPaths(term);
		entries.push({ loc: absoluteUrl(base, paths.bare) });
		const totalPages = pageCount(term.count, perPage);
		for (let page = 2; page <= totalPages; page++) {
			entries.push({ loc: absoluteUrl(base, paths.page(page)) });
		}
	}

	for (const month of snapshot.months) {
		entries.push({ loc: absoluteUrl(base, monthPath(month.year, month.month)) });
	}

	const body = entries
		.map((entry) =>
			entry.lastmod
				? `	<url><loc>${xmlEscape(entry.loc)}</loc><lastmod>${entry.lastmod}</lastmod></url>`
				: `	<url><loc>${xmlEscape(entry.loc)}</loc></url>`,
		)
		.join('\n');

	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 渲染一个目标对象。
 *
 * `nav` 做成参数是为了让 `renderTargets` 只算一次（见 `toNav` 的注释）；
 * 直接调用本函数（草稿预览就这么用）时不传，默认值会当场算一份。
 */
export function renderTarget(
	snapshot: SiteSnapshot,
	target: Target,
	nav: NavLink[] = toNav(snapshot),
): RenderedObject {
	switch (target.kind) {
		case 'post':
		case 'page':
			return renderArticleOrPage(snapshot, target, nav);
		case 'index':
			return renderIndex(snapshot, target, nav);
		case 'overview':
			return renderOverviewPage(snapshot, target, nav);
		case 'archive':
			return renderTermArchive(snapshot, target, nav);
		case 'month':
			return renderMonthArchive(snapshot, target, nav);
		case 'feed':
			return { key: target.key, kind: 'feed', body: renderFeed(snapshot), contentType: FEED_CONTENT_TYPE };
		case 'sitemap':
			return {
				key: target.key,
				kind: 'sitemap',
				body: renderSitemap(snapshot),
				contentType: SITEMAP_CONTENT_TYPE,
			};
		case 'asset': {
			// 内容和 contentType 的权威来源是清单本身，这里只做搬运（§7.2 的 immutable 由 kind 决定）
			const asset = themeAsset(target.name);
			return { key: target.key, kind: 'asset', body: asset.content, contentType: asset.contentType };
		}
	}
}

export function renderTargets(
	snapshot: SiteSnapshot,
	targets: Target[],
	nav: NavLink[] = toNav(snapshot),
): RenderedObject[] {
	return targets.map((target) => renderTarget(snapshot, target, nav));
}

/** 全站渲染：§12.2 首次发布与 §6.5 「全站重新渲染」都用它 */
export function renderSite(snapshot: SiteSnapshot): RenderedObject[] {
	return renderTargets(snapshot, siteTargets(snapshot));
}
