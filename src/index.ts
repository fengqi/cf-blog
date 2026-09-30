/**
 * Worker 入口 —— 设计文档 §2 / §7.1 / §12.3
 *
 * 这个 Worker **只服务后台**（`admin-blog.fengqi.me`）：前台由 R2 直出，一个请求都不进这里。
 * 所以这里出现的东西永远只有两类：后台页面/接口，以及 Cron。
 *
 * 路由注册顺序有讲究：`/admin/login`、`/admin/logout` 是公开的，**必须注册在鉴权中间件之前**；
 * 之后注册的 `/admin/*` 才会被 `requireAuth` 拦住。本地 e2e 里有断言盯着这条边界。
 */

import { Hono } from 'hono';
import { requireAuth } from './middleware/auth';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { previewRoutes } from './routes/preview';
import { runScheduledTasks } from './publish/sync';
import type { AdminEnv } from './types';

export const app = new Hono<{ Bindings: AdminEnv }>();

// 健康检查（部署后确认 Worker 活着）
app.get('/message', (c) => c.text('Hello Hono!'));

// ① 公开路由：登录 / 登出
app.route('/', authRoutes);

// ② 鉴权：下面注册的 /admin/* 与 /preview/* 都要登录
app.use('/admin/*', requireAuth);
app.use('/preview/*', requireAuth);

// ③ 受保护的后台与预览
app.route('/', adminRoutes);
app.route('/', previewRoutes);

app.get('/', (c) => c.redirect('/admin', 302));

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
} satisfies ExportedHandler<AdminEnv>;
