/**
 * 索引层：SQLite（`node:sqlite`，Node 内置）+ FTS5，中文按 bigram 切词。
 *
 * 为什么不再用「内存快照 + gzip」：
 *   正文 7.38M 字符、工具 38.06M 字符，落盘是 3.90 + 13.51 MB gzip。冷启动要解压
 *   207 ms、解析 310 ms，而且 `JSON.parse` 之后常驻的对象远大于那 53 MB。
 *   索引化之后一次查询只读命中那几行，冷启动不开销，工具那份也不必整份进内存。
 *
 * 为什么自己做 bigram 而不用 FTS5 的 tokenizer：
 *   `unicode61` 把连续中文当一个 token（宿主自带的搜索就死在这上面：搜「插件」命中 0）；
 *   `trigram` 按 3 字符切，中文两字词（最常见的查询形态）根本凑不满窗口，索引用不上。
 *   所以入库前把中文切成两字窗口（「会话搜索」→ `会话 话搜 搜索`），查询侧同样切。
 *   两字查询正好等于一个 token，三字以上是若干相邻 token 的 AND。
 *
 * 为什么还需要 `instr` 复验：
 *   FTS5 的 phrase 匹配要求 token 相邻，而标点、空白在切词时已被丢弃，于是
 *   「会话，搜索」也会满足 `"会话 话搜 搜索"`——它比真实的子串匹配**更宽**。
 *   FTS 只做粗筛，`instr` 在原块上做终判，两者都要。
 *
 * 分块而不是截断：
 *   旧实现给正文 200k、工具 20k 的硬上限，超出直接切掉，导致「搜不到」与「不存在」
 *   在界面上无法区分。分块入索引后不再丢内容，代价是一条超长消息会占多行。
 */

import { DatabaseSync } from 'node:sqlite';

/** 索引格式版本。切词规则或表结构变化时递增，旧库整份丢弃重建。 */
export const INDEX_VERSION = 1;

/**
 * 单块字符数。
 *
 * 块太大：一次 `instr` 复验和一次正文读取都要扫整块，候选多时放大成几十 MB。
 * 块太小：行数膨胀，SQLite 每条记录的开销和 FTS 位置列表都变厚。
 * 4000 是「7.38M 字符正文 ≈ 1845 块、38M 字符工具 ≈ 9500 块」的折中，
 * 总行数一万出头，正好是 SQLite 舒服的区间。
 */
export const CHUNK_CHARS = 4000;

/**
 * 中日韩表意文字 + 假名 + 谚文。
 *
 * 只对这段字符做两字滑窗：拉丁字母、数字、下划线走「整词」路径（它们有词边界，
 * 按 bigram 切会把 `session` 切成 `se es ss ...`，索引体积翻几倍且毫无必要）。
 */
const CJK = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3040-\\u30FF\\uAC00-\\uD7AF';

/** 一次扫描同时抓「CJK 连续段」和「ASCII 词」。 */
const TOKEN_RUN = new RegExp(`[${CJK}]+|[A-Za-z0-9_]+`, 'g');

/** 纯 ASCII 词：有词边界，走整词匹配。 */
const ASCII_WORD = /^[A-Za-z0-9_]+$/;

/**
 * 把正文切成 FTS 用的 token 串。
 *
 * 中文段两字滑窗、ASCII 段整词小写、其余字符（标点、空白、emoji）丢弃。
 * 单字中文段（长度为 1 的连续段）产生不了 bigram，直接跳过——这类查询由
 * `instr` 全表扫兜底，见 {@link buildMatch}。
 */
export function grams(text) {
  const out = [];
  TOKEN_RUN.lastIndex = 0;
  let match;
  while ((match = TOKEN_RUN.exec(text)) !== null) {
    const run = match[0];
    if (run.charCodeAt(0) < 0x2000) {
      out.push(run.toLowerCase());
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  return out.join(' ');
}

/**
 * 把用户查询编译成 FTS 表达式与复验用参数。
 *
 * 返回 `fts === null` 表示无法用索引（纯单字中文），调用方退回 `instr` 全表扫。
 *
 * `exact` 是关键的性能开关：为真时 FTS 命中即等价于原文子串命中，**不需要把 text
 * 拉回 JS 做 `instr`**。只有两种形态满足：
 *   - 两字中文：切出来正好一个 bigram，而 bigram 本身就是原文的两字窗口；
 *   - 单个 ASCII 词：unicode61 按非字母数字切词，命中 `session` 就说明原文有独立的
 *     这个词（`session-manager` 会被切成 `session` + `manager`，`sessions` 则是另一个 token）。
 * 三字以上中文会切出多个 bigram，它们可能分散在原文里，必须复验。
 *
 * @returns {{ fts: string|null, probes: string[], phrase: string, needsFold: boolean, exact: boolean }}
 */
export function buildMatch(query) {
  const phrase = query.trim();
  const words = phrase.split(/\s+/).filter(Boolean);
  const tokens = [];
  const probes = [];
  let needsFold = false;
  let indexable = true;
  let exact = words.length === 1;
  for (const word of words) {
    if (ASCII_WORD.test(word)) {
      // 词边界由 FTS 的 unicode61 保证（它按非字母数字切）。
      tokens.push(`"${word.toLowerCase()}"`);
      probes.push(word);
      needsFold = true;
      continue;
    }
    probes.push(word);
    if (word.length === 1 && hasCjk(word)) {
      // 单字：凑不出 bigram，索引帮不上忙。
      indexable = false;
      continue;
    }
    const parts = grams(word).split(' ');
    if (parts.length === 0) {
      indexable = false;
      continue;
    }
    // 多于一个 bigram 时不能靠 FTS 单独定论：token 之间可能隔着别的字。
    if (parts.length > 1) exact = false;
    for (const part of parts) tokens.push(`"${part}"`);
  }
  if (!indexable || tokens.length === 0) {
    return { fts: null, probes, phrase, needsFold, exact: false };
  }
  return { fts: tokens.join(' AND '), probes, phrase, needsFold, exact };
}

function hasCjk(text) {
  return new RegExp(`[${CJK}]`).test(text);
}

/** 一条消息切成若干块。空消息不产生行。 */
export function chunkText(text) {
  if (text.length === 0) return [];
  if (text.length <= CHUNK_CHARS) return [text];
  const out = [];
  for (let at = 0; at < text.length; at += CHUNK_CHARS) out.push(text.slice(at, at + CHUNK_CHARS));
  return out;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id      INTEGER PRIMARY KEY,
  kind    TEXT NOT NULL,
  session TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  role    TEXT NOT NULL,
  turn    INTEGER NOT NULL,
  mtime   INTEGER NOT NULL,
  msgid   TEXT NOT NULL DEFAULT '',
  chunk   INTEGER NOT NULL,
  len     INTEGER NOT NULL,
  text    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_by_session ON docs(kind, session, seq);
CREATE INDEX IF NOT EXISTS docs_by_time ON docs(kind, mtime DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  grams,
  tokenize='unicode61',
  detail=none,
  columnsize=0
);

CREATE TABLE IF NOT EXISTS sessions (
  kind    TEXT NOT NULL,
  session TEXT NOT NULL,
  size    INTEGER NOT NULL,
  events  INTEGER NOT NULL,
  turn    INTEGER NOT NULL,
  PRIMARY KEY (kind, session)
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * 一个 kind（正文 / 工具输出）一份命名空间，共用一个库文件。
 *
 * 用同步 API（`DatabaseSync`）：查询是毫秒级，异步包装只是把栈加一层。
 * 但**批量写入必须自己在会话之间让出事件循环**，否则重建一次索引会把 Host
 * 线程按在同步 IO 上好几秒，GUI 直接卡住。这个责任在调用方（index.js 的 build）。
 */
export class DocStore {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    // NORMAL：WAL 下只在 checkpoint 时 fsync 元数据。缓存库崩了最多丢一次重建，
    // 但不值得为它付每次插入一次 fsync 的代价（首次建索引是两万行）。
    this.db.exec('PRAGMA synchronous = NORMAL');
    // 默认页缓存只有 2 MB，而库是百 MB 级：不放大它，每次查询都在随机读磁盘。
    // 64 MB 足够把热的那部分（正文 posting list + 最近读的块）留在内存里。
    this.db.exec('PRAGMA cache_size = -65536');
    // mmap 读省掉 read() 系统调用与页拷贝，对大库的扫描型查询差别明显。
    this.db.exec('PRAGMA mmap_size = 268435456');
    this.db.exec(SCHEMA);
    this.stmts = new Map();
  }

  /** 预编译语句缓存：同一条 SQL 在搜索路径上每次按键都要跑。 */
  sql(text) {
    let stmt = this.stmts.get(text);
    if (stmt === undefined) {
      stmt = this.db.prepare(text);
      this.stmts.set(text, stmt);
    }
    return stmt;
  }

  getMeta(key) {
    const row = this.sql('SELECT value FROM kv WHERE key = ?').get(key);
    return row === undefined ? null : row.value;
  }

  setMeta(key, value) {
    this.sql('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** 该 kind 是否已经建过索引（版本号对得上）。 */
  indexedVersion(kind) {
    const raw = this.getMeta(`version:${kind}`);
    return raw === null ? -1 : Number(raw);
  }

  markIndexed(kind) {
    this.setMeta(`version:${kind}`, String(INDEX_VERSION));
  }

  /** 会话级进度：`size`/`events`/`turn` 是增量的接续点。 */
  getSession(kind, session) {
    const row = this.sql('SELECT size, events, turn FROM sessions WHERE kind = ? AND session = ?')
      .get(kind, session);
    return row === undefined ? null : { size: row.size, events: row.events, turn: row.turn };
  }

  setSession(kind, session, meta) {
    this.sql(`INSERT INTO sessions(kind, session, size, events, turn) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(kind, session) DO UPDATE SET size = excluded.size, events = excluded.events, turn = excluded.turn`)
      .run(kind, session, meta.size, meta.events, meta.turn);
  }

  /** 全部会话的进度，建索引用它对比现场清单。 */
  sessionsOf(kind) {
    const map = new Map();
    for (const row of this.sql('SELECT session, size, events, turn FROM sessions WHERE kind = ?').all(kind)) {
      map.set(row.session, { size: row.size, events: row.events, turn: row.turn });
    }
    return map;
  }

  /**
   * 整份清空一个 kind。
   *
   * 版本换代时用：新旧提取规则混在同一个库里，结果是「一半按新口径、一半按旧口径」，
   * 比空库更糟——搜不到的会话没有任何迹象。宁可清空后重建。
   */
  wipeKind(kind) {
    this.db.exec('BEGIN');
    try {
      this.sql('DELETE FROM docs_fts WHERE rowid IN (SELECT id FROM docs WHERE kind = ?)').run(kind);
      this.sql('DELETE FROM docs WHERE kind = ?').run(kind);
      this.sql('DELETE FROM sessions WHERE kind = ?').run(kind);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 替换单个会话的全部行（全量重读或 rewind）。 */
  replaceSession(kind, session, rows, meta) {
    const insert = this.db.prepare(
      'INSERT INTO docs(kind, session, seq, role, turn, mtime, msgid, chunk, len, text) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertFts = this.db.prepare('INSERT INTO docs_fts(rowid, grams) VALUES(?, ?)');
    this.db.exec('BEGIN');
    try {
      this.dropSessionRows(kind, session);
      for (const row of rows) {
        const info = insert.run(kind, session, row.q, row.r, row.t, row.m, row.i, row.c, row.n, row.x);
        insertFts.run(info.lastInsertRowid, row.g);
      }
      this.sql(`INSERT INTO sessions(kind, session, size, events, turn) VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(kind, session) DO UPDATE SET size = excluded.size, events = excluded.events, turn = excluded.turn`)
        .run(kind, session, meta.size, meta.events, meta.turn);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 追加单个会话的新行（事件级增量：旧行原样保留，只补新增事件提取的部分）。 */
  appendSession(kind, session, rows, meta) {
    const insert = this.db.prepare(
      'INSERT INTO docs(kind, session, seq, role, turn, mtime, msgid, chunk, len, text) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertFts = this.db.prepare('INSERT INTO docs_fts(rowid, grams) VALUES(?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        const info = insert.run(kind, session, row.q, row.r, row.t, row.m, row.i, row.c, row.n, row.x);
        insertFts.run(info.lastInsertRowid, row.g);
      }
      this.sql(`INSERT INTO sessions(kind, session, size, events, turn) VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(kind, session) DO UPDATE SET size = excluded.size, events = excluded.events, turn = excluded.turn`)
        .run(kind, session, meta.size, meta.events, meta.turn);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  dropSessionRows(kind, session) {
    this.sql('DELETE FROM docs_fts WHERE rowid IN (SELECT id FROM docs WHERE kind = ? AND session = ?)')
      .run(kind, session);
    this.sql('DELETE FROM docs WHERE kind = ? AND session = ?').run(kind, session);
  }

  /** 删掉库里已经不存在的会话（现场清单里没有的）。 */
  pruneSessions(kind, alive) {
    const stale = [];
    for (const session of this.sessionsOf(kind).keys()) {
      if (!alive.has(session)) stale.push(session);
    }
    for (const session of stale) this.dropSessionRows(kind, session);
    if (stale.length > 0) {
      const del = this.sql('DELETE FROM sessions WHERE kind = ? AND session = ?');
      for (const session of stale) del.run(kind, session);
    }
    return stale.length;
  }

  /** 某个会话在某个 kind 下的消息条数——客户端据此决定能不能就地跳转。 */
  countSession(kind, session) {
    const row = this.sql('SELECT COUNT(DISTINCT seq) c FROM docs WHERE kind = ? AND session = ?')
      .get(kind, session);
    return row === undefined ? 0 : row.c;
  }

  /** 全部会话的消息条数，一次查完，避免逐会话往返。 */
  countsBySession(kind) {
    const map = new Map();
    for (const row of this.sql('SELECT session, COUNT(DISTINCT seq) c FROM docs WHERE kind = ? GROUP BY session').all(kind)) {
      map.set(row.session, row.c);
    }
    return map;
  }

  /** 库里有多少可搜的行（用于「索引规模」这类显示）。 */
  rowCount(kind) {
    const row = this.sql('SELECT COUNT(*) c FROM docs WHERE kind = ?').get(kind);
    return row === undefined ? 0 : row.c;
  }

  /**
   * 检索。
   *
   * 三段式：FTS 粗筛（`cand`）→ 必要时 `instr` 终判（`filtered`）→ 分组与采样。
   *
   * 两条硬性能约束，都是实测逼出来的：
   *   1. **不把 text 拉回 JS**。7 万行、每行 4000 字符，一次查询顺手取回候选的全文
   *      就是几 MB 的字符串拷贝，把 50 ms 里的绝大部分花在搬运上。`exact` 命中时
   *      （两字中文、单 ASCII 词）FTS 已经是精确判定，text 只在最后取回要显示的那
   *      200 行。
   *   2. `MATERIALIZED` 保证 FTS 先跑。否则 SQLite 可能把 `instr` 排到前面，
   *      退化成「全表扫 + 逐行 instr」，那是 600 ms 级的路径。
   *
   * @param params.kind - 'text' | 'tool'
   * @param params.scope - 'session' 表示只看 `session`，其它值不过滤
   * @param params.role - 'u' | 'a' | 't' | null
   * @param params.since - 时间下界（毫秒），0 表示不限
   * @returns {{ total:number, rows:object[], groups:object[], sessionCount:number }}
   */
  search(params) {
    const { kind, query, scope, session, role, since } = params;
    const match = buildMatch(query);
    const filters = ['d.kind = ?'];
    const args = [kind];
    const scoped = scope === 'session' && typeof session === 'string' && session.length > 0;
    if (scoped) {
      filters.push('d.session = ?');
      args.push(session);
    }
    if (role !== null && role !== undefined) {
      filters.push('d.role = ?');
      args.push(role);
    }
    if (since > 0) {
      filters.push('d.mtime >= ?');
      args.push(since);
    }
    const where = filters.join(' AND ');

    // `exact` 时不带 text 出库；否则把 text 带上，交给 SQL 里的 instr 过滤。
    const metaCols = 'd.id, d.session, d.seq, d.role, d.turn, d.mtime, d.msgid, d.chunk, d.len';
    const candCols = match.exact ? metaCols : `${metaCols}, d.text`;
    let candSql;
    let candArgs;
    if (match.fts !== null) {
      candSql = `SELECT ${candCols} FROM docs_fts f JOIN docs d ON d.id = f.rowid
        WHERE docs_fts MATCH ? AND ${where}`;
      candArgs = [match.fts, ...args];
    } else {
      // 单字中文：没有 bigram 可用，只能全表扫。这类查询少，接受它的代价。
      candSql = `SELECT ${candCols} FROM docs d WHERE ${where}`;
      candArgs = args;
    }

    // 复验只对「FTS 不足以定论」的形态做。instr 区分大小写，SQLite 的 lower()
    // 只折 ASCII，中文不受影响，正好两用。
    const verifySql = match.exact
      ? null
      : 'instr(lower(text), lower(?)) > 0';
    const verifyArg = match.probes.length > 0 ? match.probes[0] : match.phrase;
    const filteredBody = `SELECT id, session, seq, role, turn, mtime, msgid, chunk, len FROM cand${verifySql === null ? '' : ` WHERE ${verifySql}`}`;
    const filteredArgs = verifySql === null ? candArgs : [...candArgs, verifyArg];
    const cte = `WITH cand AS MATERIALIZED (${candSql}), filtered AS MATERIALIZED (${filteredBody})`;

    const total = this.db.prepare(`${cte} SELECT COUNT(*) c FROM filtered`).get(...filteredArgs).c;

    let rows;
    let groups = [];
    let sessionCount = 0;

    if (scoped) {
      rows = this.db.prepare(`${cte} SELECT * FROM filtered ORDER BY mtime DESC LIMIT ?`)
        .all(...filteredArgs, params.limit);
      sessionCount = total === 0 ? 0 : 1;
    } else {
      const head = this.db.prepare(
        `${cte} SELECT session, COUNT(*) c, MAX(mtime) newest FROM filtered
         GROUP BY session ORDER BY newest DESC LIMIT ?`,
      ).all(...filteredArgs, params.maxGroups);
      sessionCount = head.length;
      if (head.length > 0) {
        const holes = head.map(() => '?').join(', ');
        // 窗口函数只输出元数据列，不把 text 带出来——分组采样阶段不需要正文。
        rows = this.db.prepare(
          `${cte}, ranked AS (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY session ORDER BY mtime DESC) rn
             FROM filtered WHERE session IN (${holes})
           )
           SELECT id, session, seq, role, turn, mtime, msgid, chunk, len FROM ranked
           WHERE rn <= ? ORDER BY mtime DESC LIMIT ?`,
        ).all(...filteredArgs, ...head.map((row) => row.session), params.maxPerSession, params.limit);
        const indexOf = new Map();
        for (const row of rows) {
          let entry = indexOf.get(row.session);
          if (entry === undefined) {
            const meta = head.find((item) => item.session === row.session);
            entry = {
              session: row.session,
              count: meta === undefined ? 0 : meta.c,
              newest: row.mtime,
              from: groups.length,
              to: 0,
            };
            indexOf.set(row.session, entry);
            groups.push(entry);
          }
          entry.to += 1;
        }
      } else {
        rows = [];
      }
    }

    // 只给最终要显示的那几行补正文：200 行 × 4000 字符，几百 KB 量级。
    if (rows.length > 0) {
      const holes = rows.map(() => '?').join(', ');
      const texts = new Map();
      for (const row of this.db.prepare(`SELECT id, text FROM docs WHERE id IN (${holes})`)
        .all(...rows.map((row) => row.id))) {
        texts.set(row.id, row.text);
      }
      for (const row of rows) row.text = texts.get(row.id) ?? '';
    }

    return { total, rows, groups, sessionCount, exact: match.exact };
  }

  /**
   * 取一条命中及其前后若干条消息，供侧栏预览。
   *
   * 分块后一条消息可能占多行，但预览要的是「前后各一条说了什么」，
   * 所以按 seq 汇总，每条只取第一块——这和旧实现的 6000 字截断是同一个意图，
   * 只是现在能明确告诉调用方「这条总共多长、命中落在第几段」。
   */
  context(params) {
    const { kind, session, seq, before, after } = params;
    const seqs = this.sql(
      'SELECT DISTINCT seq FROM docs WHERE kind = ? AND session = ? AND seq <= ? ORDER BY seq DESC LIMIT ?',
    ).all(kind, session, seq, before + 1);
    const picked = seqs.map((row) => row.seq);
    const older = this.sql(
      'SELECT DISTINCT seq FROM docs WHERE kind = ? AND session = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
    ).all(kind, session, seq, after);
    for (const row of older) picked.push(row.seq);
    if (picked.length === 0) return null;
    picked.sort((a, b) => a - b);

    const holes = picked.map(() => '?').join(', ');
    const rows = this.sql(
      `SELECT seq, role, turn, mtime, chunk, len, text FROM docs
       WHERE kind = ? AND session = ? AND seq IN (${holes}) AND chunk = 0
       ORDER BY seq ASC`,
    ).all(kind, session, ...picked);

    // 命中那条可能不在 chunk 0：把它的命中块也取出来，否则预览会显示成「消息开头」。
    const anchorRows = this.sql(
      'SELECT seq, role, turn, mtime, chunk, len, text FROM docs WHERE kind = ? AND session = ? AND seq = ? ORDER BY chunk ASC',
    ).all(kind, session, seq);
    const anchorChunk = anchorRows.find((row) => row.text.includes(params.phrase)) ?? anchorRows[anchorRows.length - 1];
    const bySeq = new Map();
    for (const row of rows) bySeq.set(row.seq, row);
    if (anchorChunk !== undefined) bySeq.set(seq, { ...anchorChunk, chunk: anchorChunk.chunk, chunks: anchorRows.length });
    else if (anchorRows.length > 0) bySeq.set(seq, { ...anchorRows[0], chunks: anchorRows.length });

    return {
      anchorSeq: bySeq.has(seq) ? seq : picked[picked.length - 1],
      items: [...bySeq.values()]
        .sort((a, b) => a.seq - b.seq)
        .map((row) => ({
          seq: row.seq,
          role: row.role,
          turn: row.turn,
          time: row.mtime,
          chunk: row.chunk,
          chunks: row.chunks ?? 1,
          len: row.len,
          text: row.text,
        })),
    };
  }

  close() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // checkpoint 失败不影响数据：WAL 会在下次打开时重放。
    }
    this.db.close();
  }
}
