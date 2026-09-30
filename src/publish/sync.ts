/**
 * 定时任务：定时发布 + 一致性对账 —— 设计文档 §6.2 / §12.3
 *
 * 一次 Cron 触发顺序做两件事（合并进同一次触发，不占第二个额度）：
 *   ① 把到点的 `status='waiting'` 文章转正
 *   ② 扫 `needs_sync = 1` 的内容，重建它们的对象
 *
 * ② 是这套静态方案唯一的兜底手段：D1 写成功、R2 写失败时，前台看不到新文章，
 * 只有这个扫描能发现并补发。**不能省**（§6.2 第 4 条）。
 */

import { createDb } from '../lib/db';
import { writeObjects } from '../lib/r2';
import {
	countNeedsSync,
	getContentByCid,
	listNeedsSyncCids,
	listWaitingCids,
	markNeedsSync,
	markSynced,
	publishWaitingPosts,
} from '../models/content';
import { ensureRendered } from './pipeline';
import type { PublishEnv } from './pipeline';
import { renderTargets } from './render';
import { loadSnapshot } from './snapshot';
import { contentPublishTargets } from './targets';
import type { Target } from './types';

export interface SyncReport {
	/** 本次转正的定时文章数 */
	published: number;
	/** 本次补发的内容 cid */
	rebuilt: number[];
	/** 写出的对象数 */
	objects: number;
	/** 写失败的 key（留着下轮再试） */
	failed: string[];
	/** 处理完之后还剩多少待同步 */
	needsSync: number;
}

/**
 * 对账：把 `needs_sync = 1` 的内容重新渲染并写入 R2。
 *
 * 两件事容易踩坑，都在这里处理：
 *   1. **`rendered` 为空要先补渲染** —— 定时文章刚转正时从没渲染过（§6.4 的 Cron 兜底）
 *   2. 多篇内容的目标清单会大量重叠（首页、分页、Feed、Sitemap），按 key 去重后**只写一次**
 */
export async function reconcileNeedsSync(env: PublishEnv, limit = 20): Promise<SyncReport> {
	const db = createDb(env.DB, 'sync');
	const cids = await listNeedsSyncCids(db, limit);
	if (cids.length === 0) {
		return { published: 0, rebuilt: [], objects: 0, failed: [], needsSync: await countNeedsSync(db) };
	}

	const { snapshot } = await loadSnapshot(env, 'sync');
	await ensureRendered(env, snapshot, cids);

	const wanted = new Set(cids);
	const dirty = [...snapshot.posts, ...snapshot.pages].filter((record) => wanted.has(record.cid));

	const byKey = new Map<string, Target>();
	for (const record of dirty) {
		for (const target of contentPublishTargets(snapshot, record)) byKey.set(target.key, target);
	}

	const targets = [...byKey.values()];
	const objects = renderTargets(snapshot, targets);
	const outcome = await writeObjects(env.BUCKET, objects);
	const rebuilt = dirty.map((record) => record.cid);

	if (outcome.failed.length === 0) {
		await markSynced(db, rebuilt);
	} else {
		// 失败就保持脏标记，下一轮 Cron 继续补（§6.3 的 waitUntil 失败作者看不到）
		await markNeedsSync(db, rebuilt);
		console.warn(`[sync] 补发失败 ${outcome.failed.length} 个对象`, outcome.failed.slice(0, 5));
	}

	return {
		published: 0,
		rebuilt,
		objects: objects.length,
		failed: outcome.failed.map((item) => item.key),
		needsSync: await countNeedsSync(db),
	};
}

/** 定时发布：到点的 waiting 转 publish，并标脏等对账写入 R2 */
export async function publishScheduled(env: PublishEnv): Promise<number> {
	const db = createDb(env.DB, 'scheduled');
	const now = Math.floor(Date.now() / 1000);
	const waiting = await listWaitingCids(db, now);
	if (waiting.length === 0) return 0;
	return await publishWaitingPosts(db, now);
}

/** Cron 入口（§12.3）：先转正定时文章，再对账补发 —— 顺序不能反 */
export async function runScheduledTasks(env: PublishEnv, limit = 20): Promise<SyncReport> {
	const published = await publishScheduled(env);
	const report = await reconcileNeedsSync(env, limit);
	return { ...report, published };
}

/** 需要人工介入时用：把某篇内容强制标脏，下一轮 Cron 会重建它 */
export async function markContentDirty(env: PublishEnv, cid: number): Promise<void> {
	const db = createDb(env.DB, 'sync');
	const post = await getContentByCid(db, cid);
	if (!post) throw new Error(`cid=${cid} 不存在`);
	await markNeedsSync(db, [cid]);
}
