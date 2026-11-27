/**
 * dsh-find-in-sessions 宿主半：把全部会话里「用户/助手看得见的正文」写进 SQLite 索引，
 * 供搜索栏做关键词检索。
 *
 * 为什么不走 sessionQuery.searchSessions：
 *   本机 profile 把 session-query-sqlite 配成 openAt: never，那条 RPC 一律报
 *   SESSION_QUERY_SEARCH_DISABLED；即便打开，它用的 unicode61 tokenizer 把连续中文
 *   当成一个 token，实测「插件」「本地搜索」这类两字/三字词命中数为 0。
 *
 * 为什么自己建索引而不是内存线性扫（v0.1 的做法）：
 *   内存版把全部正文和工具输出摊在进程里，落盘是 3.90 + 13.51 MB gzip，
 *   冷启动要解压 207 ms、解析 310 ms，工具那份解析后常驻内存远大于 53 MB JSON。
 *   索引化之后冷启动不开销、查询只读命中行、超长正文也不必整份进内存。
 *   切词方案见 lib/store.js 头部。
 *
 * 增量：会话日志是 append-only 的，用 list() 的 sizeBytes 判断变没变，
 * 再用自己记下的「已读事件数」做 read(offset) 追加读——只解析新增事件。
 *
 * 两份索引：正文（text）与工具输出（tool），同一个库里按 kind 分区。
 * 工具输出默认不建，第一次切到「工具」检索时才懒建（读全部会话，几秒），
 * 之后常驻磁盘而不是常驻内存。
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CHUNK_CHARS, DocStore, INDEX_VERSION, chunkText, grams } from './store.js';

/** 路由路径。查询与上下文共用一个入口，靠 `op` 区分——见 handler 里的说明。 */
const ROUTE = '/session-search';

/** 单次响应返回的命中条数上限。Client 只需要能点的那几条，全量没有意义。 */
const MAX_HITS = 200;

/** 每个会话采样的命中条数。挡住「单会话 400 多条」这种一头沉的情况。 */
const MAX_PER_SESSION = 5;

/** 一次响应里最多列多少个会话。再多用户也不会往下翻。 */
const MAX_GROUPS = 60;

/**
 * 收到会话变化事件后合并多久再落库。
 *
 * `session/event` 是每次事件 append 发一次（turn/start、step/start、
 * assistant/message、tool/result…），一个 turn 几十次；而一次 syncSession 要
 * stat + 增量读 + 写库。2 秒足够把一个 turn 合并成一次，又不会让「刚说的话」
 * 等太久。
 */
const DIRTY_DEBOUNCE_MS = 2000;

/**
 * system-reminder 是 Harness 塞进 user/message 的运行时注入，不是用户说的话。
 * 搜到它只会制造噪声，提取阶段整块删掉。
 */
const INJECTION_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * 整条都是运行时注入的 user/message。
 *
 * 实测本机 7723 条 user 消息里，下面这几类开头占了 2017 万 / 2750 万字符（73%）：
 * mnemon 的记忆快照、检查点正文（里面是工具结果转储和思考摘要）、时间上下文、
 * 工具目录。它们混在 user/message 里，只看 type 和 role 分不出来。
 *
 * 留着它们的后果是：搜「dsh」命中最多的是「思考链 + 工具输出」而不是用户说过的话。
 * 所以按开头判定，命中即整条丢弃——不做部分剥离，因为这类消息整条都是注入。
 *
 * 代价：这是对宿主注入格式的枚举，宿主新增一种注入开头就会漏进索引。
 * 漏进来的表现是噪声命中，不是错误结果，可以在观察到后再补一条。
 */
const INJECTION_HEADS = [
  /^\[dsh-mnemon:/,
  /^\[MNEMON\]/,
  /^MNEMON RUNTIME MEMORY SNAPSHOT/,
  /^MNEMON VIEW TOOLS/,
  /^Bounded completed checkpoint/,
  /^Current runtime context/,
  /^Time sampled while preparing/,
  /^This is an automatically generated/,
  // 模型切换提示，形如 `[model changed: assistant ...]`，实测 31 条
  /^\[model changed:/,
  // 后台子代理完成通知，实测各 2 条
  /^Background subagent /,
  /^Agent [0-9a-f]{8}-[0-9a-f]{4}-/,
];

function isRuntimeInjection(text) {
  for (const head of INJECTION_HEADS) {
    if (head.test(text)) return true;
  }
  return false;
}

/**
 * 剪掉拼在消息中间或结尾的注入。
 *
 * 之前只按「整条开头」判断，遇到「用户提问 + 后面拖一段运行时快照」就漏了：
 * 实机里主人一条消息是「把搜索栏位置改成居中…」后面紧跟
 * `MNEMON RUNTIME MEMORY SNAPSHOT` 和两个 `<runtime-memory-file>`，
 * 整条消息头是正常提问，于是 USER.md / MEMORY.md 全文都被索引了。
 *
 * 处理顺序：先按标签精确剪，再从快照标题起截断到消息结尾
 * （同一次注入在快照标题之后只有标签内容和工具清单）。
 */
function stripInjection(text) {
  let out = text.replace(/<runtime-memory-file[^>]*>[\s\S]*?<\/runtime-memory-file>/g, ' ');
  const tailAt = out.search(/\n(?:MNEMON RUNTIME MEMORY SNAPSHOT|MNEMON VIEW TOOLS \(available in this View\))/);
  if (tailAt >= 0) out = out.slice(0, tailAt);
  return out.replace(/\s+/g, ' ').trim();
}

export const name = 'dsh-find-in-sessions';

export const inject = ['webServer', 'sessionPersistence'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 索引库路径。保留旧缓存目录，旧的 *.json.gz 不再读取，可以手工删掉。 */
function indexPath() {
  return join(homedir(), '.dsh', 'cache', 'dsh-find-in-sessions', 'index.db');
}

/** 只取 type === 'text' 的块：reasoning 是模型的思考过程，不属于「对话过的内容」。 */
function joinTextBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  let out = '';
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    out += block.text;
  }
  return out.replace(INJECTION_BLOCK, '').trim();
}

/**
 * 从一个会话的事件流里抽出可索引的行。
 *
 * turn 号必须自己推：user/message 的 data 是裸 UserMessage，没有 turn 字段，
 * 而跳转要靠 data-chat-turn 定位，所以从 turn/start 事件维护当前轮次。
 *
 * 增量读只拿到「新增的那段事件」，里面可能没有 turn/start（它在上次已读的部分），
 * 所以调用方要把上次结束时的轮次传进来接着算，否则增量补进来的行 turn 会从 0 起。
 *
 * 长消息按 CHUNK_CHARS 切块，不再截断：截断会让「搜不到」和「不存在」在界面上
 * 无法区分。分块后一条超长消息占多行，`chunk` 是块号，`len` 是整条长度。
 *
 * @param startTurn - 起始轮次（增量续读时为上次的 turn）
 * @param kind - 'text' 取正文，'tool' 取工具输出
 * @returns 提取结束时所在的轮次
 */
function collectDocs(events, sessionId, sink, startTurn = 0, kind = 'text') {
  let turn = startTurn;
  for (const event of events) {
    const type = event?.type;
    if (type === 'turn/start') {
      turn = event.data?.turn ?? turn;
      continue;
    }
    if (kind === 'tool') {
      if (type !== 'tool/result') continue;
      const toolBlocks = event.data?.message?.content;
      if (!Array.isArray(toolBlocks)) continue;
      let toolText = '';
      for (const block of toolBlocks) {
        if (block?.type !== 'text' || typeof block.text !== 'string') continue;
        toolText += block.text;
      }
      toolText = toolText.trim();
      if (toolText.length === 0) continue;
      pushChunks(sink, {
        session: sessionId,
        seq: event.seq,
        role: 't',
        turn,
        mtime: event.time ?? 0,
        msgid: event.data?.message?.source?.callId,
        text: toolText,
      });
      continue;
    }
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    const isUser = type === 'user/message';
    const blocks = isUser ? event.data?.content : event.data?.message?.content;
    let text = joinTextBlocks(blocks);
    if (text.length === 0) continue;
    // 注入可能拼在提问后面，先剪掉再判断；剪完为空说明整条都是注入。
    if (isUser) {
      text = stripInjection(text);
      if (text.length === 0) continue;
      if (isRuntimeInjection(text)) continue;
    }
    pushChunks(sink, {
      session: sessionId,
      seq: event.seq,
      role: isUser ? 'u' : 'a',
      turn: isUser ? turn : (event.data?.turn ?? turn),
      mtime: event.time ?? 0,
      // 消息 id：DOM 的 data-chat-node-key 形如 `13:input-message<uuid>`，
      // 尾巴就是它。定位时按这个后缀精确查，比在正文里做指纹匹配快且唯一。
      msgid: isUser ? event.data?.id : event.data?.message?.id,
      text,
    });
  }
  return turn;
}

/** 把一条消息切块后追加进 sink。`g` 是 FTS 用的 bigram 串，随行一起准备好。 */
function pushChunks(sink, doc) {
  const chunks = chunkText(doc.text);
  for (let index = 0; index < chunks.length; index += 1) {
    sink.push({
      s: doc.session,
      q: doc.seq,
      r: doc.role,
      t: doc.turn,
      m: doc.mtime,
      i: typeof doc.msgid === 'string' ? doc.msgid : '',
      c: index,
      n: doc.text.length,
      x: chunks[index],
      g: grams(chunks[index]),
    });
  }
}

/**
 * 片段要当纯文本给人看。
 *
 * 索引主体仍是 markdown 原文（关键词要能匹配原文），但直接拿去显示时：
 * 表格变成 `a | b | c`、标题留着 `##`、代码块只剩反引号，
 * 看起来像从别处抓来的碎片而不是自己说过的话。
 * 所以只对展示用的 snippet 做一次格式清理。
 */
function cleanSnippet(text) {
  return text
    // 代码块只去掉围栏、保留内容：整块删掉会让「命令 / 报错」类片段变成空白。
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, ' $1 ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~#>\-]{1,}/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 找关键词在正文块里的位置，整串短语优先，其次单个词。 */
function locate(text, phrase, words) {
  const haystack = text.toLowerCase();
  if (phrase.length > 1) {
    const at = haystack.indexOf(phrase.toLowerCase());
    if (at >= 0) return at;
  }
  let best = -1;
  for (const word of words) {
    const at = haystack.indexOf(word.toLowerCase());
    if (at >= 0 && (best < 0 || at < best)) best = at;
  }
  return best;
}

/**
 * 命中位置前后各取一段，做成单行片段。
 * at 由 locate 算好传进来，避免这里再找一遍导致片段落点与匹配位置不一致。
 */
function makeSnippet(text, at) {
  const anchor = at < 0 ? 0 : at;
  const start = Math.max(0, anchor - 40);
  const end = Math.min(text.length, anchor + 120);
  const head = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  return head + cleanSnippet(text.slice(start, end)) + tail;
}

export function apply(ctx) {
  /**
   * 一份索引的运行时状态。正文与工具输出各一份。
   *
   * `ready` 表示库里有可搜数据；`building` 是正在跑的整份对齐。
   * 进度（读了几个事件、停在第几轮）已经落在库里，进程重启不丢。
   */
  function makeState() {
    return {
      ready: false,
      /** @type {Promise<void>|null} */
      building: null,
      /** @type {string|null} */
      error: null,
      builtAt: 0,
    };
  }

  /** @type {{ headers: Map<string, {cwd?:string, createdAt?:number, origin?:string}>, text: ReturnType<typeof makeState>, tool: ReturnType<typeof makeState>, store: DocStore|null, storeError: string|null }} */
  const state = {
    headers: new Map(),
    text: makeState(),
    tool: makeState(),
    store: null,
    storeError: null,
  };

  try {
    mkdirSync(join(homedir(), '.dsh', 'cache', 'dsh-find-in-sessions'), { recursive: true });
    state.store = new DocStore(indexPath());
  } catch (error) {
    // 不静默降级：索引打不开时查询必须报错，否则「搜不到」会被当成「没有」。
    state.storeError = String(error);
    ctx.logger?.warn?.(`dsh-find-in-sessions: 索引库打开失败：${String(error)}`);
  }

  const store = () => {
    if (state.store === null) throw new Error(`索引库不可用：${state.storeError ?? 'unknown'}`);
    return state.store;
  };

  const stateOf = (kind) => (kind === 'tool' ? state.tool : state.text);

  /** 把查询串里的数字夹到合法区间；缺失或非法时取默认值。 */
  const clampInt = (raw, fallback, min, max) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(value)));
  };

  /**
   * 会话清单。只在启动那次全量对齐里调用一次——之后的新会话靠
   * `session/created` 事件单独 stat 进来，不再需要扫描目录。
   */
  async function listSnapshots() {
    return ctx.sessionPersistence.list();
  }

  /**
   * 读一个会话，把它提取的行写进索引。
   *
   * build（启动全量）与 syncDirty（事件驱动的单会话补齐）共用这一份，
   * 避免两处增量判断各写一遍再慢慢漂移。
   *
   * 三条写入路径：
   * - 上次读过一部分且文件变大 → 追加（只补新增事件提取的行）；
   * - 文件变小（rewind）或新增事件接不上 seq → 该会话整份替换；
   * - 从没读过 → 该会话整份替换。
   *
   * @param prev - 库里记的该会话进度，null 表示没读过
   * @returns 是否成功
   */
  async function syncSession(kind, snapshot, prev) {
    const id = snapshot.header.id;
    // open 与 close 必须和读写一起被隔离：只要有一个会话打不开，异常就会从
    // build 的 for-await 里冒出去，整份对齐当场中断，`ready` 永远是 false，
    // 而每 1.5 秒一次的新对齐又会停在同一个会话上——索引永远建不完，
    // 表现就是「建索引…」一直不消失、搜索结果只有中断前那几十个会话。
    // 单个会话读不了是个体问题，不该升级成全局失败。
    let handle = null;
    try {
      handle = await ctx.sessionPersistence.open(id, 'read');
      let events = null;
      let startTurn = 0;
      let eventsRead = 0;
      let incremental = false;
      const prevEvents = prev === null ? 0 : prev.events;
      // 只有在「上次读过一部分」且「文件还变大了」时才走增量。
      // 文件变小说明被截断或回滚过（rewind），增量会把错位的历史接上去，退回全量。
      if (prev !== null && prevEvents > 0 && snapshot.sizeBytes > prev.size) {
        const partial = await handle.read(prevEvents);
        // 守卫：新增事件的第一条必须正好接在已读位置后面。对不上就是中间被改写，
        // 此时增量读到的不是原来的历史，宁可全量重来。
        if (partial.events.length > 0 && partial.events[0]?.seq === prevEvents) {
          events = partial.events;
          startTurn = prev.turn;
          eventsRead = prevEvents;
          incremental = true;
        }
      }
      if (events === null) {
        const full = await handle.read();
        events = full.events;
        startTurn = 0;
        eventsRead = 0;
      }
      const rows = [];
      const endTurn = collectDocs(events, id, rows, startTurn, kind);
      const meta = { size: snapshot.sizeBytes, events: eventsRead + events.length, turn: endTurn };
      if (incremental && rows.length > 0) store().appendSession(kind, id, rows, meta);
      else if (incremental) store().setSession(kind, id, meta);
      else store().replaceSession(kind, id, rows, meta);
      return true;
    } catch (error) {
      ctx.logger?.warn?.(`dsh-find-in-sessions: ${kind} 会话 ${id} 写入失败：${String(error)}`);
      // 失败时把进度摘掉：下次对比必然不等，于是会重试。
      // 不能留着新值，否则一次失败会让这个会话被永久跳过。
      try {
        store().dropSessionRows(kind, id);
        store().setSession(kind, id, { size: -1, events: 0, turn: 0 });
      } catch {
        // 清理也失败就等下一次整份对齐兜底。
      }
      return false;
    } finally {
      if (handle !== null) {
        try {
          await handle.close();
        } catch (error) {
          // close 抛错同样不该让整份对齐中断：数据已经落库了。
          ctx.logger?.warn?.(`dsh-find-in-sessions: ${kind} 会话 ${id} 关闭失败：${String(error)}`);
        }
      }
    }
  }

  /**
   * 对齐一份索引。
   *
   * 会话级增量：库里 size 没变就整条跳过，变了才进 syncSession。
   * 会话之间让出事件循环——每次写入是同步 SQLite 事务，连着跑上千个会话
   * 会把 Host 线程按在同步 IO 上，GUI 直接卡住。
   */
  async function build(kind) {
    const st = stateOf(kind);
    const snapshots = await listSnapshots();
    const db = store();

    if (db.indexedVersion(kind) !== INDEX_VERSION) {
      // 版本换代：整份丢弃重建。旧行留着只会让新规则下的结果半新半旧。
      db.wipeKind(kind);
      db.markIndexed(kind);
      st.ready = false;
    }

    const known = db.sessionsOf(kind);
    const alive = new Set();
    const headers = new Map();
    let index = 0;
    for (const snapshot of snapshots) {
      const id = snapshot.header.id;
      alive.add(id);
      headers.set(id, {
        cwd: snapshot.header.cwd,
        createdAt: snapshot.header.createdAt,
        origin: snapshot.header.origin,
      });
      const prev = known.get(id) ?? null;
      if (prev !== null && prev.size === snapshot.sizeBytes) continue;
      await syncSession(kind, snapshot, prev);
      index += 1;
      if (index % 32 === 0) await sleep(0);
    }

    const pruned = db.pruneSessions(kind, alive);
    if (pruned > 0) ctx.logger?.info?.(`dsh-find-in-sessions: ${kind} 索引清理了 ${pruned} 个已消失的会话`);
    state.headers = headers;
    st.ready = true;
    st.error = null;
    st.builtAt = Date.now();
  }

  /** 变了但还没补进索引的会话。2 秒内多次事件只落一次库。 */
  const dirty = new Set();
  /** @type {ReturnType<typeof setTimeout>|null} */
  let flushTimer = null;

  function scheduleFlush() {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const ids = [...dirty];
      dirty.clear();
      if (ids.length > 0) void syncDirty(ids);
    }, DIRTY_DEBOUNCE_MS);
    // 不拖住进程退出：丢掉一批只是晚一轮补齐。
    flushTimer.unref?.();
  }

  /**
   * 把若干会话补进索引。
   *
   * 这是启动全量之后唯一的写入口。触发点是宿主的 `session/event` 与
   * `session/created`（见下面的 feed effect）——会话一追加就记下它的 id，
   * 2 秒防抖后只处理这几个会话：一次 stat、一次增量读，与会话总数无关。
   *
   * 只碰 `ready` 的 kind：工具索引没建过就不该因为一条事件被建起来。
   *
   * @param ids - 待补的会话
   */
  async function syncDirty(ids) {
    // 整份对齐正在跑：它会顺带处理这些会话，本轮让位、原样放回队列。
    // 不 await 它——那是后台任务，等它会把这里也拖成秒级，正是这次要消掉的东西。
    if (state.text.building !== null || state.tool.building !== null) {
      for (const id of ids) dirty.add(id);
      scheduleFlush();
      return;
    }
    for (const sessionId of ids) {
      let stat;
      try {
        stat = await ctx.sessionPersistence.stat(sessionId);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-find-in-sessions: stat ${sessionId} 失败：${String(error)}`);
        continue;
      }
      // 会话不在存储里了（归档后删除、发布回滚）：把它从索引摘掉，不必等下一次
      // 全量对齐。sessions 表那行留着，启动时的 pruneSessions 会一起清。
      if (stat === undefined) {
        for (const kind of ['text', 'tool']) {
          if (!stateOf(kind).ready) continue;
          try {
            store().dropSessionRows(kind, sessionId);
          } catch (error) {
            ctx.logger?.warn?.(`dsh-find-in-sessions: 清理 ${kind} 会话 ${sessionId} 失败：${String(error)}`);
          }
        }
        state.headers.delete(sessionId);
        continue;
      }
      for (const kind of ['text', 'tool']) {
        const st = stateOf(kind);
        if (!st.ready) continue;
        let prev;
        try {
          prev = store().getSession(kind, sessionId);
        } catch {
          continue;
        }
        if (prev !== null && prev.size === stat.sizeBytes) continue;
        if (await syncSession(kind, stat, prev)) st.builtAt = Date.now();
      }
      state.headers.set(sessionId, {
        cwd: stat.header.cwd,
        createdAt: stat.header.createdAt,
        origin: stat.header.origin,
      });
    }
  }

  /**
   * 记一个会话变了。**不能抛**——`session/created` 的同步抛错会否决那次创建，
   * 把宿主新建会话的动作回滚掉。所以整个函数体兜在 try 里。
   */
  function markDirty(session) {
    try {
      const id = session?.id;
      if (typeof id !== 'string' || id.length === 0) return;
      dirty.add(id);
      scheduleFlush();
    } catch (error) {
      ctx.logger?.warn?.(`dsh-find-in-sessions: 记录变更失败：${String(error)}`);
    }
  }

  /**
   * 冷启动兜底：索引没有可搜数据时等一次全量对齐。已有索引时立刻返回——
   * 检索路径上不做任何对齐，新鲜度由事件驱动负责。
   */
  function ensureReady(kind) {
    const st = stateOf(kind);
    if (st.building === null && !st.ready) {
      st.building = build(kind)
        .catch((error) => {
          st.error = String(error);
          ctx.logger?.warn?.(`dsh-find-in-sessions: ${kind} 索引对齐失败：${String(error)}`);
        })
        .finally(() => {
          st.building = null;
        });
    }
    return st.ready ? undefined : st.building;
  }

  function json(res, status, body) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': payload.length,
      'cache-control': 'no-store',
    });
    res.end(payload);
  }

  ctx.effect(() => {
    // 启动就在后台预热：否则用户第一次 Ctrl+F 要等一次全量对齐。
    // 只预热正文；工具输出那份要等用户真的切过去才建（体积是正文的数倍）。
    const warm = setTimeout(() => {
      void ensureReady('text');
    }, 2500);
    return () => clearTimeout(warm);
  }, 'dsh-find-in-sessions.warmup');

  ctx.effect(function* () {
    // 会话一变就投喂：这是启动全量之后索引唯一的新鲜度来源。
    //
    // 两个监听器只做「记下会话 id」，不读文件、不写库；真正的补齐在 2 秒防抖后
    // 由 syncDirty 跑一次，成本是那个会话的 stat + 增量读，与会话总数无关。
    //
    // 为什么不直接在这里写库：写路径只该有一条（syncSession 的 size 对比 + seq 续读，
    // 那是验证过的）。事件只负责说「这个会话变了」。
    //
    // `session/created` 的同步抛出会**否决那次会话创建**并连带回滚，所以两个监听器
    // 都必须兜住异常——markDirty 内部已经 try/catch。
    //
    // 用 yield 而不是手动收集 disposer，是照官方持久化后端的写法：卸载本插件时
    // 由 Cordis 统一摘除订阅。
    yield ctx.on('session/event', (session) => markDirty(session));
    yield ctx.on('session/created', (session) => markDirty(session));
    // 会话离开存储（归档后删除、发布回滚）时它也变「脏」了：syncDirty 拿到
    // undefined 的 stat 就会把索引里那几行摘掉。文件还在的归档不会被误删——
    // 那时 stat 仍返回快照。
    yield ctx.on('session/disposed', (session) => markDirty(session));
  }, 'dsh-find-in-sessions.feed');

  ctx.effect(() => {
    return () => {
      try {
        state.store?.close();
      } catch (error) {
        ctx.logger?.warn?.(`dsh-find-in-sessions: 索引库关闭失败：${String(error)}`);
      }
    };
  }, 'dsh-find-in-sessions.store');

  /**
   * 检查这条请求是否由本机会话凭据发起。
   *
   * 必须在 handler 里**每次实时取** connection：注册 effect 的时机早于
   * connection 服务就绪，提前取一次会得到 undefined，然后
   * `connection?.requestRejection(...)` 整段跳过去——围栏形同不存在，
   * 任何本机进程都能读到全部会话正文（实测 curl 裸访问 200，而内置 API 是 401）。
   *
   * 取不到时按拒绝处理：宁可显式失败，也不要静默裸奔。
   *
   * @returns 拒绝时返回状态码，放行返回 undefined
   */
  function rejectRequest(req) {
    const connection = ctx.get('connection');
    if (connection === undefined || connection === null) {
      ctx.logger?.warn?.('dsh-find-in-sessions: connection 服务不可用，拒绝请求');
      return 401;
    }
    return connection.requestRejection({ headers: req.headers });
  }

  /**
   * 查询与上下文合并成一个路由，用 `op` 区分。
   *
   * 原来两个路径各写一遍「方法检查 + 鉴权 + URL 解析」，同一套围栏有两份实现，
   * 改一处忘另一处就是裸奔。合并后围栏只有一处，`op` 的取值是显式白名单。
   */
  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          json(res, 405, { error: 'method not allowed' });
          return;
        }
        // 与内置 API 同一条信任围栏：只接受本机会话凭据发起的请求。
        const rejection = rejectRequest(req);
        if (rejection !== undefined) {
          json(res, rejection, { error: 'unauthorized' });
          return;
        }

        let url;
        try {
          url = new URL(req.url ?? ROUTE, 'http://127.0.0.1');
        } catch {
          json(res, 400, { error: 'bad url' });
          return;
        }
        const op = url.searchParams.get('op') === 'context' ? 'context' : 'query';
        // 索引分区二选一：正文（默认）或工具输出。工具那份默认不建，首次切过去才建。
        const kind = url.searchParams.get('mode') === 'tool' ? 'tool' : 'text';
        const sessionId = url.searchParams.get('sessionId');
        const st = stateOf(kind);

        if (state.store === null) {
          json(res, 500, { error: `索引库不可用：${state.storeError ?? 'unknown'}` });
          return;
        }

        if (op === 'context') {
          const seq = Number(url.searchParams.get('seq'));
          if (typeof sessionId !== 'string' || sessionId.length === 0 || !Number.isFinite(seq)) {
            json(res, 400, { error: 'sessionId and seq are required' });
            return;
          }
          const before = clampInt(url.searchParams.get('before'), 1, 0, 20);
          const after = clampInt(url.searchParams.get('after'), 1, 0, 20);
          const phrase = (url.searchParams.get('phrase') ?? '').trim();
          // 冷启动、或者工具索引还没建过时，这里要等它可用。
          const pending = ensureReady(kind);
          if (pending !== undefined) {
            try {
              await pending;
            } catch (error) {
              json(res, 500, { error: String(error) });
              return;
            }
          }
          let found;
          try {
            found = store().context({ kind, session: sessionId, seq, before, after, phrase });
          } catch (error) {
            json(res, 500, { error: String(error) });
            return;
          }
          if (found === null) {
            json(res, 404, { error: 'no document for this session' });
            return;
          }
          const header = state.headers.get(sessionId) ?? {};
          const parts = typeof header.cwd === 'string' ? header.cwd.split(/[\\/]/).filter(Boolean) : [];
          // 规模一次查完：两个数字来自同一批行，分两次查没有意义。
          const size = store().countSession(kind, sessionId);
          json(res, 200, {
            sessionId,
            // tab 标题用工作目录尾段：和搜索面板里的会话标题保持一致。
            title: parts.length > 0 ? parts[parts.length - 1] : sessionId.slice(0, 8),
            sessionDocs: size.msgs,
            sessionTurns: size.turns,
            ...found,
          });
          return;
        }

        const query = (url.searchParams.get('q') ?? '').trim();
        const scope = url.searchParams.get('scope') === 'session' ? 'session' : 'all';
        const roleParam = url.searchParams.get('role');
        const role = roleParam === 'u' || roleParam === 'a' || roleParam === 't' ? roleParam : null;
        // 时间窗口：只接受正数毫秒时间戳，缺失或非法值表示不限制。
        const sinceParam = Number(url.searchParams.get('since'));
        const since = Number.isFinite(sinceParam) && sinceParam > 0 ? sinceParam : 0;

        if (query.length === 0) {
          json(res, 200, { total: 0, hits: [], groups: [], mode: kind, ready: st.ready });
          return;
        }
        if (query.length > 200) {
          json(res, 400, { error: 'query too long' });
          return;
        }

        const started = performance.now();
        // 检索路径上只有一件事可能等：索引还没建过（冷启动 / 第一次切到工具）。
        // 已有索引时不触发任何对齐——新鲜度由 session/event 驱动，见上面的 feed effect。
        if (!st.ready) {
          const pending = ensureReady(kind);
          if (pending !== undefined) {
            try {
              await pending;
            } catch (error) {
              json(res, 500, { error: String(error) });
              return;
            }
          }
        }

        let result;
        let counts;
        try {
          result = store().search({
            kind,
            query,
            scope,
            session: scope === 'session' ? (sessionId ?? null) : null,
            role,
            since,
            limit: MAX_HITS,
            maxPerSession: MAX_PER_SESSION,
            maxGroups: MAX_GROUPS,
          });
          // 只统计命中涉及的会话：结果里只用到这几个的规模，全表 GROUP BY 是白跑。
          counts = store().countsBySession(kind, [...new Set(result.rows.map((row) => row.session))]);
        } catch (error) {
          json(res, 500, { error: String(error) });
          return;
        }

        const words = query.split(/\s+/).filter(Boolean);
        const hits = result.rows.map((row) => {
          const at = locate(row.text, query.trim(), words);
          const anchorStart = Math.max(0, (at < 0 ? 0 : at) - 24);
          const size = counts.get(row.session) ?? { msgs: 0, turns: 0 };
          return {
            sessionId: row.session,
            seq: row.seq,
            role: row.role,
            turn: row.turn,
            time: row.mtime,
            messageId: row.msgid,
            chunk: row.chunk,
            chunks: Math.max(1, Math.ceil(row.len / CHUNK_CHARS)),
            len: row.len,
            // 轮次是「能不能就地跳转」的判据，消息条数是给人的明细；两个都带出去。
            sessionDocs: size.msgs,
            sessionTurns: size.turns,
            anchor: row.text.slice(anchorStart, anchorStart + 60).replace(/\s+/g, ' '),
            head: row.text.slice(0, 80).replace(/\s+/g, ' '),
            snippet: makeSnippet(row.text, at),
          };
        });

        // groups 的 from/to 是 hits 数组下标：Client 用同一份扁平列表做「上一处/下一处」，
        // 用区间把它铺成两级展开。
        const groups = result.groups.map((group) => ({
          sessionId: group.session,
          count: group.count,
          newest: group.newest,
          from: group.from,
          to: group.to,
        }));

        const sessions = {};
        for (const hit of hits) {
          if (sessions[hit.sessionId] === undefined) {
            sessions[hit.sessionId] = state.headers.get(hit.sessionId) ?? {};
          }
        }

        json(res, 200, {
          total: result.total,
          hits,
          groups,
          sessionCount: result.sessionCount,
          sampled: hits.length,
          sessions,
          mode: kind,
          // FTS 是否足以定论。为假表示这次检索走了全表扫（单字中文），
          // Client 据此解释「为什么这次等得久」，而不是让用户以为卡了。
          exact: result.exact,
          tookMs: Math.round((performance.now() - started) * 10) / 10,
          ready: st.ready,
          // 工具索引首次构建要读全部会话，客户端据此提示「正在建立工具索引」。
          // 只在「还没可用索引且确实在构建」时为真。
          building: !st.ready && st.building !== null,
          docs: store().rowCount(kind),
          builtAt: st.builtAt,
        });
      },
    });
  }, 'dsh-find-in-sessions.route');
}
