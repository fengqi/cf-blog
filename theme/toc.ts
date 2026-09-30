/**
 * 前台主题 · 文章目录（TOC）—— 设计文档 §11
 *
 * **在渲染时（服务端）抽取，不在客户端扫 DOM**：
 *   - 客户端扫 DOM 要等 JS 跑完才插入目录，首屏会先塌下去再撑开，CLS 很难看；
 *   - 服务端抽取出来的目录写在 HTML 里，**没有 JS 也能看、也能点**；
 *   - 目录和锚点在同一次渲染里产生，顺序天然一致，不会错位。
 *
 * 只收 h2 / h3：h1 是文章标题本身（`theme/post.ts` 输出的 `.post-title`），
 * h4 及更深的层级在中文技术文里通常是补注，进目录只会让目录比正文还长。
 *
 * 零依赖纪律同 `layout.ts` 顶部（不 import 任何包、不碰 D1/R2/Hono）。
 */

import { escapeHtml } from './html';

export interface TocItem {
	/** 锚点 id，已经保证全篇唯一 */
	id: string;
	/** 纯文本标题（已剥标签、解实体） */
	text: string;
	level: 2 | 3;
}

export interface TocResult {
	/** 注入了锚点 id 的正文 HTML */
	html: string;
	items: TocItem[];
}

/** 只匹配 h2/h3：闭合标签用反向引用保证开闭层级一致（`<h2>…</h3>` 不匹配） */
const HEADING_PATTERN = /<h([23])((?:\s[^>]*)?)>([\s\S]*?)<\/h\1>/gi;

const ENTITIES: Record<string, string> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#39;': "'",
	'&apos;': "'",
	'&nbsp;': ' ',
};

/** 剥标签 + 解常见实体 + 折空白 —— 目录里只放纯文本，不继承正文里的 `<code>`、`<em>` */
function plainText(html: string): string {
	return html
		.replace(/<[^>]+>/g, '')
		.replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * 标题文本 → 锚点 id。
 *
 * 中文标题**直接保留汉字**（`id="为什么动不动全站重渲"`）：HTML5 允许任意非空白字符做 id，
 * 浏览器对 `#为什么动不动全站重渲` 的跳转正常，复制出来的链接也比 `#section-3` 可读得多。
 * 只把「不能出现在 id 里」的字符（空白、标点）折成连字符。
 */
function slugify(text: string, index: number): string {
	const base = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}_-]+/gu, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '');
	// 标题全是标点（如「——」）时退化成一个可预测的顺序 id，别产出空 id
	return base || `section-${index}`;
}

/** 同一篇里标题可能重复（「小结」出现三次很常见），必须保证 id 唯一 */
function uniqueId(base: string, used: Set<string>): string {
	let id = base;
	let suffix = 2;
	while (used.has(id)) {
		id = `${base}-${suffix}`;
		suffix += 1;
	}
	used.add(id);
	return id;
}

/**
 * 抽取目录，并**就地把 id 写回正文**。
 *
 * 返回的是新字符串（`post.html` 是只读输入）—— 所以同一篇文章渲染成
 * 「规范 URL」与「旧 URL」两个对象时，两份的 id 完全一致，不会互相打断锚点。
 */
export function extractToc(html: string): TocResult {
	const items: TocItem[] = [];
	const used = new Set<string>();
	let index = 0;

	const withAnchors = html.replace(HEADING_PATTERN, (_match, levelRaw: string, attrs: string, inner: string) => {
		const level = Number(levelRaw) as 2 | 3;
		index += 1;
		const text = plainText(inner);
		const id = uniqueId(slugify(text, index), used);
		items.push({ id, text: text || id, level });
		return `<h${level}${attrs} id="${escapeHtml(id)}">${inner}</h${level}>`;
	});

	return { html: withAnchors, items };
}
