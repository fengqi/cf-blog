/**
 * 后台域上的附件读取 —— design.md §9 / §2（后台子域名）
 *
 * 存在的理由：正文里的图片是**根相对路径**（`/usr/uploads/<年>/<月>/<文件名>`）。
 * 前台由 R2 自定义域名直出，这个路径天然成立；但后台子域上没人服务 `/usr/*`，
 * 于是编辑器预览、`/preview/:cid` 整页预览里的图片全是破图（404）——
 * 内容本身是对的（发布后前台正常），只是预览所在的域名没有这条路由。
 *
 * 这里直接从同一个 bucket 读出来返回，让「预览」和「发布后」看到同一张图。
 * 走 `requireAuth`：不给后台子域开第二个公开入口（前台已经是公开的，没必要再开一个）。
 */

import { Hono } from 'hono';
import type { AdminEnv } from '../types';

export const attachmentRoutes = new Hono<{ Bindings: AdminEnv }>();

attachmentRoutes.get('/usr/*', async (c) => {
	// `c.req.path` 是编码后的路径，R2 key 存的是原始字符（中文、空格都可能有）
	let key = c.req.path.slice(1);
	try {
		key = decodeURIComponent(key);
	} catch {
		// 编码不合法就按原样查，查不到就是 404
	}
	if (!key) return c.notFound();

	const object = await c.env.BUCKET.get(key);
	if (!object) return c.notFound();

	c.header('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
	return c.body(object.body);
});
