/**
 * 主题资源指纹构建 —— 设计文档 §7.2 / §11
 *
 *   npm run build:assets
 *
 * 读 `theme/assets/` 下的每个文件，算内容 sha256 的前 8 位做指纹，产出
 * `theme/assets.generated.ts`（一个普通的 TS 模块，内容是转义好的字面量）。
 *
 * **为什么是「生成 .ts 模块」而不是在代码里 `import './style.css'`**：
 *   主题层要在三种运行时里跑 —— workerd（发布流水线）、tsx（bench / 迁移脚本）、
 *   tsc（类型检查）。wrangler 的 Text module rules 只在 workerd 那一路生效，
 *   `tsx scripts/bench-render.ts` 会直接炸在 `import './x.css'` 上。生成 TS 字面量之后，
 *   资源内容就是代码的一部分，三条路径自然全部可用，也**不需要给三个 wrangler 配置
 *   各加一遍 rules**（那种配置漂移迟早会咬人）。
 *
 * 生成文件要提交进仓库：部署命令里虽然也会重跑本脚本（防止漂移），
 * 但 e2e / bench / 迁移脚本都直接读它，仓库里必须有一份可用的。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = join(ROOT, 'theme', 'assets');
const OUTPUT_FILE = join(ROOT, 'theme', 'assets.generated.ts');

/** 指纹长度。8 位十六进制 = 32 bit，对「几个资源文件」这个量级足够 */
const HASH_LENGTH = 8;

/**
 * 支持的类型 → R2 对象要写的 content-type。
 * 白名单之外的文件**直接跳过并告警** —— 静默写入一个 content-type 猜错的对象，
 * 浏览器会当下载处理，比少一个文件更难排查。
 */
const CONTENT_TYPES: Record<string, string> = {
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
	'.txt': 'text/plain; charset=utf-8',
};

interface BuiltAsset {
	name: string;
	hash: string;
	key: string;
	contentType: string;
	content: string;
	bytes: number;
}

/** `style.css` + 内容 → R2 key `theme/style.a1b2c3d4.css`（§7.2 要求的指纹形态） */
function buildKey(name: string, hash: string): string {
	const ext = extname(name);
	return `theme/${name.slice(0, name.length - ext.length)}.${hash}${ext}`;
}

/** 输出成合法的 TS 字符串字面量。用 JSON.stringify 而不是模板串：内容里有反引号 / `${` 时不会炸 */
function literal(value: string): string {
	return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

async function main(): Promise<void> {
	const entries = (await readdir(SOURCE_DIR, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
		.map((entry) => entry.name)
		// 排序，保证同一份输入产出逐字节相同的文件（可 diff、可 review）
		.sort();

	const assets: BuiltAsset[] = [];
	for (const name of entries) {
		const ext = extname(name);
		const contentType = CONTENT_TYPES[ext];
		if (!contentType) {
			console.warn(`[assets] 跳过 ${name}：不支持的扩展名 ${ext || '(无)'}`);
			continue;
		}

		const content = await readFile(join(SOURCE_DIR, name), 'utf8');
		const hash = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, HASH_LENGTH);
		assets.push({
			name,
			hash,
			key: buildKey(name, hash),
			contentType,
			content,
			bytes: Buffer.byteLength(content, 'utf8'),
		});
	}

	if (assets.length === 0) {
		throw new Error(`[assets] ${SOURCE_DIR} 里没有任何可用资源 —— 主题会来不及样式，先检查目录`);
	}

	const out: string[] = [
		'/**',
		' * 主题资源清单 —— **自动生成，不要手改**。',
		' *',
		' * 由 `npm run build:assets`（`scripts/build-assets.ts`）从 `theme/assets/` 产出：',
		' * 每个文件算内容 sha256 的前 8 位做指纹，key 形如 `theme/style.a1b2c3d4.css`（§7.2）。',
		' *',
		' * 改了 `theme/assets/` 下的任何文件都要重跑构建，否则页面里的 `<link>` 仍指向旧指纹，',
		' * 而旧对象是 `immutable` 缓存的 —— 用户会一直看到旧样式。',
		' */',
		'',
		'/** 一个被打过指纹的主题资源 */',
		'export interface ThemeAssetRecord {',
		'\t/** 源文件名，如 `style.css` */',
		'\tname: string;',
		'\t/** 内容 sha256 的前 8 位 */',
		'\thash: string;',
		'\t/** R2 key，也是 URL 路径去掉前导斜杠，如 `theme/style.a1b2c3d4.css` */',
		'\tkey: string;',
		'\t/** 写入 R2 时要带的 content-type */',
		'\tcontentType: string;',
		'\t/** 文件内容原文。**别手改**，改源文件后重跑构建 */',
		'\tcontent: string;',
		'}',
		'',
		`/** 全部主题资源，按源文件名排序（${assets.length} 个） */`,
		'export const THEME_ASSETS: ThemeAssetRecord[] = [',
	];

	for (const asset of assets) {
		out.push('\t{');
		out.push(`\t\tname: ${literal(asset.name)},`);
		out.push(`\t\thash: ${literal(asset.hash)},`);
		out.push(`\t\tkey: ${literal(asset.key)},`);
		out.push(`\t\tcontentType: ${literal(asset.contentType)},`);
		out.push(`\t\tcontent: ${literal(asset.content)},`);
		out.push('\t},');
	}

	out.push('];', '');

	await writeFile(OUTPUT_FILE, out.join('\n'), 'utf8');

	const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);
	for (const asset of assets) {
		console.log(`[assets] ${asset.key}  ${(asset.bytes / 1024).toFixed(1)} KB`);
	}
	console.log(`[assets] 共 ${assets.length} 个 / ${(total / 1024).toFixed(1)} KB → theme/assets.generated.ts`);
}

await main();
