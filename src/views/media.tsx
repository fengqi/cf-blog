/**
 * 媒体库 —— design.md §9 / 待办 ④
 *
 * **只有列表，不再提供上传**：上传入口统一在编辑器右侧「附件」tab（`/admin/media/upload`），
 * 那里传完能直接插进光标处，还能当场删；媒体库只负责回看和清理。
 * 列表数据来自 D1 的 type='attachment' 记录（迁移来的 62 个与新增的混在同一份清单里），
 * LEFT JOIN 出所属文章。
 */

import type { AttachmentRow } from '../models/content';
import { formatDate } from '../../theme/layout';
import { AdminLayout } from './layout';

export interface MediaLibraryPageProps {
	/** 当前这一页的附件 */
	attachments: AttachmentRow[];
	/** 附件总数（分页用；标题里显示的也是它，不是当页条数） */
	total: number;
	page: number;
	totalPages: number;
	siteUrl: string;
	timezoneOffset: number;
	user: { screen_name: string | null; username: string };
	message?: string;
	error?: string;
}

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
			<h1 class="page-head">
				媒体库
				{/* 条数/页次挂标题右侧：原来它自己占一行 h2，还带 1.5rem 上边距，
				    导致本页第一行比别的页低一截（切页时内容上下跳） */}
				<span class="note">
					已上传 {props.total}
					{props.totalPages > 1 ? ` · 第 ${props.page} / ${props.totalPages} 页` : ''}
				</span>
			</h1>
			<table>
				<thead>
					<tr>
						<th>文件</th>
						<th>类型 / 大小</th>
						<th>时间</th>
						<th>所属文章</th>
						<th>操作</th>
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
								<td class="hint">
									{file.parent_cid && file.parent_title ? (
										<a href={`/admin/posts/${file.parent_cid}/edit`}>{file.parent_title}</a>
									) : (
										'—'
									)}
								</td>
								<td>
									{/* 包一层 .actions：与文章/分类列表的删除按钮同尺寸 */}
									<div class="actions">
										<form
											method="post"
											action="/admin/media/delete"
											onsubmit="return confirm('确定删除这个附件？R2 上的文件和记录一起删，正文里引用它的地方会变坏链')"
										>
											<input type="hidden" name="cid" value={String(file.cid)} />
											<button class="danger" type="submit">
												删除
											</button>
										</form>
									</div>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			{props.attachments.length === 0 ? <p class="hint">还没有附件。</p> : null}

			{props.totalPages > 1 ? (
				<nav class="admin-pagination" aria-label="媒体库分页">
					{props.page > 1 ? (
						<a class="button" href={`/admin/media?page=${props.page - 1}`}>
							上一页
						</a>
					) : (
						<span class="button" aria-disabled="true">
							上一页
						</span>
					)}
					<span class="hint">
						第 {props.page} / {props.totalPages} 页
					</span>
					{props.page < props.totalPages ? (
						<a class="button" href={`/admin/media?page=${props.page + 1}`}>
							下一页
						</a>
					) : (
						<span class="button" aria-disabled="true">
							下一页
						</span>
					)}
				</nav>
			) : null}
		</AdminLayout>
	);
}
