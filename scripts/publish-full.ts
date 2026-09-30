/**
 * 生产全量重渲编排 —— 封装「起 --remote publish worker → /full 从 0 循环到 null → 指纹自查」
 *
 *   npm run publish:prod [-- --limit=50]
 *
 * 什么时候要跑：部署之后，只要这次改动**会出现在前台 HTML 的字节里**——
 *   - 改了 theme/assets/（CSS/JS，指纹变了，HTML 里的 <link>/<script> 要跟）
 *   - 改了 theme/ 模板或 src/publish 渲染逻辑
 * 只改后台代码（admin 路由/鉴权/媒体等）不用跑。
 *
 * ⚠️ `wrangler dev --remote` 跑的是**本地工作区这份代码**（临时上传的预览会话），
 * 不是线上已部署的那份 —— 所以跑之前确保工作区就是刚部署的内容（干净、最新），
 * 否则等于用另一份代码重渲了全站。
 *
 * 幂等：同一份代码 + 同一份数据，跑几遍结果都一样；中途失败直接重跑即可。
 */
import { spawn } from 'node:child_process';
import { THEME_ASSETS } from '../theme/assets';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
/** 生产免费版单请求 50 个子请求封顶 —— 每个对象一次写，批上限就是 50 */
const MAX_LIMIT = 50;
const READY_TIMEOUT_MS = 120_000;

interface FullReport {
	total: number;
	offset: number;
	written: number;
	failed: string[];
	nextOffset: number | null;
}

async function waitForReady(): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${BASE}/health`);
			if (res.ok) return;
		} catch {
			// 还没起来，继续等
		}
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	throw new Error(`publish worker ${READY_TIMEOUT_MS / 1000} 秒内没就绪（检查 8799 端口占用 / 代理环境变量）`);
}

async function main(): Promise<void> {
	const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
	const limit = Math.min(Number(limitArg?.split('=')[1]) || MAX_LIMIT, MAX_LIMIT);

	console.log(`[publish:prod] 起远程发布会话（端口 ${PORT}，单批上限 ${limit}）……`);
	const child = spawn('npx', ['wrangler', 'dev', '-c', 'wrangler.publish.jsonc', '--remote', '--port', String(PORT)], {
		cwd: new URL('..', import.meta.url).pathname,
		stdio: 'inherit',
	});
	const cleanup = (): void => {
		child.kill('SIGTERM');
	};
	process.on('SIGINT', () => {
		cleanup();
		process.exit(130);
	});

	try {
		await waitForReady();

		let offset = 0;
		let total = 0;
		for (;;) {
			const res = await fetch(`${BASE}/full?offset=${offset}&limit=${limit}`);
			if (!res.ok) throw new Error(`批次 offset=${offset} 返回 HTTP ${res.status}`);
			const report = (await res.json()) as FullReport;
			total = report.total;
			console.log(
				`[batch] offset=${report.offset} written=${report.written} failed=${report.failed.length}` +
					(report.failed.length > 0 ? ` ← ${report.failed.slice(0, 5).join(', ')}` : ''),
			);
			if (report.failed.length > 0) {
				throw new Error(`有 ${report.failed.length} 个对象写入失败（上面列了前 5 个）。本命令幂等，排除原因后直接重跑。`);
			}
			if (report.nextOffset === null) break;
			offset = report.nextOffset;
		}
		console.log(`[publish:prod] 全量完成：${total} 个对象`);

		// 指纹自查 —— HTML 引用的 theme 指纹必须都在桶里（404 事故的最后一道闸）
		const keysRes = await fetch(`${BASE}/keys`);
		if (!keysRes.ok) throw new Error(`/keys 返回 HTTP ${keysRes.status}`);
		const { keys } = (await keysRes.json()) as { keys: string[] };
		const missing = THEME_ASSETS.filter((asset) => !keys.includes(asset.key)).map((asset) => asset.key);
		if (missing.length > 0) throw new Error(`主题指纹对象缺失：${missing.join(', ')}`);
		console.log(`[publish:prod] 主题指纹就位：${THEME_ASSETS.map((asset) => asset.key).join(', ')}`);
	} finally {
		cleanup();
	}
}

main().catch((error) => {
	console.error(`[publish:prod] 失败：${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
