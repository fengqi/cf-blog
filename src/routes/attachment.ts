/**
 * 后台域上的前台静态对象 —— design.md §9 / §2 / §7.2
 *
 * 后台子域（`admin-blog.fengqi.me`）上跑的是同一个 Worker，但它只注册了后台路由；
 * 而**渲染出来的 HTML 是前台同款**，里面全是根相对路径：
 *   - `/usr/uploads/...` —— 正文里的图片（§9）
 *   - `/theme/style.<hash>.css`、`/theme/app.<hash>.js` —— 主题资源（§7.2）
 * 前台由 R2 直出，这两个路径天然成立；后台没人服务 → 编辑器预览与 `/preview/:cid`
 * 整页预览要么破图、要么**完全没有样式和 JS**。内容本身没错（发布后前台正常），
 * 只是预览所在的域名缺这两条路由。
 *
 * 这里直接从同一个 bucket 把对象读出来返回，让「预览」和「发布后」看到同一份东西。
 * 走 `requireAuth`：不给后台子域开第二个公开入口（前台已经是公开的，没必要再开一个）。
 */

import { Hono } from 'hono';
import type { AdminEnv } from '../types';

export const attachmentRoutes = new Hono<{ Bindings: AdminEnv }>();

/** URL 路径 → R2 key：去掉前导斜杠，并还原中文/空格（`c.req.path` 是编码后的） */
async function readBucketObject(env: AdminEnv, path: string) {
	let key = path.slice(1);
	try {
		key = decodeURIComponent(key);
	} catch {
		// 编码不合法就按原样查，查不到就是 404
	}
	if (!key) return null;
	return await env.BUCKET.get(key);
}

/** 附件（正文图片） */
attachmentRoutes.get('/usr/*', async (c) => {
	const object = await readBucketObject(c.env, c.req.path);
	if (!object) return c.notFound();

	c.header('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
	return c.body(object.body);
});

/** 主题资源：带指纹、内容永不变，可以 immutable 长缓存（§14.2） */
attachmentRoutes.get('/theme/*', async (c) => {
	const object = await readBucketObject(c.env, c.req.path);
	if (!object) return c.notFound();

	c.header('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
	c.header('Cache-Control', 'public, max-age=31536000, immutable');
	return c.body(object.body);
});
