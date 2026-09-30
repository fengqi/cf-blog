/**
 * 文章列表 —— 设计文档 §6.2 第 5 条 / §6.5
 *
 * 两个必须出现在这里的东西：
 *   - **「待同步」数量**：让作者看见 R2 写失败，而不是靠运气发现
 *   - **「全站重新渲染」按钮**：改了模板/样式之后刷历史文章的唯一入口
 */

import type { AdminPostRow } from '../models/content';
import { formatDate } from '../../theme/layout';
import { AdminLayout } from './layout';

export interface PostListPageProps {
	posts: AdminPostRow[];
	needsSync: number;
	user: { screen_name: string | null; username: string };
	message?: string;
	error?: string;
	siteTimezoneOffset?: number;
}

const STATUS_LABEL: Record<string, string> = {
	publish: '已发布',
	draft: '草稿',
	waiting: '待发布',
	hidden: '隐藏',
	private: '私密',
};

export function PostListPage(props: PostListPageProps) {
	const offset = props.siteTimezoneOffset ?? 8;
	return (
		<AdminLayout title="文章 · 博客后台" user={props.user} message={props.message} error={props.error}>
			<div class="actions" style="margin-bottom:1rem">
				<a class="button" href="/admin/posts/new">
					写文章
				</a>
				<form method="post" action="/admin/rebuild" id="rebuild-form">
					<button type="submit">全站重新渲染</button>
				</form>
				<span id="rebuild-progress" class="hint" role="status">
					{props.needsSync > 0 ? <span class="badge dirty">待同步 {props.needsSync}</span> : null}
				</span>
				<span class="hint">共 {props.posts.length} 条</span>
			</div>

			<table>
				<thead>
					<tr>
						<th>标题</th>
						<th>状态</th>
						<th>分类</th>
						<th>时间</th>
						<th>操作</th>
					</tr>
				</thead>
				<tbody>
					{props.posts.map((post) => (
						<tr>
							<td>
								<a href={`/admin/posts/${post.cid}/edit`}>{post.title || '(无标题)'}</a>
								{post.needs_sync ? <span class="badge dirty">待同步</span> : null}
								<div class="hint">
									{post.type === 'page' ? '独立页面' : '文章'} · {post.slug} · {post.words} 字
								</div>
							</td>
							<td>
								<span class={`badge ${post.status}`}>{STATUS_LABEL[post.status] ?? post.status}</span>
							</td>
							<td class="hint">
								{post.categories.map((term) => term.name).join('、') || '—'}
							</td>
							<td class="hint">{formatDate(post.created, offset)}</td>
							<td>
								<div class="actions">
									<a class="button" href={`/preview/${post.cid}`} target="_blank">
										预览
									</a>
									<form method="post" action={`/admin/posts/${post.cid}/delete`}>
										<button class="danger" type="submit">删除</button>
									</form>
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{props.posts.length === 0 ? <p class="hint">还没有内容。</p> : null}

			<script>{`
document.addEventListener('DOMContentLoaded', function () {
  var form = document.getElementById('rebuild-form');
  if (!form) return;
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var button = form.querySelector('button');
    var progress = document.getElementById('rebuild-progress');
    button.disabled = true;
    var offset = 0;
    var written = 0;
    var failed = [];
    function post(path, params) {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
        credentials: 'same-origin',
      }).then(function (response) { return response.json(); });
    }
    // 阶段一：分批重写全站对象（模板/导航/配置变更用）
    function rebuildFull() {
      return post('/admin/rebuild/full', { offset: String(offset), limit: '50' }).then(function (report) {
        written += report.written;
        failed = failed.concat(report.failed || []);
        progress.textContent = '重建中… ' + (report.offset + report.written) + ' / ' + report.total;
        if (report.nextOffset === null) return;
        offset = report.nextOffset;
        return rebuildFull();
      });
    }
    // 阶段二：补发「待同步」的内容（地址变更/写失败的对账），直到清零
    function drainDirty() {
      return post('/admin/rebuild/batch', { limit: '20' }).then(function (report) {
        written += report.objects;
        failed = failed.concat(report.failed || []);
        progress.textContent = '补发中… 剩余 ' + report.needsSync + ' 篇';
        if (report.needsSync > 0) return drainDirty();
      });
    }
    rebuildFull()
      .then(drainDirty)
      .then(function () {
        progress.textContent = '完成：' + written + ' 个对象' +
          (failed.length > 0 ? '，失败 ' + failed.length + ' 个（可重试）' : '');
        button.disabled = false;
      })
      .catch(function (error) {
        progress.textContent = '失败：' + error + '（可重试）';
        button.disabled = false;
      });
  });
});
`}</script>
		</AdminLayout>
	);
}
