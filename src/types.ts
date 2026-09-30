/**
 * Worker 绑定与运行时密钥类型 —— 设计文档 §7.1 / §8
 *
 * `CloudflareBindings` 由 `npm run cf-typegen` 从 wrangler.jsonc 生成（D1 / R2 / KV）。
 * **secret 不在配置文件里**，所以生成不出来，在这里补上类型：
 *   wrangler secret put SESSION_SECRET / IP_SALT / TURNSTILE_SECRET
 */

export interface AdminEnv extends CloudflareBindings {
	/** 会话签名密钥，必须配置；缺了登录直接失败（fail closed） */
	SESSION_SECRET: string;
	/** 登录失败限流用的 IP 哈希盐 */
	IP_SALT: string;
	/** Turnstile 校验密钥；本地开发不配时跳过校验（见 routes/auth.ts） */
	TURNSTILE_SECRET?: string;
}
