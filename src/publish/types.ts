/**
 * 发布层的数据契约 —— 设计文档 §5.2 / §5.3 / §11
 *
 * 这层**只有数据，没有 SQL、没有 HTML**：SQL 在 `src/models/`，HTML 在 `theme/`，
 * 发布流水线负责把两者接起来。好处是 `targets.ts` / `render.ts` 都能脱离数据库单测。
 */

import type { SiteInfo } from '../../theme/layout';
import type { OverviewSection } from '../lib/url';

/** 分类或标签 */
export interface TermRecord {
	mid: number;
	name: string;
	slug: string;
	type: 'category' | 'tag';
	description?: string;
	/** 该分类/标签下的可见文章数（用于算分页） */
	count: number;
}

/** 一篇内容（文章或独立页面） */
export interface PostRecord {
	cid: number;
	/** post = 文章（URL 两段），page = 独立页面（URL 单段） */
	type: 'post' | 'page';
	/**
	 * publish | hidden | draft | private | waiting
	 * `hidden` 的语义（沿用 Typecho）：**有 URL、打得开，但不进列表/归档/Feed/sitemap**。
	 */
	status: string;
	title: string;
	/** URL 片段，可能含中文 */
	slug: string;
	created: number;
	modified: number;
	/** 已清洗的正文 HTML（§8.3） */
	html: string;
	/**
	 * 摘要 **Markdown 原文**，**只存作者在编辑器里手写的那份**（没写就留空，不自动生成落库）。
	 * 列表页渲染时由 `summaryView` 现算：手写摘要 > `<!--more-->` 分界前半段 > 全文。
	 */
	excerpt: string;
	words?: number;
	author?: { name: string; url?: string };
	/** 分类（URL 用第一个，见 targets.ts 的 primaryCategory） */
	categories: TermRecord[];
	tags: TermRecord[];
}

/** 独立页面（单段 URL） */
export type PageRecord = PostRecord;

/** 年月归档 */
export interface MonthRecord {
	year: number;
	month: number;
	/** 该月可见文章数 */
	count: number;
}

/** 全部渲染素材 —— 一次发布/全站重建的输入 */
export interface SiteSnapshot {
	site: SiteInfo;
	postsPerPage: number;
	/** 可见文章，**必须已按 created 倒序**（列表与分页都是偏移切片） */
	posts: PostRecord[];
	/** 独立页面，按 sort_order */
	pages: PageRecord[];
	/**
	 * `status='hidden'` 的文章与独立页面：只参与「生成页面」，不参与列表/归档/Feed/sitemap。
	 * 单独放一个数组，是为了让「可访问但不进列表」这件事在数据层就显式可见。
	 */
	hidden: PostRecord[];
	categories: TermRecord[];
	tags: TermRecord[];
	/** 有文章的年月，倒序 */
	months: MonthRecord[];
	/**
	 * `permalink_history`：改过 slug/分类的文章，旧 key 处要留一个
	 * 「200 + canonical 指向新 URL」的页面（§5.1 方案 A）。
	 */
	retired: { key: string; canonicalPath: string; cid: number }[];
}

/** 一个待生成的对象：key + 渲染所需的全部参数 */
export type Target =
	| { key: string; kind: 'post'; post: PostRecord; /** 旧 URL 页用：canonical 指向新地址 */ canonicalPath?: string }
	| { key: string; kind: 'page'; post: PostRecord; canonicalPath?: string }
	| { key: string; kind: 'index'; /** 0 = 首页（空 key），n≥1 = page/<n>/ 副本 */ page: number }
	| {
			key: string;
			kind: 'archive';
			term: TermRecord;
			page: number;
	  }
	| { key: string; kind: 'month'; year: number; month: number }
	/**
	 * 全站索引页：`/categories/`、`/tags/`、`/archives/`（顶栏导航的落点）。
	 *
	 * 三个对象都带各术语/各月份的文章数，所以**发一篇文章就会让它们变** ——
	 * 它们进 `siteTargets`，也进 `postPublishTargets`（3 个对象的代价，
	 * 换来计数不会长期陈旧）。
	 */
	| { key: string; kind: 'overview'; section: OverviewSection }
	| { key: string; kind: 'feed' }
	| { key: string; kind: 'sitemap' }
	/**
	 * 主题资源（CSS / JS）。`name` 是 `theme/assets/` 下的源文件名，
	 * 内容和 contentType 从 `theme/assets.generated.ts` 查（`name` 必须能在清单里找到）。
	 *
	 * 它进 `siteTargets`（全站重建时刷新），**不进 `postPublishTargets`** ——
	 * 发一篇文章不需要重写这几个对象（§7.2 的 `immutable` 正是为此）。
	 */
	| { key: string; kind: 'asset'; name: string };
