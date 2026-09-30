/**
 * 主题资源访问器 —— 设计文档 §7.2 / §11
 *
 * 数据来自 `assets.generated.ts`（由 `npm run build:assets` 生成），本文件是**手写的**
 * 那一半：只提供「怎么用」，不提供「内容是什么」。这样生成文件可以永远是纯数据。
 *
 * 谁用：
 *   - `theme/layout.ts` —— 注入 `<link rel="stylesheet">` 与 `<script defer>`
 *   - `src/publish/targets.ts` —— 把资源对象排进全站重建清单（写 R2，带 `immutable`）
 *
 * 零依赖纪律：只 import 同目录的生成文件，不引任何包。见 `layout.ts` 顶部。
 */

import { THEME_ASSETS } from './assets.generated';
import type { ThemeAssetRecord } from './assets.generated';

export { THEME_ASSETS };
export type { ThemeAssetRecord };

/** 页面里引用的路径，如 `/theme/style.a1b2c3d4.css`（R2 key 加前导斜杠，§7.2） */
export function themeAssetPath(name: string): string {
	return `/${themeAsset(name).key}`;
}

/**
 * 按源文件名取资源。
 *
 * **找不到就抛**：模板里写错文件名（`style.css` 写成 `styles.css`）属于构建期错误，
 * 必须立刻炸掉，而不是安静地少发一个 `<link>` —— 后者要等有人在浏览器里发现「没样式」才暴露。
 */
export function themeAsset(name: string): ThemeAssetRecord {
	const asset = THEME_ASSETS.find((item) => item.name === name);
	if (!asset) {
		throw new Error(
			`主题资源 ${name} 不存在。theme/assets/ 下的文件是：${THEME_ASSETS.map((item) => item.name).join('、')}；` +
				`改完记得跑 npm run build:assets`,
		);
	}
	return asset;
}

/** `<head>` 里的样式表标签（一个资源一行） */
export function stylesheetLinks(): string {
	return THEME_ASSETS.filter((asset) => asset.contentType.startsWith('text/css'))
		.map((asset) => `<link rel="stylesheet" href="${themeAssetPath(asset.name)}">`)
		.join('\n\t');
}

/** `</body>` 前的脚本标签。一律 `defer` —— 脚本不参与首屏渲染，见 app.js 的纪律 2 */
export function themeScripts(): string {
	return THEME_ASSETS.filter((asset) => asset.contentType.startsWith('text/javascript'))
		.map((asset) => `<script src="${themeAssetPath(asset.name)}" defer></script>`)
		.join('\n');
}
