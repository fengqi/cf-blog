/**
 * Typecho(SQLite) → 本项目(D1) 迁移 —— 设计文档「附：与 Typecho 迁移」
 *
 * 默认**只读体检**，什么都不写：
 *   npx tsx scripts/import-typecho.ts --db .import/typecho.db
 *
 * 生成 D1 导入 SQL（仍然不写库）：
 *   npx tsx scripts/import-typecho.ts --emit-sql .import/sql
 *
 * 先本地预演（推荐，写完在本地 R2/D1 上验证）：
 *   npx tsx scripts/import-typecho.ts --apply local
 *
 * 生产导入（**这一步才动线上**）：
 *   npx tsx scripts/import-typecho.ts --apply remote
 *
 * 三条铁律：
 *   1. **老站只读**，绝不写回 Typecho 的库
 *   2. **URL 一条都不能变**：perma 取 Typecho 的 `/<分类 slug>/<slug>.html`，
 *      slug 为空时用 cid；cids 原样保留（很多老文章的 slug 就是 cid）
 *   3. **不覆盖新库已有的管理员口令与 token_version**（那是刚 bootstrap 好的 PBKDF2 串，
 *      被 Typecho 的 phpass 覆盖就再也登不进去了）
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { countWords, extractText, makeExcerpt, renderMarkdown } from '../src/lib/markdown';
import { sanitizeHtml } from '../src/lib/sanitize';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
	const index = args.indexOf(`--${name}`);
	if (index === -1) return fallback;
	return args[index + 1];
};
const has = (name: string): boolean => args.includes(`--${name}`);

const DB_PATH = flag('db', '.import/typecho.db')!;
const SQL_DIR = flag('emit-sql', '.import/sql')!;
const APPLY = flag('apply'); // local | remote | undefined
const LIMIT = Number.parseInt(flag('limit', '0')!, 10);
const KEEP_USER_PROFILE = has('keep-user-profile');

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** SQLite 字面量。SQLite 的列是动态类型，这里统一收敛，脚本层不做严格类型体操 */
function sql(value: unknown): string {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
	if (typeof value === 'boolean') return value ? '1' : '0';
	if (typeof value === 'bigint') return value.toString();
	return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 表名探测：Typecho 的安装前缀可配（`typecho_` 或无前缀），列名也随版本变
 * （1.2 把 `users.username` 改成了 `users.name`）。所以一律先探测再查，别写死。
 */
interface Tables {
	contents: string;
	metas: string;
	relationships: string;
	users: string;
	options: string;
	fields: string | null;
	comments: string | null;
}

function resolveTables(db: DatabaseSync): Tables {
	const names = new Set(
		(rows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name)),
	);
	const find = (logical: string): string | null => {
		for (const candidate of [`typecho_${logical}`, logical]) if (names.has(candidate)) return candidate;
		return null;
	};
	const required: [keyof Tables, string][] = [
		['contents', 'contents'],
		['metas', 'metas'],
		['relationships', 'relationships'],
		['users', 'users'],
		['options', 'options'],
	];
	const resolved: Record<string, string | null> = {};
	for (const [key, logical] of required) {
		const found = find(logical);
		if (!found) throw new Error(`数据库里找不到 ${logical} 表（前缀既不是 typecho_ 也不是无前缀）`);
		resolved[key] = found;
	}
	resolved.fields = find('fields');
	resolved.comments = find('comments');
	return resolved as unknown as Tables;
}

function tableColumns(db: DatabaseSync, table: string | null): Set<string> {
	if (!table) return new Set();
	try {
		const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as { name: string }[];
		return new Set(rows.map((row) => row.name));
	} catch {
		return new Set();
	}
}

function tableExists(db: DatabaseSync, table: string | null): boolean {
	if (!table) return false;
	const row = db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
		.get(table) as { name: string } | undefined;
	return Boolean(row);
}

/** 从一组候选列名里挑第一个存在的（Typecho 各版本列名不完全一样） */
function pick(columns: Set<string>, ...candidates: string[]): string | null {
	for (const candidate of candidates) if (columns.has(candidate)) return candidate;
	return null;
}

/** 标识符加引号：Typecho 里 `order`、`group` 这类列名是 SQL 关键字，不加引号直接语法错误 */
function q(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

function rows<T = Record<string, unknown>>(db: DatabaseSync, sqlText: string): T[] {
	return db.prepare(sqlText).all() as T[];
}

// ---------------------------------------------------------------------------
// ① 体检
// ---------------------------------------------------------------------------

interface Report {
	counts: Record<string, number>;
	anomalies: string[];
	options: { name: string; value: string }[];
	imageHosts: { host: string; count: number }[];
	imagePaths: { path: string; count: number }[];
	urls: string[];
	multiCategory: {
		cid: number;
		title: string;
		categories: string[];
		urlByMid: string;
		urlByInsertOrder: string;
		mismatch: boolean;
	}[];
	longest: { cid: number; title: string; bytes: number }[];
}

function analyze(db: DatabaseSync, T: Tables): Report {
	const anomalies: string[] = [];
	const counts: Record<string, number> = {};

	const contentColumns = tableColumns(db, T.contents);
	const hasComments = tableExists(db, T.comments);

	const typeColumn = pick(contentColumns, 'type');
	const statusColumn = pick(contentColumns, 'status');
	const typeExpr = typeColumn ? q(typeColumn) : "'post'";
	const statusExpr = statusColumn ? q(statusColumn) : "'publish'";
	counts['contents 总数'] = (
		rows<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${T.contents}`)[0] ?? { n: 0 }
	).n;

	for (const row of rows<{ type: string; status: string; n: number }>(
		db,
		`SELECT ${typeExpr} AS type, ${statusExpr} AS status, COUNT(*) AS n FROM ${T.contents} GROUP BY 1,2 ORDER BY n DESC`,
	)) {
		counts[`  ${row.type} / ${row.status}`] = row.n;
	}

	const metaColumns = tableColumns(db, T.metas);
	counts['metas 总数'] = rows<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${T.metas}`)[0].n;
	for (const row of rows<{ type: string; n: number }>(
		db,
		`SELECT ${pick(metaColumns, 'type') ? q(pick(metaColumns, 'type')!) : "'category'"} AS type, COUNT(*) AS n FROM ${T.metas} GROUP BY 1`,
	)) {
		counts[`  metas ${row.type}`] = row.n;
	}
	counts['relationships'] = rows<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${T.relationships}`)[0].n;
	counts['users'] = rows<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${T.users}`)[0].n;
	counts['options'] = rows<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${T.options}`)[0].n;
	counts['fields'] = tableExists(db, T.fields)
		? rows<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${T.fields}`)[0].n
		: 0;
	counts['comments（丢弃）'] = hasComments
		? rows<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${T.comments}`)[0].n
		: 0;

	const slugColumnName = pick(contentColumns, 'slug');
	const textColumnName = pick(contentColumns, 'text');
	const slugExpr = slugColumnName ? q(slugColumnName) : "''";
	const textExpr = textColumnName ? q(textColumnName) : "''";

	// 异常：没有分类的可见文章
	const orphans = rows<{ cid: number; title: string }>(
		db,
		`SELECT c.cid, c.title FROM ${T.contents} c
		  WHERE c.type IN ('post','page')
		    AND NOT EXISTS (SELECT 1 FROM ${T.relationships} r WHERE r.cid = c.cid)
		    AND c.type = 'post'`,
	);
	if (orphans.length > 0) {
		anomalies.push(`有 ${orphans.length} 篇文章没有任何分类（URL 拼不出来）：cid=${orphans.map((r) => r.cid).join(',')}`);
	}

	// 异常：slug 重复或为空
	const emptySlugs = rows<{ cid: number }>(
		db,
		`SELECT cid FROM ${T.contents} WHERE type IN ('post','page') AND (${slugExpr} IS NULL OR TRIM(${slugExpr}) = '')`,
	);
	if (emptySlugs.length > 0) {
		anomalies.push(`有 ${emptySlugs.length} 条 slug 为空（将回落到 cid）：cid=${emptySlugs.slice(0, 10).map((r) => r.cid).join(',')}${emptySlugs.length > 10 ? ' …' : ''}`);
	}
	const dupSlugs = rows<{ slug: string; n: number }>(
		db,
		`SELECT ${slugExpr} AS slug, COUNT(*) AS n FROM ${T.contents}
		  WHERE type IN ('post','page') AND TRIM(COALESCE(${slugExpr},'')) <> ''
		  GROUP BY 1 HAVING n > 1`,
	);
	if (dupSlugs.length > 0) {
		anomalies.push(`有 ${dupSlugs.length} 个 slug 重复（新库是 UNIQUE，会导致导入失败）：${dupSlugs.slice(0, 5).map((r) => r.slug).join(', ')}`);
	}

	/**
	 * 多分类文章：Typecho 的 permalink 取「第一个分类」，而这个「第一」是
	 * **typecho_relationships 的插入顺序**（SQLite rowid 序），我们的 `primaryCategory`
	 * 却按 `metas.mid` 升序取。两者不一致时 URL 就会变 —— 所以这里把两种候选都算出来。
	 */
	const multi = rows<{ cid: number; title: string; slug: string; by_mid: string; by_rowid: string; cats: string }>(
		db,
		`SELECT c.cid, c.title, ${slugExpr} AS slug,
		        (SELECT GROUP_CONCAT(m.slug) FROM ${T.relationships} r JOIN ${T.metas} m ON m.mid = r.mid
		          WHERE r.cid = c.cid AND m.type = 'category' ORDER BY m.mid) AS cats,
		        (SELECT m.slug FROM ${T.relationships} r JOIN ${T.metas} m ON m.mid = r.mid
		          WHERE r.cid = c.cid AND m.type = 'category' ORDER BY m.mid LIMIT 1) AS by_mid,
		        (SELECT m.slug FROM ${T.relationships} r JOIN ${T.metas} m ON m.mid = r.mid
		          WHERE r.cid = c.cid AND m.type = 'category' ORDER BY r.rowid LIMIT 1) AS by_rowid
		   FROM ${T.contents} c
		  WHERE c.type = 'post'
		    AND (SELECT COUNT(*) FROM ${T.relationships} r JOIN ${T.metas} m ON m.mid = r.mid
		          WHERE r.cid = c.cid AND m.type = 'category') > 1`,
	);
	counts['多分类文章'] = multi.length;

	// 图片引用盘点
	const bodies = rows<{ cid: number; text: string; title: string }>(
		db,
		`SELECT cid, ${textExpr} AS text, title FROM ${T.contents} WHERE type IN ('post','page')`,
	);
	const hostCount = new Map<string, number>();
	const pathCount = new Map<string, number>();
	for (const row of bodies) {
		for (const match of row.text.matchAll(/https?:\/\/([^/"'\s)]+)(\/[^"'\s)]*)?/g)) {
			const host = match[1];
			if (/\.(png|jpe?g|gif|webp|avif|svg|bmp)(\?|$)/i.test(match[2] ?? '') || /img|cdn|static/i.test(host)) {
				hostCount.set(host, (hostCount.get(host) ?? 0) + 1);
			}
		}
		// 文件名里可能带空格（§9 的中文+空格场景），所以不能用 \s 截断：
		// 只到引号/尖括号/右括号/换行为止
		for (const match of row.text.matchAll(/\/usr\/uploads\/[^"'<>)\]\n]+/g)) {
			pathCount.set(match[0], (pathCount.get(match[0]) ?? 0) + 1);
		}
	}

	// URL 清单
	const urlRows = rows<{ cid: number; slug: string; cat: string | null }>(
		db,
		`SELECT c.cid, ${slugExpr} AS slug,
		        (SELECT m.slug FROM ${T.relationships} r JOIN ${T.metas} m ON m.mid = r.mid
		          WHERE r.cid = c.cid AND m.type = 'category' ORDER BY r.mid LIMIT 1) AS cat
		   FROM ${T.contents} c
		  WHERE c.type = 'post' AND c.status IN ('publish','hidden')`,
	);
	const urls: string[] = [];
	for (const row of urlRows) {
		const slug = row.slug?.trim() || String(row.cid);
		if (!row.cat) continue;
		urls.push(`/${row.cat}/${slug}.html`);
	}
	for (const row of rows<{ slug: string; cid: number }>(
		db,
		`SELECT ${slugExpr} AS slug, cid FROM ${T.contents} WHERE type = 'page' AND status IN ('publish','hidden')`,
	)) {
		urls.push(`/${row.slug?.trim() || row.cid}.html`);
	}
	for (const row of rows<{ type: string; slug: string }>(
		db,
		`SELECT type, slug FROM ${T.metas} WHERE type IN ('category','tag')`,
	)) {
		urls.push(row.type === 'category' ? `/category/${row.slug}/` : `/tag/${row.slug}/`);
	}
	for (const row of rows<{ ym: string }>(
		db,
		`SELECT DISTINCT strftime('%Y/%m', created + (SELECT CAST(value AS INTEGER) FROM ${T.options} WHERE name = 'timezone' LIMIT 1), 'unixepoch') AS ym
		   FROM ${T.contents} WHERE type = 'post' AND status = 'publish' ORDER BY ym DESC`,
	)) {
		if (row.ym) urls.push(`/${row.ym}/`);
	}
	// 附件页面：Typecho 1.3 的路由是 /attachment/[cid]/，实测线上 200
	for (const row of rows<{ cid: number }>(db, `SELECT cid FROM ${T.contents} WHERE type = 'attachment'`)) {
		urls.push(`/attachment/${row.cid}/`);
	}
	urls.push('/feed/', '/sitemap.xml');

	const multiCategory = multi.slice(0, 30).map((row) => ({
		cid: row.cid,
		title: row.title,
		categories: String(row.cats).split(','),
		urlByMid: `/${row.by_mid}/${row.slug}.html`,
		urlByInsertOrder: `/${row.by_rowid}/${row.slug}.html`,
		mismatch: row.by_mid !== row.by_rowid,
	}));
	// 两个候选 URL 都进清单：线上不一定哪个 200，爬一遍就知道（Typecho 可能两个都认）
	for (const row of multi) {
		urls.push(`/${row.by_mid}/${row.slug}.html`);
		if (row.by_rowid !== row.by_mid) urls.push(`/${row.by_rowid}/${row.slug}.html`);
	}

	const longest = rows<{ cid: number; title: string; bytes: number }>(
		db,
		`SELECT cid, title, LENGTH(${textExpr}) AS bytes FROM ${T.contents}
		  WHERE type IN ('post','page') ORDER BY bytes DESC LIMIT 5`,
	);

	return {
		counts,
		anomalies,
		options: rows<{ name: string; value: string }>(
			db,
			`SELECT name, value FROM ${T.options} WHERE user = 0 ORDER BY name`,
		).map((row) => ({
			name: row.name,
			// 插件配置与 secret 里可能有凭据，报告里只显示长度（迁移本身也不导入它们）
			value: /plugin:|secret|key|token|password/i.test(row.name)
				? `（${(row.value ?? '').length} 字节，含凭据风险，不显示）`
				: row.value,
		})),
		imageHosts: [...hostCount.entries()].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count),
		imagePaths: [...pathCount.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count),
		urls: [...new Set(urls)].sort(),
		multiCategory,
		longest,
	};
}

// ---------------------------------------------------------------------------
// ② 转换（Typecho 行 → 新库行）
// ---------------------------------------------------------------------------

interface NewContent {
	cid: number;
	title: string;
	slug: string;
	created: number;
	modified: number;
	body: string;
	rendered: string;
	excerpt: string;
	sort_order: number;
	author_id: number;
	type: 'post' | 'page' | 'attachment';
	status: string;
	password: string | null;
	allow_feed: number;
	parent: number;
	words: number;
	mime: string | null;
	size: number;
	r2_key: string | null;
}

const MORE_MARKER = /<!--\s*more\s*-->/i;
/**
 * Typecho 的正文格式开关：保存时若启用了 Markdown，正文开头会写一个 `<!--markdown-->` 标记，
 * 渲染时**只有带标记的才走 markdown**，其余原样当 HTML 输出（Typecho_Abstract_Contents::filter）。
 *
 * 实测这个库：122 篇带标记、30 篇不带（2010 年前后的老文章是手写 HTML）。
 * 一律跑 markdown-it 会把老文章的纯文本行包进 `<p>`、还可能吃掉 `*`/`_` —— 所以必须分流。
 */
const MARKDOWN_MARKER = /^\s*<!--markdown-->\s*/;

function normalizeType(rawType: string): { type: NewContent['type']; draft: boolean } | null {
	const type = String(rawType || 'post').toLowerCase();
	// `revision` 是修订记录（本库 11 条），不是正文，一律跳过
	if (type.startsWith('revision')) return null;
	if (type.startsWith('attachment')) return { type: 'attachment', draft: false };
	if (type.startsWith('page')) return { type: 'page', draft: type.includes('draft') };
	return { type: 'post', draft: type.includes('draft') };
}

function normalizeStatus(rawStatus: string, draft: boolean): string {
	if (draft) return 'draft';
	const status = String(rawStatus || 'publish').toLowerCase();
	return ['publish', 'hidden', 'private', 'waiting'].includes(status) ? status : 'draft';
}

function buildContentRow(
	row: Record<string, unknown>,
	slugColumn: string,
	textColumn: string,
): NewContent | null {
	const cid = Number(row.cid);
	const normalized = normalizeType(String(row.type ?? 'post'));
	if (!normalized) return null;
	const { type, draft } = normalized;
	const status = normalizeStatus(String(row.status ?? 'publish'), draft);
	const slug = String(row[slugColumn] ?? '').trim() || String(cid);
	const body = String(row[textColumn] ?? '');

	// 正文格式：带 `<!--markdown-->` 标记才按 Markdown 渲染，否则是原生 HTML（只清洗）
	const isMarkdown = MARKDOWN_MARKER.test(body);
	const source = isMarkdown ? body.replace(MARKDOWN_MARKER, '') : body;
	const renderSource = (text: string) => (isMarkdown ? renderMarkdown(text) : sanitizeHtml(text));

	// `<!--more-->` 是摘要分界：前半段当自定义摘要，正文里的标记去掉
	const moreIndex = source.search(MORE_MARKER);
	const excerptSource = moreIndex >= 0 ? source.slice(0, moreIndex) : '';
	const cleanBody = source.replace(MORE_MARKER, '');
	const rendered = renderSource(cleanBody);
	const excerpt = excerptSource.trim().length > 0 ? makeExcerpt(renderSource(excerptSource), 220) : makeExcerpt(rendered);

	// 附件：Typecho 把元信息塞在 text 里的 JSON
	let mime: string | null = null;
	let size = 0;
	let r2Key: string | null = null;
	if (type === 'attachment') {
		try {
			const meta = JSON.parse(body) as { type?: string; size?: number; path?: string };
			mime = meta.type ?? null;
			size = Number(meta.size ?? 0);
			r2Key = (meta.path ?? '').replace(/^\/+/, '') || null;
		} catch {
			// 解析不了就只留空元信息，正文照旧
		}
	}

	// 附件不是文章：元信息在 body 的 JSON 里，不该产出 rendered/excerpt/words
	const isAttachment = type === 'attachment';

	return {
		cid,
		title: String(row.title ?? ''),
		slug,
		created: Number(row.created ?? 0),
		modified: Number(row.modified ?? 0),
		body: cleanBody,
		rendered: isAttachment ? '' : rendered,
		excerpt: isAttachment ? '' : excerpt,
		sort_order: Number(row.order ?? 0),
		author_id: Number(row.authorId ?? 1),
		type,
		status,
		password: (row.password as string | null) ?? null,
		allow_feed: String(row.allowFeed ?? '1') === '1' ? 1 : 0,
		parent: Number(row.parent ?? 0),
		words: isAttachment ? 0 : countWords(extractText(rendered)),
		mime,
		size,
		r2_key: r2Key,
	};
}

// ---------------------------------------------------------------------------
// ③ 生成 SQL
// ---------------------------------------------------------------------------

/** 新库只认这几个配置，且**绝不导入 siteUrl**（老站是 fengqi.me，新站必须是 blog.fengqi.me） */
const OPTION_MAP: { from: string; to: string }[] = [
	{ from: 'title', to: 'site_title' },
	{ from: 'description', to: 'site_description' },
	{ from: 'keywords', to: 'site_keywords' },
	{ from: 'timezone', to: 'timezone' },
	{ from: 'pageSize', to: 'posts_per_page' }, // Typecho 1.3 的真实选项名
	{ from: 'postsPerPage', to: 'posts_per_page' },
	{ from: 'posts_per_page', to: 'posts_per_page' },
];

function emitSql(db: DatabaseSync, maps: IdMaps, T: Tables): { files: string[]; summary: Record<string, number> } {
	const contentColumns = tableColumns(db, T.contents);
	const slugColumn = pick(contentColumns, 'slug') ?? 'slug';
	const textColumn = pick(contentColumns, 'text') ?? 'text';
	const orderColumn = pick(contentColumns, 'order', 'sort_order') ?? 'order';
	const authorColumn = pick(contentColumns, 'authorId', 'author_id') ?? 'authorId';
	const feedColumn = pick(contentColumns, 'allowFeed', 'allow_feed') ?? 'allowFeed';

	const contentRows = rows<Record<string, unknown>>(
		db,
		`SELECT cid, title, ${q(slugColumn)} AS ${slugColumn}, created, modified, ${q(textColumn)} AS ${textColumn},
		        ${q(orderColumn)} AS "order", ${q(authorColumn)} AS authorId, type, status, password,
		        ${q(feedColumn)} AS allowFeed, parent
		   FROM ${T.contents} ORDER BY cid`,
	);

	const map = new Map<number, NewContent>();
	for (const row of contentRows) {
		const mapped = buildContentRow(row, slugColumn, textColumn);
		if (!mapped) continue; // revision 等非正文类型
		// 作者按 uid 映射（同名用户复用目标库里的 uid，避免 UNIQUE(username) 冲突）
		mapped.author_id = maps.user.get(mapped.author_id) ?? mapped.author_id;
		map.set(mapped.cid, mapped);
	}

	let contents = [...map.values()];
	if (Number.isFinite(LIMIT) && LIMIT > 0) {
		// 只留前 N 篇 + 它们的附件，用于本地彩排
		const keptCids = new Set(contents.filter((row) => row.type === 'post').slice(0, LIMIT).map((row) => row.cid));
		contents = contents.filter((row) => keptCids.has(row.cid) || keptCids.has(row.parent));
	}

	const keptCids = new Set(contents.map((row) => row.cid));

	const statements: string[] = [];
	statements.push('-- 由 scripts/import-typecho.ts 生成：Typecho(SQLite) → D1');
	statements.push('-- 顺序：users → metas → contents → relationships → fields → options → 计数刷新');

	// users：**只补作者信息，绝不覆盖口令/token_version**
	const userColumns = tableColumns(db, T.users);
	// Typecho 1.2 把 username 改成了 name
	const usernameColumn = pick(userColumns, 'username', 'name') ?? 'name';
	const screenNameColumn = pick(userColumns, 'screenName', 'screen_name') ?? 'screenName';
	const authColumn = pick(userColumns, 'authCode', 'auth_code') ?? 'authCode';
	const groupColumn = pick(userColumns, 'group', 'role') ?? 'group';
	for (const row of rows<Record<string, unknown>>(
		db,
		`SELECT uid, ${q(usernameColumn)} AS username, password, mail, url, ${q(screenNameColumn)} AS screenName, created, activated, logged,
		        ${q(groupColumn)} AS "group", ${q(authColumn)} AS authCode
		   FROM ${T.users} ORDER BY uid`,
	)) {
		const uid = maps.user.get(Number(row.uid));
		if (uid === undefined) continue;
		const role = ['administrator', 'editor', 'author', 'contributor'].includes(String(row.group))
			? String(row.group)
			: 'administrator';
		// 口令栏位写占位串：phpass 在 Workers 里校验不了，必须重新设置（§迁移）
		statements.push(
			`INSERT INTO users (uid, username, password, mail, url, screen_name, created, activated, logged, role, auth_code, token_version)
			 VALUES (${uid}, ${sql(row.username)}, 'pbkdf2$0$PLACEHOLDER_phpass$PLACEHOLDER', ${sql(row.mail)}, ${sql(row.url)}, ${sql(row.screenName)}, ${sql(row.created)}, ${sql(row.activated)}, ${sql(row.logged)}, ${sql(role)}, '', 0)
			 ON CONFLICT(uid) DO UPDATE SET
			   mail = excluded.mail, url = excluded.url,
			   screen_name = ${KEEP_USER_PROFILE ? 'users.screen_name' : 'excluded.screen_name'};`,
		);
	}

	// metas：mid 原样保留（relationships 要引用）
	const metaColumns = tableColumns(db, T.metas);
	const metaOrder = pick(metaColumns, 'order', 'sort_order') ?? 'order';
	for (const row of rows<Record<string, unknown>>(
		db,
		`SELECT mid, name, slug, type, description, ${q(metaOrder)} AS "order", parent FROM ${T.metas} ORDER BY mid`,
	)) {
		const mid = maps.meta.get(Number(row.mid));
		if (mid === undefined) continue;
		statements.push(
			`INSERT INTO metas (mid, name, slug, type, description, count, sort_order, parent)
			 VALUES (${mid}, ${sql(row.name)}, ${sql(row.slug)}, ${sql(row.type)}, ${sql(row.description)}, 0, ${sql(row.order)}, ${sql(row.parent)})
			 ON CONFLICT(mid) DO UPDATE SET name = excluded.name, slug = excluded.slug,
			   description = excluded.description, sort_order = excluded.sort_order, parent = excluded.parent;`,
		);
	}

	/**
	 * contents。
	 *
	 * ⚠️ 正文很长的文章**不能塞进一条 INSERT**：本地 D1（miniflare）对单条语句有上限，
	 * 一条 36KB 的语句就报 `SQLITE_TOOBIG`，而且会让**整个文件回滚**。
	 * 所以：正文先留空插入，再用 `body = body || '<分块>'` 逐块拼 —— 块大小保守取 8KB。
	 */
	const CHUNK_BYTES = 8000;
	const needsChunking = (text: string) => text.length > CHUNK_BYTES;
	for (const row of contents) {
		const longText = needsChunking(row.body) || needsChunking(row.rendered);
		statements.push(
			`INSERT INTO contents (cid, title, slug, created, modified, body, rendered, excerpt, sort_order,
			                       author_id, type, status, password, allow_feed, parent, words, mime, size, r2_key, needs_sync)
			 VALUES (${sql(row.cid)}, ${sql(row.title)}, ${sql(row.slug)}, ${sql(row.created)}, ${sql(row.modified)},
			         ${longText ? "''" : sql(row.body)}, ${longText ? "''" : sql(row.rendered)}, ${sql(row.excerpt)},
			         ${sql(row.sort_order)}, ${sql(row.author_id)}, ${sql(row.type)}, ${sql(row.status)},
			         ${sql(row.password)}, ${sql(row.allow_feed)}, ${sql(row.parent)}, ${sql(row.words)},
			         ${sql(row.mime)}, ${sql(row.size)}, ${sql(row.r2_key)}, ${row.type === 'attachment' ? 0 : 1})
			 ON CONFLICT(cid) DO UPDATE SET title = excluded.title, slug = excluded.slug, body = excluded.body,
			   rendered = excluded.rendered, excerpt = excluded.excerpt, modified = excluded.modified,
			   type = excluded.type, status = excluded.status, words = excluded.words,
			   needs_sync = excluded.needs_sync;`,
		);
		if (!longText) continue;
		for (const [column, value] of [
			['body', row.body],
			['rendered', row.rendered],
		] as const) {
			for (let index = 0; index < value.length; index += CHUNK_BYTES) {
				statements.push(
					`UPDATE contents SET ${column} = ${column} || ${sql(value.slice(index, index + CHUNK_BYTES))} WHERE cid = ${row.cid};`,
				);
			}
		}
	}

	/**
	 * 多分类文章的非规范 URL → `permalink_history`（§5.1 方案 A）。
	 *
	 * 老站对这些 URL 返回 **301** 指向规范 URL（实测 `/go/632.html` → `/default/632.html`），
	 * 而 R2 对象发不了 301，所以按方案 A 处理：旧地址照常 200，页面里 canonical 指向规范地址。
	 * 不记的话，这类 URL 在新站会变成 404。
	 */
	const nowSeconds = Math.floor(Date.now() / 1000);
	for (const row of rows<{ cid: number; slug: string; cats: string | null }>(
		db,
		`SELECT c.cid, ${q(slugColumn)} AS slug,
		        (SELECT GROUP_CONCAT(m.slug) FROM ${T.relationships} r JOIN ${T.metas} m ON m.mid = r.mid
		          WHERE r.cid = c.cid AND m.type = 'category' ORDER BY m.mid) AS cats
		   FROM ${T.contents} c
		  WHERE c.type = 'post' AND c.status IN ('publish','hidden')`,
	)) {
		const categories = String(row.cats ?? '').split(',').filter(Boolean);
		if (categories.length < 2 || !keptCids.has(Number(row.cid))) continue;
		for (const category of categories.slice(1)) {
			statements.push(
				`INSERT OR REPLACE INTO permalink_history (cid, permalink, retired_at)
				 VALUES (${row.cid}, ${sql(`${category}/${row.slug || row.cid}.html`)}, ${nowSeconds});`,
			);
		}
	}

	// relationships（只保留已导入的 cid）
	for (const row of rows<{ cid: number; mid: number }>(
		db,
		`SELECT cid, mid FROM ${T.relationships} ORDER BY cid, mid`,
	)) {
		const mid = maps.meta.get(Number(row.mid));
		if (!keptCids.has(row.cid) || mid === undefined) continue;
		statements.push(`INSERT OR IGNORE INTO relationships (cid, mid) VALUES (${row.cid}, ${mid});`);
	}

	// fields
	if (tableExists(db, T.fields)) {
		for (const row of rows<Record<string, unknown>>(
			db,
			`SELECT cid, name, type, str_value, int_value, float_value FROM ${T.fields}`,
		)) {
			if (!keptCids.has(Number(row.cid))) continue;
			statements.push(
				`INSERT OR REPLACE INTO fields (cid, name, type, str_value, int_value, float_value)
				 VALUES (${sql(row.cid)}, ${sql(row.name)}, ${sql(row.type)}, ${sql(row.str_value)}, ${sql(row.int_value)}, ${sql(row.float_value)});`,
			);
		}
	}

	// options：白名单，且**跳过 siteUrl**
	const typechoOptions = new Map(
		rows<{ name: string; value: string }>(db, `SELECT name, value FROM ${T.options} WHERE user = 0`).map(
			(row) => [row.name, row.value],
		),
	);
	for (const { from, to } of OPTION_MAP) {
		const value = typechoOptions.get(from);
		if (value === undefined) continue;
		statements.push(
			`INSERT INTO options (name, user, value) VALUES (${sql(to)}, 0, ${sql(value)})
			 ON CONFLICT(name, user) DO UPDATE SET value = excluded.value;`,
		);
	}

	// 分类/标签计数按新库重算（我们渲染时也自己数，但后台列表要用）
	statements.push(
		`UPDATE metas SET count = (SELECT COUNT(*) FROM relationships r JOIN contents c ON c.cid = r.cid
		    WHERE r.mid = metas.mid AND c.type = 'post' AND c.status = 'publish');`,
	);

	// 分块写文件：D1 的 --file 单文件别太大
	rmSync(SQL_DIR, { recursive: true, force: true });
	mkdirSync(SQL_DIR, { recursive: true });
	const CHUNK = 150;
	const files: string[] = [];
	for (let index = 0; index < statements.length; index += CHUNK) {
		const name = `import-${String(index / CHUNK + 1).padStart(3, '0')}.sql`;
		writeFileSync(join(SQL_DIR, name), statements.slice(index, index + CHUNK).join('\n') + '\n', 'utf8');
		files.push(name);
	}

	return {
		files,
		summary: {
			users: rows(db, `SELECT COUNT(*) AS n FROM ${T.users}`)[0].n as number,
			metas: rows(db, `SELECT COUNT(*) AS n FROM ${T.metas}`)[0].n as number,
			contents: contents.length,
			posts: contents.filter((row) => row.type === 'post').length,
			pages: contents.filter((row) => row.type === 'page').length,
			attachments: contents.filter((row) => row.type === 'attachment').length,
			statements: statements.length,
		},
	};
}

// ---------------------------------------------------------------------------
// ④ 目标库状态与 id 映射
// ---------------------------------------------------------------------------

/**
 * 目标 D1 里已经有什么。
 *
 * 为什么必须看：`metas` 除了 `mid` 还有 `(type, slug)` 唯一索引，`users` 有 `username` 唯一索引。
 * 盲插会在「同名但 mid 不同」时炸（本地彩排就炸了：库里已有 tag `安卓`，而老站给的是另一个 mid）。
 * 正确做法是**按业务键复用目标已有的 id**，再把 relationships / author_id 一起重映射。
 */
interface TargetState {
	metaByKey: Map<string, number>; // `${type}:${slug}` → mid
	metaMids: Set<number>;
	userByName: Map<string, number>;
	userUids: Set<number>;
	/** 目标库里现有的管理员（单作者博客要把老站作者合并到它身上） */
	admins: { uid: number; username: string }[];
}

function fetchTargetState(target: 'local' | 'remote'): TargetState {
	const query = (sqlText: string): Record<string, unknown>[] => {
		const stdout = execFileSync(
			'npx',
			['wrangler', 'd1', 'execute', 'blog-db', `--${target}`, '--json', `--command=${sqlText}`, '--yes'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
		);
		const parsed = JSON.parse(stdout) as { results?: Record<string, unknown>[] }[];
		return parsed[0]?.results ?? [];
	};

	const metaRows = query('SELECT mid, type, slug FROM metas');
	const userRows = query('SELECT uid, username, role FROM users');

	return {
		metaByKey: new Map(metaRows.map((row) => [`${row.type}:${row.slug}`, Number(row.mid)])),
		metaMids: new Set(metaRows.map((row) => Number(row.mid))),
		userByName: new Map(userRows.map((row) => [String(row.username), Number(row.uid)])),
		userUids: new Set(userRows.map((row) => Number(row.uid))),
		admins: userRows
			.filter((row) => row.role === 'administrator')
			.map((row) => ({ uid: Number(row.uid), username: String(row.username) })),
	};
}

interface IdMaps {
	meta: Map<number, number>; // 老站 mid → 目标 mid
	user: Map<number, number>; // 老站 uid → 目标 uid
	notes: string[];
}

function buildIdMaps(
	metaRows: { mid: number; type: string; slug: string; name: string }[],
	userRows: { uid: number; username: string; role: string }[],
	state: TargetState,
): IdMaps {
	const meta = new Map<number, number>();
	const user = new Map<number, number>();
	const notes: string[] = [];
	const usedMids = new Set(state.metaMids);
	const usedUids = new Set(state.userUids);
	let nextMid = Math.max(0, ...usedMids) + 1;
	let nextUid = Math.max(0, ...usedUids) + 1;

	for (const row of metaRows) {
		const key = `${row.type}:${row.slug}`;
		const existing = state.metaByKey.get(key);
		if (existing !== undefined) {
			meta.set(row.mid, existing);
			if (existing !== row.mid) notes.push(`分类/标签「${row.name}」按 (type,slug) 复用已有 mid=${existing}（老站 mid=${row.mid}）`);
			continue;
		}
		let target = row.mid;
		if (usedMids.has(target)) {
			target = nextMid++;
			notes.push(`分类/标签「${row.name}」的 mid=${row.mid} 已被占用，改用 mid=${target}`);
		}
		usedMids.add(target);
		state.metaByKey.set(key, target);
		meta.set(row.mid, target);
	}

	/**
	 * 单作者博客的关键一步：老站只有 1 个管理员、新库也只有 1 个管理员时，
	 * **把两者合并**（用户名往往不同：老站 `fengqi`、新库 `admin`）。
	 * 不合并的话会凭空多出一个「幽灵管理员」，而文章 byline 还得靠它撑 ——
	 * 本地彩排就是这么暴露的。合并只更新资料字段，**绝不碰口令与 token_version**。
	 */
	const typechoAdmins = userRows.filter((row) => row.role === 'administrator');
	if (state.admins.length === 1 && typechoAdmins.length === 1) {
		const target = state.admins[0];
		user.set(typechoAdmins[0].uid, target.uid);
		notes.push(
			`单管理员场景：老站用户「${typechoAdmins[0].username}」合并到现有管理员「${target.username}」(uid=${target.uid})，只更新资料、口令不动`,
		);
	}

	for (const row of userRows) {
		if (user.has(row.uid)) continue;
		const existing = state.userByName.get(row.username);
		if (existing !== undefined) {
			user.set(row.uid, existing);
			continue;
		}
		let target = row.uid;
		if (usedUids.has(target)) {
			target = nextUid++;
			notes.push(`用户「${row.username}」的 uid=${row.uid} 已被占用，改用 uid=${target}`);
		}
		usedUids.add(target);
		state.userByName.set(row.username, target);
		user.set(row.uid, target);
	}

	return { meta, user, notes };
}

// ---------------------------------------------------------------------------
// ⑤ 写入 D1（wrangler CLI）
// ---------------------------------------------------------------------------

function applySql(files: string[], target: 'local' | 'remote'): void {
	for (const file of files) {
		const path = join(SQL_DIR, file);
		console.log(`  → ${target}: ${file}`);
		try {
			const stdout = execFileSync(
				'npx',
				['wrangler', 'd1', 'execute', 'blog-db', `--${target}`, `--file=${path}`, '--yes'],
				{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
			);
			/**
			 * ⚠️ wrangler 对「语句级错误」是**退码 0 + 输出里带 success:false**：
			 * 之前把 stdout 收起来不看，结果一批语句整批回滚都没发现（本地彩排卡了很久）。
			 * 所以这里必须主动扫输出。
			 */
			if (/"success":\s*false/.test(stdout) || /\bERROR\b/.test(stdout)) {
				console.error(stdout.slice(0, 4000));
				throw new Error(`${file} 执行有失败语句（见上面的 wrangler 输出）`);
			}
		} catch (error) {
			const failure = error as { stdout?: string; stderr?: string };
			console.error(failure.stdout ?? '');
			console.error(failure.stderr ?? '');
			throw error;
		}
	}
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const db = new DatabaseSync(DB_PATH, { readOnly: true });
console.log(`=== 读 ${DB_PATH}（只读）===\n`);

const T = resolveTables(db);
const report = analyze(db, T);

console.log('=== 行数 ===');
for (const [key, value] of Object.entries(report.counts)) console.log(`  ${key}: ${value}`);

console.log('\n=== 异常 ===');
if (report.anomalies.length === 0) console.log('  无');
for (const item of report.anomalies) console.log(`  ⚠ ${item}`);

console.log('\n=== 多分类文章（URL 归属要对齐 Typecho 的"第一个分类"）===');
if (report.multiCategory.length === 0) console.log('  无（全部单分类，URL 无歧义）');
for (const row of report.multiCategory) {
	const flagText = row.mismatch ? '⚠ 两种排序结果不同' : '（两种排序一致）';
	console.log(`  cid=${row.cid} 《${row.title}》 分类=${row.categories.join(' / ')} ${flagText}`);
	console.log(`     按 mid 升序（我们的口径）: ${row.urlByMid}`);
	console.log(`     按插入顺序（Typecho 口径）: ${row.urlByInsertOrder}`);
}

console.log('\n=== 图片引用：域名 top ===');
for (const row of report.imageHosts.slice(0, 10)) console.log(`  ${row.host}  ×${row.count}`);
console.log('=== 图片引用：/usr/uploads/ 路径 ===');
if (report.imagePaths.length === 0) console.log('  无（正文没引用本地上传目录）');
for (const row of report.imagePaths.slice(0, 15)) console.log(`  ${row.path}  ×${row.count}`);

console.log('\n=== 最长正文 top5 ===');
for (const row of report.longest) console.log(`  cid=${row.cid} ${row.bytes} 字节 《${row.title}》`);

console.log('\n=== typecho_options（决定要导入哪些配置）===');
for (const row of report.options) {
	const value = (row.value ?? '').slice(0, 60);
	console.log(`  ${row.name} = ${value}`);
}

console.log(`\n=== URL 清单：${report.urls.length} 条 ===`);
writeFileSync('.import/urls-old.txt', report.urls.join('\n') + '\n', 'utf8');
console.log('  已写到 .import/urls-old.txt');
console.log('  前 5 条:');
for (const url of report.urls.slice(0, 5)) console.log(`    ${url}`);

if (has('verify-urls')) {
	const site = flag('site', 'https://fengqi.me')!.replace(/\/+$/, '');
	console.log(`\n=== 逐条核对老站（${site}）===`);
	const targets = report.urls;
	const results: { url: string; status: number }[] = [];
	let cursor = 0;
	const workers = Array.from({ length: 6 }, async () => {
		while (cursor < targets.length) {
			const url = targets[cursor++];
			try {
				const response = await fetch(site + url, { redirect: 'manual' });
				results.push({ url, status: response.status });
			} catch (error) {
				results.push({ url, status: -1 });
			}
		}
	});
	await Promise.all(workers);
	results.sort((a, b) => a.url.localeCompare(b.url));
	const bad = results.filter((row) => row.status !== 200);
	console.log(`  共 ${results.length} 条，非 200 的 ${bad.length} 条：`);
	for (const row of bad) console.log(`    ${row.status} ${row.url}`);
	writeFileSync('.import/urls-old-status.txt', results.map((row) => `${row.status}\t${row.url}`).join('\n') + '\n', 'utf8');
	console.log('  明细写到 .import/urls-old-status.txt');
}

if (APPLY === 'local' || APPLY === 'remote') {
	console.log(`\n=== 读目标库现状并建立 id 映射（${APPLY}）===`);
	const state = fetchTargetState(APPLY);
	const metaOrderColumn = pick(tableColumns(db, T.metas), 'order', 'sort_order') ?? 'order';
	const metaRows = rows<{ mid: number; type: string; slug: string; name: string }>(
		db,
		`SELECT mid, name, slug, type FROM ${T.metas} ORDER BY mid`,
	).map((row) => ({ ...row, mid: Number(row.mid) }));
	const maps = buildIdMaps(
		metaRows,
		rows<{ uid: number; username: string; role: string }>(
			db,
			`SELECT uid, ${q(pick(tableColumns(db, T.users), 'username', 'name') ?? 'name')} AS username,
			        ${q(pick(tableColumns(db, T.users), 'group', 'role') ?? 'group')} AS role
			   FROM ${T.users}`,
		).map((row) => ({
			uid: Number(row.uid),
			username: String(row.username),
			role: ['administrator', 'editor', 'author', 'contributor'].includes(String(row.role))
				? String(row.role)
				: 'administrator',
		})),
		state,
	);
	for (const note of maps.notes) console.log(`  · ${note}`);
	const mappedUids = new Set(maps.user.values());
	const orphans = state.admins.filter((row) => !mappedUids.has(row.uid));
	if (orphans.length > 0) {
		console.log(`  · 提示：目标库里这些用户不在老站数据中，保持原样：${orphans.map((row) => `${row.username}(uid=${row.uid})`).join(', ')}`);
	}
	void metaOrderColumn;

	console.log(`\n=== 生成 SQL 并写入 D1（${APPLY}）===`);
	const { files, summary } = emitSql(db, maps, T);
	console.log('  计划：', JSON.stringify(summary));
	if (has('plan-only')) {
		console.log(`  --plan-only：只生成不执行，SQL 在 ${SQL_DIR}/`);
	} else {
		applySql(files, APPLY);
		console.log('\n导入完成。下一步：触发全站发布把对象写进 R2（§12.2 / §6.5）');
	}
} else {
	console.log('\n（只读体检完成。加 --emit-sql 生成 SQL，或 --apply local|remote 直接导入）');
}

db.close();
