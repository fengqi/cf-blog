/**
 * 前台内联 SVG 图标 —— 顶栏导航与列表项的日期用。
 *
 * 线条稿来自 Feather Icons（MIT，https://feathericons.com），
 * 描边 currentColor：颜色跟宿主文字走，亮暗两套变量自动覆盖，不需要单独配色。
 * 零依赖纪律见 layout.ts 顶部 —— 这里只是字符串，不引任何外部资源。
 */

const SVG_ATTRS =
	' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
	' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/** key → svg path 片段。key 集合见 NavLink.icon 与 components/list.ts 的用法 */
const ICONS: Record<string, string> = {
	home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
	categories:
		'<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
	tags: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
	archives:
		'<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
	about:
		'<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
	calendar:
		'<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
	'arrow-left':
		'<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
	'arrow-right':
		'<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
};

/**
 * 输出 `<svg class="icon …">…</svg>`。name 为空或不在表里时返回空串 ——
 * 图标缺失最多少个装饰，不该让整页渲染炸掉。
 */
export function renderIcon(name: string | undefined, className = ''): string {
	if (!name) return '';
	const path = ICONS[name];
	if (!path) return '';
	const cls = className ? ` ${className}` : '';
	return `<svg class="icon${cls}"${SVG_ATTRS}>${path}</svg>`;
}
