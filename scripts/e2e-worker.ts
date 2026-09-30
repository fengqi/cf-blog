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

import { runE2E } from './e2e-runner';
import type { PublishEnv } from '../src/publish/pipeline';

export default {
	async fetch(_request: Request, env: PublishEnv): Promise<Response> {
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
} satisfies ExportedHandler<PublishEnv>;
