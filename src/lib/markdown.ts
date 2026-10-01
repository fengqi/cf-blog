/**
 * Markdown 渲染 + 摘要/字数派生 —— 设计文档 §6.1 / §6.5 / §8.3
 *
 * 只在**写入时**跑（发布流水线里），请求路径上永远不跑 —— 这是铁律 2。
 *
 * ⚠️ **渲染器要锁版本（§6.5）**：markdown-it 升级可能改变输出，
 * 所有文章共用这一份配置。升级前先准备一次「全站重新渲染」。
 */

import MarkdownIt from 'markdown-it';
import { sanitizeHtml } from './sanitize';

/**
 * `html: true` 是**故意的**：存量 Typecho 文章里有原生 HTML（图片、div 等），
 * 关掉会把它们全部转义成文本。安全由下游的白名单清洗负责（§8.3）。
 */
const md = new MarkdownIt({
	html: true,
	linkify: true,
	breaks: false,
	typographer: false,
});

/** Markdown → 清洗后的 HTML。**这是唯一对外入口**，别在别处直接 new MarkdownIt。 */
export function renderMarkdown(body: string): string {
	return sanitizeHtml(md.render(body));
}

/** 已经渲染好的 HTML 再洗一遍（全站重建、历史数据导入用） */
export function sanitizeRendered(html: string): string {
	return sanitizeHtml(html);
}

/**
 * Typecho 惯例的摘要分界标记（`<!--more-->`，兼容大小写与空格）。
 *
 * 与迁移导入（scripts/import-typecho.ts）同一套语义：标记前的部分作摘要。
 * 标记本身**保留在 D1 的 body 里**（作者手写的内容不动），只在渲染时处理。
 */
const MORE_MARKER = /<!--\s*more\s*-->/i;

/**
 * rendered 里的摘要分界哨兵。写入时由 `renderBodyWithMore` / 导入脚本插在两半之间 ——
 * 分界信息只存在于 rendered 里；`excerpt` 列只存作者手写的摘要，没写就留空。
 */
export const MORE_SENTINEL = '<!--more-->';

/**
 * 拆摘要分界：`beforeMore` = 标记前的部分（作摘要来源），`body` = **标记后**的其余正文。
 * 都已去掉首尾空白；没写标记（或标记前没内容）时 `beforeMore` 为 null、`body` 原样返回。
 */
export function splitMoreMarker(body: string): { body: string; beforeMore: string | null } {
	const match = MORE_MARKER.exec(body);
	if (!match) return { body, beforeMore: null };
	const before = body.slice(0, match.index).trim();
	const rest = body.slice(match.index + match[0].length).trim();
	return { body: rest, beforeMore: before || null };
}

/**
 * 渲染正文并带上 `<!--more-->` 分界：标记前与其余正文**各自渲染**再拼接，
 * 保证哨兵两侧的 HTML 都是平衡的（列表摘要直接截哨兵前半段就能用）。
 * `beforeMore` 为空（没写标记，或标记前没内容）时视为无分界，全文进 rendered。
 */
export function renderBodyWithMore(beforeMore: string | null, restBody: string): string {
	if (!beforeMore) return renderMarkdown(restBody);
	return `${renderMarkdown(beforeMore)}${MORE_SENTINEL}${renderMarkdown(restBody)}`;
}

const ENTITIES: Record<string, string> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#39;': "'",
	'&apos;': "'",
	'&nbsp;': ' ',
};

/** 剥标签 + 解常见实体 + 折空白，得到纯文本（Feed 的 description 用） */
export function extractText(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Feed 的 description：摘要 HTML 剥成纯文本并截断（摘要本身不再落库） */
export function makeExcerpt(html: string, limit = 200): string {
	const text = extractText(html);
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * 列表摘要视图（发布渲染时现算，`excerpt` 列不存派生摘要）：
 *  1. 作者写了摘要（Markdown 原文）→ 渲染成 HTML，显示「阅读剩余部分」；
 *  2. 没写但 rendered 里有 `<!--more-->` 哨兵 → 取哨兵前的半段（已是渲染好的 HTML）；
 *  3. 都没有 → 全文当摘要，**不显示**「阅读剩余部分」。
 */
export function summaryView(
	post: { excerpt: string; html: string },
): { excerptHtml: string; hasMore: boolean } {
	const manual = post.excerpt.trim();
	if (manual) return { excerptHtml: renderMarkdown(manual), hasMore: true };
	const index = post.html.indexOf(MORE_SENTINEL);
	if (index > 0) return { excerptHtml: post.html.slice(0, index), hasMore: true };
	return { excerptHtml: post.html, hasMore: false };
}

/**
 * 字数统计（中文按字、英文按词）。
 * 写入时算好存进 `contents.words`，列表页直接展示（§4.2 ③）。
 */
export function countWords(text: string): number {
	const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g)?.length ?? 0;
	const latin = text.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g)?.length ?? 0;
	return cjk + latin;
}
