/**
 * 改口令页 —— 待办 ⑤ / design.md §8.2
 *
 * PBKDF2 哈希在 lib/auth（与登录同一套存储格式）；保存时 `token_version += 1`
 * （models/user.ts 的 updatePassword），旧会话（含当前这个）全部立刻失效 ——
 * 提交成功后用户会被踢回登录页，这是设计行为，不是 bug。
 */

import { AdminLayout } from './layout';

export interface ChangePasswordPageProps {
	user: { screen_name: string | null; username: string };
	message?: string;
	error?: string;
}

export function ChangePasswordPage(props: ChangePasswordPageProps) {
	return (
		<AdminLayout
			title="改口令 · 博客后台"
			user={props.user}
			message={props.message}
			error={props.error}
		>
			<h1 class="page-head">改口令</h1>
			<form method="post" action="/admin/password" class="stack">
				<div>
					<label for="current_password">当前口令</label>
					<input
						type="password"
						id="current_password"
						name="current_password"
						autocomplete="current-password"
						required
					/>
				</div>
				<div>
					<label for="new_password">新口令</label>
					<input
						type="password"
						id="new_password"
						name="new_password"
						autocomplete="new-password"
						minlength="8"
						required
					/>
					<p class="hint">至少 8 位</p>
				</div>
				<div>
					<label for="confirm_password">再输一遍新口令</label>
					<input
						type="password"
						id="confirm_password"
						name="confirm_password"
						autocomplete="new-password"
						required
					/>
				</div>
				<p class="hint">
					保存后<strong>所有已登录设备立刻失效</strong>（token_version 机制，§8.1），
					需要用新口令重新登录。
				</p>
				<div class="actions">
					<button type="submit">改口令</button>
					<a class="button" href="/admin">
						返回列表
					</a>
				</div>
			</form>
		</AdminLayout>
	);
}
