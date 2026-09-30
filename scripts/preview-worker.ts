/**
 * 本地前台预览 Worker —— 设计文档 §7.2 / §12.2 的调试配套
 *
 * 线上前台是「R2 + 自定义域名」，本地没有这一层，所以用它来补：
 * 把请求路径按 **R2 的真实规则**映射成 key 再从绑定的桶里取（先百分号解码、再精确匹配，
 * `/` 对应空 key —— 见 design.md §7.2 的实测结论），于是本地也能像线上一样点着看：
 * 相对链接、`/theme/style.<hash>.css`、附件图片全都能正常加载。
 *
 * 用法：
 *   npm run preview:r2                     # 预览本地 R2（默认 8790）
 *   npx wrangler dev -c wrangler.preview.jsonc --remote   # 预览线上桶里的对象
 *   curl "http://127.0.0.1:8790/__publish?confirm=local&limit=200"   # 把当前 D1 重新渲进本地 R2
 *
 * ⚠️ **`--remote` 下不要调 `/__publish`**：那时绑定指向线上桶，这一步会写生产。
 * 路由要求 `?confirm=local` 只是为了防手滑，不是权限控制。
 *
 * 为什么单独一个 worker：它和 `publish-worker.ts` 一样是**本机调试工具**，不进任何部署路径
 * （`wrangler.preview.jsonc` 不在 CI 里），只绑 R2 + D1，没有任何别的能力。
 */

import { rebuildTargetsSlice } from '../src/publish/pipeline';

export interface PreviewEnv {
	DB: D1Database;
	BUCKET: R2Bucket;
}

/** 与 R2 一致：先解码 pathname，再当 key 精确匹配；`/` → 空 key（首页） */
function keyFromRequest(url: URL): string {
	const raw = url.pathname.replace(/^\/+/, '');
	try {
		return decodeURIComponent(raw);
	} catch {
		// 非法百分号编码：R2 也不会帮你解码成功，按原样匹配（多半就是 404）
		return raw;
	}
}

function text(body: string, status = 200): Response {
	return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export default {
	async fetch(request: Request, env: PreviewEnv): Promise<Response> {
		const url = new URL(request.url);

		/** 把当前 D1 的内容重新渲染进 R2：改了模板/样式之后刷新预览用 */
		if (url.pathname === '/__publish') {
			if (url.searchParams.get('confirm') !== 'local') {
				return text('这条路由会写 R2。本地预览请加 ?confirm=local；--remote 模式下别调它。', 400);
			}
			const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
			const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
			return Response.json(
				await rebuildTargetsSlice(env, Number.isFinite(offset) && offset > 0 ? offset : 0, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 200),
			);
		}

		/** 列对象：本地对账用（与 publish-worker 的 /keys 同形） */
		if (url.pathname === '/__keys') {
			const keys: string[] = [];
			let cursor: string | undefined;
			do {
				const page = await env.BUCKET.list({ cursor, limit: 1000 });
				keys.push(...page.objects.map((object) => object.key));
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
			return Response.json({ count: keys.length, keys: keys.sort() });
		}

		const key = keyFromRequest(url);
		const object = await env.BUCKET.get(key);
		if (object === null) {
			return text(
				`本地 R2 里没有这个 key：${JSON.stringify(key)}\n` +
					'先发布到本地 R2 再预览：\n' +
					'  curl "http://127.0.0.1:8790/__publish?confirm=local&limit=200"\n' +
					'（nextOffset 不为 null 就带着它再调一次；也可以看 /__keys 确认对象是否写进去了）\n',
				404,
			);
		}

		return new Response(object.body, {
			headers: {
				// 用写入时存的 contentType（发布时按扩展名给的值），保证 CSS/图片类型正确
				'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
				// 本地预览不缓存：改了模板/样式重渲后刷新就能看到
				'cache-control': 'no-store',
				'x-preview-key': key,
			},
		});
	},
} satisfies ExportedHandler<PreviewEnv>;
