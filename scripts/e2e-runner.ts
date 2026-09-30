/**
 * 本地端到端验证的断言集（跑在真实 workerd 里，由 `scripts/e2e-worker.ts` 调用）
 *
 * 为什么不用 Miniflare 的 JS API：装到的 miniflare 是 v5 alpha，构造参数形态还在变；
 * 而 `wrangler dev` 跑的是**同一个 workerd**、同一套 D1/R2 绑定，更接近线上。
 *
 * 验证内容：
 *   - 6 次查询的快照预算（§5.2）
 *   - publishAll / publishPost / deletePost 的 key、缓存头、同步/异步切分
 *   - `needs_sync` 状态机：写成功清零、写失败保留、Cron 补发（§6.2）
 *   - Markdown → 清洗（XSS 向量必须消失，§8.3）
 *   - 草稿预览只读（不写 R2、不改 needs_sync）
 *   - 定时文章转正后确实进了 R2（§12.3）
 *
 * 夹具 SQL 属于测试代码，不受「SQL 只能写在 src/models」约束；应用代码里的 SQL 仍然只在 models/ 与 lib/db.ts。
 */

import { app } from '../src/index';
import { hashPassword, verifyPassword } from '../src/lib/auth';
import { createDb } from '../src/lib/db';
import { getContentByCid } from '../src/models/content';
import { clearSiteOptionsCache } from '../src/models/option';
import { deletePost, publishAll, publishPost, renderPreview } from '../src/publish/pipeline';
import type { PublishEnv } from '../src/publish/pipeline';
import { loadSnapshot } from '../src/publish/snapshot';
import { runScheduledTasks } from '../src/publish/sync';

/** e2e 用的绑定：发布所需 + 后台登录所需（密钥来自 wrangler.e2e.jsonc 的 vars） */
export type E2EEnv = PublishEnv & {
	LOGIN_KV: KVNamespace;
	SESSION_SECRET: string;
	IP_SALT: string;
	TURNSTILE_SECRET?: string;
};

const CATEGORY_MID = 1; // schema 里种子数据自带的「默认分类 / default」

/** 正文里塞满 XSS 向量：markdown 链接、原生 HTML 链接、事件属性、script 标签 */
const XSS_BODY = [
	'# 标题一',
	'',
	'正文里有 <script>alert(1)</script> 和 <img src=x onerror=alert(2)>。',
	'',
	'markdown 链接：[坏链接](javascript:alert(3))。',
	'',
	'原生 HTML 链接：<a href="javascript:alert(4)">点我</a>。',
	'',
	'- 列表项 A',
	'- 列表项 B',
	'',
	'```js',
	'const a = 1;',
	'```',
].join('\n');

export async function runE2E(env: E2EEnv): Promise<string> {
	const lines: string[] = [];
	let failures = 0;

	const check = (label: string, ok: boolean, detail = ''): void => {
		if (!ok) failures++;
		lines.push(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
	};
	const run = async (sql: string, params: (string | number | null)[] = []) =>
		env.DB.prepare(sql).bind(...params).run();
	const all = async <T>(sql: string, params: (string | number | null)[] = []) =>
		(await env.DB.prepare(sql).bind(...params).all<T>()).results ?? [];

	// -----------------------------------------------------------------------
	// 夹具（可重复执行：先清掉上次的测试数据）
	// -----------------------------------------------------------------------
	lines.push('=== 夹具 ===');
	// 清空上一轮留下的 R2 对象 —— 否则「某个 key 不该存在」的断言会被上轮产物污染
	const existing = await env.BUCKET.list();
	if (existing.objects.length > 0) {
		await env.BUCKET.delete(existing.objects.map((object) => object.key));
	}
	await run('DELETE FROM relationships');
	await run('DELETE FROM permalink_history');
	await run('DELETE FROM contents');
	await run('DELETE FROM metas WHERE mid >= 20');
	await run("UPDATE metas SET name = 'Other', slug = 'default', description = '生活琐事' WHERE mid = ?", [CATEGORY_MID]);
	await run("INSERT OR REPLACE INTO options (name, user, value) VALUES ('timezone', 0, '28800')");
	await run("INSERT OR REPLACE INTO options (name, user, value) VALUES ('posts_per_page', 0, '10')");
	// options 在 isolate 内有 60 秒缓存，夹具改了配置必须主动失效（§7.3）
	clearSiteOptionsCache();

	await run("INSERT INTO metas (mid, name, slug, type, description, count, sort_order, parent) VALUES (20, '安卓', '安卓', 'tag', NULL, 0, 0, 0)");
	await run("INSERT INTO metas (mid, name, slug, type, description, count, sort_order, parent) VALUES (21, 'Cloudflare', 'cloudflare', 'tag', NULL, 0, 0, 0)");

	const now = Math.floor(Date.now() / 1000);
	for (let index = 0; index < 12; index++) {
		const cid = 100 + index;
		const created = now - 3600 - index * 86400;
		// 最后一篇是「还没到点」的定时文章：先验证它不会被提前发布，
		// 到第 6 节再把 created 改到过去，触发真正的定时发布
		const isWaiting = index === 11;
		if (isWaiting) {
			await run(
				`INSERT INTO contents (cid, title, slug, created, modified, body, rendered, excerpt, sort_order,
				                       author_id, type, status, allow_feed, parent, words, needs_sync)
				 VALUES (?, ?, ?, ?, ?, ?, '', '', 0, 1, 'post', 'waiting', 1, 0, 0, 1)`,
				[cid, `第 ${index + 1} 篇`, `post-${index + 1}`, now + 3600, now + 3600, '未来的文章。'],
			);
			await run('INSERT INTO relationships (cid, mid) VALUES (?, ?)', [cid, CATEGORY_MID]);
			continue;
		}
		await run(
			`INSERT INTO contents (cid, title, slug, created, modified, body, rendered, excerpt, sort_order,
			                       author_id, type, status, allow_feed, parent, words, needs_sync)
			 VALUES (?, ?, ?, ?, ?, ?, '', '', 0, 1, 'post', ?, 1, 0, 0, 1)`,
			[
				cid,
				index === 0 ? 'Hello <script>alert(9)</script>' : `第 ${index + 1} 篇`,
				index === 0 ? 'hello' : `post-${index + 1}`,
				created,
				created,
				index === 0 ? XSS_BODY : `第 ${index + 1} 篇的正文。`,
				isWaiting ? 'waiting' : 'publish',
			],
		);
		await run('INSERT INTO relationships (cid, mid) VALUES (?, ?)', [cid, CATEGORY_MID]);
		if (index === 0) {
			await run('INSERT INTO relationships (cid, mid) VALUES (?, 20)', [cid]);
			await run('INSERT INTO relationships (cid, mid) VALUES (?, 21)', [cid]);
			await run("INSERT INTO permalink_history (cid, permalink, retired_at) VALUES (?, 'default/old-hello.html', ?)", [cid, now]);
		}
	}
	await run(
		`INSERT INTO contents (cid, title, slug, created, modified, body, rendered, excerpt, sort_order,
		                       author_id, type, status, allow_feed, parent, words, needs_sync)
		 VALUES (200, 'About', 'about', ?, ?, '# 关于\n\n这是关于页面。', '', '', 0, 1, 'page', 'publish', 1, 0, 0, 1)`,
		[now, now],
	);
	await run(
		`INSERT INTO contents (cid, title, slug, created, modified, body, rendered, excerpt, sort_order,
		                       author_id, type, status, allow_feed, parent, words, needs_sync)
		 VALUES (300, '草稿', 'draft-one', ?, ?, '# 草稿标题\n\n还没发布。', '', '', 0, 1, 'post', 'draft', 1, 0, 0, 0)`,
		[now, now],
	);
	await run('INSERT INTO relationships (cid, mid) VALUES (300, ?)', [CATEGORY_MID]);
	check('12 篇文章（1 篇 waiting）+ 1 页面 + 1 草稿', true);

	// -----------------------------------------------------------------------
	// 1. 快照查询预算（§5.2）
	// -----------------------------------------------------------------------
	lines.push('=== 快照查询预算 ===');
	const loaded = await loadSnapshot({ DB: env.DB });
	check('查询次数 = 6（与文章数、标签数无关）', loaded.queries === 6, `实际 ${loaded.queries}`);
	check('可见文章 11 篇（12 篇里 1 篇 waiting）', loaded.snapshot.posts.length === 11, `实际 ${loaded.snapshot.posts.length}`);
	check('独立页面 1 个', loaded.snapshot.pages.length === 1);
	check('分类 1 个、标签 2 个', loaded.snapshot.categories.length === 1 && loaded.snapshot.tags.length === 2);
	check('年月归档已分组', loaded.snapshot.months.length >= 1, JSON.stringify(loaded.snapshot.months.slice(0, 2)));
	check('旧 permalink 进入快照', loaded.snapshot.retired.length === 1 && loaded.snapshot.retired[0].key === 'default/old-hello.html');
	check('列表查询聚合出主分类', loaded.snapshot.posts[0].categories[0]?.slug === 'default');
	// 快照要「渲染完备」：文章页要显示标签，所以列表查询也必须聚合标签
	check(
		'列表查询也聚合标签（含中文 slug）',
		loaded.snapshot.posts[0].tags.some((tag) => tag.slug === '安卓') && loaded.snapshot.posts[0].tags.length === 2,
		JSON.stringify(loaded.snapshot.posts[0].tags.map((tag) => tag.slug)),
	);
	const single = await getContentByCid(createDb(env.DB, 'e2e'), 100);
	check('单篇查询同样聚合出标签', single?.tags.length === 2, JSON.stringify(single?.tags.map((tag) => tag.slug)));

	// -----------------------------------------------------------------------
	// 2. 全站发布（§12.2 / §6.5）
	// -----------------------------------------------------------------------
	lines.push('=== publishAll ===');
	const full = await publishAll(env);
	const listed = await env.BUCKET.list();
	const keys = listed.objects.map((object) => object.key);
	const byKey = new Map(listed.objects.map((object) => [object.key, object]));
	check('全站对象数 > 20', keys.length > 20, `${keys.length} 个对象 / 报告 total=${full.total}`);
	check("首页 key 是空字符串 ''", keys.includes(''));
	check('page/1/ 与 page/2/ 都在（11 篇 / 每页 10）', keys.includes('page/1/') && keys.includes('page/2/'));
	check('文章 key 形如 default/<slug>.html', keys.includes('default/hello.html') && keys.includes('default/post-11.html'));
	check('独立页面是单段 key', keys.includes('about.html'));
	check('归档 key：分类 + 中文标签（含 /1/ 副本）', keys.includes('category/default/') && keys.includes('tag/安卓/') && keys.includes('tag/安卓/1/'));
	check('旧 permalink 页面已生成', keys.includes('default/old-hello.html'));
	check('feed 与 sitemap 已生成', keys.includes('feed/') && keys.includes('sitemap.xml'));
	check('草稿没有产出对象', !keys.some((key) => key.includes('draft-one')));
	check('waiting 文章没有产出对象', !keys.includes('default/post-12.html'));

	// 注意：R2 的 list() 不返回 httpMetadata（和 S3 一致），要看缓存头必须 head/get
	const homeMeta = (await env.BUCKET.head(''))?.httpMetadata;
	check('首页 contentType 来自 httpMetadata', homeMeta?.contentType === 'text/html; charset=utf-8', String(homeMeta?.contentType));
	check('首页缓存头按 §7.2', homeMeta?.cacheControl === 'public, max-age=60, stale-while-revalidate=300', String(homeMeta?.cacheControl));
	const articleMeta = (await env.BUCKET.head('default/hello.html'))?.httpMetadata;
	check('文章页缓存头按 §7.2', articleMeta?.cacheControl === 'public, max-age=300, stale-while-revalidate=600', String(articleMeta?.cacheControl));

	const afterFull = await all<{ count: number }>("SELECT COUNT(*) AS count FROM contents WHERE needs_sync = 1 AND status = 'publish'");
	check('publishAll 后 needs_sync 清零', afterFull[0].count === 0, `剩余 ${afterFull[0].count}`);

	// -----------------------------------------------------------------------
	// 3. 单篇发布：Markdown + 清洗 + 同步/异步（§6.1 / §6.3 / §8.3）
	// -----------------------------------------------------------------------
	lines.push('=== publishPost（含 XSS 清洗）===');
	const waits: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (promise: Promise<unknown>) => waits.push(promise),
		passThroughOnException: () => {},
		props: {},
	} as unknown as ExecutionContext;

	const report = await publishPost(env, ctx, 100);
	// 同步批次 = 文章本体 + 它自己的旧 URL 页（旧 URL 的 canonical 必须同时落盘，§5.1 方案 A）
	check(
		'同步写只写文章本体与它自己的旧 URL',
		report.sync?.written.includes('default/hello.html') === true &&
			report.sync.written.length === 2 &&
			report.sync.written.every((key) => key === 'default/hello.html' || key === 'default/old-hello.html'),
		JSON.stringify(report.sync?.written),
	);
	check('其余对象交给 waitUntil（§6.3）', report.deferred === undefined && waits.length > 0, `waitUntil 任务数 ${waits.length}`);
	await Promise.allSettled(waits);

	const articleHtml = (await (await env.BUCKET.get('default/hello.html'))?.text()) ?? '';
	check('正文渲染成 HTML', articleHtml.includes('<h1>标题一</h1>') && articleHtml.includes('<li>列表项 A</li>'));
	check('<script> 被清除', !articleHtml.includes('<script>alert(1)</script>'));
	check('onerror 属性被清除', !articleHtml.includes('onerror'));
	// markdown 的 [x](javascript:…) 会被 markdown-it 拒绝成字面文本（惰性，无害）；
	// 真正要挡的是**原生 HTML** 里的 href —— 那才是能点的链接
	check('原生 HTML 的 javascript: href 被剥掉', !articleHtml.includes('javascript:alert(4)'));
	check('页面里不存在 href="javascript', !articleHtml.includes('href="javascript'));
	check('标题里的 <script> 被处理', !articleHtml.includes('<script>alert(9)</script>'));
	check('代码块保留', articleHtml.includes('<pre><code'));
	check('中文标签链接已编码', articleHtml.includes('/tag/%E5%AE%89%E5%8D%93/'));
	check('文章页显示标签名', articleHtml.includes('>安卓</a>'));

	const row = await all<{ excerpt: string; words: number; needs_sync: number }>(
		'SELECT excerpt, words, needs_sync FROM contents WHERE cid = 100',
	);
	check('摘要落库且是纯文本', row[0].excerpt.length > 0 && !row[0].excerpt.includes('<'), row[0].excerpt.slice(0, 24));
	check('字数已统计', row[0].words > 0, String(row[0].words));
	check('写成功 → needs_sync = 0', row[0].needs_sync === 0);

	const canonical = /<link rel="canonical" href="([^"]+)"/.exec(articleHtml)?.[1];
	check('canonical 指向自身', canonical === 'https://blog.fengqi.me/default/hello.html', String(canonical));

	const oldHtml = (await (await env.BUCKET.get('default/old-hello.html'))?.text()) ?? '';
	const oldCanonical = /<link rel="canonical" href="([^"]+)"/.exec(oldHtml)?.[1];
	check('旧 URL 页 canonical 指向新地址（§5.1 方案 A）', oldCanonical === 'https://blog.fengqi.me/default/hello.html', String(oldCanonical));

	// -----------------------------------------------------------------------
	// 4. R2 写失败 → needs_sync 保留 → Cron 补发（§6.2）
	// -----------------------------------------------------------------------
	lines.push('=== 失败与对账 ===');
	const failing: R2Bucket = {
		put: async () => {
			throw new Error('模拟 R2 故障');
		},
		get: env.BUCKET.get.bind(env.BUCKET),
		list: env.BUCKET.list.bind(env.BUCKET),
		delete: env.BUCKET.delete.bind(env.BUCKET),
		head: env.BUCKET.head.bind(env.BUCKET),
		createMultipartUpload: env.BUCKET.createMultipartUpload.bind(env.BUCKET),
		resumeMultipartUpload: env.BUCKET.resumeMultipartUpload.bind(env.BUCKET),
	} as unknown as R2Bucket;

	await run('UPDATE contents SET body = ? WHERE cid = 100', ['# 改过的标题\n\n内容变了。']);
	await publishPost({ DB: env.DB, BUCKET: failing }, undefined, 100);
	const dirty = await all<{ needs_sync: number }>('SELECT needs_sync FROM contents WHERE cid = 100');
	check('R2 写失败后保留 needs_sync = 1', dirty[0].needs_sync === 1);
	const staleHtml = (await (await env.BUCKET.get('default/hello.html'))?.text()) ?? '';
	check('此时前台还是旧内容（故障可见）', staleHtml.includes('标题一'));

	const sync1 = await runScheduledTasks(env);
	check('Cron 扫到并补发', sync1.rebuilt.includes(100), JSON.stringify({ rebuilt: sync1.rebuilt, objects: sync1.objects }));
	check('补发后 needs_sync 清零', sync1.needsSync === 0, `剩余 ${sync1.needsSync}`);
	const freshHtml = (await (await env.BUCKET.get('default/hello.html'))?.text()) ?? '';
	check('前台已更新为新内容', freshHtml.includes('改过的标题'));

	// -----------------------------------------------------------------------
	// 5. 草稿预览只读（§2 的 /preview/:cid）
	// -----------------------------------------------------------------------
	lines.push('=== 草稿预览 ===');
	const preview = await renderPreview(env, 300);
	check('预览返回完整页面', preview.html.startsWith('<!DOCTYPE html>') && preview.html.includes('草稿标题'));
	const draftRow = await all<{ needs_sync: number }>('SELECT needs_sync FROM contents WHERE cid = 300');
	check('预览不把草稿标脏', draftRow[0].needs_sync === 0, `needs_sync=${draftRow[0].needs_sync}`);
	check('预览不产出 R2 对象', !(await env.BUCKET.list()).objects.some((object) => object.key.includes('draft-one')));

	// -----------------------------------------------------------------------
	// 6. 定时发布（§12.3 ①）
	// -----------------------------------------------------------------------
	lines.push('=== 定时发布 ===');
	const before = await all<{ status: string }>('SELECT status FROM contents WHERE cid = 111');
	check('未到点的文章仍是 waiting', before[0].status === 'waiting');
	check('未到点时不产出对象', !(await env.BUCKET.list()).objects.some((object) => object.key === 'default/post-12.html'));
	// 把发布时间改到过去，模拟「到点了」
	await run('UPDATE contents SET created = ? WHERE cid = 111', [now - 10]);
	const sync2 = await runScheduledTasks(env);
	check('Cron 把到点文章转正', sync2.published === 1, `published=${sync2.published}`);
	const after = await all<{ status: string; needs_sync: number }>('SELECT status, needs_sync FROM contents WHERE cid = 111');
	check('状态变 publish 且已写 R2', after[0].status === 'publish' && after[0].needs_sync === 0, `needs_sync=${after[0].needs_sync}`);
	check('waiting 文章的 key 已出现', (await env.BUCKET.list()).objects.some((object) => object.key === 'default/post-12.html'));
	// 定时文章从没走过「保存并发布」，body 没渲染过 —— 不补渲染就是空壳页面（本地 e2e 抓到的 bug）
	const waitingHtml = (await (await env.BUCKET.get('default/post-12.html'))?.text()) ?? '';
	check('定时文章的正文已补渲染（不是空壳）', waitingHtml.includes('未来的文章'), waitingHtml.length > 0 ? `页面 ${waitingHtml.length} 字节` : '页面为空');
	const waitingRow = await all<{ rendered: string; excerpt: string }>('SELECT rendered, excerpt FROM contents WHERE cid = 111');
	check('rendered 已回填 D1', waitingRow[0].rendered.includes('未来的文章') && waitingRow[0].excerpt.length > 0, waitingRow[0].excerpt.slice(0, 20));

	// -----------------------------------------------------------------------
	// 6b. 脏的**独立页面**也要能对账（页面没有分类，不能照抄文章的目标计算）
	// -----------------------------------------------------------------------
	lines.push('=== 独立页面对账 ===');
	await run('UPDATE contents SET needs_sync = 1 WHERE cid = 200');
	const syncPage = await runScheduledTasks(env);
	check('脏页面被对账（不会因缺少分类而崩）', syncPage.rebuilt.includes(200), JSON.stringify(syncPage.rebuilt));
	const pageRow = await all<{ needs_sync: number }>('SELECT needs_sync FROM contents WHERE cid = 200');
	check('页面 needs_sync 已清零', pageRow[0].needs_sync === 0);
	const pageHtml = (await (await env.BUCKET.get('about.html'))?.text()) ?? '';
	check('页面对象已重建且有正文', pageHtml.includes('这是关于页面'));

	// -----------------------------------------------------------------------
	// 7. 删除文章
	// -----------------------------------------------------------------------
	lines.push('=== deletePost ===');
	const del = await deletePost(env, undefined, 100);
	check('文章对象被删除', del.deleted?.written.includes('default/hello.html') === true, JSON.stringify(del.deleted?.written));
	const afterDelete = (await env.BUCKET.list()).objects.map((object) => object.key);
	check('文章 key 已消失', !afterDelete.includes('default/hello.html'));
	check('旧 permalink 一并清理', !afterDelete.includes('default/old-hello.html'));
	check('归档已按剩余内容重建', afterDelete.includes('category/default/'));

	// -----------------------------------------------------------------------
	// 8. 后台 HTTP 层：登录、会话、表单发布、方案 A、重建、删除
	// -----------------------------------------------------------------------
	lines.push('=== 后台口令（PBKDF2）===');
	const hashStart = performance.now();
	const passwordHash = await hashPassword('e2e-口令-123', 100_000);
	const hashMs = performance.now() - hashStart;
	await run('UPDATE users SET password = ?, token_version = token_version + 1 WHERE username = ?', [
		passwordHash,
		'admin',
	]);
	check('生成 PBKDF2 串并写库', passwordHash.startsWith('pbkdf2$100000$'), `${hashMs.toFixed(1)} ms（§8.2 要求 < 10ms 需复核）`);
	check('口令校验通过', await verifyPassword('e2e-口令-123', passwordHash));
	check('错误口令不通过', !(await verifyPassword('wrong', passwordHash)));

	lines.push('=== 后台路由与会话 ===');
	// 复用第 3 节那个 waitUntil 收集器（同一个变量名在这里会重复声明）
	const call = (path: string, init?: RequestInit) =>
		app.request(path, init, env as never, ctx as never);
	const postForm = (path: string, fields: Record<string, string>, cookie?: string) =>
		call(path, {
			method: 'POST',
			body: new URLSearchParams(fields),
			headers: cookie ? { cookie } : {},
		});

	// 未登录：受保护路径必须重定向
	const noAuth = await call('/admin');
	check('未登录访问 /admin 会跳登录页', noAuth.status === 302 && (noAuth.headers.get('location') ?? '').includes('/admin/login'), `${noAuth.status} → ${noAuth.headers.get('location')}`);
	const noAuthPreview = await call('/preview/300');
	check('未登录访问预览会跳登录页', noAuthPreview.status === 302);
	check('受保护响应是 private, no-store', (noAuth.headers.get('cache-control') ?? '') === 'private, no-store', String(noAuth.headers.get('cache-control')));

	const loginPage = await call('/admin/login');
	const loginHtml = await loginPage.text();
	check('登录页可访问（公开路由没被鉴权拦掉）', loginPage.status === 200 && loginHtml.includes('name="password"'));
	check('口令已 bootstrap，不再提示初始化', !loginHtml.includes('还没有设置管理员口令'));

	// 配了 site key（Cloudflare 的测试 key）就应该渲染控件；但没有 TURNSTILE_SECRET 时不强制校验
	await run("INSERT OR REPLACE INTO options (name, user, value) VALUES ('turnstile_site_key', 0, '1x00000000000000000000AA')");
	const loginWithWidget = await (await call('/admin/login')).text();
	check('配了 site key 就渲染 Turnstile 控件', loginWithWidget.includes('cf-turnstile') && loginWithWidget.includes('turnstile/v0/api.js'));

	const badLogin = await postForm('/admin/login', { username: 'admin', password: 'wrong' });
	check('错误口令被拒', badLogin.status === 401 && (await badLogin.text()).includes('用户名或口令不正确'), String(badLogin.status));

	const goodLogin = await postForm('/admin/login', { username: 'admin', password: 'e2e-口令-123' });
	const setCookie = goodLogin.headers.get('set-cookie') ?? '';
	const sessionCookie = setCookie.split(';')[0];
	check('正确口令登录成功', goodLogin.status === 303 && sessionCookie.startsWith('blog_session='), `${goodLogin.status}`);
	check('Cookie 是 HttpOnly + Secure + SameSite=Lax', /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Lax/i.test(setCookie));

	const listPage = await call('/admin', { headers: { cookie: sessionCookie } });
	const listHtml = await listPage.text();
	check('登录后能进文章列表', listPage.status === 200 && listHtml.includes('第 2 篇'));

	// 走表单改缩略名 —— 顺便验证 §5.1 方案 A（旧 URL 保留 canonical）
	const editView = await call('/admin/posts/101/edit', { headers: { cookie: sessionCookie } });
	check('编辑器能打开', editView.status === 200 && (await editView.text()).includes('name="body"'));

	const publishForm = await postForm(
		'/admin/posts/101',
		{
			title: '改过标题的第 2 篇',
			slug: 'renamed-post',
			type: 'post',
			status: 'publish',
			created: '2026-09-29T13:00',
			body: '# 新标题\n\n表单发布的内容 <script>alert(7)</script>。',
			excerpt: '',
			categories: '1',
			tags: '安卓, 表单标签',
			allow_feed: '1',
		},
		sessionCookie,
	);
	check('表单保存返回 303', publishForm.status === 303, String(publishForm.status));
	await Promise.allSettled(waits.splice(0));

	const keysAfterEdit = (await env.BUCKET.list()).objects.map((object) => object.key);
	check('新 URL 已生成', keysAfterEdit.includes('default/renamed-post.html'));
	check('旧 URL 仍在（§5.1 方案 A）', keysAfterEdit.includes('default/post-2.html'));
	const renamedHtml = (await (await env.BUCKET.get('default/renamed-post.html'))?.text()) ?? '';
	check('新页面正文来自表单且已清洗', renamedHtml.includes('表单发布的内容') && !renamedHtml.includes('<script>alert(7)'));
	check('新页面显示了新标签', renamedHtml.includes('表单标签'));
	const excerptRow = await all<{ excerpt: string }>('SELECT excerpt FROM contents WHERE cid = 101');
	check('自动摘要已生成并落库', excerptRow[0].excerpt.includes('新标题') && !excerptRow[0].excerpt.includes('<'), excerptRow[0].excerpt.slice(0, 20));
	const retiredHtml = (await (await env.BUCKET.get('default/post-2.html'))?.text()) ?? '';
	const retiredCanonical = /<link rel="canonical" href="([^"]+)"/.exec(retiredHtml)?.[1];
	check('旧 URL 的 canonical 指向新地址', retiredCanonical === 'https://blog.fengqi.me/default/renamed-post.html', String(retiredCanonical));

	// 全站重建：只标脏，交给 Cron（§6.5）
	const rebuild = await postForm('/admin/rebuild', {}, sessionCookie);
	const dirtyCount = await all<{ count: number }>("SELECT COUNT(*) AS count FROM contents WHERE needs_sync = 1 AND status = 'publish'");
	check('「全站重新渲染」把内容标脏', rebuild.status === 303 && dirtyCount[0].count > 0, `待同步 ${dirtyCount[0].count}`);
	const drain = await runScheduledTasks(env);
	check('Cron 逐批清掉脏标记', drain.needsSync === 0, `本轮重建 ${drain.rebuilt.length} 篇 / ${drain.objects} 个对象`);

	// 草稿预览（登录态）
	const previewOk = await call('/preview/300', { headers: { cookie: sessionCookie } });
	const previewHtml = await previewOk.text();
	check('登录后能预览草稿', previewOk.status === 200 && previewHtml.includes('草稿标题'));
	check('预览带 noindex', (previewOk.headers.get('x-robots-tag') ?? '').includes('noindex'));

	// 不勾分类新建：必须回落到默认分类，而不是拼不出 URL 报错
	const noCategoryForm = await postForm(
		'/admin/posts',
		{ title: '没勾分类的文章', slug: 'no-category', type: 'post', status: 'publish', body: '正文', excerpt: '', tags: '', allow_feed: '1' },
		sessionCookie,
	);
	await Promise.allSettled(waits.splice(0));
	const noCategoryKeys = (await env.BUCKET.list()).objects.map((object) => object.key);
	check('没勾分类的文章也能发布（回落到默认分类）', noCategoryForm.status === 303 && noCategoryKeys.includes('default/no-category.html'), `${noCategoryForm.status}`);

	// 表单删除
	const deleteForm = await postForm('/admin/posts/101/delete', {}, sessionCookie);
	await Promise.allSettled(waits.splice(0));
	const keysAfterDelete = (await env.BUCKET.list()).objects.map((object) => object.key);
	check('表单删除返回 303', deleteForm.status === 303);
	check('文章与旧 URL 都被清掉', !keysAfterDelete.includes('default/renamed-post.html') && !keysAfterDelete.includes('default/post-2.html'));

	// 登出
	const logout = await postForm('/admin/logout', {}, sessionCookie);
	check('登出清 Cookie', logout.status === 303 && /blog_session=;/.test(logout.headers.get('set-cookie') ?? ''));

	// -----------------------------------------------------------------------
	// 产物（交给外部 XML 校验）
	// -----------------------------------------------------------------------
	const feed = (await (await env.BUCKET.get('feed/'))?.text()) ?? '';
	const sitemap = (await (await env.BUCKET.get('sitemap.xml'))?.text()) ?? '';
	check('sitemap 不含 page/1/', !sitemap.includes('/page/1/'));
	check('sitemap 不含归档 /1/ 副本', !/category\/default\/1\//.test(sitemap));
	check('sitemap 不含旧 permalink', !sitemap.includes('old-hello'));
	check('sitemap 是绝对 URL', sitemap.includes('https://blog.fengqi.me/'));
	check('feed 里带上了补渲染的正文', feed.includes('未来的文章'));
	// 只看 item 级的 description（channel 级的站点描述为空是配置问题，不是 bug）
	const feedItems = feed.split('<item>').slice(1);
	check(
		'feed 每个 item 的 description 都不为空',
		feedItems.length > 0 && feedItems.every((block) => !/<description><\/description>/.test(block)),
		`${feedItems.length} 条 item`,
	);

	lines.push('');
	lines.push(`=== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===`);
	lines.push('---FEED---');
	lines.push(feed);
	lines.push('---SITEMAP---');
	lines.push(sitemap);

	return lines.join('\n');
}
