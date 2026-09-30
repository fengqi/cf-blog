/**
 * 媒体库 —— design.md §9 / 待办 ④
 *
 * 上传（SSR multipart 表单）+ 列表 + 复制链接。列表数据来自 D1 的
 * type='attachment' 记录（迁移来的 62 个与新增的混在同一份清单里）。
 * 「复制」用几行原生 JS（§0：后台 = SSR 表单 + 少量原生 JS）。
 */

import type { AttachmentRow } from '../models/content';
import { formatDate } from '../../theme/layout';
import { AdminLayout } from './layout';

export interface MediaLibraryPageProps {
	attachments: AttachmentRow[];
	siteUrl: string;
	timezoneOffset: number;
	user: { screen_name: string | null; username: string };
	message?: string;
	error?: string;
}

/** 复制链接的内联脚本（必须 dangerouslySetInnerHTML，见 layout.tsx 的说明） */
const COPY_SCRIPT = `
document.addEventListener('click', function (event) {
  var button = event.target.closest('[data-copy]');
  if (!button) return;
  navigator.clipboard.writeText(button.getAttribute('data-copy')).then(function () {
    var original = button.textContent;
    button.textContent = '已复制';
    setTimeout(function () { button.textContent = original; }, 1200);
  });
});
`;

function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${bytes} B`;
}

export function MediaLibraryPage(props: MediaLibraryPageProps) {
	return (
		<AdminLayout
			title="媒体库 · 博客后台"
			user={props.user}
			message={props.message}
			error={props.error}
		>
			<form method="post" action="/admin/media" enctype="multipart/form-data" class="stack">
				<div>
					<label for="files">上传附件（可多选）</label>
					<input type="file" id="files" name="files" multiple />
					<p class="hint">
						白名单：jpg / png / webp / gif / avif / pdf，单个 ≤ 10MB；存到
						<code>/usr/uploads/&lt;年&gt;/&lt;月&gt;/</code>，文件名不变。附件是不可变的（immutable）
						—— <strong>同名文件不能覆盖</strong>，要换图就换个文件名
					</p>
				</div>
				<div class="actions">
					<button type="submit">上传</button>
				</div>
			</form>

			<h2 style="font-size:1rem;margin:1.5rem 0 .5rem">已上传（{props.attachments.length}）</h2>
			<table>
				<thead>
					<tr>
						<th>文件</th>
						<th>类型 / 大小</th>
						<th>时间</th>
						<th>链接</th>
					</tr>
				</thead>
				<tbody>
					{props.attachments.map((file) => {
						const url = `${props.siteUrl}/${file.r2_key}`;
						return (
							<tr>
								<td>
									<a href={url} target="_blank" rel="noreferrer">
										{file.title || file.r2_key}
									</a>
									<div class="hint">{file.r2_key}</div>
								</td>
								<td class="hint">
									{file.mime ?? '—'} · {formatSize(file.size)}
								</td>
								<td class="hint">{formatDate(file.created, props.timezoneOffset)}</td>
								<td>
									<div class="actions">
										<input
											type="text"
											readonly
											value={url}
											aria-label={`链接：${file.title || file.r2_key}`}
											style="flex:1;min-width:14rem;font-size:.8rem"
										/>
										<button type="button" data-copy={url}>
											复制
										</button>
									</div>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			{props.attachments.length === 0 ? <p class="hint">还没有附件。</p> : null}

			<script dangerouslySetInnerHTML={{ __html: COPY_SCRIPT }} />
		</AdminLayout>
	);
}
