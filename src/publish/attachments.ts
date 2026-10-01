/**
 * 附件写入 R2 —— design.md §9
 *
 * 纪律（§11 硬约束 2）：R2 的写操作只出现在 `src/publish/`。附件虽然不进渲染流水线，
 * 但缓存策略（`immutable`）与「不能覆盖已有对象」的约束和发布是同一套，所以也收在这里。
 *
 * 路径规则：`usr/uploads/<年>/<月>/<文件名>`（<年>/<月> 按上传时间、站点时区生成）。
 * **文件名一旦写进 R2 就不能变**（正文会引用；边缘缓存 immutable）——
 * 所以同 key 已存在时拒绝写入，让作者改名，绝不静默覆盖。
 */

import { CACHE_CONTROL } from '../lib/r2';

export interface AttachmentEnv {
	BUCKET: R2Bucket;
}

/** 设计 §9 的上传白名单：按扩展名判（浏览器给的 MIME 不可信），值是写进 R2 的 content-type */
export const ATTACHMENT_TYPES: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
	gif: 'image/gif',
	avif: 'image/avif',
	pdf: 'application/pdf',
};

/** 单文件上限 10MB（R2 免费 10GB，不构成约束；真正的约束是 Worker 请求体 100MB） */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function attachmentContentType(filename: string): string | undefined {
	const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
	return ATTACHMENT_TYPES[ext];
}

/**
 * 清洗浏览器给的文件名，只留 basename；不合法返回 null。
 * 中文和空格按原样保留（§9 已实测 R2 key 支持中文+空格）；
 * `%` 必须拒掉 —— 预览与浏览器都会对路径做百分号解码，文件名里带 `%` 会解码成别的字符。
 */
export function sanitizeAttachmentFilename(raw: string): string | null {
	const name = raw.split(/[\\/]/).pop()!.trim();
	if (!name || name.length > 200) return null;
	if (/[%"?#]/.test(name) || /[\x00-\x1f]/.test(name)) return null;
	if (!name.includes('.')) return null;
	return name;
}

/** `usr/uploads/<年>/<月>/<文件名>`；<年>/<月> 按站点时区的上传时间取 */
export function attachmentKey(nowSeconds: number, timezoneOffset: number, filename: string): string {
	const shifted = new Date((nowSeconds + timezoneOffset * 3600) * 1000);
	const year = shifted.getUTCFullYear();
	const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
	return `usr/uploads/${year}/${month}/${filename}`;
}

/** 附件公开 URL 的路径部分（R2 key 去掉前导目录约定 `usr/` 后就是站点路径） */
export function attachmentUrlPath(r2Key: string): string {
	return `/${r2Key}`;
}

export type PutAttachmentResult = { ok: true } | { ok: false; reason: string };

export async function putAttachment(
	env: AttachmentEnv,
	key: string,
	body: ArrayBuffer,
	contentType: string,
): Promise<PutAttachmentResult> {
	// immutable 的对象不能覆盖：边缘可能已经缓存了旧内容（§7.2 实测 26 秒后仍返回 v1）
	const existing = await env.BUCKET.head(key);
	if (existing) {
		return { ok: false, reason: `R2 里已有同名文件：${key}（附件不可覆盖），改个文件名再传` };
	}
	await env.BUCKET.put(key, body, {
		httpMetadata: { contentType, cacheControl: CACHE_CONTROL.asset },
	});
	return { ok: true };
}

/**
 * 删除附件对象（编辑器右侧「附件」tab 的快捷删除）。
 * 与 `putAttachment` 成对放在这一层：R2 的写操作只在 `src/publish/` 出现（§11）。
 * ⚠️ 不检查正文里是否还引用着这个 URL —— 删了正文里的引用就是坏链，
 * 这是作者自己的选择（Typecho 同样不检查）。
 */
export async function deleteAttachmentObject(env: AttachmentEnv, key: string): Promise<void> {
	await env.BUCKET.delete(key);
}
