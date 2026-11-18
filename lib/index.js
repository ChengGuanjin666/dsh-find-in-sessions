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

/** 两次整体对齐之间的最小间隔。连续打字时会一直触发对齐，节流后只在空闲时补。 */
const BUILD_MIN_INTERVAL_MS = 1500;

/**
 * 会话清单的复用时长。
 * list() 要遍历上千个会话的元数据，每次搜索都调它会把十几毫秒的查询放大一个数量级。
 * 但「刚说过的话要能搜到」不能靠等这个窗口过期，所以请求里带 sessionId 时额外
 * stat 一次那个会话，把它单独刷进来。
 */
const LIST_TTL_MS = 5000;

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

  /** @type {{ headers: Map<string, {cwd?:string, createdAt?:number, origin?:string}>, snapshots: readonly object[]|null, lastListAt: number, text: ReturnType<typeof makeState>, tool: ReturnType<typeof makeState>, store: DocStore|null, storeError: string|null }} */
  const state = {
    headers: new Map(),
    snapshots: null,
    lastListAt: 0,
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
   * 会话清单：在 LIST_TTL_MS 内复用，但请求指明了当前会话时单独 stat 它。
   * stat 只读元数据，很便宜；这样「刚说过的话」不需要等清单过期就能搜到。
   */
  async function snapshotsFor(requestedSessionId) {
    const now = Date.now();
    let snapshots = state.snapshots;
    if (snapshots === null || now - state.lastListAt > LIST_TTL_MS) {
      snapshots = await ctx.sessionPersistence.list();
      state.snapshots = snapshots;
      state.lastListAt = now;
    }
    if (typeof requestedSessionId !== 'string' || requestedSessionId.length === 0) return snapshots;
    const stat = await ctx.sessionPersistence.stat(requestedSessionId);
    if (stat === undefined) return snapshots;
    const rest = snapshots.filter((snapshot) => snapshot.header.id !== requestedSessionId);
    return [stat, ...rest];
  }

  /**
   * 读一个会话，把它提取的行写进索引。
   *
   * build（整体对齐）与 refreshSession（只刷当前会话）共用这一份，
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
    const handle = await ctx.sessionPersistence.open(id, 'read');
    try {
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
      await handle.close();
    }
  }

  /**
   * 对齐一份索引。
   *
   * 会话级增量：库里 size 没变就整条跳过，变了才进 syncSession。
   * 会话之间让出事件循环——每次写入是同步 SQLite 事务，连着跑上千个会话
   * 会把 Host 线程按在同步 IO 上，GUI 直接卡住。
   */
  async function build(kind, requestedSessionId) {
    const st = stateOf(kind);
    const snapshots = await snapshotsFor(requestedSessionId);
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

  /**
   * 只刷新一个会话。
   *
   * 存在的理由：「刚说的话搜不到」。build 是后台异步的，搜索不等它——所以每次搜索
   * 看到的都是上一次对齐的结果。当前会话恰恰变化最频繁，这个滞后最刺眼。
   *
   * 只刷一个会话很便宜：增量路径下就是 read(offset) 读几条新事件。
   *
   * @returns 是否有变化
   */
  async function refreshSession(kind, sessionId) {
    const st = stateOf(kind);
    if (!st.ready) return false;
    // 已有整份对齐在跑：等它跑完再判断。它同样会写这个会话，两边并发写同一行会冲突。
    if (st.building !== null) {
      try {
        await st.building;
      } catch {
        // build 自己会记日志并保留原有索引，这里继续按 stat 判断。
      }
    }
    const stat = await ctx.sessionPersistence.stat(sessionId);
    if (stat === undefined) return false;
    const prev = store().getSession(kind, sessionId);
    if (prev !== null && prev.size === stat.sizeBytes) return false;
    const ok = await syncSession(kind, stat, prev);
    if (ok) {
      st.builtAt = Date.now();
      state.headers.set(sessionId, {
        cwd: stat.header.cwd,
        createdAt: stat.header.createdAt,
        origin: stat.header.origin,
      });
    }
    return ok;
  }

  function ensureReady(kind, requestedSessionId) {
    const st = stateOf(kind);
    // 节流：连续打字时每敲一下都触发一次整体对齐，而每次都只是把刚做过的
    // stat 比较再做一遍。当前会话的实时性由 refreshSession 单独负责，
    // 这里晚一点补不影响「刚说的话能搜到」。
    if (st.building === null && Date.now() - st.builtAt > BUILD_MIN_INTERVAL_MS) {
      st.building = build(kind, requestedSessionId)
        .catch((error) => {
          st.error = String(error);
          ctx.logger?.warn?.(`dsh-find-in-sessions: ${kind} 索引对齐失败：${String(error)}`);
        })
        .finally(() => {
          st.building = null;
        });
    }
    // 已有索引但正在对齐时不阻塞——「按键即出」优先。
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
          const pending = ensureReady(kind, sessionId);
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
          json(res, 200, {
            sessionId,
            // tab 标题用工作目录尾段：和搜索面板里的会话标题保持一致。
            title: parts.length > 0 ? parts[parts.length - 1] : sessionId.slice(0, 8),
            sessionDocs: store().countSession(kind, sessionId),
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
        // 只有冷启动才等整体对齐；已有索引不等。
        if (!st.ready) {
          const pending = ensureReady(kind, sessionId ?? undefined);
          if (pending !== undefined) {
            try {
              await pending;
            } catch (error) {
              json(res, 500, { error: String(error) });
              return;
            }
          }
        }
        // 当前会话的变化同步补上，否则「刚说的话」要等下一次搜索才出现。
        // 必须排在下面那次后台对齐之前：build 一启动 building 就非 null，
        // 这里就得等它整个跑完，白白丢掉「按键即出」。
        if (typeof sessionId === 'string' && sessionId.length > 0) {
          try {
            await refreshSession(kind, sessionId);
          } catch (error) {
            ctx.logger?.warn?.(`dsh-find-in-sessions: 当前会话刷新失败：${String(error)}`);
          }
        }
        // 其余会话放后台对齐，不阻塞本次响应。
        void ensureReady(kind, sessionId ?? undefined);

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
          counts = store().countsBySession(kind);
        } catch (error) {
          json(res, 500, { error: String(error) });
          return;
        }

        const words = query.split(/\s+/).filter(Boolean);
        const hits = result.rows.map((row) => {
          const at = locate(row.text, query.trim(), words);
          const anchorStart = Math.max(0, (at < 0 ? 0 : at) - 24);
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
            sessionDocs: counts.get(row.session) ?? 0,
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
