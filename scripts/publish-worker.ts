/**
 * 生产发布专用 Worker —— **只暴露发布与列举两个路由**，故意不含 e2e 的清库/夹具路由
 *
 * 用法（用 `wrangler dev --remote` 让它跑在真实线上绑定上）：
 *   npx wrangler dev -c wrangler.publish.jsonc --remote --port 8788
 *   curl "http://127.0.0.1:8788/full?offset=0&limit=50"     # 循环到 nextOffset 为 null
 *   curl "http://127.0.0.1:8788/keys"                       # 列举线上对象，用于对账
 *
 * 为什么单独一个文件：e2e 那个 worker 里有会**清空数据库**的夹具路由，
 * 一旦用 --remote 跑起来就等于把清库接口暴露在生产绑定上。这里从构造上避免那种事故。
 */

import { rebuildTargetsSlice } from '../src/publish/pipeline';

export interface PublishWorkerEnv {
	DB: D1Database;
	BUCKET: R2Bucket;
}

export default {
	async fetch(request: Request, env: PublishWorkerEnv): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/health') {
			return Response.json({ ok: true });
		}

		if (url.pathname === '/full') {
			const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
			const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
			return Response.json(
				await rebuildTargetsSlice(env, Number.isFinite(offset) && offset > 0 ? offset : 0, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50),
			);
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

		return new Response('not found', { status: 404 });
	},
} satisfies ExportedHandler<PublishWorkerEnv>;
