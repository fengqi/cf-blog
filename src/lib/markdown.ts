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

const ENTITIES: Record<string, string> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#39;': "'",
	'&apos;': "'",
	'&nbsp;': ' ',
};

/** 剥标签 + 解常见实体 + 折空白，得到纯文本（摘要、meta description 用） */
export function extractText(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** 自动摘要：`excerpt` 为空时用它，写回 D1 —— 这样列表查询不必回捞 `rendered` */
export function makeExcerpt(html: string, limit = 200): string {
	const text = extractText(html);
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
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
