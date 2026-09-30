/**
 * HTML 白名单清洗 —— 设计文档 §8.3
 *
 * 为什么不能省：Markdown 里嵌入的原生 HTML 会原样进 `rendered`，不洗就是给自己留后门。
 * 而且存量 Typecho 文章里本来就有原生 HTML，所以**不能靠「关掉 markdown 的 html 透传」来解决**
 * —— 那会把历史文章里的 `<img>`、`<div>` 全部转义成文本。
 *
 * 用的是 js-xss（零运行时依赖，白名单模型，纯 JS，无 Node 内置模块 —— Worker 里可直接跑）。
 * 策略：**白名单之外一律「去标签留内容」**，script / style / iframe 这类连内容一起去掉。
 */

import { FilterXSS } from 'xss';
import type { IWhiteList } from 'xss';

/** 正文里允许出现的标签与属性。刻意很小 —— 要加标签先想清楚为什么。 */
const whiteList: IWhiteList = {
	a: ['href', 'title', 'target'],
	img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
	p: [],
	br: [],
	hr: [],
	strong: [],
	b: [],
	em: [],
	i: [],
	u: [],
	s: [],
	del: [],
	ins: [],
	mark: [],
	sub: [],
	sup: [],
	h1: [],
	h2: [],
	h3: [],
	h4: [],
	h5: [],
	h6: [],
	ul: [],
	ol: ['start'],
	li: [],
	dl: [],
	dt: [],
	dd: [],
	blockquote: [],
	pre: [],
	code: ['class'],
	table: [],
	thead: [],
	tbody: [],
	tfoot: [],
	tr: [],
	th: ['colspan', 'rowspan', 'align'],
	td: ['colspan', 'rowspan', 'align'],
	figure: [],
	figcaption: [],
	div: ['class'],
	span: ['class'],
	details: ['open'],
	summary: [],
};

const filter = new FilterXSS({
	whiteList,
	// 不在白名单的标签：去掉标签、保留内容（如 <font>、<center>）
	stripIgnoreTag: true,
	// 这几个连内容一起丢掉
	stripIgnoreTagBody: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
	allowCommentTag: false,
	// 正文不需要 style 属性；给出 false 表示不启用 CSS 过滤（因为 style 已被白名单排除）
	css: false,
	/**
	 * js-xss 默认已处理 href/src 的安全值，这里再显式挡一层协议黑名单。
	 * 返回 `''` = 丢掉该属性；返回 `undefined` = 交回默认处理。
	 */
	onTagAttr(tag, name, value) {
		if ((name === 'href' || name === 'src') && /^\s*(?:javascript|vbscript|data):/i.test(value)) {
			return '';
		}
		return undefined;
	},
});

/** 清洗一段 HTML。**写入 D1 前调用一次**，前台不再重复洗（§6.1 第 2 步）。 */
export function sanitizeHtml(html: string): string {
	return filter.process(html);
}
