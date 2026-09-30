/**
 * 后台页面与操作 —— 设计文档 §6.1（保存即发布）/ §6.5 / §11
 *
 * 这一层只做三件事：解析表单、调用 models 写 D1、调用发布流水线写 R2。
 * **不拼 HTML**（那是 `views/` 与 `theme/` 的事），**不写 SQL**（那是 `models/` 的事）。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createDb } from '../lib/db';
import { parseDateTimeLocal } from '../lib/time';
import {
	countNeedsSync,
	createContent,
	getContentByCid,
	getEditorView,
	type ContentInput,
	listAdminPosts,
	markAllDirty,
	recordPermalink,
	setContentTerms,
	updateContentFields,
} from '../models/content';
import { ensureTags, listTerms } from '../models/meta';
import { getSiteOptions } from '../models/option';
import { deletePost, publishPost, rebuildTargetsSlice } from '../publish/pipeline';
import { reconcileNeedsSync } from '../publish/sync';
import { hasUrl, postKeyOf } from '../publish/targets';
import { PostEditorPage } from '../views/post-editor';
import { PostListPage } from '../views/post-list';
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
		// 独立页面是单段 URL，没有分类
		categoryIds: type === 'page' ? [] : form.getAll('categories').map(Number).filter(Number.isFinite),
		tagNames: text('tags')
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
	const [posts, needsSync] = await Promise.all([listAdminPosts(db), countNeedsSync(db)]);

	return c.html(
		<PostListPage
			posts={posts}
			needsSync={needsSync}
			user={c.var.user}
			siteTimezoneOffset={options.timezoneOffset}
			message={c.req.query('message')}
			error={c.req.query('error')}
		/>,
	);
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
	const report = await rebuildTargetsSlice(
		c.env,
		Number.isFinite(offset) && offset > 0 ? offset : 0,
		Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
	);
	return c.json(report);
});
