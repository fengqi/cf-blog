/**
 * 后台页面与操作 —— 设计文档 §6.1（保存即发布）/ §6.5 / §11
 *
 * 这一层只做三件事：解析表单、调用 models 写 D1、调用发布流水线写 R2。
 * **不拼 HTML**（那是 `views/` 与 `theme/` 的事），**不写 SQL**（那是 `models/` 的事）。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createDb } from '../lib/db';
import { hashPassword, PBKDF2_ITERATIONS, verifyPassword } from '../lib/auth';
import { categoryKey, pageCount, postKey } from '../lib/url';
import { parseDateTimeLocal } from '../lib/time';
import {
	countAdminPosts,
	countNeedsSync,
	createAttachment,
	createContent,
	getContentByCid,
	getEditorView,
	type ContentInput,
	listAdminPosts,
	listAttachments,
	listPostsInCategory,
	markAllDirty,
	markNeedsSync,
	recordPermalink,
	recordPermalinks,
	setContentTerms,
	updateContentFields,
} from '../models/content';
import {
	createCategory,
	deleteCategory,
	ensureTags,
	findCategoryBySlug,
	listTerms,
	updateCategory,
} from '../models/meta';
import { getOptionValue, getSiteOptions, saveSiteSettings } from '../models/option';
import { getUserById, updatePassword } from '../models/user';
import {
	attachmentContentType,
	attachmentKey,
	MAX_ATTACHMENT_BYTES,
	putAttachment,
	sanitizeAttachmentFilename,
} from '../publish/attachments';
import { deleteObjects, deletePost, publishPost, rebuildTargetsSlice } from '../publish/pipeline';
import { reconcileNeedsSync } from '../publish/sync';
import { hasUrl, postKeyOf, TARGET_GROUPS, type TargetGroup } from '../publish/targets';
import { CategoriesPage } from '../views/categories';
import { ChangePasswordPage } from '../views/password';
import { MediaLibraryPage } from '../views/media';
import { PostEditorPage } from '../views/post-editor';
import { PostListPage } from '../views/post-list';
import { RenderPage } from '../views/render';
import { SettingsPage } from '../views/settings';
import type { AdminVariables } from '../middleware/auth';
import type { AdminEnv } from '../types';

export const adminRoutes = new Hono<{ Bindings: AdminEnv; Variables: AdminVariables }>();

const ALLOWED_STATUS = new Set(['publish', 'draft', 'waiting', 'hidden', 'private']);

/**
 * Hono 只有在真的有 ExecutionContext 时才给 `c.executionCtx`；
 * 路由单测（`app.request(...)` 不带 ctx）会抛错，所以这里兜一下。
 */
function getExecutionContext(c: Context) {
	try {
		return c.executionCtx;
	} catch {
		return undefined;
	}
}

interface EditorPayload {
	input: ContentInput;
	categoryIds: number[];
	tagNames: string[];
}

async function parseEditorForm(c: Context, timezoneOffset: number): Promise<EditorPayload> {
	const form = await c.req.formData();
	const text = (name: string) => String(form.get(name) ?? '').trim();

	const status = text('status');
	const type = text('type') === 'page' ? 'page' : 'post';

	return {
		input: {
			title: text('title'),
			slug: text('slug'),
			body: String(form.get('body') ?? ''),
			excerpt: String(form.get('excerpt') ?? '').trim(),
			status: ALLOWED_STATUS.has(status) ? status : 'draft',
			created: parseDateTimeLocal(text('created'), timezoneOffset) ?? Math.floor(Date.now() / 1000),
			allowFeed: form.get('allow_feed') === '1' ? 1 : 0,
			type,
		},
		// 独立页面是单段 URL：没有分类也没有标签（Typecho 语义），表单里带了也忽略
		categoryIds: type === 'page' ? [] : form.getAll('categories').map(Number).filter(Number.isFinite),
		tagNames:
			type === 'page'
				? []
				: text('tags')
						.split(/[,，]/)
						.map((name) => name.trim())
						.filter(Boolean),
	};
}

/** 表单里同时带 type：它决定展示哪个列表/URL 形状，改类型属于少见操作，这里允许 */
function messageForReport(action: string, report: { skipped?: string; sync?: { written: string[] } }): string {
	if (report.skipped) return `${action}：${report.skipped}`;
	const written = report.sync?.written.length ?? 0;
	return `${action}成功：同步写入 ${written} 个对象，其余由 waitUntil 异步重建`;
}

adminRoutes.get('/admin', async (c) => {
	const db = createDb(c.env.DB, 'admin');
	const options = await getSiteOptions(c.env);
	const q = (c.req.query('q') ?? '').trim();
	const status = c.req.query('status') ?? '';
	const categoryMid = Number(c.req.query('category'));
	const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
	const pageSize = 10;
	const filter = {
		q: q || undefined,
		status: status || undefined,
		categoryMid: Number.isFinite(categoryMid) && categoryMid > 0 ? categoryMid : undefined,
	};
	const [posts, total, needsSync, categories] = await Promise.all([
		listAdminPosts(db, pageSize, filter, (page - 1) * pageSize),
		countAdminPosts(db, filter),
		countNeedsSync(db),
		listTerms(db, 'category'),
	]);
	const totalPages = Math.max(1, Math.ceil(total / pageSize));

	return c.html(
		<PostListPage
			posts={posts}
			total={total}
			page={page}
			totalPages={totalPages}
			needsSync={needsSync}
			categories={categories}
			filters={{ q, status, categoryMid: Number.isFinite(categoryMid) && categoryMid > 0 ? categoryMid : '' }}
			user={c.var.user}
			siteTimezoneOffset={options.timezoneOffset}
			message={c.req.query('message')}
			error={c.req.query('error')}
		/>,
	);
});

/** 右上角「前台」入口：跳到站点规范域名（site_url，见设置页） */
adminRoutes.get('/admin/front', async (c) => {
	const options = await getSiteOptions(c.env);
	return c.redirect(options.siteUrl || '/admin', 302);
});

/** 渲染维护页：全站渲染（阶段一）与增量渲染（阶段二）两个独立操作 */
adminRoutes.get('/admin/render', async (c) => {
	const db = createDb(c.env.DB, 'admin');
	const needsSync = await countNeedsSync(db);
	return c.html(
		<RenderPage needsSync={needsSync} user={c.var.user} message={c.req.query('message')} error={c.req.query('error')} />,
	);
});

adminRoutes.get('/admin/settings', async (c) => {
	const db = createDb(c.env.DB, 'admin');
	// turnstile_site_key 不在 SiteOptions 里（那是主题要的东西），单独读
	const [options, turnstileSiteKey] = await Promise.all([
		getSiteOptions(c.env),
		getOptionValue(db, 'turnstile_site_key'),
	]);

	return c.html(
		<SettingsPage
			user={c.var.user}
			values={{
				title: options.title,
				description: options.description,
				keywords: options.keywords,
				siteUrl: options.siteUrl,
				postsPerPage: options.postsPerPage,
				timezoneOffset: options.timezoneOffset,
				turnstileSiteKey: turnstileSiteKey ?? '',
			}}
			message={c.req.query('message')}
			error={c.req.query('error')}
		/>,
	);
});

adminRoutes.post('/admin/settings', async (c) => {
	const db = createDb(c.env.DB, 'admin');
	const form = await c.req.formData();
	const text = (name: string) => String(form.get(name) ?? '').trim();

	// site_url：剥掉末尾斜杠后必须是合法 http(s) 地址 —— 它错了整站 canonical/feed/sitemap 全错，
	// 所以这里从严校验，而不是靠 getSiteOptions 读取时的报错兜底
	const siteUrl = text('site_url').replace(/\/+$/, '');
	try {
		const parsed = new URL(siteUrl);
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('协议必须是 http(s)');
	} catch {
		return c.redirect(
			'/admin/settings?error=' + encodeURIComponent('域名必须是完整的 http(s) 地址，如 https://blog.fengqi.me'),
			303,
		);
	}

	const postsPerPage = Number.parseInt(text('posts_per_page'), 10);
	if (!(postsPerPage >= 1 && postsPerPage <= 100)) {
		return c.redirect('/admin/settings?error=' + encodeURIComponent('每页篇数必须是 1~100 的整数'), 303);
	}

	const timezone = Number.parseInt(text('timezone'), 10);
	if (!(timezone >= -12 && timezone <= 14)) {
		return c.redirect('/admin/settings?error=' + encodeURIComponent('时区必须是 -12~14 的整数小时'), 303);
	}

	// 保存前的快照：用来判断「前台可见的配置」变没变（变了就要全站重渲）
	const before = await getSiteOptions(c.env);
	await saveSiteSettings(db, {
		site_title: text('site_title'),
		site_description: text('site_description'),
		site_keywords: text('site_keywords'),
		site_url: siteUrl,
		posts_per_page: String(postsPerPage),
		timezone: String(timezone),
		turnstile_site_key: text('turnstile_site_key'),
	});
	const after = await getSiteOptions(c.env);

	const frontChanged =
		before.title !== after.title ||
		before.description !== after.description ||
		before.keywords !== after.keywords ||
		before.siteUrl !== after.siteUrl ||
		before.postsPerPage !== after.postsPerPage ||
		before.timezoneOffset !== after.timezoneOffset;

	let message = '设置已保存';
	if (frontChanged) {
		// 与「全站重新渲染」按钮同一机制：标脏交给 Cron 逐批重建（§6.5）；
		// 想立刻刷完用分批重建循环（POST /admin/rebuild/full）
		const marked = await markAllDirty(db);
		message = `设置已保存；前台配置有变动，已把 ${marked} 篇内容排入重建（Cron 每小时 20 篇，或用分批重建立即刷完）`;
	}
	return c.redirect('/admin/settings?message=' + encodeURIComponent(message), 303);
});

adminRoutes.get('/admin/media', async (c) => {
	const db = createDb(c.env.DB, 'admin');
	const [options, attachments] = await Promise.all([
		getSiteOptions(c.env),
		listAttachments(db),
	]);
	return c.html(
		<MediaLibraryPage
			attachments={attachments}
			siteUrl={options.siteUrl}
			timezoneOffset={options.timezoneOffset}
			user={c.var.user}
			message={c.req.query('message')}
			error={c.req.query('error')}
		/>,
	);
});

/**
 * 附件上传（§9）：校验类型/大小 → 写 R2（immutable，不可覆盖）→ 元信息落 D1。
 * 附件不进渲染流水线（needs_sync=0），所以这里没有 waitUntil / 发布动作。
 */
adminRoutes.post('/admin/media', async (c) => {
	const db = createDb(c.env.DB, 'admin');
	const options = await getSiteOptions(c.env);
	const form = await c.req.formData();
	const files = form.getAll('files').filter((entry): entry is File => entry instanceof File && entry.size > 0);

	if (files.length === 0) {
		return c.redirect('/admin/media?error=' + encodeURIComponent('没有选择文件'), 303);
	}

	const now = Math.floor(Date.now() / 1000);
	const uploaded: string[] = [];
	const failed: string[] = [];
	for (const file of files) {
		const name = sanitizeAttachmentFilename(file.name);
		if (!name) {
			failed.push(`${file.name}：文件名不合法（含 %?# 等字符或为空）`);
			continue;
		}
		const contentType = attachmentContentType(name);
		if (!contentType) {
			failed.push(`${name}：类型不在白名单（jpg/png/webp/gif/avif/pdf）`);
			continue;
		}
		if (file.size > MAX_ATTACHMENT_BYTES) {
			failed.push(`${name}：超过 10MB`);
			continue;
		}
		const key = attachmentKey(now, options.timezoneOffset, name);
		const result = await putAttachment(c.env, key, await file.arrayBuffer(), contentType);
		if (!result.ok) {
			failed.push(`${name}：${result.reason}`);
			continue;
		}
		await createAttachment(db, {
			title: name,
			mime: contentType,
			size: file.size,
			r2Key: key,
			authorId: c.var.user.uid,
		});
		uploaded.push(name);
	}

	if (uploaded.length === 0) {
		return c.redirect('/admin/media?error=' + encodeURIComponent(`全部失败：${failed.join('；')}`), 303);
	}
	const message =
		failed.length > 0 ? `上传 ${uploaded.length} 个；失败 ${failed.length} 个：${failed.join('；')}` : `已上传 ${uploaded.join('、')}`;
	return c.redirect('/admin/media?message=' + encodeURIComponent(message), 303);
});

adminRoutes.get('/admin/password', async (c) => {
	return c.html(
		<ChangePasswordPage
			user={c.var.user}
			message={c.req.query('message')}
			error={c.req.query('error')}
		/>,
	);
});

/**
 * 改口令（§8.2）：校验当前口令 → PBKDF2 哈希落库 → `token_version += 1`。
 * 保存成功后当前会话也失效了（中间件比 tv），跳登录页让用户用新口令进来。
 */
adminRoutes.post('/admin/password', async (c) => {
	const db = createDb(c.env.DB, 'admin');
	const form = await c.req.formData();
	const current = String(form.get('current_password') ?? '');
	const next = String(form.get('new_password') ?? '');
	const confirm = String(form.get('confirm_password') ?? '');

	if (next.length < 8) {
		return c.redirect('/admin/password?error=' + encodeURIComponent('新口令至少 8 位'), 303);
	}
	if (next !== confirm) {
		return c.redirect('/admin/password?error=' + encodeURIComponent('两次输入的新口令不一致'), 303);
	}

	const user = await getUserById(db, c.var.user.uid);
	if (!user || !(await verifyPassword(current, user.password))) {
		return c.redirect('/admin/password?error=' + encodeURIComponent('当前口令不正确'), 303);
	}

	await updatePassword(db, user.uid, await hashPassword(next, PBKDF2_ITERATIONS));
	return c.redirect(
		'/admin/login?message=' + encodeURIComponent('口令已修改，请用新口令重新登录'),
		303,
	);
});

adminRoutes.get('/admin/categories', async (c) => {
	const db = createDb(c.env.DB, 'admin');
	const categories = await listTerms(db, 'category');
	return c.html(
		<CategoriesPage
			categories={categories}
			user={c.var.user}
			message={c.req.query('message')}
			error={c.req.query('error')}
		/>,
	);
});

/** 分类/标签的 slug 会进 URL：拒掉会破坏路径形状的字符；中文按原样保留（§9 实测可用） */
function validateTermSlug(slug: string): string | null {
	if (!slug) return '缩略名不能为空';
	if (slug.length > 200) return '缩略名太长（>200 字符）';
	if (/[/%?#]/.test(slug) || /[\x00-\x1f]/.test(slug)) return '缩略名不能包含 / % ? # 或控制字符';
	return null;
}

/**
 * 分类 slug 变更/删除后要清掉的旧归档对象（基础页 + 各分页副本）。
 * 旧地址不保留 —— 方案 A 只承诺文章 URL，归档直接换新地址。
 */
function oldCategoryArchiveKeys(slug: string, publishedCount: number, postsPerPage: number): string[] {
	const keys = [categoryKey(slug)];
	for (let page = 1; page <= pageCount(publishedCount, postsPerPage); page++) {
		keys.push(categoryKey(slug, page));
	}
	return keys;
}

adminRoutes.post('/admin/categories', async (c) => {
	const db = createDb(c.env.DB, 'admin');
	const form = await c.req.formData();
	const text = (name: string) => String(form.get(name) ?? '').trim();
	const name = text('name');
	if (!name) {
		return c.redirect('/admin/categories?error=' + encodeURIComponent('名称不能为空'), 303);
	}
	const slug = text('slug') || name;
	const invalid = validateTermSlug(slug);
	if (invalid) {
		return c.redirect('/admin/categories?error=' + encodeURIComponent(invalid), 303);
	}
	if (await findCategoryBySlug(db, slug)) {
		return c.redirect('/admin/categories?error=' + encodeURIComponent(`缩略名 ${slug} 已被占用`), 303);
	}
	await createCategory(db, name, slug, text('description'));
	return c.redirect(
		'/admin/categories?message=' +
			encodeURIComponent(`分类「${name}」已创建；归档页在下次发布或全站重渲后出现`),
		303,
	);
});

/**
 * 保存分类。改 slug 是重操作：主分类是它的文章会整批换 URL（方案 A 保留旧地址），
 * 改名称/描述也会改到文章页 byline —— 两类影响都通过 needs_sync 交给补发对账收敛。
 */
adminRoutes.post('/admin/categories/:mid', async (c) => {
	const mid = Number(c.req.param('mid'));
	const db = createDb(c.env.DB, 'admin');
	const options = await getSiteOptions(c.env);
	const form = await c.req.formData();
	const text = (name: string) => String(form.get(name) ?? '').trim();

	const before = (await listTerms(db, 'category')).find((term) => term.mid === mid);
	if (!before) return c.notFound();

	const name = text('name');
	if (!name) {
		return c.redirect('/admin/categories?error=' + encodeURIComponent('名称不能为空'), 303);
	}
	const slug = text('slug') || name;
	const invalid = validateTermSlug(slug);
	if (invalid) {
		return c.redirect('/admin/categories?error=' + encodeURIComponent(invalid), 303);
	}
	if (slug !== before.slug && (await findCategoryBySlug(db, slug, mid))) {
		return c.redirect('/admin/categories?error=' + encodeURIComponent(`缩略名 ${slug} 已被占用`), 303);
	}

	const posts = await listPostsInCategory(db, mid);
	// 有对象产出的内容才需要补发（草稿发布时会整体重渲）
	const syncable = posts.filter((post) => post.status === 'publish' || post.status === 'hidden');
	// 主分类是它的文章：URL 里的分类段变了，记旧地址（方案 A）
	const moved: { cid: number; key: string }[] = [];
	if (slug !== before.slug) {
		for (const post of syncable) {
			if (post.categories[0]?.mid === mid) {
				moved.push({ cid: post.cid, key: postKey(before.slug, post.slug) });
			}
		}
	}

	await updateCategory(db, mid, name, slug, text('description'));
	await recordPermalinks(db, moved);
	await markNeedsSync(
		db,
		syncable.map((post) => post.cid),
	);
	if (slug !== before.slug) {
		await deleteObjects(c.env, oldCategoryArchiveKeys(before.slug, before.count, options.postsPerPage));
	}

	const urlNote = slug !== before.slug ? `${moved.length} 篇文章地址已变（旧地址保留 canonical），` : '';
	const message =
		`分类「${name}」已保存；${urlNote}${syncable.length} 篇引用它的文章已排入重建。` +
		'点文章列表的「全站重新渲染」一键刷全（或等 Cron）';
	return c.redirect('/admin/categories?message=' + encodeURIComponent(message), 303);
});

adminRoutes.post('/admin/categories/:mid/delete', async (c) => {
	const mid = Number(c.req.param('mid'));
	const db = createDb(c.env.DB, 'admin');
	const options = await getSiteOptions(c.env);

	const before = (await listTerms(db, 'category')).find((term) => term.mid === mid);
	if (!before) return c.notFound();

	const posts = await listPostsInCategory(db, mid);
	// 守住「文章必须有分类」的底线：只挂这一个分类的文章不能跟着陪葬
	const orphans = posts.filter((post) => post.categories.length === 1 && post.categories[0]?.mid === mid);
	if (orphans.length > 0) {
		return c.redirect(
			'/admin/categories?error=' +
				encodeURIComponent(`有 ${orphans.length} 篇文章只挂在「${before.name}」下，先把它们移到别的分类再删`),
			303,
		);
	}

	const syncable = posts.filter((post) => post.status === 'publish' || post.status === 'hidden');
	// 主分类是它的文章：删除后主分类顺延到下一个（mid 升序），URL 变，记旧地址
	const moved: { cid: number; key: string }[] = [];
	for (const post of syncable) {
		if (post.categories[0]?.mid === mid) {
			moved.push({ cid: post.cid, key: postKey(before.slug, post.slug) });
		}
	}

	await deleteCategory(db, mid);
	await recordPermalinks(db, moved);
	await markNeedsSync(
		db,
		syncable.map((post) => post.cid),
	);
	await deleteObjects(c.env, oldCategoryArchiveKeys(before.slug, before.count, options.postsPerPage));

	const message =
		`分类「${before.name}」已删除；${moved.length} 篇文章地址已变（旧地址保留 canonical），` +
		`${syncable.length} 篇引用它的文章已排入重建。点文章列表的「全站重新渲染」一键刷全`;
	return c.redirect('/admin/categories?message=' + encodeURIComponent(message), 303);
});

adminRoutes.get('/admin/posts/new', async (c) => {
	const db = createDb(c.env.DB, 'admin');
	const options = await getSiteOptions(c.env);
	const categories = await listTerms(db, 'category');

	return c.html(
		<PostEditorPage
			categories={categories}
			user={c.var.user}
			timezoneOffset={options.timezoneOffset}
			message={c.req.query('message')}
			error={c.req.query('error')}
		/>,
	);
});

adminRoutes.get('/admin/posts/:cid/edit', async (c) => {
	const cid = Number(c.req.param('cid'));
	const db = createDb(c.env.DB, 'admin');
	const options = await getSiteOptions(c.env);
	const [post, categories] = await Promise.all([getEditorView(db, cid), listTerms(db, 'category')]);
	if (!post) return c.notFound();

	return c.html(
		<PostEditorPage
			post={post}
			categories={categories}
			user={c.var.user}
			timezoneOffset={options.timezoneOffset}
			message={c.req.query('message')}
			error={c.req.query('error')}
		/>,
	);
});

adminRoutes.post('/admin/posts', async (c) => {
	const db = createDb(c.env.DB, 'admin');
	const options = await getSiteOptions(c.env);
	const payload = await parseEditorForm(c, options.timezoneOffset);

	if (!payload.input.title) {
		return c.redirect('/admin/posts/new?error=' + encodeURIComponent('标题不能为空'), 303);
	}

	try {
		// 文章必须有归属：没勾分类就回落到第一个分类（schema 里种子的「默认分类」）。
		// 否则 permalink 是 /<category>/<slug>.html，缺分类根本拼不出 URL（§4.3）
		const categoryIds = payload.categoryIds.length > 0 ? payload.categoryIds : [];
		if (payload.input.type === 'post' && categoryIds.length === 0) {
			const fallback = await listTerms(db, 'category');
			if (fallback.length === 0) {
				return c.redirect('/admin/posts/new?error=' + encodeURIComponent('没有任何分类，无法确定文章 URL'), 303);
			}
			categoryIds.push(fallback[0].mid);
		}

		const cid = await createContent(db, payload.input, c.var.user.uid);
		const tagIds = await ensureTags(db, payload.tagNames);
		await setContentTerms(db, cid, categoryIds, tagIds, [], []);
		const report = await publishPost(c.env, getExecutionContext(c), cid);
		return c.redirect(
			`/admin/posts/${cid}/edit?message=` + encodeURIComponent(messageForReport('创建', report)),
			303,
		);
	} catch (error) {
		const message = String(error).includes('UNIQUE')
			? '缩略名已被占用，换一个'
			: `创建失败：${String(error)}`;
		return c.redirect('/admin/posts/new?error=' + encodeURIComponent(message), 303);
	}
});

adminRoutes.post('/admin/posts/:cid', async (c) => {
	const cid = Number(c.req.param('cid'));
	const db = createDb(c.env.DB, 'admin');
	const options = await getSiteOptions(c.env);
	const payload = await parseEditorForm(c, options.timezoneOffset);

	if (!payload.input.title) {
		return c.redirect(`/admin/posts/${cid}/edit?error=` + encodeURIComponent('标题不能为空'), 303);
	}

	// 改 URL 之前先记下旧地址：§5.1 方案 A 靠它保留 200 + canonical
	const before = await getContentByCid(db, cid);

	try {
		await updateContentFields(db, cid, payload.input);
		const existingView = await getEditorView(db, cid);
		// 同新建：文章不能没有分类，空着就沿用原有的，仍为空则回落到第一个分类
		let categoryIds = payload.categoryIds.length > 0 ? payload.categoryIds : (existingView?.categoryIds ?? []);
		if (payload.input.type === 'post' && categoryIds.length === 0) {
			const fallback = await listTerms(db, 'category');
			if (fallback.length > 0) categoryIds = [fallback[0].mid];
		}
		const tagIds = await ensureTags(db, payload.tagNames);
		await setContentTerms(
			db,
			cid,
			categoryIds,
			tagIds,
			existingView?.categoryIds ?? [],
			[], // 标签用名字重建，旧的 mid 不必参与计数刷新（ensureTags 已覆盖）
		);

		const after = await getContentByCid(db, cid);
		if (
			before &&
			after &&
			before.type === 'post' &&
			after.type === 'post' &&
			hasUrl(before) &&
			hasUrl(after) &&
			postKeyOf(before) !== postKeyOf(after)
		) {
			await recordPermalink(db, cid, postKeyOf(before));
		}

		const report = await publishPost(c.env, getExecutionContext(c), cid);
		return c.redirect(
			`/admin/posts/${cid}/edit?message=` + encodeURIComponent(messageForReport('保存', report)),
			303,
		);
	} catch (error) {
		const message = String(error).includes('UNIQUE')
			? '缩略名已被占用，换一个'
			: `保存失败：${String(error)}`;
		return c.redirect(`/admin/posts/${cid}/edit?error=` + encodeURIComponent(message), 303);
	}
});

adminRoutes.post('/admin/posts/:cid/delete', async (c) => {
	const cid = Number(c.req.param('cid'));
	try {
		const report = await deletePost(c.env, getExecutionContext(c), cid);
		const message = `已删除：清理 ${report.deleted?.written.length ?? 0} 个对象，归档已重建`;
		return c.redirect('/admin?message=' + encodeURIComponent(message), 303);
	} catch (error) {
		return c.redirect('/admin?error=' + encodeURIComponent(`删除失败：${String(error)}`), 303);
	}
});

/**
 * §6.5「全站重新渲染」：**不在这里同步重建**（几百个对象会撞 CPU/墙钟）。
 * 这里只把所有内容标脏，由 Cron 每小时 20 篇地逐批重建。
 */
adminRoutes.post('/admin/rebuild', async (c) => {
	const db = createDb(c.env.DB, 'admin');
	const marked = await markAllDirty(db);
	const message = `已把 ${marked} 篇内容排入重建队列；Cron 每小时处理 20 篇（§6.5）`;
	return c.redirect('/admin?message=' + encodeURIComponent(message), 303);
});

/**
 * 分批重建（§6.5）：把「待同步」的内容**立刻**处理掉一批，而不是等每小时 Cron。
 *
 * 存在的意义：迁移（120 篇 + 全部分页/归档一次要写几百个对象）和改了模板之后的全站重渲，
 * 都不适合放在一次请求里 —— CPU 与墙钟会撞上限。于是拆成小批，由脚本循环调用：
 *
 *   while (needsSync > 0) POST /admin/rebuild/batch { limit: 20 }
 *
 * 返回 JSON，方便脚本判断进度。
 */
adminRoutes.post('/admin/rebuild/batch', async (c) => {
	const form = await c.req.formData().catch(() => null);
	const limit = Number.parseInt(String(form?.get('limit') ?? c.req.query('limit') ?? '20'), 10);
	const report = await reconcileNeedsSync(c.env, Number.isFinite(limit) && limit > 0 ? limit : 20);
	return c.json({
		rebuilt: report.rebuilt.length,
		objects: report.objects,
		failed: report.failed,
		needsSync: report.needsSync,
	});
});

/**
 * 全站重渲的**分批执行端**（§6.5）：一次写一批对象，脚本循环调用直到 `nextOffset` 为 null。
 *
 *   offset=0 & limit=50 → 写第 0~49 个对象，返回 nextOffset=50
 *
 * 与 `/admin/rebuild`（标脏交给 Cron）的区别：这条路径覆盖**全部对象**，
 * 包括那些只挂在草稿上的标签归档 —— 改了模板必须用它才能真正刷全。
 */
adminRoutes.post('/admin/rebuild/full', async (c) => {
	const form = await c.req.formData().catch(() => null);
	const offset = Number.parseInt(String(form?.get('offset') ?? c.req.query('offset') ?? '0'), 10);
	const limit = Number.parseInt(String(form?.get('limit') ?? c.req.query('limit') ?? '50'), 10);
	// 可选 group：只渲染某一组对象（渲染维护页的独立按钮）；缺省 = 全站
	const group = String(form?.get('group') ?? c.req.query('group') ?? '');
	let groups: Set<string> | undefined;
	if (group) {
		if (!TARGET_GROUPS.includes(group as TargetGroup)) {
			return c.json({ error: `未知分组：${group}` }, 400);
		}
		groups = new Set([group]);
	}
	const report = await rebuildTargetsSlice(
		c.env,
		Number.isFinite(offset) && offset > 0 ? offset : 0,
		Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
		groups,
	);
	return c.json(report);
});
