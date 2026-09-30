/**
 * options 表读取 —— 设计文档 §4.1 / §7.3 / §11
 *
 * 纪律（§11 硬约束 1）：SQL 只允许出现在 `src/models/` 和 `src/lib/db.ts` 里。
 * 本文件是**前台绝对 URL 的唯一来源**：canonical / feed / sitemap 都从这里取域名，
 * 模板层一个硬编码域名都不许有 —— 换域名只改 `options.site_url`，再全站重渲（§6.5）。
 */

import type { SiteInfo } from '../../theme/layout';
import { createDb } from '../lib/db';
import type { Db } from '../lib/db';

/** 只依赖 DB 绑定，方便测试与复用（`c.env` 结构上满足这个形状） */
export interface OptionsEnv {
	DB: D1Database;
}

/** 站点全局配置（`options.user = 0`），已归一化 */
export interface SiteOptions {
	title: string;
	description: string;
	/** 前台规范域名，无末尾斜杠，如 `https://blog.fengqi.me` */
	siteUrl: string;
	keywords: string;
	/** 分页大小（§5.3 的 page/<n>/ 由它算出） */
	postsPerPage: number;
	/** 展示用时区偏移小时数（+8 即东八区） */
	timezoneOffset: number;
	/** theme_options 解析后的对象；解析失败为空对象 */
	themeOptions: Record<string, unknown>;
}

export const OPTION_DEFAULTS = {
	title: '我的博客',
	description: '',
	keywords: '',
	postsPerPage: 10,
	timezoneOffset: 8,
} as const;

/**
 * 内存缓存 TTL（§7.3 的第一层）。
 * isolate 内命中零成本；跨 isolate 最多旧 60 秒，保存设置时用 clearSiteOptionsCache() 主动清。
 * §7.3 的第二层（Cache API 兜底）还没做 —— 后台请求量按每天几十次计，不急。
 */
const CACHE_TTL_MS = 60_000;

let cache: { value: SiteOptions; expiresAt: number } | null = null;

/** 保存设置后必须调用，否则 isolate 内的旧配置会继续活到 TTL 到期（§7.3） */
export function clearSiteOptionsCache(): void {
	cache = null;
}

function parseTimezoneOffset(raw: string | undefined): number {
	if (!raw) return OPTION_DEFAULTS.timezoneOffset;
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value)) return OPTION_DEFAULTS.timezoneOffset;
	// Typecho 的 `timezone` 存的是**秒**（东八区 = 28800）；万一配置成小时也认。
	// 判断依据：绝对值超过 24 一定是秒 —— 没有哪个时区偏移是 25 小时。
	return Math.abs(value) > 24 ? value / 3600 : value;
}

function parsePostsPerPage(raw: string | undefined): number {
	const value = Number.parseInt(raw ?? '', 10);
	return Number.isFinite(value) && value > 0 ? value : OPTION_DEFAULTS.postsPerPage;
}

function parseThemeOptions(raw: string | undefined): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		// 只接受纯对象：数组 / null / 标量都当没配
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** 读全局配置（带 isolate 内存缓存） */
export async function getSiteOptions(env: OptionsEnv): Promise<SiteOptions> {
	return await getSiteOptionsVia(createDb(env.DB, 'options'));
}

/**
 * 同上，但走调用方给的 `Db`（这样发布流水线能把这次查询算进总量，见 §5.2 的查询预算）。
 */
export async function getSiteOptionsVia(db: Db): Promise<SiteOptions> {
	if (cache && cache.expiresAt > Date.now()) return cache.value;

	const rows = await db.all<{ name: string; value: string | null }>(
		'SELECT name, value FROM options WHERE user = 0',
	);
	const values = new Map(rows.map((row) => [row.name, row.value ?? undefined]));

	// site_url 必须显式配置：它错了，整站的 canonical / feed / sitemap 全错，宁可报错也别静默降级
	const siteUrl = (values.get('site_url') ?? '').trim().replace(/\/+$/, '');
	if (!siteUrl) {
		throw new Error('options.site_url 未配置：前台绝对 URL 全靠它（见 docs/design.md §4.1）');
	}

	const value: SiteOptions = {
		title: values.get('site_title') || OPTION_DEFAULTS.title,
		description: values.get('site_description') ?? OPTION_DEFAULTS.description,
		siteUrl,
		keywords: values.get('site_keywords') ?? OPTION_DEFAULTS.keywords,
		postsPerPage: parsePostsPerPage(values.get('posts_per_page')),
		timezoneOffset: parseTimezoneOffset(values.get('timezone')),
		themeOptions: parseThemeOptions(values.get('theme_options')),
	};

	cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
	return value;
}

/**
 * 转成 `theme/` 要的 `SiteInfo`。
 * 主题层只收这个对象，自己不碰数据库（§11 的两套渲染机制不能互相串用）。
 */
export async function getSiteInfo(env: OptionsEnv): Promise<SiteInfo> {
	const options = await getSiteOptions(env);
	return {
		title: options.title,
		url: options.siteUrl,
		description: options.description,
		keywords: options.keywords,
		timezoneOffset: options.timezoneOffset,
	};
}
