/**
 * 前台主题 · 文章目录（TOC）—— 设计文档 §11
 *
 * **在渲染时（服务端）抽取，不在客户端扫 DOM**：
 *   - 客户端扫 DOM 要等 JS 跑完才插入目录，首屏会先塌下去再撑开，CLS 很难看；
 *   - 服务端抽取出来的目录写在 HTML 里，**没有 JS 也能看、也能点**；
 *   - 目录和锚点在同一次渲染里产生，顺序天然一致，不会错位。
 *
 * 正文里抽 h1 / h2 / h3，**按「出现的最浅层级」归一化**（最浅 → 二级、其余 → 三级）：
 *   - 页面标题是 `theme/post.ts` 单独输出的 `.post-title`，不在 `post.html` 里，
 *     所以正文里的 h1 不是「文章标题本身」—— 存量 Typecho 文章的章节就是用 `#` 写的，
 *     只收 h2/h3 会让这批文章（如 `/php/394.html`）整篇出不来目录；
 *   - 归一化后目录最多两级（`toc-level-2` / `toc-level-3`），正文标题层级写得不规范
 *     （`#` 开头或 `###` 开头）也能得到一个层级正确的目录；
 *   - h4 及更深的层级在中文技术文里通常是补注，进目录只会让目录比正文还长。
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

/** 匹配 h1/h2/h3：闭合标签用反向引用保证开闭层级一致（`<h2>…</h3>` 不匹配） */
const HEADING_PATTERN = /<h([123])((?:\s[^>]*)?)>([\s\S]*?)<\/h\1>/gi;

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
 *
 * 层级归一化要**两步**：先按原始层级收集（id 的生成与层级无关，可以同步写回），
 * 收集完才知道全篇最浅层级是几，再把目录条目平移成最多两级。
 */
export function extractToc(html: string): TocResult {
	const raw: Array<{ item: TocItem; level: number }> = [];
	const used = new Set<string>();
	let index = 0;

	const withAnchors = html.replace(HEADING_PATTERN, (_match, levelRaw: string, attrs: string, inner: string) => {
		const level = Number(levelRaw);
		index += 1;
		const text = plainText(inner);
		const id = uniqueId(slugify(text, index), used);
		raw.push({ item: { id, text: text || id, level: 2 }, level });
		return `<h${level}${attrs} id="${escapeHtml(id)}">${inner}</h${level}>`;
	});

	// 最浅层级 → 2，更深逐级 +1，封顶 3（h1/h2/h3 最多差两级，平移后不会超过 3）
	if (raw.length > 0) {
		const shallowest = Math.min(...raw.map((entry) => entry.level));
		for (const entry of raw) {
			entry.item.level = Math.min(entry.level - shallowest + 2, 3) as 2 | 3;
		}
	}

	return { html: withAnchors, items: raw.map((entry) => entry.item) };
}
