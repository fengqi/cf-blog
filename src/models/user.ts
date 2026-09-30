/**
 * users 表 —— 设计文档 §4.1 / §8.1 / §11
 *
 * 会话是无状态的（§8.1），所以这里的写操作只有两类：
 *   - 改口令（顺带 `token_version += 1`，把该用户全部旧会话立刻作废）
 *   - 记录最近登录时间
 */

import type { Db } from '../lib/db';

export interface UserRecord {
	uid: number;
	username: string;
	password: string;
	mail: string;
	url: string | null;
	screen_name: string | null;
	role: 'administrator' | 'editor' | 'author' | 'contributor';
	/** 0=待激活 1=正常；只有 1 才允许登录 */
	activated: number;
	token_version: number;
	created: number;
	logged: number;
}

const USER_FIELDS =
	'uid, username, password, mail, url, screen_name, role, activated, token_version, created, logged';

export async function getUserByUsername(db: Db, username: string): Promise<UserRecord | null> {
	return await db.first<UserRecord>(`SELECT ${USER_FIELDS} FROM users WHERE username = ? LIMIT 1`, [username]);
}

export async function getUserById(db: Db, uid: number): Promise<UserRecord | null> {
	return await db.first<UserRecord>(`SELECT ${USER_FIELDS} FROM users WHERE uid = ? LIMIT 1`, [uid]);
}

/** 有没有可用的管理员账号（判断要不要提示「先 bootstrap 口令」，§8.2） */
export async function countUsableAdmins(db: Db): Promise<number> {
	const row = await db.first<{ count: number }>(
		`SELECT COUNT(*) AS count FROM users
		  WHERE role = 'administrator' AND activated = 1 AND password NOT LIKE '%PLACEHOLDER%'`,
	);
	return row?.count ?? 0;
}

/** 改口令 + 撤销该用户全部旧会话（§8.1 的 token_version 机制） */
export async function updatePassword(db: Db, uid: number, passwordHash: string): Promise<void> {
	await db.run('UPDATE users SET password = ?, token_version = token_version + 1 WHERE uid = ?', [
		passwordHash,
		uid,
	]);
}

/** 登出全部设备 */
export async function bumpTokenVersion(db: Db, uid: number): Promise<void> {
	await db.run('UPDATE users SET token_version = token_version + 1 WHERE uid = ?', [uid]);
}

export async function touchLogin(db: Db, uid: number, now: number): Promise<void> {
	await db.run('UPDATE users SET logged = ? WHERE uid = ?', [now, uid]);
}

export async function countUsers(db: Db): Promise<number> {
	const row = await db.first<{ count: number }>('SELECT COUNT(*) AS count FROM users');
	return row?.count ?? 0;
}
