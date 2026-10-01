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
 *   - 主题资源指纹：对象进 R2、`immutable` 缓存头、页面注入 `<link>`（§7.2）
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
import { postDeleteTargets, postPublishTargets, siteTargets } from '../src/publish/targets';
import { THEME_ASSETS, themeAsset, themeAssetPath } from '../theme/assets';

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
	'## 二级标题',
	'',
	'二级标题下的正文。',
	'',
	'### 三级标题',
	'',
	'三级标题下的正文。',
	'',
	'## 二级标题',
	'',
	'重复的标题，用来验证锚点 id 会去重。',
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
	// 只保留 schema 种子里的默认分类（mid=1），其余分类/标签全部清掉，保证夹具可重复
	await run('DELETE FROM metas WHERE mid <> 1');
	await run("UPDATE metas SET name = 'Other', slug = 'default', description = '生活琐事' WHERE mid = ?", [CATEGORY_MID]);
	await run("INSERT OR REPLACE INTO options (name, user, value) VALUES ('timezone', 0, '28800')");
	await run("INSERT OR REPLACE INTO options (name, user, value) VALUES ('posts_per_page', 0, '10')");
	// options 在 isolate 内有 60 秒缓存，夹具改了配置必须主动失效（§7.3）
	clearSiteOptionsCache();

	await run("INSERT OR REPLACE INTO metas (mid, name, slug, type, description, count, sort_order, parent) VALUES (20, '安卓', '安卓', 'tag', NULL, 0, 0, 0)");
	await run("INSERT OR REPLACE INTO metas (mid, name, slug, type, description, count, sort_order, parent) VALUES (21, 'Cloudflare', 'cloudflare', 'tag', NULL, 0, 0, 0)");

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

	// 隐藏文章：Typecho 的 hidden 语义 —— 有 URL、可访问，但不进列表/Feed/sitemap
	await run(
		`INSERT INTO contents (cid, title, slug, created, modified, body, rendered, excerpt, sort_order,
		                       author_id, type, status, allow_feed, parent, words, needs_sync)
		 VALUES (112, '隐藏文章标题', 'hidden-one', ?, ?, '# 隐藏正文\n\n不进列表。', '', '', 0, 1, 'post', 'hidden', 1, 0, 0, 1)`,
		[now - 90000, now - 90000],
	);
	await run('INSERT INTO relationships (cid, mid) VALUES (112, ?)', [CATEGORY_MID]);

	check('12 篇文章（1 篇 waiting）+ 1 hidden + 1 页面 + 1 草稿', true);

	// -----------------------------------------------------------------------
	// 1. 快照查询预算（§5.2）
	// -----------------------------------------------------------------------
	lines.push('=== 快照查询预算 ===');
	const loaded = await loadSnapshot({ DB: env.DB });
	check('查询次数 = 7（与文章数、标签数无关）', loaded.queries === 7, `实际 ${loaded.queries}`);
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
	// 1b. 主题资源在全站清单里的位置（§7.2）
	// -----------------------------------------------------------------------
	const themeTargets = siteTargets(loaded.snapshot);
	const headKinds = themeTargets.slice(0, THEME_ASSETS.length).map((target) => target.kind);
	check(
		'主题资源排在全站清单最前（批量重建 offset=0 必写）',
		headKinds.length === THEME_ASSETS.length && headKinds.every((kind) => kind === 'asset'),
		headKinds.join(',') || '(空)',
	);
	check(
		'每个主题资源都在全站清单里',
		THEME_ASSETS.every((asset) => themeTargets.some((target) => target.kind === 'asset' && target.name === asset.name)),
	);
	check(
		'单篇发布的清单带上主题资源（写出的 HTML 引用的指纹必须已在 R2）',
		postPublishTargets(loaded.snapshot, loaded.snapshot.posts[0])
			.slice(0, THEME_ASSETS.length)
			.every((target) => target.kind === 'asset'),
	);

	// -----------------------------------------------------------------------
	// 1c. 索引页进了发布清单，删除则只重建受影响的对象（§6.5 / §13.1）
	// -----------------------------------------------------------------------
	const overviewKeys = ['categories/', 'tags/', 'archives/'];
	check('三个索引页都在全站清单里', overviewKeys.every((key) => themeTargets.some((target) => target.key === key)));
	check(
		'发一篇文章会重建三个索引页（页面上的计数会变）',
		overviewKeys.every((key) => postPublishTargets(loaded.snapshot, loaded.snapshot.posts[0]).some((target) => target.key === key)),
	);

	const deleteTargets = postDeleteTargets(loaded.snapshot, loaded.snapshot.posts[0]);
	const deleteKeys = deleteTargets.map((target) => target.key);
	check(
		'删除清单里没有任何文章 / 独立页面对象',
		!deleteKeys.some((key) => key.endsWith('.html')),
		deleteKeys.filter((key) => key.endsWith('.html')).join(',') || '(无)',
	);
	check(
		'删除只重建受影响的对象（线上是 35 而不是 800）',
		deleteTargets.length < 30,
		`${deleteTargets.length} 个 / 全站清单 ${themeTargets.length} 个`,
	);
	check(
		'删除清单含该文章的分类与标签归档',
		deleteKeys.includes('category/default/') && deleteKeys.includes('tag/安卓/'),
	);
	check(
		'删除清单含首页、分页、索引页、feed 与 sitemap',
		deleteKeys.includes('') && deleteKeys.includes('page/2/') && overviewKeys.every((key) => deleteKeys.includes(key)) && deleteKeys.includes('feed/') && deleteKeys.includes('sitemap.xml'),
	);

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
	check(
		'三个索引页已生成',
		overviewKeys.every((key) => keys.includes(key)),
		overviewKeys.filter((key) => !keys.includes(key)).join(',') || '(全在)',
	);
	check('草稿没有产出对象', !keys.some((key) => key.includes('draft-one')));
	check('waiting 文章没有产出对象', !keys.includes('default/post-12.html'));

	// hidden：有页面，但不进列表 / Feed / sitemap（Typecho 语义）
	check('hidden 文章有页面对象', keys.includes('default/hidden-one.html'));
	const homeHtml = (await (await env.BUCKET.get(''))?.text()) ?? '';
	check('hidden 不出现在首页列表', !homeHtml.includes('隐藏文章标题'));
	const indexPage1 = (await (await env.BUCKET.get('page/1/'))?.text()) ?? '';
	check('hidden 不出现在分页里', !indexPage1.includes('隐藏文章标题'));
	const categoryHtml = (await (await env.BUCKET.get('category/default/'))?.text()) ?? '';
	check('hidden 不出现在分类归档', !categoryHtml.includes('隐藏文章标题'));
	const earlySitemap = (await (await env.BUCKET.get('sitemap.xml'))?.text()) ?? '';
	const earlyFeed = (await (await env.BUCKET.get('feed/'))?.text()) ?? '';
	check('hidden 不进 sitemap', !earlySitemap.includes('hidden-one'));
	check('hidden 不进 feed', !earlyFeed.includes('隐藏文章标题'));
	const hiddenHtml = (await (await env.BUCKET.get('default/hidden-one.html'))?.text()) ?? '';
	check('hidden 页面正文正常渲染', hiddenHtml.includes('隐藏正文'));
	// 全站一个宽度档（§11.1）：容器宽度只有一个开关 `--container-size`，
	// 目录浮在容器右边的留白里，不再把容器撑宽
	check('没有 h2/h3 的短文章与列表页同宽（`.layout-narrow`）', hiddenHtml.includes('<body class="layout-narrow">'));

	// 注意：R2 的 list() 不返回 httpMetadata（和 S3 一致），要看缓存头必须 head/get
	const homeMeta = (await env.BUCKET.head(''))?.httpMetadata;
	check('首页 contentType 来自 httpMetadata', homeMeta?.contentType === 'text/html; charset=utf-8', String(homeMeta?.contentType));
	check('首页缓存头按 §7.2', homeMeta?.cacheControl === 'public, max-age=60, stale-while-revalidate=300', String(homeMeta?.cacheControl));
	const articleMeta = (await env.BUCKET.head('default/hello.html'))?.httpMetadata;
	check('文章页缓存头按 §7.2', articleMeta?.cacheControl === 'public, max-age=300, stale-while-revalidate=600', String(articleMeta?.cacheControl));

	// 主题资源流水线（§7.2）：指纹 key + immutable + 页面注入
	const cssAsset = themeAsset('style.css');
	const cssMeta = (await env.BUCKET.head(cssAsset.key))?.httpMetadata;
	check('主题 CSS 按指纹写入 R2', keys.includes(cssAsset.key), cssAsset.key);
	check(
		'指纹 key 形态 = theme/<名>.<8 位 hex>.<扩展名>',
		/^theme\/[a-z0-9-]+\.[0-9a-f]{8}\.(css|js)$/.test(cssAsset.key),
		cssAsset.key,
	);
	check(
		'主题资源是 immutable 长缓存',
		cssMeta?.cacheControl === 'public, max-age=31536000, immutable',
		String(cssMeta?.cacheControl),
	);
	check('主题资源 contentType 取清单里的值', cssMeta?.contentType === cssAsset.contentType, String(cssMeta?.contentType));
	check(
		'写进 R2 的 CSS 与源文件逐字一致',
		(await (await env.BUCKET.get(cssAsset.key))?.text()) === cssAsset.content,
	);
	const jsAsset = themeAsset('app.js');
	check('主题 JS 也进了 R2', keys.includes(jsAsset.key), jsAsset.key);
	check(
		'首页注入指纹 CSS link',
		homeHtml.includes(`<link rel="stylesheet" href="${themeAssetPath('style.css')}">`),
		themeAssetPath('style.css'),
	);
	check('首页注入 defer 脚本', homeHtml.includes(`<script src="${themeAssetPath('app.js')}" defer></script>`));
	check(
		'全站都不再有侧栏（顶栏导航取代，文章页也不再挂全局数据）',
		!homeHtml.includes('class="sidebar"') && !categoryHtml.includes('class="sidebar"'),
	);
	check(
		'顶栏导航含 分类 / 标签 / 归档 / 关于',
		homeHtml.includes('<a href="/categories/">分类</a>') &&
			homeHtml.includes('<a href="/tags/">标签</a>') &&
			homeHtml.includes('<a href="/archives/">归档</a>') &&
			homeHtml.includes('<a href="/about.html">关于</a>'),
	);
	check('列表页是限宽版式（`.layout-narrow`）', homeHtml.includes('<body class="layout-narrow">'));
	check('列表页不再输出两栏骨架', !homeHtml.includes('site-body'));

	const categoriesHtml = (await (await env.BUCKET.get('categories/'))?.text()) ?? '';
	check(
		'分类索引页列出分类与计数',
		categoriesHtml.includes('<h1 class="archive-title">分类</h1>') &&
			categoriesHtml.includes('href="/category/default/"') &&
			categoriesHtml.includes('class="term-count"'),
	);
	// 分类只有 7 条、每条带一句描述 → 一行一条；标签 198 条 → 流式排列（一行多个）
	check(
		'分类页保持一行一条（带描述），不加 `--flow`',
		categoriesHtml.includes('class="term-list"') &&
			categoriesHtml.includes('class="term-description"') &&
			!categoriesHtml.includes('term-list--flow'),
	);
	const tagsHtml = (await (await env.BUCKET.get('tags/'))?.text()) ?? '';
	check('标签索引页链接已编码（中文标签）', tagsHtml.includes('href="/tag/%E5%AE%89%E5%8D%93/"'));
	check('标签索引页是流式排列（一行多个）', tagsHtml.includes('class="term-list term-list--flow"'));
	const archivesHtml = (await (await env.BUCKET.get('archives/'))?.text()) ?? '';
	check(
		'归档索引页按年份分组、月份流式排列',
		archivesHtml.includes('<h1 class="archive-title">归档</h1>') &&
			archivesHtml.includes('class="term-list term-list--flow"') &&
			archivesHtml.includes('<section class="term-group">') &&
			archivesHtml.includes('<h2 class="term-group-title">'),
	);
	// 三个索引页都不再输出「共 N 个…」的说明行（见 theme/overview.ts）
	check(
		'索引页不再输出「共 N 个…」说明行',
		!categoriesHtml.includes('archive-description') &&
			!tagsHtml.includes('archive-description') &&
			!archivesHtml.includes('archive-description'),
	);

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
	check('围栏语言留在 class 上（客户端高亮的入口）', articleHtml.includes('class="language-js"'));
	check('中文标签链接已编码', articleHtml.includes('/tag/%E5%AE%89%E5%8D%93/'));
	check('文章页显示标签名', articleHtml.includes('>安卓</a>'));
	check('文章页同样注入指纹 CSS link', articleHtml.includes(themeAssetPath('style.css')));
	check(
		'文章页骨架完整（顶栏导航 + 主题切换按钮 + 尾部脚本）',
		articleHtml.includes('<a href="/categories/">分类</a>') &&
			articleHtml.includes('data-theme-toggle') &&
			articleHtml.includes(`<script src="${themeAssetPath('app.js')}" defer></script>`),
	);
	// 全站同宽：有目录的文章页也不额外加宽，目录自己浮到容器右边的留白里（§11.1）
	check(
		'有目录的文章页与列表页同宽（`.layout-narrow`，`.layout-post` 已废弃）',
		articleHtml.includes('<body class="layout-narrow">') && !articleHtml.includes('layout-post'),
	);
	check('文章页不再有侧栏', !articleHtml.includes('class="sidebar"'));
	// 目录是**服务端**抽取的（theme/toc.ts）：锚点 id 与目录链接在同一次渲染里产生
	check('正文 h2/h3 被注入锚点 id', articleHtml.includes('<h2 id="二级标题">') && articleHtml.includes('<h3 id="三级标题">'));
	check('重复标题的锚点 id 会去重', articleHtml.includes('<h2 id="二级标题-2">'));
	check(
		'宽屏右栏目录由服务端渲染',
		articleHtml.includes('<aside class="post-toc" aria-label="文章目录">') &&
			articleHtml.includes('href="#二级标题"') &&
			articleHtml.includes('href="#三级标题"') &&
			articleHtml.includes('href="#二级标题-2"'),
	);
	check(
		'窄屏折叠目录用原生 details（不依赖 JS）',
		articleHtml.includes('<details class="post-toc-inline">') && articleHtml.includes('<summary>目录</summary>'),
	);

	const row = await all<{ excerpt: string; words: number; needs_sync: number }>(
		'SELECT excerpt, words, needs_sync FROM contents WHERE cid = 100',
	);
	check('未写摘要时 excerpt 留空（不再自动生成）', row[0].excerpt === '', row[0].excerpt.slice(0, 24));
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
	check(
		'rendered 已回填 D1（excerpt 保持留空）',
		waitingRow[0].rendered.includes('未来的文章') && waitingRow[0].excerpt === '',
		waitingRow[0].excerpt.slice(0, 20),
	);

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
	// 独立页面只有 `# 关于` 一个 h1，没有 h2/h3 —— 不该出现空目录栏
	check(
		'没有 h2/h3 的页面不渲染目录',
		!pageHtml.includes('<aside class="post-toc"') && !pageHtml.includes('post-toc-inline'),
	);
	check(
		'独立页面与列表页同宽（`.layout-narrow`）',
		pageHtml.includes('<body class="layout-narrow">') && !pageHtml.includes('layout-post'),
	);

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
	check('列表有渲染维护入口、待同步徽标链到渲染页', listHtml.includes('/admin/render') && !listHtml.includes('id="rebuild-form"'));
	const qSinglePage = await call('/admin?q=post-3', { headers: { cookie: sessionCookie } });
	const qSinglePageHtml = await qSinglePage.text();
	check('筛选后只有一页时不渲染分页条', qSinglePage.status === 200 && !qSinglePageHtml.includes('<nav class="admin-pagination"'));

	const renderPage = await call('/admin/render', { headers: { cookie: sessionCookie } });
	const renderHtml = await renderPage.text();
	check(
		'渲染维护页拆出两个独立操作（全站/增量）',
		renderPage.status === 200 &&
			renderHtml.includes('id="full-start"') &&
			renderHtml.includes('id="drain-start"') &&
			renderHtml.includes('/admin/rebuild/full') &&
			renderHtml.includes('/admin/rebuild/batch'),
	);
	check(
		'渲染页带分组独立渲染按钮（含分类/标签拆分）',
		renderHtml.includes('data-group="categories"') && renderHtml.includes('data-group="tags"') && renderHtml.includes('data-group="feed"'),
	);
	// 内联脚本被 JSX 转义会让 raw text 元素里出现 &#39;（浏览器不还原实体 → JS 语法错误）
	check('渲染页内联脚本没有被实体转义', !renderHtml.includes('&#39;') && !renderHtml.includes('&quot;'));

	const feedGroup = await postForm('/admin/rebuild/full?group=feed&offset=0&limit=50', {}, sessionCookie);
	const feedGroupReport = (await feedGroup.json()) as { total?: number; written?: number; nextOffset?: unknown };
	check(
		'分组渲染 feed 只写 1 个对象',
		feedGroup.status === 200 && feedGroupReport.total === 1 && feedGroupReport.written === 1 && feedGroupReport.nextOffset === null,
		JSON.stringify(feedGroupReport),
	);
	const badGroup = await postForm('/admin/rebuild/full?group=bogus', {}, sessionCookie);
	check('未知分组返回 400', badGroup.status === 400);
	check('页头有品牌首页链接、前台入口、删除确认', listHtml.includes('class="brand"') && listHtml.includes('/admin/front') && listHtml.includes('onsubmit='));
	check('列表带筛选条（关键词/状态/分类）', listHtml.includes('name="q"') && listHtml.includes('name="status"') && listHtml.includes('name="category"'));
	check('操作栏带「修改」入口', listHtml.includes('/admin/posts/101/edit') && listHtml.includes('/preview/101'));

	const qPage = await call('/admin?q=post-3', { headers: { cookie: sessionCookie } });
	const qHtml = await qPage.text();
	check('关键词筛出唯一匹配（slug=post-3）', qPage.status === 200 && qHtml.includes('第 3 篇') && !qHtml.includes('第 2 篇'));

	const draftPage = await call('/admin?status=draft', { headers: { cookie: sessionCookie } });
	const draftHtml = await draftPage.text();
	check('状态筛选 draft 只剩草稿', draftPage.status === 200 && draftHtml.includes('>草稿<') && !draftHtml.includes('第 2 篇'));

	const catFilterPage = await call(`/admin?category=${CATEGORY_MID}`, { headers: { cookie: sessionCookie } });
	const catFilterHtml = await catFilterPage.text();
	check('分类筛出该分类全部文章', catFilterPage.status === 200 && catFilterHtml.includes('第 2 篇'));
	const emptyCatPage = await call('/admin?category=999', { headers: { cookie: sessionCookie } });
	const emptyCatHtml = await emptyCatPage.text();
	check('筛到无文章的分类显示空态', emptyCatPage.status === 200 && !emptyCatHtml.includes('第 2 篇') && emptyCatHtml.includes('还没有内容'));

	// 后台设置页：SSR 表单保存 options（§6.1 / §7.3）
	lines.push('=== 后台设置页 ===');
	const settingsPage = await call('/admin/settings', { headers: { cookie: sessionCookie } });
	const settingsHtml = await settingsPage.text();
	check(
		'设置页能打开且字段齐全',
		settingsPage.status === 200 &&
			['site_title', 'site_description', 'site_keywords', 'site_url', 'posts_per_page', 'timezone', 'turnstile_site_key'].every(
				(name) => settingsHtml.includes(`name="${name}"`),
			),
		String(settingsPage.status),
	);

	const saveSettings = await postForm(
		'/admin/settings',
		{
			site_title: '风息的测试站',
			site_description: 'e2e 描述',
			site_keywords: 'e2e',
			site_url: 'https://blog.fengqi.me/', // 末尾斜杠应被剥掉，归一化后与夹具一致
			posts_per_page: '5',
			timezone: '8',
			turnstile_site_key: '1x00000000000000000000AA',
		},
		sessionCookie,
	);
	const settingsLocation = decodeURIComponent(saveSettings.headers.get('location') ?? '');
	check('保存设置返回 303 且前台配置变动时排入重建', saveSettings.status === 303 && settingsLocation.includes('排入重建'), settingsLocation);
	const perPageRow = await all<{ value: string }>("SELECT value FROM options WHERE name = 'posts_per_page' AND user = 0");
	check('设置已写入 options 表', perPageRow[0]?.value === '5', perPageRow[0]?.value);
	const siteUrlRow = await all<{ value: string }>("SELECT value FROM options WHERE name = 'site_url' AND user = 0");
	check('site_url 已归一化（无末尾斜杠）', siteUrlRow[0]?.value === 'https://blog.fengqi.me', siteUrlRow[0]?.value);

	const badSettings = await postForm(
		'/admin/settings',
		{
			site_title: 'x',
			site_description: '',
			site_keywords: '',
			site_url: 'blog.fengqi.me', // 缺协议，必须被拒
			posts_per_page: '10',
			timezone: '8',
			turnstile_site_key: '',
		},
		sessionCookie,
	);
	check('缺协议的域名被拒', badSettings.status === 303 && decodeURIComponent(badSettings.headers.get('location') ?? '').includes('error='), badSettings.headers.get('location') ?? '');

	// 走表单改缩略名 —— 顺便验证 §5.1 方案 A（旧 URL 保留 canonical）
	const editView = await call('/admin/posts/101/edit', { headers: { cookie: sessionCookie } });
	const editHtml = await editView.text();
	check('编辑器能打开', editView.status === 200 && editHtml.includes('name="body"'));
	check(
		'编辑器带工具栏、预览 tab 与传图入口',
		editHtml.includes('id="editor-toolbar"') && editHtml.includes('data-cmd="bold"') && editHtml.includes('id="md-preview"') && editHtml.includes('id="image-input"'),
	);

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
	check('未写摘要时 excerpt 留空（不再自动生成）', excerptRow[0].excerpt === '', excerptRow[0].excerpt.slice(0, 20));
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
	// 8.5 媒体库 / 改口令 / 分批重建端点（待办 ④⑤⑥）
	// -----------------------------------------------------------------------
	lines.push('=== 媒体库与改口令 ===');
	const relogin = await postForm('/admin/login', { username: 'admin', password: 'e2e-口令-123' });
	const cookie2 = (relogin.headers.get('set-cookie') ?? '').split(';')[0];
	check('重新登录成功（后续测试用）', relogin.status === 303 && cookie2.startsWith('blog_session='));

	// 分批重建端点（全站重渲按钮循环调的就是它）
	const fullSlice = await postForm('/admin/rebuild/full', { offset: '0', limit: '50' }, cookie2);
	const fullReport = (await fullSlice.json()) as { total: number; written: number; failed: string[]; nextOffset: number | null };
	check(
		'分批重建端点返回进度（待办 ⑥）',
		fullSlice.status === 200 &&
			typeof fullReport.total === 'number' &&
			fullReport.total > 0 &&
			fullReport.written > 0 &&
			(fullReport.nextOffset === null || typeof fullReport.nextOffset === 'number'),
		`total=${fullReport.total} written=${fullReport.written} nextOffset=${fullReport.nextOffset}`,
	);

	// 媒体库：页面 + multipart 上传（白名单外的 .txt 应被拒）
	const mediaPage = await call('/admin/media', { headers: { cookie: cookie2 } });
	const mediaHtml = await mediaPage.text();
	check('媒体库能打开', mediaPage.status === 200 && mediaHtml.includes('name="files"'));

	const uploadForm = new FormData();
	uploadForm.append('files', new File([new Uint8Array([137, 80, 78, 71])], 'e2e 图片.png', { type: 'image/png' }));
	uploadForm.append('files', new File(['plain text'], 'bad.txt', { type: 'text/plain' }));
	const uploadRes = await call('/admin/media', { method: 'POST', body: uploadForm, headers: { cookie: cookie2 } });
	const uploadLoc = decodeURIComponent(uploadRes.headers.get('location') ?? '');
	check('上传返回 303', uploadRes.status === 303);
	check('白名单外的 .txt 被拒、png 成功', uploadLoc.includes('上传 1 个') && uploadLoc.includes('失败 1 个') && uploadLoc.includes('bad.txt'), uploadLoc);

	const attRow = await all<{ cid: number; r2_key: string; mime: string; size: number }>(
		"SELECT cid, r2_key, mime, size FROM contents WHERE type = 'attachment' ORDER BY cid DESC LIMIT 1",
	);
	check('附件元信息落库（mime/size/r2_key）', attRow[0]?.mime === 'image/png' && attRow[0]?.size === 4, JSON.stringify(attRow[0]));
	check('附件 key 按 §9 路径规则', /^usr\/uploads\/\d{4}\/\d{2}\/e2e 图片\.png$/.test(attRow[0]?.r2_key ?? ''), attRow[0]?.r2_key);
	const attObj = await env.BUCKET.get(attRow[0]?.r2_key ?? '');
	check(
		'附件写进 R2 且 immutable',
		attObj !== null &&
			attObj.httpMetadata?.cacheControl === 'public, max-age=31536000, immutable' &&
			attObj.httpMetadata?.contentType === 'image/png',
		JSON.stringify(attObj?.httpMetadata),
	);

	const dupForm = new FormData();
	dupForm.append('files', new File([new Uint8Array([1])], 'e2e 图片.png', { type: 'image/png' }));
	const dupRes = await call('/admin/media', { method: 'POST', body: dupForm, headers: { cookie: cookie2 } });
	check('同名附件不可覆盖（immutable）', dupRes.status === 303 && decodeURIComponent(dupRes.headers.get('location') ?? '').includes('不可覆盖'));

	const mediaAfter = await (await call('/admin/media', { headers: { cookie: cookie2 } })).text();
	check('媒体库列表显示新附件', mediaAfter.includes('e2e 图片.png') && mediaAfter.includes('data-copy'));

	// 编辑器快速传图端点（单文件 JSON，与媒体库同一套校验）
	const quickForm = new FormData();
	quickForm.append('file', new File([new Uint8Array([137, 80, 78, 71])], 'e2e 编辑器图.png', { type: 'image/png' }));
	const quickRes = await call('/admin/media/upload', { method: 'POST', body: quickForm, headers: { cookie: cookie2 } });
	const quickJson = (await quickRes.json()) as { url?: string; name?: string; isImage?: boolean };
	check(
		'快速传图返回插入用 URL',
		quickRes.status === 200 && /^\/usr\/uploads\/\d{4}\/\d{2}\/e2e 编辑器图\.png$/.test(quickJson.url ?? '') && quickJson.isImage === true,
		JSON.stringify(quickJson),
	);
	const quickObj = await env.BUCKET.get((quickJson.url ?? '').slice(1));
	check('快速传图写进 R2', quickObj !== null && quickObj.httpMetadata?.contentType === 'image/png');

	// 同秒连传第二个附件：createAttachment 的 slug 曾用秒级时间戳，撞 UNIQUE(type, slug) 必 500
	const quickForm2 = new FormData();
	quickForm2.append('file', new File([new Uint8Array([137, 80, 78, 71])], 'e2e 编辑器图2.png', { type: 'image/png' }));
	const quickRes2 = await call('/admin/media/upload', { method: 'POST', body: quickForm2, headers: { cookie: cookie2 } });
	check('同一秒内连传两个附件不撞唯一约束', quickRes2.status === 200, String(quickRes2.status));

	const quickTxtForm = new FormData();
	quickTxtForm.append('file', new File(['x'], 'bad.txt', { type: 'text/plain' }));
	const quickTxtRes = await call('/admin/media/upload', { method: 'POST', body: quickTxtForm, headers: { cookie: cookie2 } });
	check('快速传图拒绝白名单外类型', quickTxtRes.status === 400);

	// 编辑器预览端点（发布同款渲染器 + 白名单清洗）
	const previewForm = new FormData();
	previewForm.append('body', '# 预览标题\n\n**加粗** <script>alert(1)</script>');
	const previewRes = await call('/admin/preview', { method: 'POST', body: previewForm, headers: { cookie: cookie2 } });
	const previewFrag = await previewRes.text();
	check(
		'预览端点渲染 Markdown',
		previewRes.status === 200 && previewFrag.includes('<h1>预览标题</h1>') && previewFrag.includes('<strong>加粗</strong>'),
	);
	check('预览端点输出已清洗', !previewFrag.includes('<script>alert(1)</script>'));
	check('预览端点不缓存', (previewRes.headers.get('cache-control') ?? '').includes('no-store'));

	const previewNoAuth = await call('/admin/preview', { method: 'POST', body: previewForm });
	check('预览端点必须登录', previewNoAuth.status === 302 && (previewNoAuth.headers.get('location') ?? '').includes('/admin/login'));

	// 分类管理：创建 / 查重 / slug 变更（URL 走方案 A）/ 删除守卫与主分类顺延
	lines.push('=== 分类管理 ===');
	const catPage = await call('/admin/categories', { headers: { cookie: cookie2 } });
	const catHtml = await catPage.text();
	check('分类管理页能打开', catPage.status === 200 && catHtml.includes('/admin/categories'));

	const catCreate = await postForm('/admin/categories', { name: '测试分类', slug: 'test-cat', description: '' }, cookie2);
	check('创建分类返回 303', catCreate.status === 303);
	const catDup = await postForm('/admin/categories', { name: '另一个', slug: 'test-cat' }, cookie2);
	check('重复缩略名被拒', catDup.status === 303 && decodeURIComponent(catDup.headers.get('location') ?? '').includes('已被占用'));
	const catMidRow = await all<{ mid: number }>("SELECT mid FROM metas WHERE type = 'category' AND slug = 'test-cat'");
	const catMid = catMidRow[0]?.mid;

	const catPostForm = await postForm(
		'/admin/posts',
		{
			title: '分类迁移测试',
			slug: 'cat-post',
			type: 'post',
			status: 'publish',
			created: '2026-09-30T15:00',
			body: '正文',
			excerpt: '',
			categories: String(catMid),
			tags: '',
			allow_feed: '1',
		},
		cookie2,
	);
	await Promise.allSettled(waits.splice(0));
	check('分类下的文章已发布', catPostForm.status === 303);
	check('文章 URL 按 /<分类>/<slug>.html', (await env.BUCKET.get('test-cat/cat-post.html')) !== null);
	const catPostCidRow = await all<{ cid: number }>("SELECT cid FROM contents WHERE slug = 'cat-post'");
	const catPostCid = catPostCidRow[0]?.cid;

	const catUpdate = await postForm(`/admin/categories/${catMid}`, { name: '测试分类', slug: 'test-cat-2', description: '' }, cookie2);
	await runScheduledTasks(env);
	const catUpdateMsg = decodeURIComponent(catUpdate.headers.get('location') ?? '');
	check('改分类 slug 返回 303 且提示地址变更', catUpdate.status === 303 && catUpdateMsg.includes('地址已变'), catUpdateMsg);
	check('文章新地址已写出', (await env.BUCKET.get('test-cat-2/cat-post.html')) !== null);
	const oldPostObj = await env.BUCKET.get('test-cat/cat-post.html');
	const oldPostHtml = await oldPostObj?.text() ?? '';
	check('旧文章地址保留并指向新 canonical', oldPostHtml.includes('test-cat-2/cat-post.html'));
	check('旧分类归档对象已删除', (await env.BUCKET.get('category/test-cat/')) === null);
	check('新分类归档对象已生成', (await env.BUCKET.get('category/test-cat-2/')) !== null);

	const catDeleteGuard = await postForm(`/admin/categories/${catMid}/delete`, {}, cookie2);
	check(
		'唯一分类的文章会拦住删除',
		catDeleteGuard.status === 303 && decodeURIComponent(catDeleteGuard.headers.get('location') ?? '').includes('只挂在'),
	);

	const spareCreate = await postForm('/admin/categories', { name: '备胎分类', slug: 'spare-cat' }, cookie2);
	check('备胎分类创建成功', spareCreate.status === 303);
	const spareMidRow = await all<{ mid: number }>("SELECT mid FROM metas WHERE type = 'category' AND slug = 'spare-cat'");
	// categories 是多值字段：必须 append 两次，塞成一个 "38,39" 会被 Number() 解析成 NaN
	const catPostUpdateBody = new URLSearchParams({
		title: '分类迁移测试',
		slug: 'cat-post',
		type: 'post',
		status: 'publish',
		created: '2026-09-30T15:00',
		body: '正文',
		excerpt: '',
		tags: '',
		allow_feed: '1',
	});
	catPostUpdateBody.append('categories', String(catMid));
	catPostUpdateBody.append('categories', String(spareMidRow[0]?.mid));
	const catPostUpdate = await call(`/admin/posts/${catPostCid}`, {
		method: 'POST',
		body: catPostUpdateBody,
		headers: { cookie: cookie2 },
	});
	check('给文章挂上第二个分类返回 303', catPostUpdate.status === 303, String(catPostUpdate.status));
	await Promise.allSettled(waits.splice(0));
	const catDelete = await postForm(`/admin/categories/${catMid}/delete`, {}, cookie2);
	await runScheduledTasks(env);
	check('删除分类返回 303', catDelete.status === 303);
	check('主分类顺延后新地址已写出', (await env.BUCKET.get('spare-cat/cat-post.html')) !== null);

	// `<!--more-->` 摘要分界（Typecho 惯例）：分界以哨兵留在 rendered，excerpt 保持留空
	const moreForm = await postForm(
		'/admin/posts',
		{
			title: '摘要分界测试',
			slug: 'more-marker',
			type: 'post',
			status: 'publish',
			created: '2026-09-30T16:00',
			body: '这是标记前的摘要部分。<!--more-->这是标记后的正文。',
			excerpt: '',
			allow_feed: '1',
		},
		cookie2,
	);
	await Promise.allSettled(waits.splice(0));
	const moreRow = await all<{ excerpt: string; rendered: string }>(
		"SELECT excerpt, rendered FROM contents WHERE slug = 'more-marker'",
	);
	check(
		'`<!--more-->` 分界：excerpt 留空（不自动生成）',
		moreForm.status === 303 && moreRow[0]?.excerpt === '',
		moreRow[0]?.excerpt,
	);
	check(
		'分界哨兵进 rendered（两半各自渲染，HTML 平衡）',
		/<p>这是标记前的摘要部分。<\/p>\s*<!--more-->\s*<p>这是标记后的正文。<\/p>/.test(moreRow[0]?.rendered ?? ''),
		moreRow[0]?.rendered,
	);
	const moreObj = await env.BUCKET.get('default/more-marker.html');
	const moreHtml = await moreObj?.text() ?? '';
	check('文章页正文完整（分界两半都在）', moreHtml.includes('这是标记前的摘要部分。') && moreHtml.includes('这是标记后的正文。'));

	// 手写摘要：用作者写的那份（支持 Markdown），照样显示「阅读剩余部分」
	const manualForm = await postForm(
		'/admin/posts',
		{
			title: '手写摘要测试',
			slug: 'manual-excerpt',
			type: 'post',
			status: 'publish',
			created: '2026-10-01T00:00',
			body: '正文里没有摘要分界。',
			excerpt: '**手写**的 *Markdown* 摘要。',
			allow_feed: '1',
		},
		cookie2,
	);
	await Promise.allSettled(waits.splice(0));
	const manualRow = await all<{ excerpt: string; rendered: string }>(
		"SELECT excerpt, rendered FROM contents WHERE slug = 'manual-excerpt'",
	);
	check(
		'手写摘要原文落库（Markdown 不动）且不混进正文',
		manualForm.status === 303 &&
			manualRow[0]?.excerpt === '**手写**的 *Markdown* 摘要。' &&
			!(manualRow[0]?.rendered ?? '').includes('手写'),
		manualRow[0]?.excerpt,
	);

	const homeObj = await env.BUCKET.get('');
	const homeExcerptHtml = await homeObj?.text() ?? '';
	check(
		'首页 `<!--more-->` 项用分界前半段作摘要',
		homeExcerptHtml.includes('<div class="post-excerpt"><p>这是标记前的摘要部分。</p>'),
		`hasDiv=${homeExcerptHtml.includes('post-excerpt')} hasText=${homeExcerptHtml.includes('这是标记前的摘要部分。')}`,
	);
	// 逐项检查列表项：有没有摘要、有没有「阅读剩余部分」
	const homeItems = homeExcerptHtml.split('<li class="post-item">').slice(1);
	const itemBlock = (needle: string): string => {
		const item = homeItems.find((entry) => entry.includes(needle)) ?? '';
		const end = item.indexOf('</li>');
		return end < 0 ? item : item.slice(0, end);
	};
	check('`<!--more-->` 分界的列表项显示「阅读剩余部分」', itemBlock('摘要分界测试').includes('post-more'));
	check(
		'手写摘要项按 Markdown 渲染且显示「阅读剩余部分」',
		itemBlock('手写摘要测试').includes('<strong>手写</strong>') && itemBlock('手写摘要测试').includes('post-more'),
	);
	check(
		'全文当摘要的列表项不显示「阅读剩余部分」',
		itemBlock('没勾分类的文章').includes('没勾分类的文章') && !itemBlock('没勾分类的文章').includes('post-more'),
	);

	// 改口令（⑤）：错误当前口令 / 两次不一致 / 成功后旧会话全失效
	const wrongCurrent = await postForm(
		'/admin/password',
		{ current_password: 'wrong', new_password: '新的口令-456', confirm_password: '新的口令-456' },
		cookie2,
	);
	check('当前口令错被拒', wrongCurrent.status === 303 && decodeURIComponent(wrongCurrent.headers.get('location') ?? '').includes('当前口令不正确'));

	const mismatched = await postForm(
		'/admin/password',
		{ current_password: 'e2e-口令-123', new_password: '新的口令-456', confirm_password: '另一个-456' },
		cookie2,
	);
	check('两次新口令不一致被拒', mismatched.status === 303 && decodeURIComponent(mismatched.headers.get('location') ?? '').includes('不一致'));

	const changePw = await postForm(
		'/admin/password',
		{ current_password: 'e2e-口令-123', new_password: '新的口令-456', confirm_password: '新的口令-456' },
		cookie2,
	);
	check('改口令成功跳登录页', changePw.status === 303 && (changePw.headers.get('location') ?? '').includes('/admin/login'));
	const staleSession = await call('/admin', { headers: { cookie: cookie2 } });
	check('旧会话已失效（token_version +1）', staleSession.status === 302);
	const pwRelogin = await postForm('/admin/login', { username: 'admin', password: '新的口令-456' });
	check('新口令能登录', pwRelogin.status === 303);
	const pwOldLogin = await postForm('/admin/login', { username: 'admin', password: 'e2e-口令-123' });
	check('旧口令被拒', pwOldLogin.status === 401);

	// -----------------------------------------------------------------------
	// 后台分页：塞 55 篇填充文章把列表顶过一页（放套件最末尾，不影响前面的断言）
	// -----------------------------------------------------------------------
	lines.push('=== 后台分页 ===');
	const pageLogin = await postForm('/admin/login', { username: 'admin', password: '新的口令-456' });
	const pageCookie = (pageLogin.headers.get('set-cookie') ?? '').split(';')[0];
	for (let index = 0; index < 55; index++) {
		const cid = 500 + index;
		const created = now - 7200 - index * 60; // 比正主文章旧，排在列表尾部
		await run(
			`INSERT INTO contents (cid, title, slug, created, modified, body, rendered, excerpt, sort_order,
			                       author_id, type, status, allow_feed, parent, words, needs_sync)
			 VALUES (?, ?, ?, ?, ?, ?, '', '', 0, 1, 'post', 'publish', 1, 0, 0, 0)`,
			[cid, `分页填充文章 ${index + 1}`, `pgfill-${index + 1}`, created, created, '填充正文。'],
		);
		await run('INSERT INTO relationships (cid, mid) VALUES (?, ?)', [cid, CATEGORY_MID]);
	}
	const page1 = await call('/admin', { headers: { cookie: pageCookie } });
	const page1Html = await page1.text();
	check('第 1 页出现下一页链接', page1.status === 200 && page1Html.includes('/admin?page=2'));
	check('第 1 页不含最后的填充文章', !page1Html.includes('分页填充文章 55'));
	const page2 = await call('/admin?page=2', { headers: { cookie: pageCookie } });
	const page2Html = await page2.text();
	// 填充文章按 created 插在正主文章和「更老的填充」之间，第 2 页是否纯填充取决于每页条数
	// （目前后台 10 条/页：填充文章占第 6~60 行，第 2 页 = 第 11~20 行，全是填充）
	check(
		'第 2 页是填充文章、没有正主文章',
		page2.status === 200 && page2Html.includes('分页填充文章') && !page2Html.includes('第 2 篇'),
	);
	const page2Filtered = await call(`/admin?q=${encodeURIComponent('分页')}&page=2`, { headers: { cookie: pageCookie } });
	const page2FilteredHtml = await page2Filtered.text();
	check('翻页链接背着筛选参数', page2Filtered.status === 200 && page2FilteredHtml.includes('分页填充文章'));

	// -----------------------------------------------------------------------
	// 产物（交给外部 XML 校验）
	// -----------------------------------------------------------------------
	const feed = (await (await env.BUCKET.get('feed/'))?.text()) ?? '';
	const sitemap = (await (await env.BUCKET.get('sitemap.xml'))?.text()) ?? '';
	check('sitemap 不含 page/1/', !sitemap.includes('/page/1/'));
	check('sitemap 不含归档 /1/ 副本', !/category\/default\/1\//.test(sitemap));
	check('sitemap 不含旧 permalink', !sitemap.includes('old-hello'));
	check('sitemap 是绝对 URL', sitemap.includes('https://blog.fengqi.me/'));
	check(
		'sitemap 收录三个索引页',
		['categories/', 'tags/', 'archives/'].every((section) => sitemap.includes(`https://blog.fengqi.me/${section}`)),
	);
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
