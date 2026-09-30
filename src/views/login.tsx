/**
 * 登录页 —— 设计文档 §8.4（Turnstile）
 *
 * Turnstile 的 site key 存在 `options.turnstile_site_key`；没配就不渲染控件，
 * 服务端也会跳过校验（本地开发/首次部署时的降级路径，见 routes/auth.ts）。
 */

import { PlainLayout } from './layout';

export interface LoginPageProps {
	siteTitle: string;
	turnstileSiteKey?: string;
	error?: string;
	message?: string;
	/** 口令还没 bootstrap 时给个明确提示，省得对着「密码错误」猜（§8.2） */
	needsBootstrap?: boolean;
}

export function LoginPage(props: LoginPageProps) {
	return (
		<PlainLayout title="登录 · 博客后台">
			<div class="login">
				<h1>博客后台</h1>
				<p class="hint">{props.siteTitle}</p>
				{props.message ? <p class="message">{props.message}</p> : null}
				{props.error ? <p class="message error">{props.error}</p> : null}
				{props.needsBootstrap ? (
					<p class="hint">
						还没有设置管理员口令：先跑 <code>npx tsx scripts/hash-password.ts '你的口令'</code>，
						再按输出里的命令更新 D1（见 docs/design.md §8.2）。
					</p>
				) : null}
				<form method="post" action="/admin/login" class="stack">
					<div>
						<label for="username">用户名</label>
						<input type="text" id="username" name="username" autocomplete="username" required />
					</div>
					<div>
						<label for="password">口令</label>
						<input
							type="password"
							id="password"
							name="password"
							autocomplete="current-password"
							required
						/>
					</div>
					{props.turnstileSiteKey ? (
						<div
							class="cf-turnstile"
							data-sitekey={props.turnstileSiteKey}
							data-theme="auto"
						/>
					) : null}
					<div class="actions">
						<button type="submit">登录</button>
					</div>
				</form>
				{props.turnstileSiteKey ? (
					<script
						src="https://challenges.cloudflare.com/turnstile/v0/api.js"
						async
						defer
					/>
				) : null}
			</div>
		</PlainLayout>
	);
}
