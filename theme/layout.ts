/**
 * 前台主题 · 页面骨架（设计文档 §6.1 / §7.2 / §11 / §14.1）
 *
 * 本目录的三条纪律：
 *   1. **零依赖**。不 import 任何包，不碰 D1 / R2 / Hono —— 它要在发布流水线里裸跑。
 *   2. **只做字符串拼接**。每个 render*() 返回完整 HTML 字符串；写 R2 还是直接当
 *      响应体返回，由调用方决定（§14.1 的可回退设计）。
 *   3. **转义责任分清**。除 `content`（调用方拼好的、已转义的 HTML 片段）外，
 *      所有文本都必须经过 escapeHtml()。文章正文是唯一注入原始 HTML 的地方，
 *      它已在写入 D1 前清洗（§8.3）。
 */

import { stylesheetLinks, themeScripts } from './assets';
import { escapeHtml, formatDate } from './html';

/**
 * 转义与时间格式化搬到了 `html.ts`。这里原样再导出一次，
 * 是为了不动已有调用点（`theme/post.ts`、`theme/components/list.ts` 等）。
 */
export { escapeHtml, formatDate, formatDateTime } from './html';

/** 站点级配置，来自 options 表（§4.1 / §7.3）。 */
export interface SiteInfo {
	/** 站点名，如「我的博客」 */
	title: string;
	/** 站点根绝对 URL，可带或不带末尾斜杠，如 https://blog.fengqi.me */
	url: string;
	description?: string;
	keywords?: string;
	/** <html lang>，默认 zh-CN */
	lang?: string;
	/** 时区偏移小时数，默认 +8（options 里没有就按 +8） */
	timezoneOffset?: number;
}

export interface NavLink {
	text: string;
	url: string;
}

/**
 * 页面容器宽度。由 `body` 上的类控制（见 style.css 的「容器宽度」一节）：
 *   - `default` 1080px —— 目前没有页面用它，留给将来需要宽幅的页面
 *   - `narrow`   50rem  —— 目前**所有**页面：列表 / 分页 / 归档 / 索引页 / 独立页面 / 文章页。
 *                          具体数值是 `style.css` 的 `--container-size`（宽度只有一个开关）。
 *                          不限制宽度的话一行能塞六十多个汉字，所以上限收在「约 44 个汉字一行」。
 *                          文章页的目录**不占正文宽度**（宽屏浮在容器右边的留白里，
 *                          窄屏折叠进正文顶部），所以「有目录」不需要更宽的容器 ——
 *                          全站一个宽度档就够，页头 / 页脚 / 正文的左边缘处处重合。
 */
export type LayoutWidth = 'default' | 'narrow';

export interface LayoutOptions {
	site: SiteInfo;
	/** 主内容 HTML，调用方拼好并已转义 */
	content: string;
	/**
	 * 页面标题。省略时只输出站点名；给出时输出 `<页面标题> - <站点名>`。
	 * 每页必须有唯一的 <title>，否则搜索结果里一堆同名页面。
	 */
	title?: string;
	/** canonical 用的**相对路径**（如 `/default/760.html`），与 site.url 拼成绝对 URL；
	 *  不传则不输出 canonical。传 '/' 表示首页。 */
	canonicalPath?: string;
	/** 顶栏导航链接，默认只有「首页」 */
	nav?: NavLink[];
	/** 页头站点名是否用 <h1>（首页用 h1，文章页用默认的 <p>，避免一页两个 h1） */
	siteTitleTag?: 'h1' | 'p';
	/** 页面容器宽度，默认 `default` */
	width?: LayoutWidth;
	/** 额外的 <head> 内容（带指纹的主题资源 `<link>` 由本文件自动注入，见 §7.2） */
	extraHead?: string;
	/** 额外的 </body> 前内容 */
	extraFoot?: string;
}

/**
 * 首屏应用主题的内联脚本。
 *
 * **必须内联、必须同步、必须放在 `<head>`**：`app.js` 是 `defer` 的，等它跑起来页面已经
 * 用亮色画过了，暗色用户会看到一帧闪白。它只做两件事：
 *   ① 给 `<html>` 加 `.js` —— 切换按钮的显隐由这个类控制（没有 JS 就别露出死按钮）
 *   ② 若用户手动选过主题（localStorage），立刻把 `data-theme` 设上
 * 没选过就不设 —— CSS 的 `prefers-color-scheme` 分支会接管，**没有 JS 也能进暗色**。
 */
const THEME_INIT_SCRIPT =
	`<script>(function(){var root=document.documentElement;root.className+=" js";` +
	`try{var saved=localStorage.getItem("theme");` +
	`if(saved==="dark"||saved==="light")root.setAttribute("data-theme",saved);}catch(err){}})();</script>`;

/** 站点根 URL 归一化：去掉末尾斜杠，便于拼相对路径。 */
function siteBase(site: SiteInfo): string {
	return site.url.replace(/\/+$/, '');
}

/**
 * 拼出完整页面。**只返回字符串，不关心它的去向。**
 */
export function renderLayout(options: LayoutOptions): string {
	const { site, content } = options;
	const base = siteBase(site);
	const lang = site.lang || 'zh-CN';
	const offset = site.timezoneOffset;
	const titleTag = options.siteTitleTag || 'p';
	const nav = options.nav || [{ text: '首页', url: '/' }];
	// 页脚年份：按站点时区取"当前年"，保证同一时刻渲染结果一致
	const year = formatDate(Date.now() / 1000, offset).slice(0, 4);

	const pageTitle =
		options.title && options.title !== site.title
			? `${options.title} - ${site.title}`
			: site.title;

	const head: string[] = [
		`<meta charset="utf-8">`,
		`<meta name="viewport" content="width=device-width, initial-scale=1">`,
		`<title>${escapeHtml(pageTitle)}</title>`,
	];
	if (site.description) {
		head.push(`<meta name="description" content="${escapeHtml(site.description)}">`);
	}
	if (site.keywords) {
		head.push(`<meta name="keywords" content="${escapeHtml(site.keywords)}">`);
	}
	if (options.canonicalPath) {
		head.push(`<link rel="canonical" href="${escapeHtml(base + options.canonicalPath)}">`);
	}
	// RSS 固定路径见 §5.1（带末尾斜杠）
	head.push(
		`<link rel="alternate" type="application/rss+xml" title="${escapeHtml(site.title)}" href="${escapeHtml(base)}/feed/">`,
	);
	// 带指纹的主题样式（§7.2）：路径来自 assets.generated.ts，文件名即缓存键
	head.push(stylesheetLinks());
	head.push(THEME_INIT_SCRIPT);
	if (options.extraHead) head.push(options.extraHead);

	const navHtml = nav
		.map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(link.text)}</a>`)
		.join('\n\t\t\t');

	const descriptionHtml = site.description
		? `\n\t\t\t\t<p class="site-description">${escapeHtml(site.description)}</p>`
		: '';

	const bodyClass = options.width && options.width !== 'default' ? ` class="layout-${options.width}"` : '';

	return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
	${head.join('\n\t')}
</head>
<body${bodyClass}>
	<header class="site-header">
		<div class="container site-header-inner">
			<div class="site-brand">
				<${titleTag} class="site-title"><a href="/">${escapeHtml(site.title)}</a></${titleTag}>${descriptionHtml}
			</div>
			<nav class="site-nav">
			${navHtml}
			</nav>
			<button type="button" class="theme-toggle" data-theme-toggle aria-label="切换深色 / 浅色模式" title="切换深色 / 浅色模式"></button>
		</div>
	</header>
	<main class="container site-main">
${content}
	</main>
	<footer class="site-footer">
		<div class="container">
			<p>© ${year} ${escapeHtml(site.title)}</p>
		</div>
	</footer>
	${themeScripts()}${options.extraFoot ? '\n' + options.extraFoot : ''}
</body>
</html>
`;
}
