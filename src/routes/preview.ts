/**
 * 草稿预览 —— 设计文档 §2（`/preview/:cid`）
 *
 * 未发布的文章在 R2 里并不存在，所以只能在这里渲染。**渲染结果是直接当响应体返回的**
 * —— 这正是 §14.1 说的「`theme/` 既能写 R2、也能当 HTTP 响应体」，所以回退到纯 Worker
 * 动态渲染时只需要换一个调用点。
 *
 * 必须登录：草稿不该被外面看到（这也是它不走 R2 的原因）。
 */

import { Hono } from 'hono';
import { renderPreview } from '../publish/pipeline';
import type { AdminVariables } from '../middleware/auth';
import type { AdminEnv } from '../types';

export const previewRoutes = new Hono<{ Bindings: AdminEnv; Variables: AdminVariables }>();

previewRoutes.get('/preview/:cid', async (c) => {
	const cid = Number(c.req.param('cid'));
	if (!Number.isFinite(cid)) return c.notFound();

	try {
		const { html } = await renderPreview(c.env, cid);
		c.header('Cache-Control', 'private, no-store');
		// 草稿页别被搜索引擎收进去
		c.header('X-Robots-Tag', 'noindex, nofollow');
		return c.html(html);
	} catch (error) {
		return c.text(`预览失败：${String(error)}`, 404);
	}
});
