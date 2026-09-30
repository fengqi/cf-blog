/**
 * 登录 / 登出 —— 设计文档 §8.1 / §8.2 / §8.4
 *
 * 登录是**全站唯一的外部写入入口**（评论移除后），所以这里的防护比通常更紧：
 *   1. Turnstile（免费，配了密钥就校验）
 *   2. 同 IP 15 分钟内失败 10 次锁定（KV 计数，IP 存哈希不存明文）
 *   3. 口令用 PBKDF2 校验；schema 里的占位哈希视为「不可用」，直接拒绝
 *
 * 会话是签名的无状态 Cookie（§8.1），没有会话表要查。
 */

import { Hono } from 'hono';
import {
	buildLogoutCookie,
	buildSessionCookie,
	hashIp,
	isUsablePasswordHash,
	LOGIN_FAIL_LIMIT,
	LOGIN_FAIL_WINDOW_SECONDS,
	readSessionCookie,
	sessionExpiry,
	signSession,
	verifyPassword,
	verifySession,
} from '../lib/auth';
import { createDb } from '../lib/db';
import { getOptionValue } from '../models/option';
import { getSiteOptions } from '../models/option';
import { countUsableAdmins, getUserByUsername, touchLogin } from '../models/user';
import { LoginPage } from '../views/login';
import type { AdminEnv } from '../types';

export const authRoutes = new Hono<{ Bindings: AdminEnv }>();

/**
 * 只有**密钥与 site key 都配了**才强制人机校验。
 *
 * 否则会出现最糟的情况：服务端要 token，而登录页因为没配 site key 不渲染控件
 * —— 表单永远拿不到 token，等于把自己锁在门外（而口令和限流本来就在）。
 */
function turnstileEnabled(secret: string | undefined, siteKey: string | undefined): boolean {
	if (!secret) return false;
	if (!siteKey) {
		console.warn('[auth] 配了 TURNSTILE_SECRET 但缺少 options.turnstile_site_key，已跳过人机校验');
		return false;
	}
	return true;
}

/** Turnstile 服务端校验（§8.4） */
async function verifyTurnstile(secret: string, token: string, ip: string): Promise<boolean> {
	if (!token) return false;
	const body = new URLSearchParams({ secret, response: token, remoteip: ip });
	const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
		method: 'POST',
		body,
	});
	if (!response.ok) return false;
	const result = (await response.json()) as { success?: boolean };
	return result.success === true;
}

authRoutes.get('/admin/login', async (c) => {
	c.header('Cache-Control', 'private, no-store');

	// 已登录就别再看登录页
	const token = readSessionCookie(c.req.header('cookie') ?? null);
	if (token && c.env.SESSION_SECRET) {
		const payload = await verifySession(token, c.env.SESSION_SECRET);
		if (payload) return c.redirect('/admin', 302);
	}

	const db = createDb(c.env.DB, 'login');
	const options = await getSiteOptions(c.env);
	const [siteKey, usableAdmins] = await Promise.all([
		getOptionValue(db, 'turnstile_site_key'),
		countUsableAdmins(db),
	]);
	return c.html(
		<LoginPage
			siteTitle={options.title}
			// 只要配了 site key 就渲染控件；**强制校验**另看 helper（两者都要有）
			turnstileSiteKey={siteKey}
			needsBootstrap={usableAdmins === 0}
			error={c.req.query('error')}
		/>,
	);
});

authRoutes.post('/admin/login', async (c) => {
	c.header('Cache-Control', 'private, no-store');

	if (!c.env.SESSION_SECRET) {
		return c.text('SESSION_SECRET 未配置：wrangler secret put SESSION_SECRET', 500);
	}

	const form = await c.req.formData();
	const username = String(form.get('username') ?? '').trim();
	const password = String(form.get('password') ?? '');
	const turnstileToken = String(form.get('cf-turnstile-response') ?? '');
	const ip = c.req.header('CF-Connecting-IP') ?? '0.0.0.0';

	const db = createDb(c.env.DB, 'login');
	const options = await getSiteOptions(c.env);
	const siteKey = await getOptionValue(db, 'turnstile_site_key');

	const reject = async (message: string, status = 400) => {
		const usableAdmins = await countUsableAdmins(db);
		return c.html(
			<LoginPage
				siteTitle={options.title}
				turnstileSiteKey={siteKey}
				needsBootstrap={usableAdmins === 0}
				error={message}
			/>,
			status as 400,
		);
	};

	// ① 频率限制（§8.4）
	const ipHash = await hashIp(ip, c.env.IP_SALT ?? 'missing-ip-salt');
	const failKey = `login_fail:${ipHash}`;
	const failures = Number.parseInt((await c.env.LOGIN_KV.get(failKey)) ?? '0', 10);
	if (Number.isFinite(failures) && failures >= LOGIN_FAIL_LIMIT) {
		return reject(`失败次数过多，请 ${LOGIN_FAIL_WINDOW_SECONDS / 60} 分钟后再试`, 429);
	}

	const recordFailure = async () => {
		await c.env.LOGIN_KV.put(failKey, String(failures + 1), {
			expirationTtl: LOGIN_FAIL_WINDOW_SECONDS,
		});
	};

	// ② Turnstile：密钥与 site key 都配了才校验（判断逻辑与登录页共用）
	const turnstileSecret = c.env.TURNSTILE_SECRET;
	if (turnstileSecret && turnstileEnabled(turnstileSecret, siteKey)) {
		const passed = await verifyTurnstile(turnstileSecret, turnstileToken, ip);
		if (!passed) {
			await recordFailure();
			return reject('人机校验未通过，请重试');
		}
	}

	// ③ 口令
	const user = await getUserByUsername(db, username);
	const canCheck = Boolean(user && user.activated === 1 && isUsablePasswordHash(user.password));
	const passwordOk = canCheck ? await verifyPassword(password, user!.password) : false;
	if (!user || !passwordOk) {
		await recordFailure();
		// 不区分「用户不存在」和「口令错误」
		return reject('用户名或口令不正确', 401);
	}

	await c.env.LOGIN_KV.delete(failKey);
	const now = Math.floor(Date.now() / 1000);
	await touchLogin(db, user.uid, now);

	const token = await signSession(
		{ uid: user.uid, tv: user.token_version, exp: sessionExpiry(now) },
		c.env.SESSION_SECRET,
	);
	c.header('Set-Cookie', buildSessionCookie(token));
	// 303：让浏览器把 POST 换成 GET，避免刷新重复提交
	return c.redirect('/admin', 303);
});

authRoutes.post('/admin/logout', (c) => {
	c.header('Cache-Control', 'private, no-store');
	c.header('Set-Cookie', buildLogoutCookie());
	return c.redirect('/admin/login', 303);
});
