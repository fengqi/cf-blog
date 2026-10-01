/**
 * 文章编辑器 —— 设计文档 §6.1（保存即发布）/ §10（草稿、定时发布）
 *
 * 表单是纯 SSR + 浏览器原生控件，没有前端框架（§0「后台形态：SSR 表单 + 少量原生 JS」）。
 * 提交后由 `routes/admin.ts` 调发布流水线，而不是在这里拼 HTML。
 */

import type { EditorView } from '../models/content';
import type { TermRecord } from '../publish/types';
import { formatDateTimeLocal } from '../lib/time';
import { AdminLayout } from './layout';

export interface PostEditorPageProps {
	post?: EditorView;
	categories: TermRecord[];
	user: { screen_name: string | null; username: string };
	timezoneOffset: number;
	message?: string;
	error?: string;
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
	{ value: 'publish', label: '发布' },
	{ value: 'draft', label: '草稿' },
	{ value: 'waiting', label: '定时发布（到点由 Cron 转正）' },
	{ value: 'hidden', label: '隐藏（不进列表）' },
];

/** 类型切换收起分类/标签的内联脚本（必须 dangerouslySetInnerHTML，见 layout.tsx 的说明） */
const TYPE_SCRIPT = `
(function () {
  var typeSelect = document.getElementById('type');
  var termsRow = document.getElementById('terms-row');
  if (!typeSelect || !termsRow) return;
  function syncTerms() {
    termsRow.style.display = typeSelect.value === 'page' ? 'none' : '';
  }
  typeSelect.addEventListener('change', syncTerms);
  syncTerms();
})();
`;

/**
 * 编辑器增强（仿 Typecho write-post 的简版，§0「SSR 表单 + 少量原生 JS」）：
 *   ① Markdown 工具栏：包裹选区 / 行前缀 / 插入分割线与 <!--more-->
 *   ② 撰写/预览 tab：预览内容 POST /admin/preview（发布同款渲染器，服务端渲染）
 *   ③ 快速传图：工具栏按钮 / 拖拽文件进正文框 / 粘贴剪贴板截图 →
 *      POST /admin/media/upload → 在光标处插入 ![](url) 或 [](url)
 * 约束：纯原生 JS、零依赖；文本改动用 setRangeText（execCommand 已废弃），
 * 代价是绕过原生 undo 栈 —— 简易按钮换来的取舍。
 */
const EDITOR_SCRIPT = `
(function () {
  var textarea = document.getElementById('body');
  var toolbar = document.getElementById('editor-toolbar');
  var preview = document.getElementById('md-preview');
  var status = document.getElementById('editor-status');
  var imageInput = document.getElementById('image-input');
  if (!textarea || !toolbar) return;

  // ---- 光标处插入：setRangeText + 手动派发 input ----
  function insertText(text) {
    textarea.focus();
    textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** 包裹选区；无选区时插入占位文字并选中（方便直接打字替换） */
  function wrap(before, after, placeholder) {
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var selected = textarea.value.slice(start, end);
    if (selected) {
      insertText(before + selected + after);
    } else {
      insertText(before + placeholder + after);
      var s = textarea.selectionEnd - after.length - placeholder.length;
      textarea.setSelectionRange(s, s + placeholder.length);
    }
  }

  /** 行前缀命令（引用/标题/列表）：作用于选区覆盖的每一行；numbered 时配 1. 2. 3. */
  function linePrefix(prefix, numbered) {
    var v = textarea.value;
    var lineStart = v.lastIndexOf('\\n', textarea.selectionStart - 1) + 1;
    var lineEnd = v.indexOf('\\n', textarea.selectionEnd);
    if (lineEnd < 0) lineEnd = v.length;
    var lines = v.slice(lineStart, lineEnd).split('\\n');
    var out = lines
      .map(function (line, i) { return numbered ? i + 1 + '. ' + line : prefix + line; })
      .join('\\n');
    textarea.focus();
    textarea.setRangeText(out, lineStart, lineEnd, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  var commands = {
    bold: function () { wrap('**', '**', '加粗文字'); },
    italic: function () { wrap('*', '*', '斜体文字'); },
    code: function () { wrap('\`', '\`', '代码'); },
    codeblock: function () { wrap('\\n\`\`\`\\n', '\\n\`\`\`\\n', '代码块'); },
    link: function () {
      var selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
      var url = window.prompt('链接地址：', 'https://');
      if (!url) return;
      var text = selected || window.prompt('链接文字（留空则用地址）：', '') || url;
      insertText('[' + text + '](' + url + ')');
    },
    quote: function () { linePrefix('> '); },
    heading: function () { linePrefix('## '); },
    ul: function () { linePrefix('- '); },
    ol: function () { linePrefix('', true); },
    hr: function () { insertText('\\n\\n---\\n\\n'); },
    more: function () { insertText('\\n\\n<!--more-->\\n\\n'); }
  };

  toolbar.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-cmd]');
    if (!btn) return;
    e.preventDefault();
    var fn = commands[btn.getAttribute('data-cmd')];
    if (fn) fn();
  });

  // 快捷键：B / I / K（与 Typecho 的 pagedown 一致）
  textarea.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    var key = e.key.toLowerCase();
    if (key === 'b') { e.preventDefault(); commands.bold(); }
    else if (key === 'i') { e.preventDefault(); commands.italic(); }
    else if (key === 'k') { e.preventDefault(); commands.link(); }
  });

  // ---- 撰写 / 预览 tab ----
  var tabs = document.querySelectorAll('.editor-tabs button[data-tab]');
  var previewTimer = null;

  function refreshPreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      preview.textContent = '正在渲染…';
      var data = new FormData();
      data.append('body', textarea.value);
      fetch('/admin/preview', { method: 'POST', body: data })
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); })
        .then(function (html) { preview.innerHTML = html; })
        .catch(function () { preview.textContent = '预览失败，请稍后重试'; });
    }, 250);
  }

  function showTab(name) {
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
    }
    if (name === 'preview') {
      toolbar.style.display = 'none';
      textarea.style.display = 'none';
      preview.hidden = false;
      refreshPreview();
    } else {
      toolbar.style.display = '';
      textarea.style.display = '';
      preview.hidden = true;
    }
  }

  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function () { showTab(this.getAttribute('data-tab')); });
  }

  // ---- 快速传图：上传 → 光标处插入 ----
  function setStatus(msg) { if (status) status.textContent = msg || ''; }

  function insertAttachment(file, attachment) {
    var alt = file.name.replace(/\\.[^.]+$/, '');
    var md = attachment.isImage
      ? '![' + alt + '](' + attachment.url + ')'
      : '[' + file.name + '](' + attachment.url + ')';
    insertText('\\n' + md + '\\n');
  }

  function uploadFiles(files) {
    var list = Array.prototype.slice.call(files);
    if (!list.length) return;
    var remaining = list.length;
    setStatus('正在上传 ' + remaining + ' 个文件…');
    list.forEach(function (file) {
      var data = new FormData();
      data.append('file', file);
      fetch('/admin/media/upload', { method: 'POST', body: data })
        .then(function (res) {
          return res.json().then(function (json) { return { ok: res.ok, json: json }; });
        })
        .then(function (r) {
          if (!r.ok) throw new Error(r.json && r.json.error ? r.json.error : '上传失败');
          insertAttachment(file, r.json);
        })
        .catch(function (err) { setStatus(file.name + ' 上传失败：' + err.message); })
        .then(function () {
          remaining--;
          if (remaining === 0 && !status.textContent.includes('失败')) setStatus('');
        });
    });
  }

  // 工具栏「图片」按钮 → 文件选择框
  var uploadBtn = document.getElementById('btn-image');
  if (uploadBtn && imageInput) {
    uploadBtn.addEventListener('click', function () { imageInput.click(); });
    imageInput.addEventListener('change', function () {
      uploadFiles(imageInput.files);
      imageInput.value = '';
    });
  }

  // 粘贴剪贴板里的图片（截图直接 Ctrl+V）
  textarea.addEventListener('paste', function (e) {
    var items = (e.clipboardData || {}).items;
    if (!items) return;
    var files = [];
    for (var j = 0; j < items.length; j++) {
      if (items[j].kind !== 'file') continue;
      var file = items[j].getAsFile();
      if (!file || file.size === 0) continue;
      if (!file.name) {
        // 剪贴板截图常没有文件名；服务端按扩展名判白名单，这里补一个
        var ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        file = new File([file], 'paste-' + Date.now() + '.' + ext, { type: file.type });
      }
      files.push(file);
    }
    if (files.length) {
      e.preventDefault();
      uploadFiles(files);
    }
  });

  // 拖文件进正文框
  textarea.addEventListener('dragover', function (e) { e.preventDefault(); });
  textarea.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      e.preventDefault();
      uploadFiles(e.dataTransfer.files);
    }
  });
})();
`;

export function PostEditorPage(props: PostEditorPageProps) {
	const post = props.post;
	const isNew = !post;
	const action = isNew ? '/admin/posts' : `/admin/posts/${post.cid}`;
	// 新建时默认「草稿」：先落库再决定发布，比一上来就写 R2 稳
	const status = post?.status ?? 'draft';
	const created = post?.created ?? Math.floor(Date.now() / 1000);
	const type = post?.type ?? 'post';

	return (
		<AdminLayout
			title={isNew ? '写文章 · 博客后台' : `编辑：${post.title} · 博客后台`}
			user={props.user}
			message={props.message}
			error={props.error}
		>
			<form method="post" action={action} class="stack">
				<div>
					<label for="title">标题</label>
					<input type="text" id="title" name="title" value={post?.title ?? ''} required />
				</div>

				<div class="row">
					<div>
						<label for="slug">缩略名（URL 片段）</label>
						<input type="text" id="slug" name="slug" value={post?.slug ?? ''} />
						<p class="hint">
							留空则用 cid；改它会让旧链接变成 canonical 页（§5.1 方案 A）；
							独立页面 slug 为 <code>about</code> 时会出现在前台顶栏「关于」
						</p>
					</div>
					<div>
						<label for="type">类型</label>
						<select id="type" name="type">
							<option value="post" selected={type === 'post'}>
								文章（/&lt;分类&gt;/&lt;缩略名&gt;.html）
							</option>
							<option value="page" selected={type === 'page'}>
								独立页面（/&lt;缩略名&gt;.html）
							</option>
						</select>
					</div>
				</div>

				<div class="row">
					<div>
						<label for="status">状态</label>
						<select id="status" name="status">
							{STATUS_OPTIONS.map((option) => (
								<option value={option.value} selected={status === option.value}>
									{option.label}
								</option>
							))}
						</select>
					</div>
					<div>
						<label for="created">发布时间（站点时区）</label>
						<input
							type="datetime-local"
							id="created"
							name="created"
							value={formatDateTimeLocal(created, props.timezoneOffset)}
						/>
					</div>
				</div>

			<div>
				<label for="body">正文（Markdown）</label>
				<div class="editor-tabs" role="tablist">
					<button type="button" class="active" data-tab="write">
						撰写
					</button>
					<button type="button" data-tab="preview">
						预览
					</button>
					<span id="editor-status" class="status" aria-live="polite" />
				</div>
				<div id="editor-toolbar" class="editor-toolbar">
					<button type="button" data-cmd="bold" title="加粗（Ctrl+B）">
						<strong>B</strong>
					</button>
					<button type="button" data-cmd="italic" title="斜体（Ctrl+I）">
						<em>I</em>
					</button>
					<button type="button" data-cmd="link" title="链接（Ctrl+K）">
						链接
					</button>
					<button type="button" data-cmd="heading" title="标题（h2）">
						H2
					</button>
					<button type="button" data-cmd="quote" title="引用">
						引用
					</button>
					<button type="button" data-cmd="ul" title="无序列表">
						• 列表
					</button>
					<button type="button" data-cmd="ol" title="有序列表">
						1. 列表
					</button>
					<button type="button" data-cmd="code" title="行内代码">
						代码
					</button>
					<button type="button" data-cmd="codeblock" title="代码块">
						代码块
					</button>
					<button type="button" data-cmd="hr" title="分割线">
						---
					</button>
					<button type="button" data-cmd="more" title="摘要分割线（首页在此截断）">
						more
					</button>
					<button type="button" id="btn-image" title="上传图片并插入正文（也可拖拽 / 粘贴）">
						图片
					</button>
					{/* 无 name：这个 input 只给编辑器脚本用，绝不随表单提交 */}
					<input type="file" id="image-input" accept="image/*" multiple hidden />
				</div>
				<textarea id="body" name="body" class="body">
					{post?.body ?? ''}
				</textarea>
				<div id="md-preview" class="md-preview" hidden />
				<p class="hint">
					正文里的原生 HTML 会保留，但写入前会过一遍白名单清洗（§8.3）；
					图片支持工具栏上传、拖进正文框或直接粘贴截图
				</p>
			</div>

				<div>
					<label for="excerpt">自定义摘要</label>
					<textarea id="excerpt" name="excerpt" rows={3}>
						{post?.excerpt ?? ''}
					</textarea>
					<p class="hint">
						支持 Markdown，首页按渲染后的样式展示；留空则取正文里{' '}
						<code>&lt;!--more--&gt;</code> 前的部分（Typecho 惯例），也没有就自动截前 200 字
					</p>
				</div>

				{/* 独立页面没有分类/标签（Typecho 语义）；选「独立页面」时整块收起，保存端也一并忽略 */}
				<div class="row" id="terms-row" style={type === 'page' ? 'display:none' : undefined}>
					<div>
						<label>分类</label>
						{props.categories.map((term) => (
							<label class="hint" style="font-weight:400">
								<input
									type="checkbox"
									name="categories"
									value={String(term.mid)}
									checked={
										post
											? post.categoryIds.includes(term.mid)
											: term.mid === props.categories[0]?.mid // 新建时默认选中第一个分类
									}
								/>{' '}
								{term.name}
							</label>
						))}
						<p class="hint">
							文章 URL 里用的是<strong>第一个</strong>分类（按 mid 升序）
						</p>
					</div>
					<div>
						<label for="tags">标签（逗号分隔）</label>
						<input
							type="text"
							id="tags"
							name="tags"
							value={post?.tagNames.join(', ') ?? ''}
							placeholder="cloudflare, 踩坑记录"
						/>
					</div>
				</div>

				<label class="hint" style="font-weight:400">
					<input
						type="checkbox"
						name="allow_feed"
						value="1"
						checked={(post?.allow_feed ?? 1) === 1}
					/>{' '}
					允许进入 RSS
				</label>

				<div class="actions">
					<button type="submit">{isNew ? '保存' : '保存并发布'}</button>
					{post ? (
						<a class="button" href={`/preview/${post.cid}`} target="_blank">
							预览
						</a>
					) : null}
					<a class="button" href="/admin">
						返回列表
					</a>
				</div>
			</form>

			{/* 类型切到「独立页面」时收起分类/标签（服务端对页面本来就忽略这两样）。
			    编辑器脚本见文件头部 EDITOR_SCRIPT 的说明。
			    内联脚本必须 dangerouslySetInnerHTML——JSX 转义会让 raw text 元素里出现 &#39; */}
			<script dangerouslySetInnerHTML={{ __html: TYPE_SCRIPT }} />
			<script dangerouslySetInnerHTML={{ __html: EDITOR_SCRIPT }} />
		</AdminLayout>
	);
}
