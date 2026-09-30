/**
 * 前台主题 · 页面骨架（设计文档 §6.1 / §11 / §14.1）
 *
 * 本目录的三条纪律：
 *   1. **零依赖**。不 import 任何包，不碰 D1 / R2 / Hono —— 它要在发布流水线里裸跑。
 *   2. **只做字符串拼接**。每个 render*() 返回完整 HTML 字符串；写 R2 还是直接当
 *      响应体返回，由调用方决定（§14.1 的可回退设计）。
 *   3. **转义责任分清**。除 `content`（调用方拼好的、已转义的 HTML 片段）外，
 *      所有文本都必须经过 escapeHtml()。文章正文是唯一注入原始 HTML 的地方，
 *      它已在写入 D1 前清洗（§8.3）。
 */

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
	/** 导航链接，默认只有「首页」 */
	nav?: NavLink[];
	/** 页头站点名是否用 <h1>（首页用 h1，文章页用默认的 <p>，避免一页两个 h1） */
	siteTitleTag?: 'h1' | 'p';
	/** 额外的 <head> 内容（后续接入带指纹的主题资源，见 §7.2 / §14.2） */
	extraHead?: string;
	/** 额外的 </body> 前内容 */
	extraFoot?: string;
}

/**
 * HTML 转义。& 必须第一个替换，否则会把后面生成的实体再转一遍。
 */
export function escapeHtml(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * 把 Unix 秒格式化成 `YYYY-MM-DD`。
 *
 * 故意不用 Intl：不同运行时（workerd / Node）的 ICU 数据不一致，而这是发布时渲染、
 * 一次写进 R2 的内容，必须可复现。
 */
export function formatDate(timestamp: number, offsetHours = 8): string {
	const shifted = new Date((timestamp + offsetHours * 3600) * 1000);
	const year = shifted.getUTCFullYear();
	const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
	const day = String(shifted.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

/** `<time datetime>` 用的机器可读时间（UTC ISO 8601，与时区展示无关）。 */
export function formatDateTime(timestamp: number): string {
	return new Date(timestamp * 1000).toISOString();
}

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
	if (options.extraHead) head.push(options.extraHead);

	const navHtml = nav
		.map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(link.text)}</a>`)
		.join('\n\t\t');

	const descriptionHtml = site.description
		? `\n\t\t<p class="site-description">${escapeHtml(site.description)}</p>`
		: '';

	return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
	${head.join('\n\t')}
</head>
<body>
	<header class="site-header">
		<${titleTag} class="site-title"><a href="/">${escapeHtml(site.title)}</a></${titleTag}>${descriptionHtml}
		<nav class="site-nav">
		${navHtml}
		</nav>
	</header>
	<main>
${content}
	</main>
	<footer class="site-footer">
		<p>© ${year} ${escapeHtml(site.title)}</p>
	</footer>${options.extraFoot ? '\n' + options.extraFoot : ''}
</body>
</html>
`;
}
