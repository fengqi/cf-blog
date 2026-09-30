/**
 * 一次发布/重建要产出哪些对象 —— 设计文档 §5.3 / §6.3 / §11
 *
 * 纯函数：只算 key 与参数，不碰数据库也不拼 HTML。渲染在 `render.ts`。
 *
 * ⚠️ **调用方必须传入「已更新」的快照**：新文章要已经在 `posts` 里、
 * 对应 `TermRecord.count` 要已经重算、`months` 要已经补上。
 * 否则分页对象会算少（例如新文章让某个标签从 1 页变成 2 页，而快照还停留在 1 页）。
 */

import { THEME_ASSETS } from '../../theme/assets';
import {
	FEED_KEY,
	HOME_KEY,
	OVERVIEW_SECTIONS,
	SITEMAP_KEY,
	categoryKey,
	indexPageKey,
	monthKey,
	overviewKey,
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

/**
 * 主题资源（带指纹的 CSS/JS）—— 每个都是一个独立的 R2 对象。
 *
 * **排在全站清单最前面**：`rebuildTargetsSlice` 是按下标切片的，
 * 把资源放在第 0 条，意味着**任何一次分批重建的第一批都会顺带刷新样式**。
 * 放到末尾的话，只跑前几批就以为「重建完了」的人会拿到新 HTML + 旧样式。
 */
export function themeAssetTargets(): Target[] {
	return THEME_ASSETS.map((asset) => ({ key: asset.key, kind: 'asset' as const, name: asset.name }));
}

/**
 * 给任意目标清单补上主题资源 —— **所有会写 HTML 的发布路径都必须经过这里**。
 *
 * 页面里注入的 `<link>`/`<script>` 指纹来自**当前部署的代码**：改了 theme/assets
 * 重新部署后，任何「只渲一部分对象」的路径（发一篇文章、Cron 对账、按分组渲染）
 * 写出的都是引用新指纹的 HTML —— 资源对象若还没进 R2，前台就是无样式页面
 * （2026-09-30 生产事故 ×2）。资源是幂等写（同 key 同内容，immutable 缓存不受影响），
 * 代价是每次发布多 2~3 个 PUT，换来「写出的 HTML 引用的指纹必然已存在」这条不变量。
 */
function withThemeAssets(targets: Target[]): Target[] {
	return [...themeAssetTargets(), ...targets];
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
 * 全站索引页：`/categories/`、`/tags/`、`/archives/`（顶栏导航的落点）。
 *
 * 它们是**全局可变数据**的展示面（每个分类/标签/月份的文章数），所以
 * 发一篇文章就会让三个对象一起变 —— 但只有 3 个，比让计数长期陈旧便宜得多。
 * 这也是「文章页不再带侧栏」换来的：可变数据从 765 个页面收敛到 3 个页面。
 */
export function overviewTargets(): Target[] {
	return OVERVIEW_SECTIONS.map((section) => ({
		key: overviewKey(section),
		kind: 'overview' as const,
		section,
	}));
}

/**
 * 内容有没有 URL。独立页面永远有（单段 key）；文章**必须有分类** ——
 * permalink 形状是 `/<category>/<slug>.html`，没分类就拼不出地址。
 */
export function hasUrl(record: PostRecord): boolean {
	return record.type === 'page' || record.categories.length > 0;
}

/**
 * **全站对象清单** —— 首次发布（§12.2）与「全站重新渲染」（§6.5）用它。
 *
 * 前置条件：快照里的文章**都已经有分类**（`loadSnapshot` 会把没分类的过滤掉）。
 */
export function siteTargets(snapshot: SiteSnapshot): Target[] {
	const perPage = snapshot.postsPerPage;
	const byCid = new Map(snapshot.posts.map((post) => [post.cid, post]));

	const targets: Target[] = [
		// 主题资源排最前，理由见 themeAssetTargets 的注释
		...themeAssetTargets(),
		...indexTargets(snapshot),
		...overviewTargets(),
		...snapshot.posts.map((post) => ({ key: postKeyOf(post), kind: 'post' as const, post })),
		...snapshot.pages.map((page) => ({
			key: standaloneKeyOf(page),
			kind: 'page' as const,
			post: page,
		})),
		// hidden：只生成页面，不进列表/归档/Feed/sitemap（Typecho 语义）
		...snapshot.hidden.map((record) =>
			record.type === 'page'
				? { key: standaloneKeyOf(record), kind: 'page' as const, post: record }
				: { key: postKeyOf(record), kind: 'post' as const, post: record },
		),
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
 *
 * ⚠️ `post` 参数**必须带上它的 tags**（否则标签归档不会进清单）——
 * 所以传的是 `getContentByCid` 拿到的完整记录，不是列表查询的瘦身版。
 */
export function postPublishTargets(snapshot: SiteSnapshot, post: PostRecord): Target[] {
	const perPage = snapshot.postsPerPage;
	const wanted = new Set<string>([postKeyOf(post)]);

	for (const target of indexTargets(snapshot)) wanted.add(target.key);
	// 索引页上带各术语的文章数，发一篇就会变 —— 3 个对象，直接一起重建
	for (const target of overviewTargets()) wanted.add(target.key);
	for (const target of termTargets(primaryCategory(post), perPage, categoryKey)) wanted.add(target.key);
	for (const tag of post.tags) {
		for (const target of termTargets(tag, perPage, tagKey)) wanted.add(target.key);
	}

	/**
	 * **这篇文章自己的旧 URL 也要重建**（§5.1 方案 A）。
	 *
	 * 少了这一步，改缩略名之后旧 URL 会继续以「自己就是规范地址」的状态对外服务 ——
	 * 方案 A 的 canonical 根本没写上去（本地 e2e 抓到的第四个 bug）。
	 */
	for (const retired of snapshot.retired) {
		if (retired.cid === post.cid) wanted.add(retired.key);
	}

	const created = monthOf(post.created, snapshot.site.timezoneOffset);
	wanted.add(monthKey(created.year, created.month));
	wanted.add(FEED_KEY);
	wanted.add(SITEMAP_KEY);

	return withThemeAssets(siteTargets(snapshot).filter((target) => wanted.has(target.key)));
}

/**
 * 独立页面变更后要重建的子集。
 *
 * 页面**不出现在**首页列表、归档、Feed 里，所以只有它自己和 sitemap 需要重建
 * （sitemap 里列了页面）。这一点和文章不同，别照抄 `postPublishTargets`。
 *
 * 三个索引页也**不用重建**：它们列的是分类/标签/月份的文章数，与独立页面无关。
 */
export function pagePublishTargets(snapshot: SiteSnapshot, page: PostRecord): Target[] {
	const wanted = new Set<string>([standaloneKeyOf(page), SITEMAP_KEY]);
	return withThemeAssets(siteTargets(snapshot).filter((target) => wanted.has(target.key)));
}

/**
 * 删除一篇文章后要重建的子集。
 *
 * 与 `postPublishTargets` 的唯一差别是**不含文章页本身**（已经被删了）。
 * 术语必须用**删除后的新快照**重新解析：传进来的 `record` 拿的是删除前的 count，
 * 按它算分页会多算一页。
 *
 * ⚠️ 调用时机：D1 里那条记录**必须已经删掉**，否则 `snapshot` 里还有它，
 * 分页与归档会照旧把它算进去。
 *
 * 本函数是「删一篇文章别重写全站 800 个对象」的落点：受影响的是
 * 首页+分页、三个索引页、该文章自己的分类/标签归档、所在月份、feed、sitemap。
 * 其余 700 多个对象和这次删除毫无关系。
 */
export function postDeleteTargets(snapshot: SiteSnapshot, record: PostRecord): Target[] {
	const perPage = snapshot.postsPerPage;
	const wanted = new Set<string>();

	for (const target of indexTargets(snapshot)) wanted.add(target.key);
	for (const target of overviewTargets()) wanted.add(target.key);

	for (const term of record.categories) {
		const current = snapshot.categories.find((item) => item.mid === term.mid);
		if (!current) continue;
		for (const target of termTargets(current, perPage, categoryKey)) wanted.add(target.key);
	}
	for (const term of record.tags) {
		const current = snapshot.tags.find((item) => item.mid === term.mid);
		if (!current) continue;
		for (const target of termTargets(current, perPage, tagKey)) wanted.add(target.key);
	}

	/**
	 * 该月如果一篇不剩，快照的 `months` 里就没有它了 —— 和 `siteTargets` 保持一致，
	 * **不硬造一个空归档**。（遗留影响：那个月份对象会永久留在 R2 上，
	 * 详见 `docs/design.md` 的「删除的边界」一节。）
	 */
	const created = monthOf(record.created, snapshot.site.timezoneOffset);
	if (snapshot.months.some((item) => item.year === created.year && item.month === created.month)) {
		wanted.add(monthKey(created.year, created.month));
	}

	wanted.add(FEED_KEY);
	wanted.add(SITEMAP_KEY);

	return withThemeAssets(siteTargets(snapshot).filter((target) => wanted.has(target.key)));
}

/**
 * 按内容类型与状态分发 —— 调用方不该自己去判断这是文章还是独立页面。
 *
 * `hidden` 只重建它自己（+ 它自己的旧 URL）：它不进列表、不进归档、不进 Feed/sitemap，
 * 所以改了它不会影响任何共享对象。
 */
export function contentPublishTargets(snapshot: SiteSnapshot, record: PostRecord): Target[] {
	if (record.status === 'hidden') {
		const own: Target =
			record.type === 'page'
				? { key: standaloneKeyOf(record), kind: 'page', post: record }
				: { key: postKeyOf(record), kind: 'post', post: record };
		const retired: Target[] = snapshot.retired
			.filter((entry) => entry.cid === record.cid)
			.map((entry) => ({ key: entry.key, kind: 'post', post: record, canonicalPath: entry.canonicalPath }));
		return withThemeAssets([own, ...retired]);
	}
	return record.type === 'page'
		? pagePublishTargets(snapshot, record)
		: postPublishTargets(snapshot, record);
}

/** 内容被删除时要清掉的对象（其余归档靠重建覆盖）——同样按类型分发 */
export function contentDeleteKeys(record: PostRecord): string[] {
	return record.type === 'page' ? [standaloneKeyOf(record)] : [postKeyOf(record)];
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

/**
 * 渲染维护页的**独立渲染分组**（§6.5）：一组 = 一类可以单独重渲的对象。
 *
 * `kind` 本身已经接近这个划分，只有一点例外：分类归档和标签归档共用
 * `kind: 'archive'`，靠 `term.type` 拆开 —— 两者的 URL 段和清单页都不同，
 * 改分类 slug 没理由连 200 个标签归档一起重写。
 */
export type TargetGroup =
	| 'assets'
	| 'index'
	| 'overview'
	| 'posts'
	| 'pages'
	| 'categories'
	| 'tags'
	| 'months'
	| 'feed'
	| 'sitemap';

export function targetGroup(target: Target): TargetGroup {
	switch (target.kind) {
		case 'asset':
			return 'assets';
		case 'index':
			return 'index';
		case 'overview':
			return 'overview';
		case 'post':
			return 'posts';
		case 'page':
			return 'pages';
		case 'archive':
			return target.term.type === 'category' ? 'categories' : 'tags';
		case 'month':
			return 'months';
		case 'feed':
			return 'feed';
		case 'sitemap':
			return 'sitemap';
	}
}

/** 渲染维护页按这个顺序展示分组按钮 */
export const TARGET_GROUPS: readonly TargetGroup[] = [
	'assets',
	'index',
	'overview',
	'posts',
	'pages',
	'categories',
	'tags',
	'months',
	'feed',
	'sitemap',
];

/** 把全站清单按分组过滤；不传 groups = 全部（全站渲染） */
export function filterTargetsByGroups(targets: Target[], groups?: ReadonlySet<string>): Target[] {
	if (!groups || groups.size === 0) return targets;
	return targets.filter((target) => groups.has(targetGroup(target)));
}
