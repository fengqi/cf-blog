-- ============================================================================
-- Cloudflare Workers 博客系统 · D1 初始化 Schema
--
-- 模型参考 Typecho 的表结构，去掉了评论表（本方案不实现评论功能），
-- 并做了 5 处必要改造：
--   1. contents 拆出 rendered 字段：发布时预渲染 HTML，请求期不再跑 Markdown，
--      规避 Workers 免费版 10ms CPU 上限。
--   2. users 增加 token_version：无状态签名会话的撤销机制，避免为每次请求查会话表。
--   3. contents 增加 synced_at / needs_sync：D1 是内容权威源，R2 是可重建的派生层，
--      两者之间没有事务，靠这对字段做对账兜底（design.md §6.2）。
--   4. 新增 permalink_history：文章 URL 含分类 slug，改分类会改变 URL，
--      需要留痕以便在旧路径保留 200 + canonical（design.md §5.1）。
--   5. 字段命名统一 snake_case，补齐索引与约束。
--
-- 应用方式：wrangler d1 migrations apply <db-name> --remote
-- 注意：D1 migration 自动包裹事务，文件内不要写 BEGIN / COMMIT。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. users · 用户与角色
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  uid            INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL,
  password       TEXT    NOT NULL,              -- PBKDF2-SHA256 编码串，格式见 design.md §8.2
  mail           TEXT    NOT NULL DEFAULT '',
  url            TEXT,
  screen_name    TEXT,
  created        INTEGER NOT NULL,              -- Unix 秒
  activated      INTEGER NOT NULL DEFAULT 1,    -- 0=待激活 1=正常
  logged         INTEGER NOT NULL DEFAULT 0,
  role           TEXT    NOT NULL DEFAULT 'contributor',
                 -- administrator | editor | author | contributor
  auth_code      TEXT    NOT NULL DEFAULT '',
  token_version  INTEGER NOT NULL DEFAULT 0,    -- 自增即吊销该用户全部会话
  CHECK (role IN ('administrator','editor','author','contributor'))
);

CREATE UNIQUE INDEX idx_users_username ON users(username);
CREATE UNIQUE INDEX idx_users_mail     ON users(mail);


-- ---------------------------------------------------------------------------
-- 2. contents · 文章 / 独立页面 / 附件
--    三者在同一张表，靠 type 区分（沿用 Typecho 设计）
-- ---------------------------------------------------------------------------
CREATE TABLE contents (
  cid            INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT    NOT NULL DEFAULT '',
  slug           TEXT    NOT NULL,              -- URL 片段，可能含中文，需 URL 编码
  created        INTEGER NOT NULL,
  modified       INTEGER NOT NULL,
  body           TEXT    NOT NULL DEFAULT '',   -- Markdown 原文（编辑用）
  rendered       TEXT    NOT NULL DEFAULT '',   -- 预渲染 HTML（前台直接输出，关键字段）
  excerpt        TEXT,                          -- 作者手写的摘要（Markdown 原文）；没写就留空，不自动生成
  sort_order     INTEGER NOT NULL DEFAULT 0,    -- 独立页面排序
  author_id      INTEGER NOT NULL,
  template       TEXT,                          -- 预留：自定义页面模板名
  type           TEXT    NOT NULL DEFAULT 'post',
                 -- post | page | attachment
  status         TEXT    NOT NULL DEFAULT 'publish',
                 -- publish | draft | hidden | private | waiting
  password       TEXT,                          -- 私密文章的访问口令（明文由应用层哈希）
  allow_feed     INTEGER NOT NULL DEFAULT 1,
  parent         INTEGER NOT NULL DEFAULT 0,    -- 附件挂在哪个 cid 下；0 = 无归属
  words          INTEGER NOT NULL DEFAULT 0,    -- 写入时算好，列表页直接展示
  mime           TEXT,                          -- attachment 专用，如 image/webp
  size           INTEGER NOT NULL DEFAULT 0,    -- attachment 专用，字节
  r2_key         TEXT,                          -- attachment 专用，R2 对象键
  synced_at      INTEGER,                       -- 最近一次成功写入 R2 的时间戳
  needs_sync     INTEGER NOT NULL DEFAULT 1,    -- 0=已同步 1=待重建，见 design.md §6.2
  FOREIGN KEY (author_id) REFERENCES users(uid),
  CHECK (type   IN ('post','page','attachment')),
  CHECK (status IN ('publish','draft','hidden','private','waiting'))
);

-- 列表页主力索引：WHERE type=? AND status=? ORDER BY created DESC
CREATE INDEX idx_contents_feed     ON contents(type, status, created DESC);
CREATE INDEX idx_contents_author   ON contents(author_id, type, status, created DESC);
CREATE INDEX idx_contents_parent   ON contents(parent, type);
CREATE UNIQUE INDEX idx_contents_slug ON contents(type, slug);

-- Cron 对账：定期扫待同步的文章重新发布（design.md §6.2）
CREATE INDEX idx_contents_sync ON contents(needs_sync, modified);


-- ---------------------------------------------------------------------------
-- 3. metas · 分类与标签
-- ---------------------------------------------------------------------------
CREATE TABLE metas (
  mid          INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  slug         TEXT    NOT NULL,
  type         TEXT    NOT NULL,                -- category | tag
  description  TEXT,
  count        INTEGER NOT NULL DEFAULT 0,      -- 冗余计数，避免归档页 COUNT(*)
  sort_order   INTEGER NOT NULL DEFAULT 0,
  parent       INTEGER NOT NULL DEFAULT 0,      -- 分类支持父子层级；0 = 顶层
  CHECK (type IN ('category','tag'))
);

CREATE UNIQUE INDEX idx_metas_slug   ON metas(type, slug);
CREATE INDEX        idx_metas_parent ON metas(type, parent, sort_order);


-- ---------------------------------------------------------------------------
-- 4. relationships · 内容与分类/标签的关联
-- ---------------------------------------------------------------------------
CREATE TABLE relationships (
  cid INTEGER NOT NULL,
  mid INTEGER NOT NULL,
  PRIMARY KEY (cid, mid),
  FOREIGN KEY (cid) REFERENCES contents(cid) ON DELETE CASCADE,
  FOREIGN KEY (mid) REFERENCES metas(mid)    ON DELETE CASCADE
) WITHOUT ROWID;

-- 归档页按标签查文章需要反向索引
CREATE INDEX idx_relationships_mid ON relationships(mid, cid);


-- ---------------------------------------------------------------------------
-- 5. fields · 自定义字段
-- ---------------------------------------------------------------------------
CREATE TABLE fields (
  cid         INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  type        TEXT    NOT NULL DEFAULT 'str',   -- str | int | float
  str_value   TEXT,
  int_value   INTEGER,
  float_value REAL,
  PRIMARY KEY (cid, name),
  FOREIGN KEY (cid) REFERENCES contents(cid) ON DELETE CASCADE
) WITHOUT ROWID;


-- ---------------------------------------------------------------------------
-- 6. options · 站点配置与统计
--    user=0 表示全局配置；user=uid 表示该用户的个人偏好
-- ---------------------------------------------------------------------------
CREATE TABLE options (
  name  TEXT    NOT NULL,
  user  INTEGER NOT NULL DEFAULT 0,
  value TEXT,
  PRIMARY KEY (name, user)
) WITHOUT ROWID;


-- ---------------------------------------------------------------------------
-- 7. permalink_history · URL 变更留痕
--    文章 URL 里含分类 slug（/<category>/<slug>.html），改分类会改变 URL。
--    要保留旧 URL 的 200 响应 + canonical（design.md §5.1 方案 A），
--    就必须记录这篇文章曾用过哪些路径。
-- ---------------------------------------------------------------------------
CREATE TABLE permalink_history (
  cid        INTEGER NOT NULL,
  permalink  TEXT    NOT NULL,               -- 旧路径，如 'default/760.html'
  retired_at INTEGER NOT NULL,
  PRIMARY KEY (cid, permalink),
  FOREIGN KEY (cid) REFERENCES contents(cid) ON DELETE CASCADE
) WITHOUT ROWID;


-- ---------------------------------------------------------------------------
-- 8. 初始化数据
--    admin 的密码是**不可用的占位哈希** —— 刻意的 fail-closed，不提供默认弱口令。
--    上线前必须 bootstrap（见 design.md §8.2）：
--      npx tsx scripts/hash-password.ts '<口令>'
--      wrangler d1 execute blog-db --remote --command "UPDATE users SET password='<输出>' WHERE username='admin'"
--    哈希格式：pbkdf2$<iterations>$<salt_b64>$<hash_b64>
-- ---------------------------------------------------------------------------
INSERT INTO users (username, password, mail, screen_name, created, role)
VALUES (
  'admin',
  'pbkdf2$100000$dHlwZWNoby1ibG9nLWluaXQ=$PLACEHOLDER_RUN_scripts/hash-password.ts',
  'admin@example.com',
  '站长',
  CAST(strftime('%s','now') AS INTEGER),
  'administrator'
);

-- 站点配置（前台每页都要读，见 design.md §7.3 必须走缓存）
INSERT INTO options (name, user, value) VALUES
  ('site_title',       0, '我的博客'),
  ('site_description', 0, ''),
  -- 必须填真实域名：Feed / Sitemap / canonical 的绝对 URL 全靠它
  ('site_url',         0, 'https://blog.fengqi.me'),
  ('site_keywords',    0, ''),
  ('posts_per_page',   0, '10'),
  ('theme_options',    0, '{}'),
  ('installed_at',     0, CAST(strftime('%s','now') AS TEXT));

-- 默认分类：删除前所有文章必须有归属
INSERT INTO metas (name, slug, type, description, count, sort_order, parent)
VALUES ('默认分类', 'default', 'category', '未分类文章', 0, 0, 0);
