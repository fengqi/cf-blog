/**
 * 前台主题脚本 —— 设计文档 §11 / §14.2
 *
 * 三条纪律：
 *   1. **零依赖**。不用 CDN、不 import 任何东西 —— 这个文件本身就是最终产物，
 *      由 `npm run build:assets` 打指纹后写入 R2 的 `theme/app.<hash>.js`。
 *   2. **纯增量**。脚本不跑，页面必须完全可用（阅读所需的样式全在 CSS 里）。
 *      高亮失败、语言不认识、代码块过长，都安静地什么都不做，绝不留下半截 DOM。
 *   3. **不碰正文的其余部分**。只扫 `pre > code[class*="language-"]`，
 *      用的是 textContent + createTextNode，没有任何 innerHTML 拼接。
 *
 * 做三件事：
 *   - 暗色/亮色切换（选择存 localStorage；首屏应用由 `<head>` 里的内联脚本负责，避免闪白）
 *   - 代码块轻量语法高亮：只处理 markdown-it 打了 `language-xxx` 的围栏代码块
 *   - 文章目录的滚动高亮（只给宽屏右栏那一个目录上色，窄屏的 `<details>` 不动）
 */

(function () {
	'use strict';

	var root = document.documentElement;

	// ----------------------------------------------------------------------
	// 暗色 / 亮色切换
	// ----------------------------------------------------------------------

	var toggle = document.querySelector('[data-theme-toggle]');
	if (toggle) {
		toggle.addEventListener('click', function () {
			// 用户还没手动选过时，以系统偏好为起点，这样第一次点击一定是「切换到另一边」
			var current =
				root.getAttribute('data-theme') ||
				(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
			var next = current === 'dark' ? 'light' : 'dark';
			root.setAttribute('data-theme', next);
			try {
				window.localStorage.setItem('theme', next);
			} catch (error) {
				// 隐私模式/禁用存储时 setItem 会抛错。忽略：本次会话内切换依然生效
			}
		});
	}

	// ----------------------------------------------------------------------
	// 文章目录滚动高亮
	// ----------------------------------------------------------------------

	/**
	 * 目录与锚点都是**服务端**产出的（见 theme/toc.ts），这里只负责上色。
	 * 脚本不跑、或者锚点 id 被改坏，目录依然是可点的链接 —— 只是没有高亮。
	 *
	 * 只处理后端渲染的那份目录（`.post-toc`）：窄屏那份是 `<details>` 里的，用户点开
	 * 才看，而窄屏下 `.post-toc` 是 `display:none`，这里就该跳过、不做无用的滚动监听。
	 *
	 * ⚠️ 判断「看得见吗」**不要用 `offsetParent`**。它现在恒为 null 的情况虽然没了
	 * （`.post-toc` 是 `position: sticky`），但曾经用 `position: fixed` 定位时
	 * `offsetParent` 恒为 `null`，宽屏下整个滚动高亮被**静默关掉** —— 不报错、目录照常
	 * 显示可点，只是永远不亮。`getClientRects()` 对 `display:none` 返回空列表、
	 * 对定位元素正常返回，直接判「占不占位置」，不依赖定位方式。
	 */
	var tocBox = document.querySelector('.post-toc');
	if (tocBox && tocBox.getClientRects().length > 0) {
		var tocLinks = {};
		var tocAnchors = tocBox.querySelectorAll('.toc-list a');
		for (var t = 0; t < tocAnchors.length; t++) {
			var href = tocAnchors[t].getAttribute('href') || '';
			if (href.charAt(0) !== '#') continue;
			try {
				tocLinks[decodeURIComponent(href.slice(1))] = tocAnchors[t];
			} catch (error) {
				// href 里有裸 `%` 时 decodeURIComponent 会抛错，退回原样匹配
				tocLinks[href.slice(1)] = tocAnchors[t];
			}
		}

		var headings = document.querySelectorAll('.post-content h2[id], .post-content h3[id]');
		if (headings.length > 0) {
			var highlighted = null;

			var sync = function () {
				// 「当前小节」= 视口顶部往下 100px 之内最后一个标题；滚动位置在第一个标题之前时算第一节
				var currentId = headings[0].id;
				for (var h = 0; h < headings.length; h++) {
					if (headings[h].getBoundingClientRect().top > 100) break;
					currentId = headings[h].id;
				}

				var next = tocLinks[currentId] || null;
				if (next === highlighted) return;
				if (highlighted) highlighted.classList.remove('is-active');
				if (next) next.classList.add('is-active');
				highlighted = next;
			};

			// 滚动事件很密，合并到每一帧做一次（顺带避免读 getBoundingClientRect 造成的抖动）
			var queued = false;
			var onScroll = function () {
				if (queued) return;
				queued = true;
				window.requestAnimationFrame(function () {
					queued = false;
					sync();
				});
			};

			window.addEventListener('scroll', onScroll, { passive: true });
			window.addEventListener('resize', onScroll);
			sync();
		}
	}

	// ----------------------------------------------------------------------
	// 轻量语法高亮
	// ----------------------------------------------------------------------

	/** 正则元字符转义（行注释前缀用） */
	function escapeRe(text) {
		return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/** 引号字符串：支持反斜杠转义；`multiline` 为真时允许跨行（模板串、Go 反引号） */
	function quoted(quote, multiline) {
		return quote + '(?:\\\\.|[^\\\\' + quote + (multiline ? '' : '\\n') + '])*' + quote;
	}

	/** 三引号字符串（Python） */
	function triple(quote) {
		return quote + quote + quote + '[\\s\\S]*?' + quote + quote + quote;
	}

	var JS_KEYWORDS =
		'await async break case catch class const continue default delete do else export extends finally for from ' +
		'function if import in instanceof let new of return static super switch this throw try typeof var void ' +
		'while yield null undefined true false';

	/**
	 * 语言表。刻意只收「有把握」的语言：正文里出现别的语言（`language-html`、
	 * `language-yaml`…）就整块保持原样 —— 乱上色比不上色更糟。
	 */
	var LANGS = {
		javascript: {
			kw: JS_KEYWORDS,
			line: ['//'],
			block: true,
			strings: [quoted("'"), quoted('"'), quoted('`', true)],
		},
		go: {
			kw:
				'break case chan const continue default defer else fallthrough for func go goto if import interface ' +
				'map package range return select struct switch type var nil true false make new len cap append copy ' +
				'delete panic recover',
			line: ['//'],
			block: true,
			strings: [quoted('"'), quoted('`', true)],
		},
		php: {
			kw:
				'abstract and array as break case catch class clone const continue declare default die do echo else ' +
				'elseif empty extends final finally fn for foreach function global goto if implements include ' +
				'include_once instanceof interface isset list namespace new or print private protected public ' +
				'require require_once return static switch throw trait try unset use while yield true false null',
			line: ['//', '#'],
			block: true,
			strings: [quoted("'"), quoted('"')],
		},
		python: {
			kw:
				'and as assert async await break class continue def del elif else except finally for from global if ' +
				'import in is lambda nonlocal not or pass raise return try while with yield None True False self',
			line: ['#'],
			block: false,
			strings: [triple('"'), triple("'"), quoted('"'), quoted("'")],
		},
		sql: {
			kw:
				'select from where insert into values update set delete join left right inner outer full on as group ' +
				'by order having limit offset union all distinct and or not null is like in between exists case when ' +
				'then else end create table primary key foreign references default index drop alter add column count ' +
				'sum avg min max',
			line: ['--'],
			block: true,
			strings: ["'(?:''|[^'])*'", '"(?:""|[^"])*"'],
		},
		bash: {
			kw:
				'if then else elif fi for while until do done case esac function return export local readonly declare ' +
				'echo cd exit source alias unset set trap',
			line: ['#'],
			block: false,
			strings: [quoted("'"), quoted('"')],
		},
		json: {
			kw: 'true false null',
			line: [],
			block: false,
			strings: [quoted('"')],
		},
		css: {
			line: [],
			block: true,
			strings: [quoted('"'), quoted("'")],
		},
	};

	/** 围栏信息串 → 语言表键。`ts`/`jsx` 都按 JavaScript 处理 */
	var ALIASES = {
		js: 'javascript',
		javascript: 'javascript',
		mjs: 'javascript',
		cjs: 'javascript',
		jsx: 'javascript',
		ts: 'javascript',
		typescript: 'javascript',
		tsx: 'javascript',
		go: 'go',
		golang: 'go',
		php: 'php',
		phtml: 'php',
		py: 'python',
		python: 'python',
		sql: 'sql',
		mysql: 'sql',
		sqlite: 'sql',
		postgres: 'sql',
		postgresql: 'sql',
		sh: 'bash',
		shell: 'bash',
		zsh: 'bash',
		bash: 'bash',
		console: 'bash',
		json: 'json',
		jsonc: 'json',
		css: 'css',
		scss: 'css',
		less: 'css',
	};

	/** 把语言定义编译成一个「一次扫完」的正则：每个分支一个捕获组，组序号 → token class */
	function compile(spec) {
		var sources = [];
		var classes = [];

		var lines = spec.line || [];
		for (var i = 0; i < lines.length; i++) {
			sources.push('(' + escapeRe(lines[i]) + '[^\\n]*)');
			classes.push('tok-com');
		}
		if (spec.block) {
			sources.push('(\\/\\*[\\s\\S]*?\\*\\/)');
			classes.push('tok-com');
		}
		var strings = spec.strings || [];
		for (var j = 0; j < strings.length; j++) {
			sources.push('(' + strings[j] + ')');
			classes.push('tok-str');
		}
		sources.push('(\\b\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?\\b|\\b0[xX][0-9a-fA-F_]+\\b)');
		classes.push('tok-num');
		if (spec.kw) {
			sources.push('(\\b(?:' + spec.kw.split(' ').join('|') + ')\\b)');
			classes.push('tok-key');
		}

		return { source: sources.join('|'), classes: classes, groups: sources.length };
	}

	var COMPILED = {};

	/** 单个代码块着色。返回 false 表示「没动它」 */
	function paint(code) {
		var info = /language-([\w+#.-]+)/.exec(code.className || '');
		if (!info) return;
		var name = ALIASES[info[1].toLowerCase()];
		if (!name) return;

		var text = code.textContent || '';
		// 超长块直接放弃：几万字符跑正则会让低端机卡住，而阅读并不依赖高亮
		if (!text || text.length > 20000) return;

		var spec = COMPILED[name] || (COMPILED[name] = compile(LANGS[name]));
		var re = new RegExp(spec.source, 'g');
		var fragment = document.createDocumentFragment();
		var last = 0;
		var painted = false;
		var match;

		while ((match = re.exec(text)) !== null) {
			// 空匹配会让 lastIndex 不动 → 死循环。语言表里不该出现，留个保险
			if (match[0] === '') {
				re.lastIndex++;
				continue;
			}
			if (match.index > last) fragment.appendChild(document.createTextNode(text.slice(last, match.index)));

			var group = 1;
			while (group <= spec.groups && match[group] === undefined) group++;

			var span = document.createElement('span');
			span.className = spec.classes[group - 1] || 'tok-key';
			span.textContent = match[0];
			fragment.appendChild(span);

			last = match.index + match[0].length;
			painted = true;
		}

		if (!painted) return;
		if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));

		code.textContent = '';
		code.appendChild(fragment);
	}

	function highlightAll() {
		var blocks = document.querySelectorAll('pre > code[class*="language-"]');
		for (var i = 0; i < blocks.length; i++) {
			try {
				paint(blocks[i]);
			} catch (error) {
				// 单个块出问题不该影响其它块，更不该影响页面
			}
		}
	}

	// 这个脚本带 defer，执行时 DOM 已经解析完；保险起见还是判断一下
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', highlightAll);
	} else {
		highlightAll();
	}
})();
