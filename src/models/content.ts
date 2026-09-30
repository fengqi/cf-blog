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
import { refreshMetaCountsStatement } from './meta';
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
		status: row.status ?? 'publish',
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
 * `status='hidden'` 的文章与独立页面（一条 SQL 拿完，再按 type 分）。
 *
 * Typecho 的 hidden 语义是「有 URL、可访问，但不进列表」—— 线上实测这些 URL 全部 200，
 * 所以迁移时必须照样生成页面，否则就是几十个 404（§5.1 的 URL 保全）。
 */
export async function listHiddenContent(db: Db): Promise<PostRecord[]> {
	const rows = await db.all<ContentRow>(
		`SELECT c.cid, c.title, c.slug, c.created, c.modified, c.rendered, c.excerpt, c.words, c.type, c.status,
		        ${metaAggregate(null)} AS metas
		   FROM contents c
		  WHERE c.type IN ('post','page') AND c.status = 'hidden'
		  ORDER BY c.created DESC, c.cid DESC`,
	);
	return rows.map((row) => toPostRecord(row, parseTerms(row.metas)));
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
// 后台列表与编辑器
// ---------------------------------------------------------------------------

export interface AdminPostRow {
	cid: number;
	title: string;
	slug: string;
	type: 'post' | 'page';
	status: string;
	created: number;
	modified: number;
	words: number;
	needs_sync: number;
	excerpt: string | null;
	categories: TermRecord[];
}

/**
 * 后台文章列表 —— **刻意不回捞 `rendered`**（§5.2：要精简查询就单独开一个，
 * 别去动 `listPublishedPosts`，那个是给渲染用的，必须「渲染完备」）。
 */
/** 后台列表筛选（§6.5）：关键词匹配标题/缩略名，状态精确，分类按关系表 */
export interface AdminPostFilter {
	q?: string;
	status?: string;
	categoryMid?: number;
}

/** 后台列表筛选（§6.5）：关键词匹配标题/缩略名，状态精确，分类按关系表 */
export interface AdminPostFilter {
	q?: string;
	status?: string;
	categoryMid?: number;
}

/** 组装筛选 WHERE —— 列表查询与计数查询共用，保证两边口径一致 */
function adminPostWhere(filter: AdminPostFilter): { sql: string; params: (string | number)[] } {
	const where: string[] = ["c.type IN ('post','page')"];
	const params: (string | number)[] = [];
	if (filter.q) {
		where.push('(c.title LIKE ? OR c.slug LIKE ?)');
		const like = `%${filter.q}%`;
		params.push(like, like);
	}
	if (filter.status) {
		where.push('c.status = ?');
		params.push(filter.status);
	}
	if (filter.categoryMid !== undefined) {
		where.push('EXISTS (SELECT 1 FROM relationships fr WHERE fr.cid = c.cid AND fr.mid = ?)');
		params.push(filter.categoryMid);
	}
	return { sql: where.join(' AND '), params };
}

/** 筛选条件下的内容总数（分页用），与 listAdminPosts 同一口径 */
export async function countAdminPosts(db: Db, filter: AdminPostFilter = {}): Promise<number> {
	const { sql, params } = adminPostWhere(filter);
	const rows = await db.all<{ count: number }>(`SELECT COUNT(*) AS count FROM contents c WHERE ${sql}`, params);
	return rows[0]?.count ?? 0;
}

export async function listAdminPosts(
	db: Db,
	limit = 200,
	filter: AdminPostFilter = {},
	offset = 0,
): Promise<AdminPostRow[]> {
	const { sql, params } = adminPostWhere(filter);
	params.push(limit, offset);
	const rows = await db.all<ContentRow & { needs_sync: number }>(
		`SELECT c.cid, c.title, c.slug, c.type, c.status, c.created, c.modified, c.words,
		        c.needs_sync, c.excerpt, ${metaAggregate('category')} AS categories
		   FROM contents c
		  WHERE ${sql}
		  ORDER BY c.created DESC, c.cid DESC
		  LIMIT ? OFFSET ?`,
		params,
	);
	return rows.map((row) => ({
		cid: row.cid,
		title: row.title,
		slug: row.slug,
		type: row.type === 'page' ? 'page' : 'post',
		status: row.status ?? 'draft',
		created: row.created,
		modified: row.modified,
		words: row.words,
		needs_sync: row.needs_sync,
		excerpt: row.excerpt,
		categories: parseTerms(row.categories),
	}));
}

/** 编辑器视图：Markdown 原文 + 关系（分类 mid、标签名）—— 一条 SQL */
export interface EditorView {
	cid: number;
	title: string;
	slug: string;
	body: string;
	excerpt: string;
	status: string;
	type: 'post' | 'page';
	created: number;
	allow_feed: number;
	categoryIds: number[];
	tagNames: string[];
}

export async function getEditorView(db: Db, cid: number): Promise<EditorView | null> {
	const row = await db.first<{
		cid: number;
		title: string;
		slug: string;
		body: string;
		excerpt: string | null;
		status: string;
		type: string;
		created: number;
		allow_feed: number;
		category_ids: string | null;
		tag_names: string | null;
	}>(
		`SELECT c.cid, c.title, c.slug, c.body, c.excerpt, c.status, c.type, c.created, c.allow_feed,
		        (SELECT json_group_array(m.mid) FROM relationships r JOIN metas m ON m.mid = r.mid
		          WHERE r.cid = c.cid AND m.type = 'category') AS category_ids,
		        (SELECT json_group_array(m.name) FROM relationships r JOIN metas m ON m.mid = r.mid
		          WHERE r.cid = c.cid AND m.type = 'tag') AS tag_names
		   FROM contents c
		  WHERE c.cid = ?
		  LIMIT 1`,
		[cid],
	);
	if (!row) return null;

	return {
		cid: row.cid,
		title: row.title,
		slug: row.slug,
		body: row.body,
		excerpt: row.excerpt ?? '',
		status: row.status,
		type: row.type === 'page' ? 'page' : 'post',
		created: row.created,
		allow_feed: row.allow_feed,
		categoryIds: parseNumberArray(row.category_ids),
		tagNames: parseStringArray(row.tag_names),
	};
}

function parseNumberArray(value: string | null): number[] {
	try {
		const parsed: unknown = JSON.parse(value ?? '[]');
		return Array.isArray(parsed) ? (parsed as number[]) : [];
	} catch {
		return [];
	}
}

function parseStringArray(value: string | null): string[] {
	try {
		const parsed: unknown = JSON.parse(value ?? '[]');
		return Array.isArray(parsed) ? (parsed as string[]) : [];
	} catch {
		return [];
	}
}

export interface ContentInput {
	title: string;
	slug: string;
	body: string;
	excerpt: string;
	status: string;
	created: number;
	allowFeed: number;
	type: 'post' | 'page';
}

/**
 * 新建内容。
 *
 * **缩略名为空时用 cid 兜底**（§5.1：「`<slug>` 未填缩略名时即 cid」）——
 * 所以先插入拿到 cid，再回填 slug（两条语句）。
 */
export async function createContent(db: Db, input: ContentInput, authorId: number): Promise<number> {
	const now = Math.floor(Date.now() / 1000);
	const result = await db.run(
		`INSERT INTO contents (title, slug, created, modified, body, rendered, excerpt, sort_order,
		                       author_id, type, status, allow_feed, parent, words, needs_sync)
		 VALUES (?, ?, ?, ?, ?, '', ?, 0, ?, ?, ?, ?, 0, 0, 1)`,
		[
			input.title,
			input.slug.trim(),
			input.created,
			now,
			input.body,
			input.excerpt,
			authorId,
			input.type,
			input.status,
			input.allowFeed,
		],
	);
	const cid = Number(result.meta.last_row_id);
	if (!input.slug.trim()) {
		await db.run('UPDATE contents SET slug = ? WHERE cid = ?', [String(cid), cid]);
	}
	return cid;
}

/** 更新正文字段；`rendered` 由发布流水线负责（不在这里拼 HTML） */
export async function updateContentFields(db: Db, cid: number, input: ContentInput): Promise<void> {
	await db.run(
		`UPDATE contents
		    SET title = ?, slug = ?, body = ?, excerpt = ?, status = ?, created = ?,
		        allow_feed = ?, modified = ?
		  WHERE cid = ?`,
		[
			input.title,
			input.slug.trim(),
			input.body,
			input.excerpt,
			input.status,
			input.created,
			input.allowFeed,
			Math.floor(Date.now() / 1000),
			cid,
		],
	);
	if (!input.slug.trim()) {
		await db.run('UPDATE contents SET slug = ? WHERE cid = ?', [String(cid), cid]);
	}
}

/**
 * 重设内容与分类/标签的关系。
 *
 * §4.3 的坑：改分类时新旧 meta 的 count 要在**同一个 batch** 里一起更新。
 * 这里把「删关系 + 插关系 + 刷新计数」放进一次 `db.batch()` —— 一次往返、一个事务。
 */
export async function setContentTerms(
	db: Db,
	cid: number,
	categoryIds: number[],
	tagIds: number[],
	currentCategoryIds: number[],
	currentTagIds: number[],
): Promise<void> {
	const affected = [...new Set([...currentCategoryIds, ...currentTagIds, ...categoryIds, ...tagIds])];
	const statements: D1PreparedStatement[] = [
		db.prepare('DELETE FROM relationships WHERE cid = ?', [cid]),
		...[...categoryIds, ...tagIds].map((mid) =>
			db.prepare('INSERT OR IGNORE INTO relationships (cid, mid) VALUES (?, ?)', [cid, mid]),
		),
	];
	const refresh = refreshMetaCountsStatement(db, affected);
	if (refresh) statements.push(refresh);
	await db.batch(statements);
}

/** §6.5「全站重新渲染」：把所有已发布内容标脏，交给 Cron 逐批重建 */
export async function markAllDirty(db: Db): Promise<number> {
	const result = await db.run(
		`UPDATE contents SET needs_sync = 1 WHERE type IN ('post','page') AND status = 'publish'`,
	);
	return result.meta.changes ?? 0;
}

/**
 * 记下旧 permalink（§4.2 ⑤）。
 *
 * 文章 URL 含分类 slug，**改分类或改缩略名都会让 URL 变化**。旧 key 不删，
 * 改写成带 canonical 的页面（§5.1 方案 A）—— 前提是这里留了痕。
 */
export async function recordPermalink(db: Db, cid: number, key: string): Promise<void> {
	await db.run(
		`INSERT OR REPLACE INTO permalink_history (cid, permalink, retired_at) VALUES (?, ?, ?)`,
		[cid, key, Math.floor(Date.now() / 1000)],
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
		  WHERE needs_sync = 1 AND type IN ('post','page') AND status IN ('publish','hidden')
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

/**
 * 后台首页显示「待同步」数量（§6.2 第 5 条：让作者看见异常，而不是靠运气发现）。
 *
 * ⚠️ 过滤条件必须和 `listNeedsSyncCids` **完全一致**（`type IN ('post','page')`），
 * 否则计数会永远停在一个对账轮次根本处理不到的行上 —— 附件就是这样：
 * 它的 `needs_sync` 是给「文件上传」那一步看的，不该出现在内容流水线的待办里。
 * （本地彩排里就卡在 `needsSync: 1` 上，查了半天。）
 */
export async function countNeedsSync(db: Db): Promise<number> {
	const row = await db.first<{ count: number }>(
		`SELECT COUNT(*) AS count FROM contents
		  WHERE needs_sync = 1 AND type IN ('post','page') AND status = 'publish'`,
	);
	return row?.count ?? 0;
}

// -------------------------------------------------------------------------
// 附件（媒体库）—— design.md §9：路径保持 /usr/uploads/<年>/<月>/<文件名>，
// 元信息照 Typecho 惯例存 contents（type='attachment'，mime/size/r2_key 专用列）
// -------------------------------------------------------------------------

export interface AttachmentRow {
	cid: number;
	title: string;
	created: number;
	mime: string | null;
	size: number;
	r2_key: string;
}

/** 后台媒体库列表（新→旧）；不回捞 body/rendered —— 附件没有这些 */
export async function listAttachments(db: Db, limit = 200): Promise<AttachmentRow[]> {
	return await db.all<AttachmentRow>(
		`SELECT cid, title, created, mime, size, r2_key
		   FROM contents
		  WHERE type = 'attachment' AND r2_key IS NOT NULL
		  ORDER BY created DESC, cid DESC
		  LIMIT ?`,
		[limit],
	);
}

export interface AttachmentInput {
	title: string;
	mime: string;
	size: number;
	r2Key: string;
	authorId: number;
}

/** 附件落库：needs_sync = 0 —— 附件不进内容渲染流水线，文件本体在上传时直接写 R2 */
export async function createAttachment(db: Db, input: AttachmentInput): Promise<number> {
	const now = Math.floor(Date.now() / 1000);
	const result = await db.run(
		`INSERT INTO contents (title, slug, created, modified, body, rendered, excerpt, sort_order,
		                       author_id, type, status, allow_feed, parent, words, mime, size, r2_key, needs_sync)
		 VALUES (?, ?, ?, ?, '', '', NULL, 0, ?, 'attachment', 'publish', 0, 0, 0, ?, ?, ?, 0)`,
		[input.title, String(now), now, now, input.authorId, input.mime, input.size, input.r2Key],
	);
	return Number(result.meta.last_row_id);
}

// ---------------------------------------------------------------------------
// 分类管理的影响面查询（routes/admin.tsx 用）
// ---------------------------------------------------------------------------

export interface CategoryPostRow {
	cid: number;
	slug: string;
	status: string;
	/** 这个分类下的文章，按 mid 升序 —— 与快照一致，categories[0] 就是主分类 */
	categories: TermRecord[];
}

/** 挂在某分类下的全部文章（含草稿/隐藏），带各自的全部分类 */
export async function listPostsInCategory(db: Db, mid: number): Promise<CategoryPostRow[]> {
	const rows = await db.all<{ cid: number; slug: string; status: string; categories: string | null }>(
		`SELECT c.cid, c.slug, c.status, ${metaAggregate('category')} AS categories
		   FROM contents c
		   JOIN relationships r ON r.cid = c.cid
		  WHERE r.mid = ? AND c.type = 'post'`,
		[mid],
	);
	return rows.map((row) => ({ cid: row.cid, slug: row.slug, status: row.status, categories: parseTerms(row.categories) }));
}

/** 批量记录旧地址（§5.1 方案 A）：分类 slug 变更/删除会让一批文章换 URL */
export async function recordPermalinks(db: Db, entries: { cid: number; key: string }[]): Promise<void> {
	if (entries.length === 0) return;
	const now = Math.floor(Date.now() / 1000);
	await db.batch(
		entries.map((entry) =>
			db.prepare('INSERT OR REPLACE INTO permalink_history (cid, permalink, retired_at) VALUES (?, ?, ?)', [
				entry.cid,
				entry.key,
				now,
			]),
		),
	);
}
