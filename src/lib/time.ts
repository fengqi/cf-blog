/**
 * 时间处理 —— 设计文档 §4.1（`contents.created` 是 Unix 秒）
 *
 * 和主题层一样**故意不用 `Intl`**：workerd 与 Node 的 ICU 数据不一致，
 * 而这些都是要写进 R2 的内容，必须可复现。
 *
 * 展示格式在 `theme/layout.ts`（主题要能独立裸跑，所以那边也有一份格式化函数）。
 */

/** 按站点时区偏移算出「哪年哪月」，用于年月归档的 key 与标题 */
export function monthOf(timestamp: number, offsetHours = 8): { year: number; month: number } {
	const shifted = new Date((timestamp + offsetHours * 3600) * 1000);
	return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
}

/** W3C 日期（sitemap 的 `<lastmod>` 用）：`2026-09-30` */
export function formatDateOnly(timestamp: number, offsetHours = 8): string {
	const { year, month } = monthOf(timestamp, offsetHours);
	const day = new Date((timestamp + offsetHours * 3600) * 1000).getUTCDate();
	return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * RFC 822 日期（RSS 的 `<pubDate>` 用）：`Tue, 30 Sep 2026 06:00:00 +0000`
 *
 * RSS 习惯用 GMT，这里就固定输出 UTC —— 展示用的时区在页面里已经处理过了。
 */
export function formatRfc822(timestamp: number): string {
	const date = new Date(timestamp * 1000);
	return (
		`${WEEKDAYS[date.getUTCDay()]}, ${String(date.getUTCDate()).padStart(2, '0')} ` +
		`${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
		`${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:` +
		`${String(date.getUTCSeconds()).padStart(2, '0')} +0000`
	);
}

/**
 * `<input type="datetime-local">` 的值（按**站点时区**）：`2026-09-30T14:05`
 *
 * 编辑器和展示必须用同一套时区语义，否则作者看到的发布时间会和前台差几个小时。
 */
export function formatDateTimeLocal(timestamp: number, offsetHours = 8): string {
	const shifted = new Date((timestamp + offsetHours * 3600) * 1000);
	const pad = (value: number) => String(value).padStart(2, '0');
	return (
		`${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
		`T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
	);
}

/** 解析 `datetime-local` 的值（按站点时区）→ Unix 秒；非法输入返回 null */
export function parseDateTimeLocal(value: string, offsetHours = 8): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
	if (!match) return null;
	const [, year, month, day, hour, minute, second] = match;
	const utc = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second ?? 0),
	);
	if (Number.isNaN(utc)) return null;
	return Math.floor(utc / 1000) - offsetHours * 3600;
}
