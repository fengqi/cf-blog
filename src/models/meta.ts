/**
 * 分类与标签 —— 设计文档 §4.1 / §4.2 ③ / §11
 *
 * **渲染用的 count 不读 `metas.count`**：那是给后台列表看的冗余计数，
 * 改分类时漏更新就会长期偏差（§4.3 点名的坑）。这里实时数，但**必须用下面的
 * GROUP BY 聚合 + LEFT JOIN 的形状**：
 *
 * ⚠️ 别改回「每个术语一个相关 COUNT 子查询」—— SQLite 对那个形状选的执行计划是
 * 「扫全部已发布文章 × 反查关联」，实测 281 个术语一次要烧 **3.2 万 rows_read**
 * （D1 免费额度 500 万/天，快照每次加载都跑它，2026-09-30 曾把当天额度吃到 78%）。
 * JOIN 版只把 relationships/contents 各扫一遍，~1.7K 行。
 */

import type { Db } from '../lib/db';
import type { TermRecord } from '../publish/types';

export interface TermRow {
	mid: number;
	name: string;
	slug: string;
	type: 'category' | 'tag';
	description: string | null;
	sort_order: number;
	count: number;
}

/** 实时计数：一次聚合出「每个 mid 名下有几篇已发布文章」，再 JOIN 回术语表 */
const TERM_COUNT_JOIN = `
  LEFT JOIN (
    SELECT r.mid, COUNT(*) AS count
      FROM relationships r
      JOIN contents c ON c.cid = r.cid
     WHERE c.type = 'post' AND c.status = 'publish'
     GROUP BY r.mid
  ) cnt ON cnt.mid = m.mid`;

const TERM_SQL = `
SELECT m.mid, m.name, m.slug, m.type, m.description, m.sort_order,
       COALESCE(cnt.count, 0) AS count
  FROM metas m ${TERM_COUNT_JOIN}
 WHERE m.type = ?
 ORDER BY m.sort_order, m.mid`;

function toTerm(row: TermRow): TermRecord {
	return {
		mid: row.mid,
		name: row.name,
		slug: row.slug,
		type: row.type,
		description: row.description ?? undefined,
		count: row.count,
	};
}

export async function listTerms(db: Db, type: 'category' | 'tag'): Promise<TermRecord[]> {
	const rows = await db.all<TermRow>(TERM_SQL, [type]);
	return rows.map(toTerm);
}

/**
 * 重算若干分类/标签的冗余计数（§4.2 ③ / §4.3）。
 *
 * 渲染其实不依赖 `metas.count`（见文件头），但后台列表要显示它。
 * 改关系时把它一起刷新，避免长期偏差 —— 一条 SQL，不按 mid 循环。
 */
export function refreshMetaCountsStatement(db: Db, mids: number[]): D1PreparedStatement | null {
	if (mids.length === 0) return null;
	const placeholders = mids.map(() => '?').join(',');
	return db.prepare(
		`UPDATE metas
		    SET count = (SELECT COUNT(*)
		                   FROM relationships r
		                   JOIN contents c ON c.cid = r.cid
		                  WHERE r.mid = metas.mid AND c.type = 'post' AND c.status = 'publish')
		  WHERE mid IN (${placeholders})`,
		mids,
	);
}

/**
 * 按名字确保标签存在，返回它们的 mid。
 *
 * 新标签的 slug 就用名字本身（可能含中文，渲染时按 URL 编码 —— 实测可用，见 §9）。
 * 两条 SQL：先 `INSERT OR IGNORE`，再一次性把 mid 查回来，不在循环里查。
 */
export async function ensureTags(db: Db, names: string[]): Promise<number[]> {
	const cleaned = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
	if (cleaned.length === 0) return [];

	await db.batch(
		cleaned.map((name) =>
			db.prepare(
				`INSERT OR IGNORE INTO metas (name, slug, type, description, count, sort_order, parent)
				 VALUES (?, ?, 'tag', NULL, 0, 0, 0)`,
				[name, name],
			),
		),
	);

	const placeholders = cleaned.map(() => '?').join(',');
	const rows = await db.all<{ mid: number }>(
		`SELECT mid FROM metas WHERE type = 'tag' AND slug IN (${placeholders})`,
		cleaned,
	);
	return rows.map((row) => row.mid);
}

/** 一次拿全部分类与标签（快照构建用）：一条 SQL，不按类型循环 */
export async function listAllTerms(db: Db): Promise<TermRecord[]> {
	const rows = await db.all<TermRow>(
		`SELECT m.mid, m.name, m.slug, m.type, m.description, m.sort_order,
		        COALESCE(cnt.count, 0) AS count
		   FROM metas m ${TERM_COUNT_JOIN}
		  ORDER BY m.type, m.sort_order, m.mid`,
	);
	return rows.map(toTerm);
}

// ---------------------------------------------------------------------------
// 后台分类管理 —— 分类 slug 直接嵌在文章 URL（/<category>/<slug>.html）里，
// 改/删的影响面在 routes/admin.tsx 里算，这里只管数据。
// ---------------------------------------------------------------------------

/** 按 slug 查分类（查重用）；excludeMid 用于改名时排除自己 */
export async function findCategoryBySlug(db: Db, slug: string, excludeMid?: number): Promise<TermRow | null> {
	return await db.first<TermRow>(
		`SELECT m.mid, m.name, m.slug, m.type, m.description, m.sort_order, m.count
		   FROM metas m
		  WHERE m.type = 'category' AND m.slug = ? AND m.mid != ?
		  LIMIT 1`,
		[slug, excludeMid ?? 0],
	);
}

export async function createCategory(db: Db, name: string, slug: string, description: string): Promise<number> {
	const result = await db.run(
		`INSERT INTO metas (name, slug, type, description, count, sort_order, parent)
		 VALUES (?, ?, 'category', ?, 0, 0, 0)`,
		[name, slug, description || null],
	);
	return Number(result.meta.last_row_id);
}

export async function updateCategory(
	db: Db,
	mid: number,
	name: string,
	slug: string,
	description: string,
): Promise<void> {
	await db.run(`UPDATE metas SET name = ?, slug = ?, description = ? WHERE mid = ? AND type = 'category'`, [
		name,
		slug,
		description || null,
		mid,
	]);
}

/** 删分类：关系表有 ON DELETE CASCADE，但显式删一遍不依赖外键行为 */
export async function deleteCategory(db: Db, mid: number): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM relationships WHERE mid = ?', [mid]),
		db.prepare("DELETE FROM metas WHERE mid = ? AND type = 'category'", [mid]),
	]);
}
