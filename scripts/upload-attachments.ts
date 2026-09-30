/**
 * 附件迁移：把老站 `usr/uploads/` 下的文件按**原路径**写进 R2 —— 设计文档 §9
 *
 * 用法：
 *   npx tsx scripts/upload-attachments.ts --root .import --target local     # 本地彩排
 *   npx tsx scripts/upload-attachments.ts --root .import --target remote    # 生产
 *   npx tsx scripts/upload-attachments.ts --root .import --dry-run          # 只看计划
 *
 * 三条纪律：
 *   1. **R2 key 必须与老站路径逐字一致**（`usr/uploads/2011/04/xxx.jpg`）。
 *      正文里 54 处相对引用 + 37 处绝对 URL（`https://fengqi.me/usr/uploads/...`）都指着它，
 *      改一个字符就是碎图。
 *   2. **文件名可能含中文/空格** —— key 用解码后的字面量，浏览器请求时 R2 会先解码再匹配
 *      （实测见 §9）。文件名一律不改。
 *   3. 附件用 `immutable`：文件名一旦确定就不变，要换图就换文件名（§7.2）。
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : args[index + 1];
};
const has = (name: string) => args.includes(`--${name}`);

const ROOT = flag('root', '.import')!;
const TARGET = flag('target', 'local')!;
const BUCKET = 'blog-content';
const DRY_RUN = has('dry-run');

const SOURCE_DIR = join(ROOT, 'usr', 'uploads');
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

const MIME: Record<string, string> = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.svg': 'image/svg+xml',
	'.bmp': 'image/bmp',
	'.ico': 'image/x-icon',
	'.pdf': 'application/pdf',
	'.zip': 'application/zip',
	'.gz': 'application/gzip',
	'.mp4': 'video/mp4',
	'.mp3': 'audio/mpeg',
	'.txt': 'text/plain; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json',
};

function contentTypeOf(path: string): string {
	const dot = path.lastIndexOf('.');
	return (dot >= 0 ? MIME[path.slice(dot).toLowerCase()] : undefined) ?? 'application/octet-stream';
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		// .DS_Store 是 macOS 垃圾文件，别搬到线上
		if (entry.name === '.DS_Store') continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

const files = walk(SOURCE_DIR).sort();
console.log(`=== 附件迁移：${files.length} 个文件（${SOURCE_DIR}）→ R2 ${BUCKET}（${TARGET}）===`);

let uploaded = 0;
let bytes = 0;
const failed: string[] = [];

for (const file of files) {
	// key = 相对 --root 的路径，恰好就是老站 URL 去掉前导斜杠（usr/uploads/...）
	const key = relative(ROOT, file).split(sep).join('/');
	const size = statSync(file).size;
	bytes += size;

	if (DRY_RUN) {
		console.log(`  [dry-run] ${key}  ${size} B  ${contentTypeOf(file)}`);
		continue;
	}

	try {
		execFileSync(
			'npx',
			[
				'wrangler',
				'r2',
				'object',
				'put',
				`${BUCKET}/${key}`,
				`--file=${file}`,
				`--content-type=${contentTypeOf(file)}`,
				`--cache-control=${CACHE_CONTROL}`,
				`--${TARGET}`,
			],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
		);
		uploaded++;
		if (uploaded % 10 === 0) console.log(`  已上传 ${uploaded}/${files.length}`);
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string };
		failed.push(key);
		console.error(`  ✗ ${key}`);
		console.error((failure.stdout ?? '').slice(0, 400));
		console.error((failure.stderr ?? '').slice(0, 400));
	}
}

if (DRY_RUN) {
	console.log(`\n计划上传 ${files.length} 个文件，合计 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
} else {
	console.log(`\n=== 完成：成功 ${uploaded}，失败 ${failed.length}，合计 ${(bytes / 1024 / 1024).toFixed(1)} MB ===`);
	for (const key of failed) console.log('  ✗', key);
	if (failed.length > 0) process.exitCode = 1;
}
