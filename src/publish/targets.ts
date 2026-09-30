/**
 * 一次发布/重建要产出哪些对象 —— 设计文档 §5.3 / §6.3 / §11
 *
 * 纯函数：只算 key 与参数，不碰数据库也不拼 HTML。渲染在 `render.ts`。
 *
 * ⚠️ **调用方必须传入「已更新」的快照**：新文章要已经在 `posts` 里、
 * 对应 `TermRecord.count` 要已经重算、`months` 要已经补上。
 * 否则分页对象会算少（例如新文章让某个标签从 1 页变成 2 页，而快照还停留在 1 页）。
 */

import {
	FEED_KEY,
	HOME_KEY,
	SITEMAP_KEY,
	categoryKey,
	indexPageKey,
	monthKey,
	pageCount,
	postKey,
	standalonePageKey,
	tagKey,
} from '../lib/url';
import { monthOf } from '../lib/time';
import type { PostRecord, SiteSnapshot, Target, TermRecord } from './types';

/**
 * 文章 URL 里的分类段取**第一个分类**（§5.1）。
 *
 * 这意味着 models 层必须用确定顺序返回分类（建议 `metas.mid ASC`），
 * 否则同一篇文章的 URL 会随查询顺序漂移 —— 那是索引灾难。
 */
export function primaryCategory(post: PostRecord): TermRecord {
	const category = post.categories[0];
	if (!category) {
		throw new Error(
			`cid=${post.cid} 没有分类：permalink 形状是 /<category>/<slug>.html，无法生成 URL`,
		);
	}
	return category;
}

export function postKeyOf(post: PostRecord): string {
	return postKey(primaryCategory(post).slug, post.slug);
}

export function standaloneKeyOf(page: PostRecord): string {
	return standalonePageKey(page.slug);
}

/** 首页 + 全部分页（page/1/ 是首页的副本，也要生成，§5.1） */
function indexTargets(snapshot: SiteSnapshot): Target[] {
	const totalPages = pageCount(snapshot.posts.length, snapshot.postsPerPage);
	const targets: Target[] = [{ key: HOME_KEY, kind: 'index', page: 0 }];
	for (let page = 1; page <= totalPages; page++) {
		targets.push({ key: indexPageKey(page), kind: 'index', page });
	}
	return targets;
}

/**
 * 分类/标签归档：裸 URL + 第 1…N 页。
 *
 * **第 1 页副本（`/category/x/1/`）也要生成** —— 线上存在且返回 200，
 * 分页器在有多页时会链到它（§5.1 的 URL 保全原则）。
 */
function termTargets(term: TermRecord, perPage: number, keyOf: (slug: string, page?: number) => string): Target[] {
	const totalPages = pageCount(term.count, perPage);
	const targets: Target[] = [{ key: keyOf(term.slug), kind: 'archive', term, page: 0 }];
	for (let page = 1; page <= totalPages; page++) {
		targets.push({ key: keyOf(term.slug, page), kind: 'archive', term, page });
	}
	return targets;
}

function monthTargets(snapshot: SiteSnapshot): Target[] {
	return snapshot.months.map((entry) => ({
		key: monthKey(entry.year, entry.month),
		kind: 'month' as const,
		year: entry.year,
		month: entry.month,
	}));
}

/**
 * **全站对象清单** —— 首次发布（§12.2）与「全站重新渲染」（§6.5）用它。
 */
export function siteTargets(snapshot: SiteSnapshot): Target[] {
	const perPage = snapshot.postsPerPage;
	const byCid = new Map(snapshot.posts.map((post) => [post.cid, post]));

	const targets: Target[] = [
		...indexTargets(snapshot),
		...snapshot.posts.map((post) => ({ key: postKeyOf(post), kind: 'post' as const, post })),
		...snapshot.pages.map((page) => ({
			key: standaloneKeyOf(page),
			kind: 'page' as const,
			post: page,
		})),
		...snapshot.categories.flatMap((term) => termTargets(term, perPage, categoryKey)),
		...snapshot.tags.flatMap((term) => termTargets(term, perPage, tagKey)),
		...monthTargets(snapshot),
		// §5.1 方案 A：旧 permalink 保留 200 + canonical 指向新地址
		...snapshot.retired.flatMap((retired) => {
			const post = byCid.get(retired.cid);
			return post
				? [{ key: retired.key, kind: 'post' as const, post, canonicalPath: retired.canonicalPath }]
				: [];
		}),
		{ key: FEED_KEY, kind: 'feed' },
		{ key: SITEMAP_KEY, kind: 'sitemap' },
	];

	return dedupeByKey(targets);
}

/**
 * 发布一篇文章后需要重建的**子集**（§6.3）。
 *
 * 同步部分只有文章页本身，其余交给 `ctx.waitUntil()`。
 * 注意偏移分页会让**首页与全部分页整体顺移**，所以它们全在清单里 —— 这也是 §5.3 的结论：
 * 一次发布约 30~40 个对象，量级上完全不需要优化。
 */
export function postPublishTargets(snapshot: SiteSnapshot, post: PostRecord): Target[] {
	const perPage = snapshot.postsPerPage;
	const wanted = new Set<string>([postKeyOf(post)]);

	for (const target of indexTargets(snapshot)) wanted.add(target.key);
	for (const target of termTargets(primaryCategory(post), perPage, categoryKey)) wanted.add(target.key);
	for (const tag of post.tags) {
		for (const target of termTargets(tag, perPage, tagKey)) wanted.add(target.key);
	}

	const created = monthOf(post.created, snapshot.site.timezoneOffset);
	wanted.add(monthKey(created.year, created.month));
	wanted.add(FEED_KEY);
	wanted.add(SITEMAP_KEY);

	return siteTargets(snapshot).filter((target) => wanted.has(target.key));
}

/** 文章被删除时要清掉的对象（其余归档靠重建覆盖） */
export function postDeleteKeys(post: PostRecord): string[] {
	return [postKeyOf(post)];
}

/** 同一 key 出现两次是数据问题的信号，这里静默去重并保留第一个 */
function dedupeByKey(targets: Target[]): Target[] {
	const seen = new Set<string>();
	const result: Target[] = [];
	for (const target of targets) {
		if (seen.has(target.key)) continue;
		seen.add(target.key);
		result.push(target);
	}
	return result;
}
