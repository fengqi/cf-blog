/**
 * 前台主题 · 文章页与独立页面（设计文档 §5.1 / §6.1）
 *
 * 输出一篇文章的完整 HTML，由发布流水线写入 R2 的 `<category>/<slug>.html`。
 * 零依赖，见 layout.ts 顶部的三条纪律。
 */

import { escapeHtml, formatDate, formatDateTime, renderLayout } from './layout';
import type { NavLink, SiteInfo } from './layout';

/** 分类 / 标签链接 */
export interface TermLink {
	name: string;
	/** 相对路径，如 /category/default/ */
	url: string;
}

/** 上一篇 / 下一篇 */
export interface PostLink {
	title: string;
	url: string;
}

/** 一篇文章的视图模型（由 src/models/ 聚合查询喂进来，见 §5.2） */
export interface PostView {
	cid: number;
	title: string;
	/** 相对路径，如 /default/760.html */
	url: string;
	/** Unix 秒 */
	created: number;
	modified?: number;
	/** 预渲染并清洗过的正文 HTML（§4.2 ① / §8.3）——本文件唯一的原始 HTML 注入点 */
	html: string;
	author?: {
		name: string;
		/**
		 * 作者归档 `/author/<uid>/` 已明确放弃（§5.1 豁免清单，迁移后会 404）。
		 * 所以默认**不要传这个字段** —— 传了就会渲染出一个坏链接。
		 * 只有将来真的生成作者归档页时才填。
		 */
		url?: string;
	};
	categories?: TermLink[];
	tags?: TermLink[];
	words?: number;
}

export interface PostContext {
	site: SiteInfo;
	post: PostView;
	/**
	 * canonical 的目标路径。默认取 post.url；
	 * 渲染 `permalink_history` 里的**旧 URL** 时必须显式传新路径，
	 * 让旧页面 return 200 同时把权重归并到新 URL（§5.1 方案 A）。
	 */
	canonicalPath?: string;
	prev?: PostLink;
	next?: PostLink;
	nav?: NavLink[];
}

function renderTermLinks(className: string, label: string, terms: TermLink[] | undefined): string {
	if (!terms || terms.length === 0) return '';
	const links = terms
		.map((term) => `<a href="${escapeHtml(term.url)}" rel="tag">${escapeHtml(term.name)}</a>`)
		.join(', ');
	return `<span class="post-${className}">${label}：${links}</span>`;
}

export function renderPost(context: PostContext): string {
	const { site, post, prev, next } = context;

	const meta: string[] = [
		`<time datetime="${escapeHtml(formatDateTime(post.created))}">${escapeHtml(formatDate(post.created, site.timezoneOffset))}</time>`,
	];
	if (post.author) {
		meta.push(
			post.author.url
				? `<span class="post-author"><a href="${escapeHtml(post.author.url)}">${escapeHtml(post.author.name)}</a></span>`
				: `<span class="post-author">${escapeHtml(post.author.name)}</span>`,
		);
	}
	const categoryHtml = renderTermLinks('categories', '分类', post.categories);
	if (categoryHtml) meta.push(categoryHtml);
	const tagHtml = renderTermLinks('tags', '标签', post.tags);
	if (tagHtml) meta.push(tagHtml);
	if (post.words) {
		meta.push(`<span class="post-words">${post.words} 字</span>`);
	}

	const navHtml: string[] = [];
	if (prev) {
		navHtml.push(
			`<span class="post-prev">上一篇：<a href="${escapeHtml(prev.url)}">${escapeHtml(prev.title)}</a></span>`,
		);
	}
	if (next) {
		navHtml.push(
			`<span class="post-next">下一篇：<a href="${escapeHtml(next.url)}">${escapeHtml(next.title)}</a></span>`,
		);
	}

	const content = `	<article class="post">
		<h1 class="post-title">${escapeHtml(post.title)}</h1>
		<p class="post-meta">
			${meta.join('\n\t\t\t')}
		</p>
		<div class="post-content">
${post.html}
		</div>
	</article>${navHtml.length ? `\n\t<nav class="post-nav">\n\t\t${navHtml.join('\n\t\t')}\n\t</nav>` : ''}`;

	return renderLayout({
		site,
		content,
		title: post.title,
		canonicalPath: context.canonicalPath || post.url,
		nav: context.nav,
	});
}
