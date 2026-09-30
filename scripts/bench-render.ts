/**
 * 发布流水线渲染压测 —— 对应设计文档 §13.1 第 4 项
 *
 * 目的：量出「渲染完整页面 + 写出全部对象」的量级，决定 §6.3 的同步/异步切分点，
 * 以及是否必须上 Queues。用合成数据（规模对齐线上：约 120 篇文章、7 个分类、
 * 一堆标签、约 60 个月），**不连数据库、不连 R2**，所以可以随便跑。
 *
 * 用法：npx tsx scripts/bench-render.ts
 *
 * ⚠️ 这里量的是**墙钟**，不是 Workers 的 CPU 时间。本地 Node 比 Free 版 isolate 快，
 * 所以真实部署后要用 `wrangler dev` / 线上 observability 复核一次（§13.1 #4 的剩余部分）。
 */

import { renderTargets } from '../src/publish/render';
import { postPublishTargets, siteTargets } from '../src/publish/targets';
import type { PostRecord, SiteSnapshot, TermRecord } from '../src/publish/types';
import type { SiteInfo } from '../theme/layout';

const CATEGORIES = [
	['Go', 'go'],
	['Java', 'java'],
	['PHP', 'php'],
	['Unix', 'unix'],
	['iOS', 'ios'],
	['DB', 'db'],
	['Other', 'default'],
] as const;

const TAG_POOL = [
	'cloudflare', 'r2', 'd1', 'workers', 'typecho', 'kafka', 'mysql', 'redis',
	'安卓', '退款', '腾讯', '渠道', 'nginx', 'ffmpeg', 'docker', 'gitlab',
	'vscode', 'macos', 'linux', '性能优化', '踩坑记录', '自动化', '备份', '迁移',
];

const POST_COUNT = 120;
const MONTHS = 60;

const site: SiteInfo = {
	title: '幸福飞过海',
	url: 'https://blog.fengqi.me',
	description: '风起的网络记事本',
	keywords: '',
	timezoneOffset: 8,
};

/** 用确定性的伪随机（不用 Math.random，保证每次跑数据一样，便于对比数字） */
function makeRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
}

function buildSnapshot(): SiteSnapshot {
	const random = makeRandom(20260930);

	const categories: TermRecord[] = CATEGORIES.map(([name, slug], index) => ({
		mid: index + 1,
		name,
		slug,
		type: 'category',
		count: 0,
	}));

	const tags: TermRecord[] = TAG_POOL.map((slug, index) => ({
		mid: 100 + index,
		name: slug,
		slug,
		type: 'tag',
		count: 0,
	}));

	// 每篇正文约 3~6KB，接近真实文章量级
	const paragraph = '这是一段用于压测的正文内容，模拟真实文章里的中文段落与代码片段。'.repeat(30);

	const posts: PostRecord[] = [];
	const start = 1756108800; // 2025-08-25 附近，往前铺 MONTHS 个月
	for (let index = 0; index < POST_COUNT; index++) {
		const created = start - Math.floor((index / POST_COUNT) * MONTHS * 30 * 86400);
		const category = categories[Math.floor(random() * categories.length)];
		const tagCount = 2 + Math.floor(random() * 4);
		const postTags: TermRecord[] = [];
		for (let t = 0; t < tagCount; t++) {
			const tag = tags[Math.floor(random() * tags.length)];
			if (!postTags.some((item) => item.mid === tag.mid)) postTags.push(tag);
		}

		posts.push({
			cid: 1000 - index,
			type: 'post',
			status: 'publish',
			title: `第 ${index + 1} 篇压测文章：${category.name} 相关`,
			slug: `bench-${1000 - index}`,
			created,
			modified: created + 3600,
			html: `<p>${paragraph}</p>\n<pre><code>console.log('bench');</code></pre>\n<p>${paragraph}</p>`,
			excerpt: '这是一段用于压测的摘要文本，模拟列表页展示。',
			words: 1200,
			author: { name: '风起' },
			categories: [category],
			tags: postTags,
		});

		category.count++;
		for (const tag of postTags) tag.count++;
	}

	// 年月归档（按站点时区）
	const monthSet = new Map<string, { year: number; month: number; count: number }>();
	for (const post of posts) {
		const date = new Date((post.created + 8 * 3600) * 1000);
		const year = date.getUTCFullYear();
		const month = date.getUTCMonth() + 1;
		const key = `${year}-${month}`;
		const entry = monthSet.get(key) ?? { year, month, count: 0 };
		entry.count++;
		monthSet.set(key, entry);
	}
	const months = [...monthSet.values()].sort((a, b) => b.year - a.year || b.month - a.month);

	const pages: PostRecord[] = [
		{
			cid: 1,
			type: 'page',
			status: 'publish',
			title: 'About',
			slug: 'about',
			created: start,
			modified: start,
			html: '<p>关于我</p>',
			excerpt: '关于我',
			categories: [],
			tags: [],
		},
		{
			cid: 2,
			type: 'page',
			status: 'publish',
			title: 'Guest',
			slug: 'guest',
			created: start,
			modified: start,
			html: '<p>留言板</p>',
			excerpt: '留言板',
			categories: [],
			tags: [],
		},
	];

	return {
		site,
		postsPerPage: 10,
		posts,
		pages,
		hidden: [],
		categories,
		tags: tags.filter((tag) => tag.count > 0),
		months,
		retired: [],
	};
}

function time(label: string, fn: () => void): number {
	const started = performance.now();
	fn();
	const elapsed = performance.now() - started;
	console.log(`  ${label}: ${elapsed.toFixed(1)} ms`);
	return elapsed;
}

const snapshot = buildSnapshot();
const targets = siteTargets(snapshot);

console.log('=== 输入规模 ===');
console.log(`  文章 ${snapshot.posts.length} 篇，独立页面 ${snapshot.pages.length} 个`);
console.log(`  分类 ${snapshot.categories.length} 个，有效标签 ${snapshot.tags.length} 个，年月 ${snapshot.months.length} 个`);

const byKind = new Map<string, number>();
for (const target of targets) byKind.set(target.kind, (byKind.get(target.kind) ?? 0) + 1);
console.log('=== 全站对象清单（§5.3）===');
console.log(`  合计 ${targets.length} 个对象`);
for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
	console.log(`    ${kind.padEnd(8)} ${count}`);
}

const single = snapshot.posts.find((post) => post.categories[0].slug === 'default')!;
const publishTargets = postPublishTargets(snapshot, single);
console.log('=== 单篇发布要重建的对象（§6.3）===');
console.log(`  cid=${single.cid}（分类 default）→ ${publishTargets.length} 个对象`);

console.log('=== 渲染耗时（墙钟）===');
// 第一次跑含 JIT 预热，单独报出来 —— 真实发布是「偶尔跑一次」，预热成本也要算进去
const coldMs = time(`全站重建 ${targets.length} 个对象（首次，含预热）`, () => {
	renderTargets(snapshot, targets);
});
const warmMs = time(`全站重建 ${targets.length} 个对象（第二次，稳态）`, () => {
	renderTargets(snapshot, targets);
});
time(`单篇发布重建 ${publishTargets.length} 个对象`, () => {
	renderTargets(snapshot, publishTargets);
});

// V8 的字符串是 rope，构建时并不真正展开 —— 写入 R2 前必然要物化，所以单独量一次
const rendered = renderTargets(snapshot, targets);
const encoder = new TextEncoder();
const bytes = rendered.reduce((total, object) => total + encoder.encode(object.body).length, 0);
const materializeMs = time(`物化 ${(bytes / 1024 / 1024).toFixed(2)} MB（TextEncoder 编码全部 body）`, () => {
	for (const object of rendered) encoder.encode(object.body);
});
const longest = rendered.reduce((max, object) => Math.max(max, object.body.length), 0);

console.log('=== 产物 ===');
console.log(`  总字节 ${(bytes / 1024 / 1024).toFixed(2)} MB，单对象最大 ${(longest / 1024).toFixed(1)} KB`);
console.log(
	`  全站重建 首次 ${coldMs.toFixed(1)} ms / 稳态 ${warmMs.toFixed(1)} ms（${(warmMs / targets.length).toFixed(3)} ms/对象）`,
);
console.log(`  物化占比 ${((materializeMs / (warmMs + materializeMs)) * 100).toFixed(0)}%`);

console.log('=== 关键 key 抽查 ===');
const keySet = new Set(targets.map((target) => target.key));
const expect = (label: string, ok: boolean) => console.log(`  ${ok ? '✓' : '✗'} ${label}`);
const firstPost = snapshot.posts[0];
const firstCategory = firstPost.categories[0];
expect("首页 key 是空字符串 ''", keySet.has(''));
expect('page/1/ 副本存在', keySet.has('page/1/'));
expect('category/default/1/ 副本存在', keySet.has('category/default/1/'));
expect('feed/ 与 sitemap.xml 存在', keySet.has('feed/') && keySet.has('sitemap.xml'));
expect('无重复 key', keySet.size === targets.length);
expect(
	`文章 key = ${firstCategory.slug}/${firstPost.slug}.html`,
	keySet.has(`${firstCategory.slug}/${firstPost.slug}.html`),
);
expect('独立页面是单段 key', keySet.has('about.html'));

const sitemap = rendered.find((object) => object.kind === 'sitemap')!;
expect('sitemap 不含 page/1/', !sitemap.body.includes('/page/1/'));
expect('sitemap 不含 …/1/ 归档副本', !/category\/default\/1\/</.test(sitemap.body));
expect('sitemap 是绝对 URL', sitemap.body.includes('https://blog.fengqi.me/'));
const feed = rendered.find((object) => object.kind === 'feed')!;
expect('feed 是合法 XML 头', feed.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
