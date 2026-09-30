/**
 * contents 表读写 —— 设计文档 §4.1 / §5.2 / §11
 *
 * 三条纪律：
 *  1. **分类与标签必须用 `json_group_array` 在同一条 SQL 里聚合**（§1.4 铁律 4），
 *     绝不允许「查文章 → 循环查分类」这种 N+1。
 *  2. 列表查询**不回捞 `rendered`** —— 摘要落库（`excerpt`）就是为了这个，
 *     一次发布不用把几百 KB 正文从 D1 拉过来。
 *  3. 写入只在这里出现，`routes/` 与 `theme/` 不碰数据库。
 */

import type { Db } from '../lib/db';
import type { MonthRecord, PostRecord, TermRecord } from '../publish/types';

/** 聚合分类/标签的公共子查询；`type` 传 null 表示全都聚合 */
function metaAggregate(type: 'category' | 'tag' | null): string {
	const filter = type ? `AND m2.type = '${type}'` : '';
	return `COALESCE((
		SELECT json_group_array(json_object(
			'mid', m.mid, 'name', m.name, 'slug', m.slug, 'type', m.type,
			'description', m.description, 'count', 0))
		  FROM (SELECT m2.mid, m2.name, m2.slug, m2.type, m2.description
		          FROM relationships r
		          JOIN metas m2 ON m2.mid = r.mid
		         WHERE r.cid = c.cid ${filter}
		         ORDER BY m2.type, m2.mid) AS m
	), '[]')`;
}

interface ContentRow {
	cid: number;
	title: string;
	slug: string;
	created: number;
	modified: number;
	body?: string;
	rendered?: string;
	excerpt: string | null;
	words: number;
	type: string;
	status?: string;
	allow_feed?: number;
	author_name?: string | null;
	author_url?: string | null;
	metas?: string | null;
	categories?: string | null;
}

function parseTerms(json: string | null | undefined): TermRecord[] {
	if (!json) return [];
	try {
		const parsed: unknown = JSON.parse(json);
		return Array.isArray(parsed) ? (parsed as TermRecord[]) : [];
	} catch {
		return [];
	}
}

function splitTerms(terms: TermRecord[]): { categories: TermRecord[]; tags: TermRecord[] } {
	return {
		categories: terms.filter((term) => term.type === 'category'),
		tags: terms.filter((term) => term.type === 'tag'),
	};
}

function toPostRecord(row: ContentRow, terms: TermRecord[], fallbackType: 'post' | 'page' = 'post'): PostRecord {
	const { categories, tags } = splitTerms(terms);
	return {
		cid: row.cid,
		type: row.type === 'page' ? 'page' : fallbackType,
		title: row.title,
		slug: row.slug,
		created: row.created,
		modified: row.modified,
		html: row.rendered ?? '',
		excerpt: row.excerpt ?? '',
		words: row.words,
		author: row.author_name ? { name: row.author_name, url: row.author_url ?? undefined } : undefined,
		categories,
		tags,
	};
}

/**
 * 单篇内容：文章 + 作者 + 分类标签聚合，**一次查询**（§5.2 查询 1）。
 * 发布与草稿预览都走它。
 */
export async function getContentByCid(db: Db, cid: number): Promise<PostRecord | null> {
	const row = await db.first<ContentRow>(
		`SELECT c.cid, c.title, c.slug, c.created, c.modified, c.body, c.rendered, c.excerpt,
		        c.words, c.type, c.status, c.allow_feed,
		        u.screen_name AS author_name, u.url AS author_url,
		        ${metaAggregate(null)} AS metas
		   FROM contents c
		   LEFT JOIN users u ON u.uid = c.author_id
		  WHERE c.cid = ?
		  LIMIT 1`,
		[cid],
	);
	if (!row) return null;
	return toPostRecord(row, parseTerms(row.metas));
}

/** 文章本体（含 Markdown 原文），发布流程需要 body */
export async function getContentBody(db: Db, cid: number): Promise<{ cid: number; body: string; excerpt: string | null } | null> {
	const row = await db.first<{ cid: number; body: string; excerpt: string | null }>(
		`SELECT cid, body, excerpt FROM contents WHERE cid = ? LIMIT 1`,
		[cid],
	);
	return row ?? null;
}

/**
 * 可见文章列表（含**分类、标签与正文**），按 created 倒序 —— 列表、分页、Feed、Sitemap 的输入。
 *
 * ⚠️ **快照必须是「渲染完备」的**，两处踩过坑（都由本地 e2e 抓到）：
 *   - 漏了 `rendered`：文章页只剩骨架没有正文
 *   - 漏了标签聚合：文章页的分类标签行缺一半、标签链接全丢
 * 想省流量就给后台的文章列表另写一个精简查询，**不要动这里**。
 * D1 的额度按 rows read 计，不按字节；120 篇 × 几 KB 完全不是问题。
 */
export async function listPublishedPosts(db: Db): Promise<PostRecord[]> {
	const rows = await db.all<ContentRow>(
		`SELECT c.cid, c.title, c.slug, c.created, c.modified, c.rendered, c.excerpt, c.words,
		        ${metaAggregate(null)} AS metas
		   FROM contents c
		  WHERE c.type = 'post' AND c.status = 'publish'
		  ORDER BY c.created DESC, c.cid DESC`,
	);
	return rows.map((row) => toPostRecord(row, parseTerms(row.metas), 'post'));
}

/** 独立页面：单段 URL，按 sort_order */
export async function listStandalonePages(db: Db): Promise<PostRecord[]> {
	const rows = await db.all<ContentRow>(
		`SELECT c.cid, c.title, c.slug, c.created, c.modified, c.rendered, c.excerpt, c.words
		   FROM contents c
		  WHERE c.type = 'page' AND c.status = 'publish'
		  ORDER BY c.sort_order, c.cid`,
	);
	return rows.map((row) => toPostRecord(row, [], 'page'));
}

/**
 * 年月归档列表。按月分组要在**站点时区**下算，所以把偏移量加进 Unix 时间再格式化 ——
 * 与 `src/lib/time.ts` 的 `monthOf()` 保持同一套语义。
 */
export async function listMonths(db: Db, timezoneOffset: number): Promise<MonthRecord[]> {
	const offsetSeconds = timezoneOffset * 3600;
	const rows = await db.all<{ year: string; month: string; count: number }>(
		`SELECT strftime('%Y', c.created + ?, 'unixepoch') AS year,
		        strftime('%m', c.created + ?, 'unixepoch') AS month,
		        COUNT(*) AS count
		   FROM contents c
		  WHERE c.type = 'post' AND c.status = 'publish'
		  GROUP BY year, month
		  ORDER BY year DESC, month DESC`,
		[offsetSeconds, offsetSeconds],
	);
	return rows.map((row) => ({
		year: Number.parseInt(row.year, 10),
		month: Number.parseInt(row.month, 10),
		count: row.count,
	}));
}

/** `permalink_history`：改过 slug/分类的文章，旧 key 处要留 200 + canonical（§5.1 方案 A） */
export async function listRetiredPermalinks(db: Db): Promise<{ cid: number; key: string }[]> {
	return await db.all<{ cid: number; key: string }>(
		`SELECT h.cid, h.permalink AS key
		   FROM permalink_history h
		   JOIN contents c ON c.cid = h.cid
		  WHERE c.status = 'publish'
		  ORDER BY h.retired_at DESC`,
	);
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

export interface RenderedFields {
	rendered: string;
	excerpt: string;
	words: number;
}

/**
 * 写回渲染结果。
 *
 * `needs_sync` 只在**已发布**的内容上置 1：草稿/私密文章不产出 R2 对象，
 * 把它们的脏标记立起来只会污染后台的「待同步」计数（§6.2 第 5 条）。
 */
export async function saveRendered(db: Db, cid: number, fields: RenderedFields): Promise<void> {
	await db.run(
		`UPDATE contents
		    SET rendered = ?, excerpt = ?, words = ?,
		        needs_sync = CASE WHEN status = 'publish' THEN 1 ELSE needs_sync END
		  WHERE cid = ?`,
		[fields.rendered, fields.excerpt, fields.words, cid],
	);
}

/** 内容状态（发布流水线判断要不要产出静态对象） */
export async function getContentStatus(db: Db, cid: number): Promise<string | null> {
	const row = await db.first<{ status: string }>('SELECT status FROM contents WHERE cid = ? LIMIT 1', [cid]);
	return row?.status ?? null;
}

/** 某篇内容留痕的旧 URL（§5.1 方案 A） */
export async function listRetiredKeysByCid(db: Db, cid: number): Promise<string[]> {
	const rows = await db.all<{ permalink: string }>(
		'SELECT permalink FROM permalink_history WHERE cid = ? ORDER BY retired_at DESC',
		[cid],
	);
	return rows.map((row) => row.permalink);
}

/**
 * 物理删除一条内容。`relationships` / `permalink_history` 靠外键 `ON DELETE CASCADE` 一起走
 * （D1 默认开启外键约束；即便没开，术语计数与旧 URL 查询都 JOIN 了 contents，孤儿行不会外泄）。
 *
 * 顺序很重要：**先删 D1 行，再删 R2 对象、再重建**。反过来的话，重建时的快照里还有这篇文章，
 * 会把刚删掉的对象又写回去（本地 e2e 抓到的第二个 bug）。
 */
export async function deleteContent(db: Db, cid: number): Promise<void> {
	await db.run('DELETE FROM contents WHERE cid = ?', [cid]);
}

export async function markSynced(db: Db, cids: number[]): Promise<void> {
	if (cids.length === 0) return;
	const placeholders = cids.map(() => '?').join(',');
	await db.run(
		`UPDATE contents SET needs_sync = 0, synced_at = ? WHERE cid IN (${placeholders})`,
		[Math.floor(Date.now() / 1000), ...cids],
	);
}

export async function markNeedsSync(db: Db, cids: number[]): Promise<void> {
	if (cids.length === 0) return;
	const placeholders = cids.map(() => '?').join(',');
	await db.run(`UPDATE contents SET needs_sync = 1 WHERE cid IN (${placeholders})`, cids);
}

/** Cron 对账扫描（§6.2 第 4 条） */
export async function listNeedsSyncCids(db: Db, limit = 20): Promise<number[]> {
	const rows = await db.all<{ cid: number }>(
		`SELECT cid FROM contents
		  WHERE needs_sync = 1 AND type IN ('post','page') AND status = 'publish'
		  ORDER BY modified ASC
		  LIMIT ?`,
		[limit],
	);
	return rows.map((row) => row.cid);
}

/** 到点该发布的定时文章（§12.3 ①） */
export async function listWaitingCids(db: Db, now: number): Promise<number[]> {
	const rows = await db.all<{ cid: number }>(
		`SELECT cid FROM contents
		  WHERE type = 'post' AND status = 'waiting' AND created <= ?
		  ORDER BY created ASC`,
		[now],
	);
	return rows.map((row) => row.cid);
}

/**
 * 到点该发布的定时文章转正（§12.3 ①）。
 * 同时把 `needs_sync` 置 1 —— 它们刚变成「已发布但还没写进 R2」，
 * 紧接着的对账步骤要能扫到（两步在同一次 Cron 触发里顺序执行）。
 */
export async function publishWaitingPosts(db: Db, now: number): Promise<number> {
	const result = await db.run(
		`UPDATE contents SET status = 'publish', modified = ?, needs_sync = 1
		  WHERE type = 'post' AND status = 'waiting' AND created <= ?`,
		[now, now],
	);
	return result.meta.changes ?? 0;
}

/** 后台首页显示「待同步」数量（§6.2 第 5 条：让作者看见异常，而不是靠运气发现） */
export async function countNeedsSync(db: Db): Promise<number> {
	const row = await db.first<{ count: number }>(
		`SELECT COUNT(*) AS count FROM contents WHERE needs_sync = 1 AND status = 'publish'`,
	);
	return row?.count ?? 0;
}
