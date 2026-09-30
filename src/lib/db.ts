/**
 * D1 封装 + 查询计数器 —— 设计文档 §1.4 铁律 3 / §11
 *
 * 免费版对「单次调用到 Cloudflare 服务的子请求」有上限（1000，见 §1.1），
 * 而且 N+1 会让查询数随文章数线性膨胀。这里给每次调用记一个计数器，
 * 超过阈值打一条 warn —— 它只是纪律提醒，不是硬限。
 *
 * 纪律（§11 硬约束 1）：**SQL 只允许出现在 `src/models/` 与 `src/lib/db.ts` 里。**
 */

/** D1 参数只可能是这几种，够用且能避开 unknown[] 展开的类型噪音 */
export type DbParam = string | number | null;

export class Db {
	private count = 0;

	constructor(
		private readonly db: D1Database,
		/** 日志里用来区分是谁在查（如 `snapshot` / `sync`） */
		private readonly label = 'db',
		/** 超过这个查询数就告警；后台单页查询数远低于它 */
		private readonly warnAt = 50,
	) {}

	/** 当前调用已执行的查询数（可断言用，见 scripts/e2e-local.ts） */
	get queries(): number {
		return this.count;
	}

	private tick(): void {
		this.count++;
		if (this.count === this.warnAt + 1) {
			console.warn(
				`[db] ${this.label} 一次调用已发出 ${this.count} 次查询，注意 N+1（§1.4 铁律 3）`,
			);
		}
	}

	async all<T>(sql: string, params: DbParam[] = []): Promise<T[]> {
		this.tick();
		const result = await this.db.prepare(sql).bind(...params).all<T>();
		return result.results ?? [];
	}

	async first<T>(sql: string, params: DbParam[] = []): Promise<T | null> {
		this.tick();
		return await this.db.prepare(sql).bind(...params).first<T>();
	}

	async run(sql: string, params: DbParam[] = []): Promise<D1Result> {
		this.tick();
		return await this.db.prepare(sql).bind(...params).run();
	}

	/**
	 * 写多条语句时用它 —— 一次 `batch` 只算一次往返，
	 * 也让「改分类要同时更新新旧两个 meta 的 count」这类一致性要求（§4.3）能落在一个事务里。
	 */
	async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
		if (statements.length === 0) return [];
		this.tick();
		return await this.db.batch(statements);
	}

	/** 给 models 层拼 batch 用：不执行，只 prepare */
	prepare(sql: string, params: DbParam[] = []): D1PreparedStatement {
		return this.db.prepare(sql).bind(...params);
	}
}

export function createDb(db: D1Database, label?: string): Db {
	return new Db(db, label);
}
