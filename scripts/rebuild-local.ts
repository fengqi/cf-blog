/**
 * 本地全量重渲 —— 把「循环 curl /__publish?confirm=local&offset=N&limit=200 直到 nextOffset=null」
 * 封装成一个命令：
 *
 *   npm run preview:r2          # 先起本地预览（8790）
 *   npm run rebuild:local       # 把当前 D1 的内容重新渲进本地 R2
 *
 * 想看线上桶时（--remote 预览）**不要**跑这个脚本：那时绑定指向线上桶，
 * /__publish 会写生产。脚本没法从 HTTP 层区分本地/远程，只认 --base 给的地址
 * （默认 127.0.0.1:8790），起远程预览时换端口（如 8791）就撞不到它。
 */

interface SliceReport {
	total: number;
	offset: number;
	written: number;
	failed: string[];
	nextOffset: number | null;
}

function argValue(flag: string): string | undefined {
	const found = process.argv.find((arg) => arg.startsWith(`${flag}=`));
	return found?.slice(flag.length + 1);
}

async function main(): Promise<void> {
	const base = (argValue('--base') ?? 'http://127.0.0.1:8790').replace(/\/+$/, '');
	const limit = Math.min(Math.max(Number.parseInt(argValue('--limit') ?? '200', 10) || 200, 1), 200);

	let offset = 0;
	let written = 0;
	const failed: string[] = [];

	for (;;) {
		let report: SliceReport;
		try {
			const response = await fetch(`${base}/__publish?confirm=local&offset=${offset}&limit=${limit}`);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}：${await response.text()}`);
			}
			report = (await response.json()) as SliceReport;
		} catch (error) {
			console.error(`重渲失败（offset=${offset}）：${String(error)}`);
			console.error(`连不上 ${base}？先起本地预览：npm run preview:r2`);
			process.exit(1);
		}

		written += report.written;
		failed.push(...report.failed);
		console.log(
			`offset=${String(report.offset).padStart(4)} 写入 ${report.written} / 共 ${report.total}` +
				(report.nextOffset === null ? '，完成' : `，nextOffset=${report.nextOffset}`),
		);
		if (report.nextOffset === null) break;
		offset = report.nextOffset;
	}

	if (failed.length > 0) {
		console.error(`\n有 ${failed.length} 个对象写失败（保留脏标记，可重跑本命令重试）：`);
		for (const key of failed.slice(0, 10)) console.error(`  ✗ ${key}`);
		if (failed.length > 10) console.error(`  … 其余 ${failed.length - 10} 个略`);
		process.exit(1);
	}
	console.log(`\n完成：${written} 个对象已写入本地 R2（${base}）。curl ${base}/__keys 可对账`);
}

main();
