/**
 * R2 读写封装 + 缓存头 —— 设计文档 §7.2 / §11
 *
 * ⚠️ **纪律（§11 硬约束 2）：只有 `src/publish/` 允许调用本文件的写函数。**
 * 别的地方碰 R2，会让缓存策略与对象一致性失控 —— 这是静态直出方案唯一的纪律要求。
 *
 * 缓存头按 §7.2（已按 2026-09 实测修正）：
 *  - `.html` 不在 Cloudflare 默认可缓存扩展名里 → 文章页覆盖即生效，短 max-age 有意义
 *  - 可缓存扩展名（.css/.js/图片…）会被边缘缓存，而 Cloudflare 会把 **小于 4 小时** 的
 *    max-age 抬到 14400（默认 Browser Cache TTL），缺省时还会插入 —— 实测 300 → 14400、
 *    不设 → 14400、`31536000, immutable` → 原样保留
 *  - 所以主题资源与附件必须 `immutable` + 文件名指纹，**不能**靠短 TTL 更新
 *  - Free 版 Edge Cache TTL 最低 2 小时，别指望把边缘缓存压到几分钟
 */

export type ObjectKind = 'post' | 'index' | 'overview' | 'archive' | 'feed' | 'sitemap' | 'asset';

/** 一个待写入 R2 的文本对象 */
export interface RenderedObject {
	/** R2 key，**解码后的字面量**（中文不编码，见 src/lib/url.ts 顶部说明） */
	key: string;
	kind: ObjectKind;
	body: string;
	contentType: string;
}

export const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

export const CACHE_CONTROL: Record<ObjectKind, string> = {
	post: 'public, max-age=300, stale-while-revalidate=600',
	index: 'public, max-age=60, stale-while-revalidate=300',
	// 索引页只在发布时变（计数），介于列表页与文章页之间取 300
	overview: 'public, max-age=300',
	archive: 'public, max-age=120',
	feed: 'public, max-age=600',
	sitemap: 'public, max-age=600',
	asset: 'public, max-age=31536000, immutable',
};

export function metadataFor(kind: ObjectKind, contentType = HTML_CONTENT_TYPE): R2HTTPMetadata {
	return { contentType, cacheControl: CACHE_CONTROL[kind] };
}

export interface WriteOutcome {
	written: string[];
	failed: { key: string; reason: string }[];
}

/**
 * 批量写对象。**返回失败清单而不是抛错** —— 发布流水线要拿它去标记 `needs_sync`（§6.2）：
 * D1 写成功但 R2 写失败时，前台看不到新文章，必须留下对账线索。
 */
export async function writeObjects(
	bucket: R2Bucket,
	objects: RenderedObject[],
	options: { concurrency?: number } = {},
): Promise<WriteOutcome> {
	const concurrency = Math.max(1, options.concurrency ?? 8);
	const written: string[] = [];
	const failed: { key: string; reason: string }[] = [];

	for (let index = 0; index < objects.length; index += concurrency) {
		const chunk = objects.slice(index, index + concurrency);
		const results = await Promise.allSettled(
			chunk.map((object) =>
				bucket.put(object.key, object.body, {
					httpMetadata: metadataFor(object.kind, object.contentType),
				}),
			),
		);
		results.forEach((result, offset) => {
			const key = chunk[offset].key;
			if (result.status === 'fulfilled') written.push(key);
			else failed.push({ key, reason: String(result.reason) });
		});
	}

	return { written, failed };
}

/** 批量删对象（文章删除、失效对象清理用） */
export async function deleteKeys(
	bucket: R2Bucket,
	keys: string[],
	options: { concurrency?: number } = {},
): Promise<WriteOutcome> {
	const concurrency = Math.max(1, options.concurrency ?? 8);
	const written: string[] = [];
	const failed: { key: string; reason: string }[] = [];

	for (let index = 0; index < keys.length; index += concurrency) {
		const chunk = keys.slice(index, index + concurrency);
		const results = await Promise.allSettled(chunk.map((key) => bucket.delete(key)));
		results.forEach((result, offset) => {
			if (result.status === 'fulfilled') written.push(chunk[offset]);
			else failed.push({ key: chunk[offset], reason: String(result.reason) });
		});
	}

	return { written, failed };
}
