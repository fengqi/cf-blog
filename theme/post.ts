/**
 * 前台主题 · 文章页与独立页面（设计文档 §5.1 / §6.1）
 *
 * 输出一篇文章的完整 HTML，由发布流水线写入 R2 的 `<category>/<slug>.html`。
 * 零依赖，见 layout.ts 顶部的三条纪律。
 */

import { escapeHtml, formatDate, formatDateTime, renderLayout } from './layout';
import type { NavLink, SiteInfo } from './layout';
import { renderIcon } from './icons';
import { extractToc } from './toc';
import type { TocItem } from './toc';

/**
 * Twikoo 前端脚本版本。**必须与服务端版本一致**（服务端就是用户部署的 Twikoo
 * 实例，GET_CONFIG 会返回 VERSION）—— 大版本不匹配时接口会对不上。
 * 升级时同步改这里与 `options.twikoo_env` 指向的服务端。
 */
const TWIKOO_VERSION = '2.0.15';

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

/**
 * 把值变成能放进 `<script>` 里单引号字符串的字面量。
 * script 内容对 HTML 解析器是 **raw text**，escapeHtml() 在这里只会帮倒忙
 * （`&` 会变成字面的 `&amp;`）；要防的是引号逃逸与 `</script` 提前闭合。
 */
function jsString(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/<\/script/gi, '<\\/script');
}

/**
 * Twikoo 评论区。`options.twikoo_env` 没配就整个不渲染（列表/归档页本来就不经过这里）。
 *
 * `path` 传 canonical **相对路径**而不是 `location.pathname`：
 * 旧 permalink 页（§5.1 方案 A，canonical 指向新地址）的评论要并进新地址的同一条线程；
 * 相对路径也不随换域名漂移。 Twikoo 自己按 path 存取评论，域名变了线程还在。
 */
function renderComments(site: SiteInfo, canonicalPath: string): { container: string; foot: string } {
	if (!site.twikooEnv) return { container: '', foot: '' };
	const container = `\n\t<div class="post-comments" id="twikoo"></div>`;
	const foot = `<script src="https://cdn.jsdelivr.net/npm/twikoo@${TWIKOO_VERSION}/dist/twikoo.all.min.js"></script>
<script>
twikoo.init({
	envId: '${jsString(site.twikooEnv)}',
	el: '#twikoo',
	path: '${jsString(canonicalPath)}'
});
</script>`;
	return { container, foot };
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
			`<span class="post-prev">${renderIcon('arrow-left')}上一篇：<a href="${escapeHtml(prev.url)}">${escapeHtml(prev.title)}</a></span>`,
		);
	}
	if (next) {
		navHtml.push(
			`<span class="post-next">下一篇：<a href="${escapeHtml(next.url)}">${escapeHtml(next.title)}</a>${renderIcon('arrow-right')}</span>`,
		);
	}

	/**
	 * 目录在这里抽取，**锚点 id 同时写回正文**（见 `toc.ts` 的说明）。
	 * 所以必须在拼 `post.html` 之前做，渲染完的 `contentHtml` 才是带 id 的那份。
	 */
	const { html: contentHtml, items: toc } = extractToc(post.html);
	// 目录少于两条就没有导航价值（「目录 → 关于」这种自指条目纯属噪音），不渲染
	const hasToc = toc.length >= 2;
	const tocItems = hasToc ? renderTocItems(toc) : '';

	/**
	 * 目录出现两遍是**故意的**：
	 *   - `.post-toc-inline`（`<details>`）给窄屏，用原生折叠，不需要 JS；
	 *   - `.post-toc` 给宽屏，`fixed` 钉在容器右边的留白里，跟着滚动高亮。
	 * CSS 按视口宽度二选一显示（断点与定位见 style.css 的「11. 响应式」）。
	 * 只出现一次的方案要么需要 JS 搬 DOM，
	 * 要么得给 `<details>` 做「宽屏强制展开」的 hack（`open` 由 UA 控制，CSS 盖不住）。
	 */
	const inlineToc = hasToc
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

	const comments = renderComments(site, context.canonicalPath || post.url);

	/**
	 * `.post-body` **两种版式都要有**：正文列宽由它的网格轨道决定
	 * （见 style.css 的 `.post-layout`）。少了这层包裹，正文会直接铺满整个容器、
	 * 跟另一种版式错开。
	 */
	const body = `		<div class="post-body">
${article}${comments.container}
		</div>`;

	// 没有目录（标题少于两条）的文章不渲染目录栏 —— 版式和有目录的文章完全一样
	const content =
		hasToc
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
		/** Twikoo 的 CDN 脚本与 init 必须等容器进了 DOM，放 </body> 前最稳 */
		extraFoot: comments.foot || undefined,
		/**
		 * **全站一个宽度档**（`style.css` 的 `--container-size`，当前 56rem）。
		 *
		 * 目录不再靠「把容器撑到 62rem」来腾位置 —— 宽屏时它浮在容器右边的留白里，
		 * 窄屏折叠进正文顶部（见 style.css 的「11. 响应式」）。容器宽度与内容无关，
		 * 页头 / 页脚 / 正文的左边缘在全站任意两个页面之间都完全重合。
		 *
		 * 曾经这里按 `toc.length` 给 `'post'`（62rem）：文章页的页头比首页宽 288px，
		 * 正文还得靠 `.post-body` 再收窄一次，两条边都对不齐；独立页面和没写小标题的
		 * 短文更顶着 62rem 的空外壳。那个宽度档已经废掉 —— **正文宽度该由「读起来
		 * 舒不舒服」决定，不该由「这一页有没有第二列」决定。**
		 */
		width: 'narrow',
	});
}
