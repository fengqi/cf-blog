/**
 * 分类与标签 —— 设计文档 §4.1 / §4.2 ③ / §11
 *
 * **渲染用的 count 不读 `metas.count`**：那是给后台列表看的冗余计数，
 * 改分类时漏更新就会长期偏差（§4.3 点名的坑）。这里在一条 SQL 里用相关子查询重新数，
 * 既不引入 N+1，也不依赖冗余字段的正确性。
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

const TERM_SQL = `
SELECT m.mid, m.name, m.slug, m.type, m.description, m.sort_order,
       (SELECT COUNT(*)
          FROM relationships r
          JOIN contents c ON c.cid = r.cid
         WHERE r.mid = m.mid AND c.type = 'post' AND c.status = 'publish') AS count
  FROM metas m
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

/** 一次拿全部分类与标签（快照构建用）：一条 SQL，不按类型循环 */
export async function listAllTerms(db: Db): Promise<TermRecord[]> {
	const rows = await db.all<TermRow>(
		`SELECT m.mid, m.name, m.slug, m.type, m.description, m.sort_order,
		        (SELECT COUNT(*)
		           FROM relationships r
		           JOIN contents c ON c.cid = r.cid
		          WHERE r.mid = m.mid AND c.type = 'post' AND c.status = 'publish') AS count
		   FROM metas m
		  ORDER BY m.type, m.sort_order, m.mid`,
	);
	return rows.map(toTerm);
}
