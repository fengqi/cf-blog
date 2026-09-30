/**
 * 发布流水线 —— 设计文档 §6.1 / §6.2 / §6.3 / §11
 *
 * 一次发布按 §6.1 的顺序走：
 *   1. Markdown → HTML
 *   2. XSS 清洗
 *   3. 生成摘要、统计字数
 *   4. 写 D1（body 原文 + rendered + excerpt + words，并把 needs_sync 置 1）
 *   5. 用模板把 rendered 套进完整页面骨架
 *   6. 批量写 R2
 *   7. 清理失效对象（删除文章时）
 *
 * **同步/异步切分（§6.3）**：
 *   同步 —— 只写文章页本身，让作者立刻看到成功
 *   异步 —— `ctx.waitUntil()` 重建首页、分页、归档、Feed、Sitemap
 * 实测单篇发布 26 个对象、0.7 ms（§13.1 #4），余量很大，所以不需要 Queues。
 *
 * **一致性（§6.2）**：先写 D1 后写 R2，R2 失败不回滚 D1。
 * 任何写失败都要留着 `needs_sync = 1`，交给 Cron 对账。
 */

import { createDb } from '../lib/db';
import { countWords, extractText, makeExcerpt, renderMarkdown, splitMoreMarker } from '../lib/markdown';
import { deleteKeys, writeObjects } from '../lib/r2';
import type { WriteOutcome } from '../lib/r2';
import { standalonePagePath, postPath } from '../lib/url';
import {
	countNeedsSync,
	deleteContent,
	getContentBody,
	getContentByCid,
	getContentStatus,
	listRetiredKeysByCid,
	markNeedsSync,
	markSynced,
	saveRendered,
} from '../models/content';
import { renderTarget, renderTargets } from './render';
import { loadSnapshot } from './snapshot';
import {
	contentDeleteKeys,
	contentPublishTargets,
	filterTargetsByGroups,
	postDeleteTargets,
	postKeyOf,
	postPublishTargets,
	primaryCategory,
	siteTargets,
} from './targets';
import type { PostRecord, SiteSnapshot, Target } from './types';

export interface PublishEnv {
	DB: D1Database;
	BUCKET: R2Bucket;
}

/**
 * 只需要 `waitUntil` 这一个能力。
 * 这样 Hono 的 `ExecutionContext<unknown>` 与 Workers 的 `ExecutionContext` 都能直接传进来，
 * 路由单测里还能传一个把 promise 收集起来的假对象。
 */
export interface WaitUntilContext {
	waitUntil(promise: Promise<unknown>): void;
}

export interface PublishReport {
	cid?: number;
	/** 同步写的对象（文章页本身） */
	sync?: WriteOutcome;
	/** 异步重建的对象（首页/分页/归档/Feed/Sitemap） */
	deferred?: WriteOutcome;
	deleted?: WriteOutcome;
	/** 全部写完的总数（publishAll 用） */
	total?: number;
	/** 落库后仍待同步的数量（后台首页要显示它，§6.2 第 5 条） */
	needsSync: number;
	/** 草稿/私密文章不产出 R2 对象（§10） */
	skipped?: string;
}

/** 渲染片段并写回 D1：Markdown → HTML → 清洗 → 摘要/字数（§6.1 第 1~4 步） */
export async function renderAndSaveBody(
	env: PublishEnv,
	cid: number,
): Promise<{ rendered: string; excerpt: string; words: number }> {
	const db = createDb(env.DB, 'publish');
	const source = await getContentBody(db, cid);
	if (!source) throw new Error(`cid=${cid} 不存在`);

	// `<!--more-->` 摘要分界（Typecho 惯例）：标记前的部分作摘要，标记本身不进正文
	const { body, beforeMore } = splitMoreMarker(source.body);
	const rendered = renderMarkdown(body);
	const text = extractText(rendered);
	// 摘要优先级：作者自定义 > `<!--more-->` 前半段 > 自动截前 200 字。
	// 作者填了自定义摘要就尊重它；否则把自动摘要**落库** —— 这样列表查询不必回捞 rendered
	const excerpt =
		(source.excerpt ?? '').trim() ||
		(beforeMore !== null ? makeExcerpt(renderMarkdown(beforeMore)) : '') ||
		makeExcerpt(rendered);
	const words = countWords(text);

	await saveRendered(db, cid, { rendered, excerpt, words });
	return { rendered, excerpt, words };
}

/**
 * 目标清单按「同步 / 异步」切开（§6.3）。
 *
 * 同步 = 内容页本体**以及它自己的旧 URL 页**：旧 URL 的 canonical 必须和正文一起落盘，
 * 否则在异步窗口里，旧地址会以「自己就是规范地址」的状态被爬虫看到（方案 A 就白做了）。
 * 异步 = 首页、分页、归档、Feed、Sitemap。
 */
function splitTargets(targets: Target[]): { sync: Target[]; deferred: Target[] } {
	const sync: Target[] = [];
	const deferred: Target[] = [];
	for (const target of targets) {
		if (target.kind === 'post' || target.kind === 'page') sync.push(target);
		else deferred.push(target);
	}
	return { sync, deferred };
}

/** 写一批目标对象，并把失败的 key 记下来（交给调用方决定 needs_sync） */
async function writeTargets(env: PublishEnv, snapshot: SiteSnapshot, targets: Target[]): Promise<WriteOutcome> {
	const objects = renderTargets(snapshot, targets);
	return await writeObjects(env.BUCKET, objects);
}

/**
 * 直接删一批 R2 对象（后台分类管理用：分类 slug 变更/删除后，旧归档地址不保留）。
 *
 * 放在 publish 层是因为「写/删 R2 只允许出现在这里」（§11 纪律 2）；
 * 调用方（routes/admin.tsx）只负责算出要删哪些 key。
 */
export async function deleteObjects(env: PublishEnv, keys: string[]): Promise<number> {
	if (keys.length === 0) return 0;
	const outcome = await deleteKeys(env.BUCKET, keys);
	if (outcome.failed.length > 0) {
		console.warn(`[publish] 删除旧归档对象失败 ${outcome.failed.length} 个`, outcome.failed.slice(0, 5));
	}
	return outcome.written.length;
}

/**
 * 补渲染：把 `rendered` 为空的内容先渲染出来（§6.4 的 Cron 兜底）。
 *
 * 什么时候会是空的：
 *   - **定时文章刚被 Cron 转正** —— 它从没走过「保存并发布」，body 还没渲染过，
 *     不补渲染就会写出一堆空壳页面（本地 e2e 抓到的第三个 bug）
 *   - §6.4 的「保存拆两步」：先落库 body，渲染交给 `waitUntil`，那次失败就留空
 *
 * 渲染结果直接 patch 回内存里的快照，省掉重新加载整个快照（6 次查询）。
 */
export async function ensureRendered(
	env: PublishEnv,
	snapshot: SiteSnapshot,
	cids?: number[],
): Promise<number[]> {
	const wanted = cids ? new Set(cids) : undefined;
	const pending = [...snapshot.posts, ...snapshot.pages, ...snapshot.hidden].filter(
		(record) => record.html === '' && (!wanted || wanted.has(record.cid)),
	);

	for (const record of pending) {
		const fields = await renderAndSaveBody(env, record.cid);
		record.html = fields.rendered;
		record.excerpt = fields.excerpt;
		record.words = fields.words;
	}

	if (pending.length > 0) console.log(`[publish] 补渲染 ${pending.length} 篇未渲染的内容`);
	return pending.map((record) => record.cid);
}

/**
 * 发布一篇文章：**同步写文章页，异步重建其余对象**。
 *
 * 注意 `postPublishTargets` 需要文章的 tags —— 所以这里传的是
 * `getContentByCid` 拿到的完整记录（带标签），而不是列表查询的瘦身版。
 */
export async function publishPost(
	env: PublishEnv,
	ctx: WaitUntilContext | undefined,
	cid: number,
): Promise<PublishReport> {
	const db = createDb(env.DB, 'publish');

	// 1~4：渲染并落库（这一步之后 D1 已是权威状态，只有 needs_sync 标记还没清）
	await renderAndSaveBody(env, cid);

	const post = await getContentByCid(db, cid);
	if (!post) throw new Error(`cid=${cid} 在写入后读不到，数据异常`);

	// 草稿 / 私密 / 待发布都不产出 R2 对象（§10：静态直出下「私密文章」降级为不发布）；
	// `hidden` 例外：它有 URL、可访问，只是不进列表 —— 线上这些 URL 都是 200，必须照旧生成
	const status = await getContentStatus(db, cid);
	if (status !== 'publish' && status !== 'hidden') {
		return {
			cid,
			skipped: `status=${status ?? 'unknown'} 不产出静态对象`,
			needsSync: await countNeedsSync(db),
		};
	}

	const { snapshot } = await loadSnapshot(env, 'publish');
	const targets = contentPublishTargets(snapshot, post);
	const { sync, deferred } = splitTargets(targets);

	// 同步部分：让作者立刻能看到文章页
	const syncOutcome = await writeTargets(env, snapshot, sync);

	// 异步部分：首页、分页、归档、Feed、Sitemap
	const rebuild = async (): Promise<WriteOutcome> => {
		const deferredOutcome = await writeTargets(env, snapshot, deferred);
		const failed = [...syncOutcome.failed, ...deferredOutcome.failed];
		if (failed.length === 0) {
			await markSynced(db, [cid]);
		} else {
			// §6.2：R2 失败必须留下线索，别让作者靠运气发现
			await markNeedsSync(db, [cid]);
			console.warn(`[publish] cid=${cid} 有 ${failed.length} 个对象写失败`, failed.slice(0, 5));
		}
		return deferredOutcome;
	};

	let deferredOutcome: WriteOutcome | undefined;
	if (ctx) {
		ctx.waitUntil(rebuild());
	} else {
		// 本地脚本/测试里没有 ExecutionContext，就直接等它跑完
		deferredOutcome = await rebuild();
	}

	return {
		cid,
		sync: syncOutcome,
		deferred: deferredOutcome,
		needsSync: await countNeedsSync(db),
	};
}

/**
 * 全站重建 —— §6.5「全站重新渲染」与 §12.2 首次发布。
 *
 * ⚠️ **别在一次 Worker 请求里调用它**：几百个对象会撞 CPU/墙钟与子请求预算。
 * 它主要是给本地脚本用的（`npx tsx scripts/import-typecho.ts --full-publish`，见 §12.2），
 * 本地跑完全不受 Worker 限制。
 */
export async function publishAll(env: PublishEnv): Promise<PublishReport> {
	const db = createDb(env.DB, 'publish');
	const { snapshot } = await loadSnapshot(env, 'publish:full');
	// 首次发布/全站重建时，别把还没渲染过的内容产出成空壳页面
	await ensureRendered(env, snapshot);
	const targets = siteTargets(snapshot);
	const objects = renderTargets(snapshot, targets);
	const outcome = await writeObjects(env.BUCKET, objects);

	// 全站发布成功才清 needs_sync；有失败就保持脏标记，交给 Cron 对账
	const cids = [...snapshot.posts, ...snapshot.pages].map((post) => post.cid);
	if (outcome.failed.length === 0) await markSynced(db, cids);
	else await markNeedsSync(db, cids);

	return {
		total: objects.length,
		sync: outcome,
		needsSync: await countNeedsSync(db),
	};
}

/**
 * 全站分批重建：按 `siteTargets` 的**下标切片**，一次写一批（§6.5）。
 *
 * 为什么粒度是「对象」而不是「内容」：`reconcileNeedsSync` 是按脏内容重建的，
 * 它只会覆盖「文章自己的」标签归档；而**只挂在草稿上的标签**（本库有 76 个，线上仍是 200）
 * 永远轮不到。主题/模板变更后的全站重渲必须走这条路径，才能覆盖每一个对象。
 *
 * 目标清单是确定性的（同一份 D1 数据 → 同一个顺序），所以偏移量可以跨请求使用。
 */
export async function rebuildTargetsSlice(
	env: PublishEnv,
	offset = 0,
	limit = 50,
	groups?: ReadonlySet<string>,
): Promise<{ total: number; offset: number; written: number; failed: string[]; nextOffset: number | null }> {
	const { snapshot } = await loadSnapshot(env, 'publish:slice');
	const targets = filterTargetsByGroups(siteTargets(snapshot), groups);
	const slice = targets.slice(offset, offset + limit);
	const objects = renderTargets(snapshot, slice);
	const outcome = await writeObjects(env.BUCKET, objects);
	return {
		total: targets.length,
		offset,
		written: outcome.written.length,
		failed: outcome.failed.map((item) => item.key),
		nextOffset: offset + limit < targets.length ? offset + limit : null,
	};
}

/**
 * 删除一篇文章：删掉它的对象 + 旧 URL 对象，然后**按影响面**重建。
 *
 * 不删旧 URL（§5.1 方案 A 只针对**改地址**）；文章真被删了，旧 URL 也一并清掉。
 *
 * ⚠️ 重建范围**只有受影响的几十个对象**（`postDeleteTargets`），不是全站。
 * 这里曾经直接调 `siteTargets(snapshot)`，删一篇文章要重写全站 800 个对象 ——
 * 其中 700 多个和这次删除毫无关系，纯粹是浪费（§13.1 的实测数据）。
 */
export async function deletePost(
	env: PublishEnv,
	ctx: WaitUntilContext | undefined,
	cid: number,
): Promise<PublishReport> {
	const db = createDb(env.DB, 'publish');
	const post = await getContentByCid(db, cid);
	if (!post) throw new Error(`cid=${cid} 不存在`);

	const retired = await listRetiredKeysByCid(db, cid);
	const keys = [...contentDeleteKeys(post), ...retired];

	// ⚠️ 先删 D1 行再删对象：顺序反了的话，下面按快照重建会把文章又写回去（快照里还有它）
	await deleteContent(db, cid);
	const outcome = await deleteKeys(env.BUCKET, keys);

	/**
	 * 文章没了，归档与分页都变了 —— 用剩下的内容重建**受影响的那一批**。
	 *
	 * `post` 是删除前读到的完整记录（带分类/标签/创建时间），
	 * 而 `snapshot` 是删除后的 —— 两者都要：
	 * 前者用来知道「影响了哪些术语与月份」，后者用来算「现在每个归档有几页」。
	 */
	const { snapshot } = await loadSnapshot(env, 'publish:delete');
	await ensureRendered(env, snapshot);
	const rebuild = async () => {
		await writeTargets(env, snapshot, postDeleteTargets(snapshot, post));
	};
	if (ctx) ctx.waitUntil(rebuild());
	else await rebuild();

	return { cid, deleted: outcome, needsSync: await countNeedsSync(db) };
}

/**
 * 草稿预览（§2 的 `/preview/:cid`）：把未发布的内容套进完整页面。
 *
 * **不写 R2、也不改 D1** —— 预览是只读操作。渲染好的 HTML 直接注入视图模型，
 * 避免草稿的 `rendered` 为空时页面空白。
 */
export async function renderPreview(env: PublishEnv, cid: number): Promise<{ html: string; post: PostRecord }> {
	const db = createDb(env.DB, 'preview');
	const source = await getContentBody(db, cid);
	if (!source) throw new Error(`cid=${cid} 不存在`);

	const post = await getContentByCid(db, cid);
	if (!post) throw new Error(`cid=${cid} 读不到`);

	// 只读路径：渲染结果只存在内存里
	post.html = renderMarkdown(source.body);

	const { snapshot } = await loadSnapshot(env, 'preview');
	const target: Target =
		post.type === 'page'
			? { key: post.slug, kind: 'page', post, canonicalPath: standalonePagePath(post.slug) }
			: {
					key: postKeyOf(post),
					kind: 'post',
					post,
					canonicalPath: postPath(primaryCategory(post).slug, post.slug),
				};

	return { html: renderTarget(snapshot, target).body, post };
}
