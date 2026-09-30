/**
 * 从 D1 装配一份站点快照 —— 设计文档 §5.2 / §6.1 第 5 步
 *
 * 这里是「查询预算」的落地点：**查询次数与文章数、标签数无关**。
 * 一共 7 次：
 *   1. options（站点配置）
 *   2. contents（可见文章 + 分类标签聚合）
 *   3. contents（独立页面）
 *   4. contents（hidden 内容：只生成页面、不进列表）
 *   5. metas（分类与标签，含相关子查询数出来的 count）
 *   6. contents（年月分组）
 *   7. permalink_history（旧 URL 留痕）
 *
 * 任何「查文章 → 循环查它的标签」都违反了 §1.4 铁律 4。
 */

import type { Db } from '../lib/db';
import { createDb } from '../lib/db';
import {
	listHiddenContent,
	listMonths,
	listPublishedPosts,
	listRetiredPermalinks,
	listStandalonePages,
} from '../models/content';
import { listAllTerms } from '../models/meta';
import { getSiteOptionsVia } from '../models/option';
import { postPath } from '../lib/url';
import { hasUrl, primaryCategory } from './targets';
import type { SiteSnapshot } from './types';

export interface SnapshotEnv {
	DB: D1Database;
}

export interface LoadedSnapshot {
	snapshot: SiteSnapshot;
	/** 这次装配实际发出的查询数（用于测试断言，别在业务里依赖它） */
	queries: number;
	db: Db;
}

export async function loadSnapshot(env: SnapshotEnv, label = 'snapshot'): Promise<LoadedSnapshot> {
	const db = createDb(env.DB, label);

	const options = await getSiteOptionsVia(db);
	const allPosts = await listPublishedPosts(db);
	const pages = await listStandalonePages(db);
	const hidden = await listHiddenContent(db);
	const terms = await listAllTerms(db);
	const months = await listMonths(db, options.timezoneOffset);
	const retired = await listRetiredPermalinks(db);

	/**
	 * 没有分类的文章在这里就丢掉：permalink 形状是 `/<category>/<slug>.html`，
	 * 拼不出地址就既不能渲染（列表项、归档都会炸）也不能生成 key。
	 * 它们的 `needs_sync` 仍是 1，所以会出现在后台的「待同步」计数里等人工修（§6.2 第 5 条）——
	 * 比让一整行脏数据把整条流水线炸掉要好。
	 */
	const posts = allPosts.filter((post) => {
		if (hasUrl(post)) return true;
		console.warn(`[snapshot] cid=${post.cid} 没有分类，已从快照中排除`);
		return false;
	});

	// 旧 URL 的 canonical 要指向文章**现在**的地址；文章已删除的旧 URL 不再生成
	const byCid = new Map(posts.map((post) => [post.cid, post]));
	const retiredTargets = retired.flatMap((entry) => {
		const post = byCid.get(entry.cid);
		if (!post) return [];
		return [{ key: entry.key, canonicalPath: postPath(primaryCategory(post).slug, post.slug), cid: entry.cid }];
	});

	return {
		snapshot: {
			site: {
				title: options.title,
				url: options.siteUrl,
				description: options.description,
				keywords: options.keywords,
				timezoneOffset: options.timezoneOffset,
			},
			postsPerPage: options.postsPerPage,
			posts,
			pages,
			hidden,
			categories: terms.filter((term) => term.type === 'category'),
			tags: terms.filter((term) => term.type === 'tag'),
			months,
			retired: retiredTargets,
		},
		queries: db.queries,
		db,
	};
}
