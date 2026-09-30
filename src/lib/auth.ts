/**
 * 认证：签名 Cookie 会话 + PBKDF2 口令 —— 设计文档 §8.1 / §8.2 / §8.4
 *
 * 会话是**无状态**的：
 *   payload = base64url({ uid, tv, exp })
 *   token   = payload + "." + HMAC-SHA256(payload, SESSION_SECRET)
 * 校验时只比对 `tv === users.token_version`（这一步本来就要查用户行）。
 * 撤销 = `token_version += 1`（改密码、登出全部设备），旧 token 立刻失效，不需要会话表。
 *
 * Workers 没有原生 bcrypt/argon2，用 WebCrypto 的 PBKDF2-SHA256。
 */

const SESSION_COOKIE = 'blog_session';
/** 会话有效期 14 天（§8.1） */
const SESSION_TTL_SECONDS = 14 * 24 * 3600;

/**
 * PBKDF2 迭代次数。
 *
 * §8.2 要求：从 10 万起步，在 `wrangler dev` 里看实际 CPU，超 10ms 就降到 5 万、再不行 2.5 万。
 * 实测见 §13.1（本仓库的 e2e 会打印一次哈希耗时）。
 */
export const PBKDF2_ITERATIONS = 100_000;

export interface SessionPayload {
	/** users.uid */
	uid: number;
	/** users.token_version */
	tv: number;
	/** 过期时间（Unix 秒） */
	exp: number;
}

// ---------------------------------------------------------------------------
// base64url / JSON
// ---------------------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function encodeJson(value: unknown): string {
	return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson<T>(value: string): T | null {
	try {
		return JSON.parse(new TextDecoder().decode(fromBase64Url(value))) as T;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

async function importHmacKey(secret: string): Promise<CryptoKey> {
	return await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
	const body = encodeJson(payload);
	const signature = await crypto.subtle.sign('HMAC', await importHmacKey(secret), new TextEncoder().encode(body));
	return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/** 验签 + 校验过期；任何一步不对都返回 null（不区分原因，别给攻击者线索） */
export async function verifySession(token: string, secret: string): Promise<SessionPayload | null> {
	const [body, signature] = token.split('.');
	if (!body || !signature) return null;

	const valid = await crypto.subtle.verify(
		'HMAC',
		await importHmacKey(secret),
		fromBase64Url(signature),
		new TextEncoder().encode(body),
	);
	if (!valid) return null;

	const payload = decodeJson<SessionPayload>(body);
	if (!payload || typeof payload.uid !== 'number' || typeof payload.exp !== 'number') return null;
	if (payload.exp * 1000 < Date.now()) return null;
	return payload;
}

export function sessionExpiry(now = Math.floor(Date.now() / 1000)): number {
	return now + SESSION_TTL_SECONDS;
}

/** 从 Cookie 头里取出会话 token */
export function readSessionCookie(cookieHeader: string | null): string | null {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(';')) {
		const [name, ...rest] = part.trim().split('=');
		if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
	}
	return null;
}

/** §8.1：HttpOnly + Secure + SameSite=Lax */
export function buildSessionCookie(token: string): string {
	return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function buildLogoutCookie(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// 口令（PBKDF2-SHA256）
// ---------------------------------------------------------------------------

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
		'deriveBits',
	]);
	const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
	return new Uint8Array(bits);
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** 生成 `pbkdf2$<iterations>$<salt_b64>$<hash_b64>`（§8.2 的存储格式） */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await derive(password, salt, iterations);
	return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** 定长比较，避免用字符串比较泄漏时序 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index++) diff |= a[index] ^ b[index];
	return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split('$');
	if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

	const iterations = Number.parseInt(parts[1], 10);
	if (!Number.isFinite(iterations) || iterations <= 0) return false;

	try {
		const hash = await derive(password, fromBase64(parts[2]), iterations);
		return timingSafeEqual(hash, fromBase64(parts[3]));
	} catch {
		return false;
	}
}

/** schema 里的占位哈希是故意不可用的；用它来判断「还没 bootstrap」 */
export function isUsablePasswordHash(stored: string | null | undefined): boolean {
	if (!stored) return false;
	if (stored.includes('PLACEHOLDER')) return false;
	return /^pbkdf2\$\d+\$[^$]+\$[^$]+$/.test(stored);
}

// ---------------------------------------------------------------------------
// 登录失败限流（§8.4）
// ---------------------------------------------------------------------------

/** IP 存哈希不存明文：`SHA-256(ip + IP_SALT)` */
export async function hashIp(ip: string, salt: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}${salt}`));
	return toBase64Url(new Uint8Array(digest)).slice(0, 32);
}

export const LOGIN_FAIL_LIMIT = 10;
export const LOGIN_FAIL_WINDOW_SECONDS = 15 * 60;
