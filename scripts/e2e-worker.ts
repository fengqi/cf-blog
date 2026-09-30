/**
 * 本地 e2e 的 Worker 入口 —— 只在本地 `wrangler dev` 里跑，**不部署**
 *
 * 用法（见 README）：
 *   npx wrangler d1 migrations apply blog-db --local
 *   npx wrangler dev -c wrangler.e2e.jsonc --port 8788
 *   curl -s http://127.0.0.1:8788/
 *
 * 它跑的是真实 workerd + 真实 D1/R2 绑定，比 mock 更接近线上。
 */

import { reconcileNeedsSync } from '../src/publish/sync';
import { runE2E } from './e2e-runner';
import type { E2EEnv } from './e2e-runner';

export default {
	async fetch(request: Request, env: E2EEnv): Promise<Response> {
		const url = new URL(request.url);

		// 迁移彩排用的两个只读/批处理入口（这个 worker 只在本地 wrangler dev 里跑）
		if (url.pathname === '/drain') {
			const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
			const report = await reconcileNeedsSync(env, Number.isFinite(limit) && limit > 0 ? limit : 20);
			return Response.json({
				rebuilt: report.rebuilt.length,
				objects: report.objects,
				failed: report.failed,
				needsSync: report.needsSync,
			});
		}
		// 本地彩排用：清空本地 R2（必须显式确认；这个 worker 只在 --local 下跑）
		if (url.pathname === '/wipe') {
			if (url.searchParams.get('confirm') !== 'wipe-local-r2') {
				return new Response('需要 ?confirm=wipe-local-r2', { status: 400 });
			}
			const keys: string[] = [];
			let cursor: string | undefined;
			do {
				const page = await env.BUCKET.list({ cursor, limit: 1000 });
				keys.push(...page.objects.map((object) => object.key));
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
			if (keys.length > 0) await env.BUCKET.delete(keys);
			return Response.json({ deleted: keys.length });
		}
		if (url.pathname === '/keys') {
			const keys: string[] = [];
			let cursor: string | undefined;
			do {
				const page = await env.BUCKET.list({ cursor, limit: 1000 });
				keys.push(...page.objects.map((object) => object.key));
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
			return Response.json({ count: keys.length, keys: keys.sort() });
		}

		try {
			const report = await runE2E(env);
			const failed = report.includes('项失败');
			return new Response(report, {
				status: failed ? 500 : 200,
				headers: { 'content-type': 'text/plain; charset=utf-8' },
			});
		} catch (error) {
			return new Response(`e2e 崩了：${String(error)}\n${(error as Error).stack ?? ''}`, {
				status: 500,
				headers: { 'content-type': 'text/plain; charset=utf-8' },
			});
		}
	},
} satisfies ExportedHandler<E2EEnv>;
