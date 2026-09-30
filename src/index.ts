/**
 * Worker 入口 —— 设计文档 §2 / §7.1 / §12.3
 *
 * 这个 Worker **只服务后台**（`admin-blog.fengqi.me`）：前台由 R2 直出，一个请求都不进这里。
 * 所以这里出现的东西永远只有两类：后台页面/接口，以及 Cron。
 */

import { Hono } from 'hono';
import { runScheduledTasks } from './publish/sync';

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get('/message', (c) => {
	return c.text('Hello Hono!');
});

export default {
	fetch: app.fetch,

	/**
	 * Cron（§12.3）：每小时一次
	 *   ① 发布到点的定时文章
	 *   ② 扫 `needs_sync = 1` 的内容补发（D1 与 R2 的一致性兜底，§6.2）
	 */
	scheduled: (_event, env, ctx) => {
		ctx.waitUntil(
			runScheduledTasks(env)
				.then((report) => {
					console.log('[cron] 完成', JSON.stringify(report));
				})
				.catch((error: unknown) => {
					// 失败必须留下日志：Cron 里没有人看得到返回值
					console.error('[cron] 失败', error);
				}),
		);
	},
} satisfies ExportedHandler<CloudflareBindings>;
