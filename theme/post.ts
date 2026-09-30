/**
 * 前台主题 · 文章页与独立页面（设计文档 §5.1 / §6.1）
 *
 * 输出一篇文章的完整 HTML，由发布流水线写入 R2 的 `<category>/<slug>.html`。
 * 零依赖，见 layout.ts 顶部的三条纪律。
 */

import { escapeHtml, formatDate, formatDateTime, renderLayout } from './layout';
import type { NavLink, SiteInfo } from './layout';
import { extractToc } from './toc';
import type { TocItem } from './toc';

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

/** 目录条目（桌面右栏与窄屏折叠块共用同一份 li） */
function renderTocItems(items: TocItem[]): string {
	return items
		.map(
			(item) =>
				`\t\t\t\t<li class="toc-item toc-level-${item.level}"><a href="#${escapeHtml(item.id)}">${escapeHtml(
					item.text,
				)}</a></li>`,
		)
		.join('\n');
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

	/**
	 * 目录在这里抽取，**锚点 id 同时写回正文**（见 `toc.ts` 的说明）。
	 * 所以必须在拼 `post.html` 之前做，渲染完的 `contentHtml` 才是带 id 的那份。
	 */
	const { html: contentHtml, items: toc } = extractToc(post.html);
	const tocItems = toc.length > 0 ? renderTocItems(toc) : '';

	/**
	 * 目录出现两遍是**故意的**：
	 *   - `.post-toc-inline`（`<details>`）给窄屏，用原生折叠，不需要 JS；
	 *   - `.post-toc`（右栏）给宽屏，sticky 跟着正文。
	 * CSS 按 `62rem` 断点二选一显示。只出现一次的方案要么需要 JS 搬 DOM，
	 * 要么得给 `<details>` 做「宽屏强制展开」的 hack（`open` 由 UA 控制，CSS 盖不住）。
	 */
	const inlineToc =
		toc.length > 0
			? `
		<details class="post-toc-inline">
			<summary>目录</summary>
			<ol class="toc-list">
${tocItems}
			</ol>
		</details>`
			: '';

	const article = `	<article class="post">
		<h1 class="post-title">${escapeHtml(post.title)}</h1>
		<p class="post-meta">
			${meta.join('\n\t\t\t')}
		</p>${inlineToc}
		<div class="post-content">
${contentHtml}
		</div>
	</article>${navHtml.length ? `\n\t<nav class="post-nav">\n\t\t${navHtml.join('\n\t\t')}\n\t</nav>` : ''}`;

	/**
	 * `.post-body` **两种版式都要有**：正文列宽由它的网格轨道决定
	 * （见 style.css 的 `.post-layout`）。无目录时少了这层包裹，正文会直接铺满 62rem。
	 */
	const body = `		<div class="post-body">
${article}
		</div>`;

	// 没有 h2/h3 的文章（短文、纯代码笔记）不渲染空目录栏，正文自己居中即可
	const content =
		toc.length > 0
			? `	<div class="post-layout post-layout--with-toc">
${body}
		<aside class="post-toc" aria-label="文章目录">
			<h2 class="post-toc-title">目录</h2>
			<ol class="toc-list">
${tocItems}
			</ol>
		</aside>
	</div>`
			: `	<div class="post-layout">
${body}
	</div>`;

	return renderLayout({
		site,
		content,
		title: post.title,
		canonicalPath: context.canonicalPath || post.url,
		nav: context.nav,
		/**
		 * 版式宽度**跟着内容走，不跟着「是文章还是页面」走**：
		 *   - 有目录 → 62rem，给 `42rem 正文 + 14rem 右栏` 两列留位置；
		 *   - 没目录 → 44rem，和首页 / 索引页同一档。
		 * 这里**必须按 `toc.length` 判断，不能恒给 `post`** —— 独立页面（`/about.html` 等）
		 * 和没有 h2/h3 的短文章本来就只有一列，恒给 62rem 会让它们顶着一个比首页宽一截的
		 * 外壳、正文缩在中间：页头和正文都跟其他页对不齐（`.layout-narrow` 的容器内宽 664px
		 * 正好等于列表页的正文宽度）。
		 */
		width: toc.length > 0 ? 'post' : 'narrow',
	});
}
