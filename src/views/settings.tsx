/**
 * 站点设置 —— 设计文档 §6.1 后台「设置」/ §7.3（配置缓存失效）
 *
 * 纯 SSR 表单，样式沿用 AdminLayout 的内联 CSS（§0：后台无单独构建链）。
 * 字段与 `options` 表的 name 一一对应（见 models/option.ts 的 SITE_SETTING_KEYS）；
 * 校验在 routes/admin.tsx 里做，这里只负责展示与提交。
 */

import { AdminLayout } from './layout';

export interface SettingsValues {
	title: string;
	description: string;
	keywords: string;
	siteUrl: string;
	/** 静态资源（附件/图片）域名；与 options 里的 `static_url` 对应，未配置时与站点域名相同 */
	staticUrl: string;
	postsPerPage: number;
	/** 归一化后的小时数（+8 即东八区；库里可能存的是 Typecho 的秒数） */
	timezoneOffset: number;
	turnstileSiteKey: string;
}

export interface SettingsPageProps {
	values: SettingsValues;
	user: { screen_name: string | null; username: string };
	message?: string;
	error?: string;
}

export function SettingsPage(props: SettingsPageProps) {
	const v = props.values;
	return (
		<AdminLayout title="站点设置 · 博客后台" user={props.user} message={props.message} error={props.error}>
			<h1 class="page-head">站点设置</h1>
			<form method="post" action="/admin/settings" class="stack">
				<div>
					<label for="site_title">站点标题</label>
					<input type="text" id="site_title" name="site_title" value={v.title} />
					<p class="hint">显示在页头、登录页与 RSS；改了要全站重渲</p>
				</div>

				<div>
					<label for="site_description">站点描述</label>
					<textarea id="site_description" name="site_description" rows={2}>
						{v.description}
					</textarea>
					<p class="hint">进 RSS channel 与首页 meta；改了要全站重渲</p>
				</div>

				<div>
					<label for="site_keywords">站点关键词</label>
					<input type="text" id="site_keywords" name="site_keywords" value={v.keywords} />
					<p class="hint">进首页 meta keywords；改了要全站重渲</p>
				</div>

				<div>
					<label for="site_url">站点域名</label>
					<input
						type="text"
						id="site_url"
						name="site_url"
						value={v.siteUrl}
						placeholder="https://blog.fengqi.me"
						required
					/>
					<p class="hint">
						完整的 http(s) 地址，不带末尾斜杠。<strong>canonical / feed / sitemap 全靠它</strong>
						，填错整站绝对链接都错；改了必须全站重渲（§6.5）
					</p>
				</div>

				<div>
					<label for="static_url">静态资源域名（可空）</label>
					<input
						type="text"
						id="static_url"
						name="static_url"
						value={v.staticUrl === v.siteUrl ? '' : v.staticUrl}
						placeholder="https://static.fengqi.me"
					/>
					<p class="hint">
						正文里插入的<strong>图片地址用它拼成完整地址</strong>，与站点域名解耦 ——
						以后换博客域名，已发布文章里的图片地址不受影响。这个域名要能取到同一个桶里的
						<code>/usr/uploads/...</code>（R2 自定义域名或 CDN 回源都行），
						路径不能变。留空则用上面的站点域名
					</p>
				</div>

				<div class="row">
					<div>
						<label for="posts_per_page">每页篇数</label>
						<input
							type="number"
							id="posts_per_page"
							name="posts_per_page"
							value={String(v.postsPerPage)}
							min="1"
							max="100"
							step="1"
						/>
						<p class="hint">首页与归档分页大小；改了要全站重渲</p>
					</div>
					<div>
						<label for="timezone">时区（小时）</label>
						<input
							type="number"
							id="timezone"
							name="timezone"
							value={String(v.timezoneOffset)}
							min="-12"
							max="14"
							step="1"
						/>
						<p class="hint">东八区填 8；影响展示时间与按月归档分组</p>
					</div>
				</div>

				<div>
					<label for="turnstile_site_key">Turnstile Site Key（可空）</label>
					<input type="text" id="turnstile_site_key" name="turnstile_site_key" value={v.turnstileSiteKey} />
					<p class="hint">
						配了它登录页才渲染人机校验控件；配合密钥 <code>TURNSTILE_SECRET</code>（wrangler secret）
						才真正强制校验。只影响登录页，不用重渲
					</p>
				</div>

				<div class="actions">
					<button type="submit">保存设置</button>
					<a class="button" href="/admin">
						返回列表
					</a>
				</div>
			</form>
		</AdminLayout>
	);
}
