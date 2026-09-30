/**
 * 后台鉴权中间件 —— 设计文档 §8.1 / §7.4
 *
 * 每个受保护请求做三件事：
 *   1. 取签名 Cookie 并验签（无状态，不查会话表）
 *   2. 查用户行，比对 `tv === users.token_version`（改密码后旧会话立刻失效）
 *   3. 给响应打上 `private, no-store`（§7.4：后台一律不缓存）
 */

import { createMiddleware } from 'hono/factory';
import { createDb } from '../lib/db';
import { readSessionCookie, verifySession } from '../lib/auth';
import { getUserById } from '../models/user';
import type { UserRecord } from '../models/user';
import type { AdminEnv } from '../types';

export type AdminVariables = { user: UserRecord };

export const requireAuth = createMiddleware<{ Bindings: AdminEnv; Variables: AdminVariables }>(
	async (c, next) => {
		// §7.4：后台响应一律 private, no-store（且都带 Set-Cookie）
		c.header('Cache-Control', 'private, no-store');

		const secret = c.env.SESSION_SECRET;
		if (!secret) {
			// fail closed：没配密钥就别让人进
			return c.text('SESSION_SECRET 未配置：wrangler secret put SESSION_SECRET', 500);
		}

		const token = readSessionCookie(c.req.header('cookie') ?? null);
		if (!token) return c.redirect('/admin/login', 302);

		const payload = await verifySession(token, secret);
		if (!payload) return c.redirect('/admin/login', 302);

		const user = await getUserById(createDb(c.env.DB, 'auth'), payload.uid);
		if (!user || user.token_version !== payload.tv) return c.redirect('/admin/login', 302);

		c.set('user', user);
		await next();
	},
);
