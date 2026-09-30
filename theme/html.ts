/**
 * 主题层的转义与时间格式化 —— 设计文档 §11
 *
 * 单独一个模块是历史原因：早先 `layout.ts` 与 `components/sidebar.ts` 互相要转义函数，
 * 留在任一文件里都会形成循环依赖。侧栏已经整站移除（顶栏导航取代），环不存在了，
 * 但这个模块留着更清楚：**它是纯函数，谁都能引**，不用管引入方在主题的哪一层。
 *
 * 零依赖纪律同 `layout.ts` 顶部（不 import 任何包、不碰 D1/R2/Hono）。
 */

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
