/**
 * 文章编辑器 —— 设计文档 §6.1（保存即发布）/ §10（草稿、定时发布）/ §9（附件）
 *
 * 布局与交互仿 Typecho write-post：左边写内容（标题 / 缩略名 / 正文 / 摘要），
 * 右边是「选项」与「附件」两个 tab（状态、发布时间、类型、分类标签、上传与插入）。
 * 表单是纯 SSR + 浏览器原生控件，没有前端框架（§0「后台形态：SSR 表单 + 少量原生 JS」）。
 * 提交后由 `routes/admin.ts` 调发布流水线，而不是在这里拼 HTML。
 */

import type { AttachmentRow, EditorView } from '../models/content';
import type { TermRecord } from '../publish/types';
import { formatDateTimeLocal } from '../lib/time';
import { AdminLayout } from './layout';

export interface PostEditorPageProps {
	post?: EditorView;
	categories: TermRecord[];
	/** 已挂在这篇文章上的附件（右侧「附件」tab 的初始清单；新建时为空） */
	attachments: AttachmentRow[];
	/** 静态资源域名：附件插入正文用的是完整地址（预览与前台都指向它，与站点域名解耦） */
	staticUrl: string;
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

/** 附件大小（与媒体库页同一口径：MB / KB / B） */
function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${bytes} B`;
}

function isImageAttachment(mime: string | null): boolean {
	return (mime ?? '').startsWith('image/');
}

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
 * 编辑器脚本（仿 Typecho write-post 的交互，§0「SSR 表单 + 少量原生 JS」）：
 *   ① Markdown 工具栏：包裹选区 / 行前缀 / 插入分割线与 <!--more-->
 *   ② 撰写/预览 tab：预览内容 POST /admin/preview（发布同款渲染器，服务端渲染）
 *   ③ 「图片」「链接」按钮都是**手填地址**的弹窗（Typecho 的 wmd prompt 同款）；
 *      本地图片走右侧「附件」tab：上传 → 弹出插入（可取消）→ 之后随时点列表里的
 *      文件名重新插入，列表项还能快捷删除
 * 约束：纯原生 JS、零依赖；文本改动用 setRangeText（execCommand 已废弃），
 * 代价是绕过原生 undo 栈 —— 简易按钮换来的取舍。
 *
 * `postCid` 是编辑中的文章 cid（新建为 0）：上传时带上，附件直接挂在文章上。
 */
export function editorScript(postCid: number): string {
	return `
(function () {
  var POST_CID = ${postCid};
  var textarea = document.getElementById('body');
  var toolbar = document.getElementById('editor-toolbar');
  var preview = document.getElementById('md-preview');
  var status = document.getElementById('editor-status');
  var fileList = document.getElementById('file-list');
  var fileInput = document.getElementById('file-input');
  var fileCount = document.getElementById('file-count');
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

  /** 手填地址的弹窗（Typecho 的 wmd prompt 同款）：取消就是不插入 */
  function promptFor(what, preset) {
    return window.prompt(what, preset || '');
  }

  var commands = {
    bold: function () { wrap('**', '**', '加粗文字'); },
    italic: function () { wrap('*', '*', '斜体文字'); },
    code: function () { wrap('\`', '\`', '代码'); },
    codeblock: function () { wrap('\\n\`\`\`\\n', '\\n\`\`\`\\n', '代码块'); },
    // 图片：只手填地址（本地图片请到右侧「附件」上传），描述取选区或留空
    image: function () {
      var selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
      var url = promptFor('插入图片：请输入图片地址（本地图片请到右侧「附件」上传）', 'https://');
      if (!url) return;
      var alt = selected || promptFor('图片描述（可留空）：', '') || '';
      insertText('![' + alt + '](' + url + ')');
    },
    link: function () {
      var selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
      var url = promptFor('插入链接：请输入链接地址', 'https://');
      if (!url) return;
      var text = selected || promptFor('链接文字（留空则用地址）：', '') || url;
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

  // ---- 右侧「附件」tab：上传 / 插入 / 删除 ----
  function setStatus(msg) { if (status) status.textContent = msg || ''; }

  function updateFileCount() {
    if (!fileCount || !fileList) return;
    var n = fileList.querySelectorAll('li[data-cid]').length;
    fileCount.textContent = String(n);
    fileCount.style.display = n > 0 ? '' : 'none';
  }

  function altOf(name) { return name.replace(/\\.[^.]+$/, ''); }

  /** Markdown 链接里的空格会把语法截断（截图文件名常带空格）→ 只转义空格，其余原样 */
  function mdUrl(url) { return url.replace(/ /g, '%20'); }

  /** 插入已上传的附件：弹窗预填地址，取消则只留在列表里（之后点文件名可再插） */
  function insertUploaded(url, name, isImage) {
    if (isImage) {
      var finalUrl = promptFor('插入图片（取消则只保留在「附件」里，之后点文件名可再插）', url);
      if (finalUrl) insertText('![' + altOf(name) + '](' + mdUrl(finalUrl) + ')');
    } else {
      var link = promptFor('插入文件链接', url);
      if (link) insertText('[' + name + '](' + mdUrl(link) + ')');
    }
  }

  function makeItem(cid, url, name, sizeText, isImage) {
    var li = document.createElement('li');
    li.setAttribute('data-cid', String(cid));
    li.setAttribute('data-url', url);
    li.setAttribute('data-name', name);
    li.setAttribute('data-image', isImage ? '1' : '0');

    var insert = document.createElement('a');
    insert.className = 'insert';
    insert.setAttribute('href', '#');
    insert.textContent = name;

    var info = document.createElement('span');
    info.className = 'info';
    info.textContent = sizeText;

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'delete';
    del.textContent = '删除';

    // 随表单提交：文章保存后把这些附件挂到文章上（Typecho 的 attachment[] 同款）
    var hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.name = 'attachments[]';
    hidden.value = String(cid);

    li.appendChild(insert);
    li.appendChild(info);
    li.appendChild(del);
    li.appendChild(hidden);
    return li;
  }

  function removeItem(li) {
    if (!li) return;
    var cid = li.getAttribute('data-cid');
    if (!window.confirm('确认删除这个附件？正文里已经插入的引用不会变（会变成坏链）。')) return;
    fetch('/admin/attachments/' + cid + '/delete', { method: 'POST' })
      .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.j && r.j.error ? r.j.error : '删除失败');
        li.parentNode.removeChild(li);
        updateFileCount();
      })
      .catch(function (err) { setStatus(err.message); });
  }

  if (fileList) {
    fileList.addEventListener('click', function (e) {
      var del = e.target.closest('.delete');
      if (del) {
        e.preventDefault();
        removeItem(del.closest('li[data-cid]'));
        return;
      }
      var ins = e.target.closest('.insert');
      if (!ins) return;
      e.preventDefault();
      var li = ins.closest('li[data-cid]');
      insertUploaded(
        li.getAttribute('data-url'),
        li.getAttribute('data-name'),
        li.getAttribute('data-image') === '1'
      );
    });
    updateFileCount();
  }

  function uploadFiles(files) {
    var list = Array.prototype.slice.call(files);
    if (!list.length) return;
    var remaining = list.length;
    setStatus('正在上传 ' + remaining + ' 个文件…');
    list.forEach(function (file) {
      var li = document.createElement('li');
      li.className = 'loading';
      li.textContent = file.name;
      if (fileList) fileList.insertBefore(li, fileList.firstChild);

      var data = new FormData();
      data.append('file', file);
      if (POST_CID) data.append('cid', String(POST_CID));
      fetch('/admin/media/upload', { method: 'POST', body: data })
        .then(function (res) {
          return res.json().then(function (json) { return { ok: res.ok, json: json }; });
        })
        .then(function (r) {
          if (!r.ok) throw new Error(r.json && r.json.error ? r.json.error : '上传失败');
          var size = file.size >= 1024 ? Math.round(file.size / 1024) + ' KB' : file.size + ' B';
          var item = makeItem(r.json.cid, r.json.url, r.json.name, size, r.json.isImage);
          li.parentNode.replaceChild(item, li);
          updateFileCount();
          // 上传完弹插入（Typecho 同款）；取消也只是不插，列表项仍在
          insertUploaded(r.json.url, r.json.name, r.json.isImage);
        })
        .catch(function (err) {
          li.className = 'error';
          li.textContent = file.name + '：' + err.message;
          setTimeout(function () { if (li.parentNode) li.parentNode.removeChild(li); }, 4000);
        })
        .then(function () {
          remaining--;
          if (remaining === 0 && status && !status.textContent.includes('失败')) setStatus('');
        });
    });
  }

  // 「上传」按钮 / 拖入上传区
  var uploadBtn = document.getElementById('btn-upload');
  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      uploadFiles(fileInput.files);
      fileInput.value = '';
    });
  }
  var uploadArea = document.getElementById('upload-area');
  if (uploadArea) {
    ['dragenter', 'dragover'].forEach(function (type) {
      uploadArea.addEventListener(type, function (e) { e.preventDefault(); uploadArea.classList.add('drag'); });
    });
    ['dragleave', 'dragend'].forEach(function (type) {
      uploadArea.addEventListener(type, function () { uploadArea.classList.remove('drag'); });
    });
    uploadArea.addEventListener('drop', function (e) {
      e.preventDefault();
      uploadArea.classList.remove('drag');
      if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
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

  // 拖文件进正文框（Typecho 只在上传区有，但拖到正文上没反应更奇怪）
  textarea.addEventListener('dragover', function (e) { e.preventDefault(); });
  textarea.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      e.preventDefault();
      uploadFiles(e.dataTransfer.files);
    }
  });

  // ---- 右侧两个 tab 的切换 ----
  var sideTabs = document.querySelectorAll('.side-tabs button[data-side-tab]');
  for (var k = 0; k < sideTabs.length; k++) {
    sideTabs[k].addEventListener('click', function () {
      var name = this.getAttribute('data-side-tab');
      for (var m = 0; m < sideTabs.length; m++) {
        sideTabs[m].classList.toggle('active', sideTabs[m] === this);
      }
      var optionsPane = document.getElementById('side-options');
      var filesPane = document.getElementById('side-files');
      if (!optionsPane || !filesPane) return;
      var isFiles = name === 'files';
      optionsPane.hidden = isFiles;
      filesPane.hidden = !isFiles;
    });
  }
})();
`;
}

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
			<form method="post" action={action} class="editor-grid">
				{/* ---------------- 左栏：内容 ---------------- */}
				<div class="editor-main">
					<div>
						<label for="title">标题</label>
						<input type="text" id="title" name="title" value={post?.title ?? ''} required />
					</div>

					<div>
						<label for="slug">缩略名（URL 片段）</label>
						<input type="text" id="slug" name="slug" value={post?.slug ?? ''} />
						<p class="hint">
							留空则用 cid；改它会让旧链接变成 canonical 页（§5.1 方案 A）；
							独立页面 slug 为 <code>about</code> 时会出现在前台顶栏「关于」
						</p>
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
							<button type="button" data-cmd="image" title="插入图片（手填地址）">
								图片
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
						</div>
						<textarea id="body" name="body" class="body">
							{post?.body ?? ''}
						</textarea>
						<div id="md-preview" class="md-preview" hidden />
						<p class="hint">
							正文里的原生 HTML 会保留，但写入前会过一遍白名单清洗（§8.3）；
							「图片」按钮填的是外部图片地址，本地图片请到右侧「附件」上传
						</p>
					</div>

					<div>
						<label for="excerpt">自定义摘要</label>
						<textarea id="excerpt" name="excerpt" rows={3}>
							{post?.excerpt ?? ''}
						</textarea>
						<p class="hint">
							支持 Markdown，首页按渲染后的样式展示；留空则取正文里{' '}
							<code>&lt;!--more--&gt;</code> 前的部分（Typecho 惯例），也没有就整篇当摘要
						</p>
					</div>

					{/* 操作按钮在**左栏底部**（Typecho 的 .submit 同款位置）——
					    放右栏的话，切到「附件」tab 就看不见保存了 */}
					{/* 靠右排（Typecho 的 .submit 同款）：次要操作在左，主操作在最右 */}
					<div class="actions">
						<a class="button" href="/admin">
							返回列表
						</a>
						{post ? (
							<a class="button" href={`/preview/${post.cid}`} target="_blank">
								预览
							</a>
						) : null}
						<button type="submit">{isNew ? '保存' : '保存并发布'}</button>
					</div>
				</div>

				{/* ---------------- 右栏：选项 / 附件 ---------------- */}
				<aside class="editor-side">
					<div class="side-tabs" role="tablist">
						<button type="button" class="active" data-side-tab="options">
							选项
						</button>
						<button type="button" data-side-tab="files">
							附件
							<span id="file-count" class="balloon">
								{props.attachments.length}
							</span>
						</button>
					</div>

					<div id="side-options" class="side-pane">
						<div class="side-field">
							<label for="status">状态</label>
							<select id="status" name="status">
								{STATUS_OPTIONS.map((option) => (
									<option value={option.value} selected={status === option.value}>
										{option.label}
									</option>
								))}
							</select>
						</div>

						<div class="side-field">
							<label for="created">发布时间（站点时区）</label>
							<input
								type="datetime-local"
								id="created"
								name="created"
								value={formatDateTimeLocal(created, props.timezoneOffset)}
							/>
						</div>

						<div class="side-field">
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

						{/* 独立页面没有分类/标签（Typecho 语义）；选「独立页面」时整块收起，保存端也一并忽略 */}
						<div id="terms-row" style={type === 'page' ? 'display:none' : undefined}>
							<div class="side-field">
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

							<div class="side-field">
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

						<div class="side-field">
							<label class="hint" style="font-weight:400">
								<input
									type="checkbox"
									name="allow_feed"
									value="1"
									checked={(post?.allow_feed ?? 1) === 1}
								/>{' '}
								允许进入 RSS
							</label>
						</div>
					</div>

					<div id="side-files" class="side-pane" hidden>
						<div class="upload-area" id="upload-area">
							<button type="button" id="btn-upload">
								点击上传
							</button>
							<span class="hint">或把文件拖进来</span>
							{/* 无 name：只给脚本用，绝不随表单提交 */}
							<input type="file" id="file-input" accept="image/*,application/pdf" multiple hidden />
						</div>
						<p class="hint">
							白名单 jpg / png / webp / gif / avif / pdf，单个 ≤ 10MB；同名文件不可覆盖
						</p>

						<ul id="file-list" class="file-list">
							{props.attachments.map((file) => (
								<li
									data-cid={String(file.cid)}
									data-url={`${props.staticUrl}/${file.r2_key}`}
									data-name={file.title || file.r2_key}
									data-image={isImageAttachment(file.mime) ? '1' : '0'}
								>
									<a class="insert" href="#">
										{file.title || file.r2_key}
									</a>
									<span class="info">{formatSize(file.size)}</span>
									<button type="button" class="delete">
										删除
									</button>
									<input type="hidden" name="attachments[]" value={String(file.cid)} />
								</li>
							))}
						</ul>
						<p class="hint">
							点文件名插入正文（可反复插入，取消也留在这里）；删除只删附件本身，
							正文里已经插入的引用不会变
						</p>
					</div>
				</aside>
			</form>

			{/* 类型切到「独立页面」时收起分类/标签（服务端对页面本来就忽略这两样）。
			    编辑器脚本见上面 editorScript 的说明。
			    内联脚本必须 dangerouslySetInnerHTML——JSX 转义会让 raw text 元素里出现 &#39; */}
			<script dangerouslySetInnerHTML={{ __html: TYPE_SCRIPT }} />
			<script dangerouslySetInnerHTML={{ __html: editorScript(post?.cid ?? 0) }} />
		</AdminLayout>
	);
}
