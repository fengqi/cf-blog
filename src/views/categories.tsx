/**
 * 分类管理 —— design.md §4.1 / §4.3
 *
 * ⚠️ 分类 slug 直接嵌在每篇文章的 URL（/<category>/<slug>.html）里，而且是
 * 「主分类」（mid 最小的那个）决定 URL。所以：
 *   - 改 slug 会让挂在这个分类下的文章（作为主分类的那些）换地址 ——
 *     走 §5.1 方案 A（旧地址保留 canonical），影响面在 routes/admin.tsx 里算
 *   - 改名称/描述会改到文章页 byline 与归档页 —— 引用它的文章也要重渲
 * 影响面大不大取决于文章数，页面上把 count 显示出来就是给这个判断用的。
 */

import type { TermRecord } from '../publish/types';
import { AdminLayout } from './layout';

export interface CategoriesPageProps {
	categories: TermRecord[];
	user: { screen_name: string | null; username: string };
	message?: string;
	error?: string;
}

export function CategoriesPage(props: CategoriesPageProps) {
	return (
		<AdminLayout
			title="分类管理 · 博客后台"
			user={props.user}
			message={props.message}
			error={props.error}
		>
			<form method="post" action="/admin/categories" class="stack">
				<div class="row">
					<div>
						<label for="name">新分类名称</label>
						<input type="text" id="name" name="name" required />
					</div>
					<div>
						<label for="slug">缩略名（可空，默认用名称）</label>
						<input type="text" id="slug" name="slug" />
					</div>
					<div>
						<label for="description">描述（可空）</label>
						<input type="text" id="description" name="description" />
					</div>
				</div>
				<div class="actions">
					<button type="submit">创建分类</button>
				</div>
			</form>

			<h2 style="font-size:1rem;margin:1.5rem 0 .5rem">全部分类（{props.categories.length}）</h2>
			{/* 表单放在表格外面，单元格里的控件用 form 属性挂接 —— HTML 不允许 form 包 tr */}
			{props.categories.map((term) => (
				<form
					id={`edit-${term.mid}`}
					method="post"
					action={`/admin/categories/${term.mid}`}
					style="display:contents"
				/>
			))}
			{props.categories.map((term) => (
				<form id={`delete-${term.mid}`} method="post" action={`/admin/categories/${term.mid}/delete`} />
			))}
			<table>
				<thead>
					<tr>
						<th>名称</th>
						<th>缩略名（URL 片段）</th>
						<th>描述</th>
						<th>文章数</th>
						<th>操作</th>
					</tr>
				</thead>
				<tbody>
					{props.categories.map((term) => (
						<tr>
							<td>
								<input form={`edit-${term.mid}`} type="text" name="name" value={term.name} required />
							</td>
							<td>
								<input form={`edit-${term.mid}`} type="text" name="slug" value={term.slug} />
							</td>
							<td>
								<input
									form={`edit-${term.mid}`}
									type="text"
									name="description"
									value={term.description ?? ''}
								/>
							</td>
							<td class="hint">{term.count}</td>
							<td>
								<div class="actions">
									<button form={`edit-${term.mid}`} type="submit">
										保存
									</button>
									<button form={`delete-${term.mid}`} class="danger" type="submit">
										删除
									</button>
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<p class="hint">
				改缩略名会让以它为主分类的文章换地址（旧地址自动保留 canonical）；删除分类前，先把只挂在它下面的文章移走。
				保存后点文章列表的「全站重新渲染」一键刷全。
			</p>
		</AdminLayout>
	);
}
