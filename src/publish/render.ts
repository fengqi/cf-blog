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
import { renderHome } from '../../theme/home';
import { renderPost } from '../../theme/post';
import type { ListPost } from '../../theme/components/list';
import type { TermLink } from '../../theme/post';
import { HTML_CONTENT_TYPE } from '../lib/r2';
import type { RenderedObject } from '../lib/r2';
import { formatDateOnly, formatRfc822, monthOf } from '../lib/time';
import {
	absoluteUrl,
	categoryPath,
	indexPagePath,
	monthPath,
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
	return {
		title: post.title,
		url: articlePath(post),
		created: post.created,
		excerpt: post.excerpt,
		categories: toTermLinks(post.categories),
	};
}

// ---------------------------------------------------------------------------
// 各类型对象
// ---------------------------------------------------------------------------

function renderArticleOrPage(snapshot: SiteSnapshot, target: Extract<Target, { kind: 'post' | 'page' }>): RenderedObject {
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
	});

	return { key: target.key, kind: 'post', body: html, contentType: HTML_CONTENT_TYPE };
}

function renderIndex(snapshot: SiteSnapshot, target: Extract<Target, { kind: 'index' }>): RenderedObject {
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

function renderTermArchive(snapshot: SiteSnapshot, target: Extract<Target, { kind: 'archive' }>): RenderedObject {
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
	});

	return { key: target.key, kind: 'archive', body: html, contentType: HTML_CONTENT_TYPE };
}

function renderMonthArchive(snapshot: SiteSnapshot, target: Extract<Target, { kind: 'month' }>): RenderedObject {
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
	});

	return { key: target.key, kind: 'archive', body: html, contentType: HTML_CONTENT_TYPE };
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
		<description>${xmlEscape(post.excerpt)}</description>
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

export function renderTarget(snapshot: SiteSnapshot, target: Target): RenderedObject {
	switch (target.kind) {
		case 'post':
		case 'page':
			return renderArticleOrPage(snapshot, target);
		case 'index':
			return renderIndex(snapshot, target);
		case 'archive':
			return renderTermArchive(snapshot, target);
		case 'month':
			return renderMonthArchive(snapshot, target);
		case 'feed':
			return { key: target.key, kind: 'feed', body: renderFeed(snapshot), contentType: FEED_CONTENT_TYPE };
		case 'sitemap':
			return {
				key: target.key,
				kind: 'sitemap',
				body: renderSitemap(snapshot),
				contentType: SITEMAP_CONTENT_TYPE,
			};
	}
}

export function renderTargets(snapshot: SiteSnapshot, targets: Target[]): RenderedObject[] {
	return targets.map((target) => renderTarget(snapshot, target));
}

/** 全站渲染：§12.2 首次发布与 §6.5 「全站重新渲染」都用它 */
export function renderSite(snapshot: SiteSnapshot): RenderedObject[] {
	return renderTargets(snapshot, siteTargets(snapshot));
}
