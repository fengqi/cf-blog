/**
 * 生成 PBKDF2 口令串 —— 设计文档 §8.2
 *
 * schema 里给 admin 写的是**不可用的占位哈希**（刻意的 fail-closed），
 * 所以上线前必须先跑一次这个脚本，再把结果写进 D1。
 *
 * 用法：
 *   npx tsx scripts/hash-password.ts '你的口令'
 *
 * ⚠️ 输出里的 `$` 在 shell 双引号里会被当成变量展开 —— 脚本会同时打印**已转义**的命令，
 * 直接用那条。也可以把 SQL 写进文件再 `--file`（脚本会提示）。
 */

import { writeFileSync } from 'node:fs';
import { hashPassword, PBKDF2_ITERATIONS } from '../src/lib/auth';

const password = process.argv[2];
if (!password) {
	console.error("用法：npx tsx scripts/hash-password.ts '你的口令'");
	process.exit(1);
}

const started = performance.now();
const hash = await hashPassword(password, PBKDF2_ITERATIONS);
const elapsed = performance.now() - started;

console.log(hash);
console.log('');
console.log(`（PBKDF2-SHA256 / ${PBKDF2_ITERATIONS} 次迭代，本机耗时 ${elapsed.toFixed(1)} ms）`);
console.log('注意：§8.2 要求核对 Workers 里的 CPU 时间，超过 10ms 就把迭代数降到 5 万。');
console.log('');
console.log('写入远端 D1（已把 $ 转义，直接复制）：');
console.log(
	`  npx wrangler d1 execute blog-db --remote --command "UPDATE users SET password='${hash.replace(/\$/g, '\\$')}' WHERE username='admin'"`,
);
console.log('');
console.log('本地 D1（开发用）：把上面的 --remote 换成 --local');

// 需要更稳的写法时可以落一个 SQL 文件
if (process.argv.includes('--file')) {
	const path = '/tmp/cf-blog-update-password.sql';
	writeFileSync(path, `UPDATE users SET password='${hash}' WHERE username='admin';\n`, 'utf8');
	console.log('');
	console.log(`SQL 已写到 ${path}（含口令哈希，用完删掉）：`);
	console.log(`  npx wrangler d1 execute blog-db --remote --file=${path}`);
}
