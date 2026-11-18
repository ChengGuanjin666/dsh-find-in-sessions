/**
 * dsh-find-in-sessions 宿主半：把全部会话里「用户/助手看得见的正文」提取成一份内存快照，
 * 供搜索栏做关键词检索。
 *
 * 为什么不走 sessionQuery.searchSessions：
 *   本机 profile 把 session-query-sqlite 配成 openAt: never，那条 RPC 一律报
 *   SESSION_QUERY_SEARCH_DISABLED；即便打开，它用的 unicode61 tokenizer 把连续中文
 *   当成一个 token，实测「插件」「本地搜索」这类两字/三字词命中数为 0。
 *
 * 为什么不建倒排索引 / 不上 SQLite FTS：
 *   实测本机 1096 个会话解压后 616 MB，但只取 user/assistant 的 text 块只有
 *   33 MB / 1.7 万条；内存线性扫一遍 10~30 ms。这个量级下倒排索引只会更慢，
 *   还要额外维护分词、对账和游标世代。所以这里只做「正文快照」。
 *
 * 增量：会话日志是 append-only 的，用 list() 的 sizeBytes 判断变没变，
 * 再用自己记下的「已读事件数」做 read(offset) 追加读——只解析新增事件，
 * 不重解析整份。当前会话每次搜索都在变，全量重读一份 12MB 日志要 108ms
 * （解压 41 + JSON.parse 52），增量后是几毫秒，这是打字手感的来源。
 *
 * 两份快照：正文（text）与工具输出（tool）。工具输出的体积是正文的数倍，
 * 混在一份里会让扫描和内存翻倍，所以默认只建正文快照，切到工具检索时再懒建。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

/** 路由路径。与 Client 半里的 fetch 目标必须一致。 */
const ROUTE = '/session-search/query';

/**
 * 缓存格式版本；字段语义或提取规则变化时递增，旧缓存自动作废。
 * 注意：会话级增量只看 sizeBytes，改提取规则（比如新增注入过滤）
 * 不会让已有会话"看起来变了"，不 bump 这个版本就会一直用旧快照；
 * meta 里存的 eventsRead / lastTurn 是事件级增量的接续点，语义变了也要 bump。
 */
const CACHE_VERSION = 6;

/** 工具输出快照的独立版本：它和正文的提取规则各自演进，不能共用一个号。 */
const TOOL_CACHE_VERSION = 1;

/** 工具输出单条上限。一条 `rh` 或 `Get-Content` 的输出可以到几 MB，全留会吃光内存。 */
const MAX_TOOL_CHARS = 20_000;

/** 单条消息保留的最大字符数。超长的工具转储类正文截断，避免一份快照吃掉几百 MB。 */
const MAX_DOC_CHARS = 200_000;

/** 单次响应返回的命中条数上限。Client 只需要能点的那几条，全量没有意义。 */
const MAX_HITS = 200;

/** 每个会话采样的命中条数。挡住「单会话 400 多条」这种一头沉的情况。 */
const MAX_PER_SESSION = 5;

/** 一次响应里最多列多少个会话。再多用户也不会往下翻。 */
const MAX_GROUPS = 60;

/**
 * 会话清单的复用时长。
 * list() 要遍历 1096 个会话的元数据，每次搜索都调它会把 15 ms 的扫描放大成 150 ms 以上。
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

function cacheFile(kind = 'text') {
  const name = kind === 'tool' ? 'tool.json.gz' : 'body.json.gz';
  return join(homedir(), '.dsh', 'cache', 'dsh-find-in-sessions', name);
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
 * 从一个会话的事件流里抽出可搜索文档。
 *
 * turn 号必须自己推：user/message 的 data 是裸 UserMessage，没有 turn 字段，
 * 而跳转要靠 data-chat-turn 定位，所以从 turn/start 事件维护当前轮次。
 *
 * 增量读只拿到「新增的那段事件」，里面可能没有 turn/start（它在上次已读的部分），
 * 所以调用方要把上次结束时的轮次传进来接着算，否则增量补进来的文档 turn 会从 0 起。
 *
 * @param startTurn - 起始轮次（增量续读时为上次的 lastTurn）
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
      if (toolText.length > MAX_TOOL_CHARS) toolText = toolText.slice(0, MAX_TOOL_CHARS);
      const callId = event.data?.message?.source?.callId;
      sink.push({
        s: sessionId,
        q: event.seq,
        r: 't',
        t: turn,
        m: event.time ?? 0,
        i: typeof callId === 'string' ? callId : '',
        x: toolText,
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
    if (text.length > MAX_DOC_CHARS) text = text.slice(0, MAX_DOC_CHARS);
    sink.push({
      s: sessionId,
      q: event.seq,
      r: isUser ? 'u' : 'a',
      t: isUser ? turn : (event.data?.turn ?? turn),
      m: event.time ?? 0,
      // 消息 id：DOM 的 data-chat-node-key 形如 `13:input-message<uuid>`，
      // 尾巴就是它。定位时按这个后缀精确查，比在正文里做指纹匹配快且唯一。
      i: isUser ? event.data?.id : event.data?.message?.id,
      x: text,
    });
  }
  return turn;
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

/**
 * 把关键词编译成匹配器。
 *
 * 纯 ASCII 的词必须按**词边界**匹配：否则搜 `assi` 会命中 `assistant-step`、
 * 搜 `dsh` 会命中 `dshw`——结果里全是技术术语，用户看到的就是「命中了不知道哪来的内容」。
 * 中文没有词边界概念，仍用子串：`插件` 要能在 `会话搜索插件` 里命中。
 *
 * 性能：中文没有大小写，对它调 `toLowerCase()` 是纯浪费。实测全库扫一遍
 * 7.23M 字符耗时 22.4ms，其中 21.7ms 花在 toLowerCase 上，真正的 includes 只占 0.6ms。
 * 所以只有「含字母的词」才去查小写副本，其余直接匹配原文。
 */
function compileNeedle(text) {
  const lower = text.toLowerCase();
  if (/^[A-Za-z0-9_-]+$/.test(text)) {
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { re: new RegExp(`(^|[^a-z0-9])${escaped}(?![a-z0-9])`, 'i'), lower, fold: true };
  }
  return { substr: text, lower, fold: lower !== text };
}

/**
 * 判断一条文档是否命中某个关键词。
 * @param doc - 文档
 * @param needle - 编译后的关键词
 * @param folded - 该文档的小写副本；只在 needle.fold 为真时才需要
 */
function matchesNeedle(doc, needle, folded) {
  if (needle.re !== undefined) return needle.re.test(folded ?? doc.x);
  if (needle.fold) return (folded ?? doc.x.toLowerCase()).includes(needle.lower);
  return doc.x.includes(needle.substr);
}

/**
 * 为一份快照准备小写副本。
 *
 * 键必须是「文档数组本身」：同一份 docs 只构建一次，docs 被重建（增量补齐、
 * 切换快照）时自动作废。放在 WeakMap 里省掉手动失效——docs 数组一旦被替换，
 * 旧键连带旧副本一起被回收。
 */
const lowerCache = new WeakMap();

function foldedDocs(docs) {
  let folded = lowerCache.get(docs);
  if (folded === undefined) {
    folded = docs.map((doc) => doc.x.toLowerCase());
    lowerCache.set(docs, folded);
  }
  return folded;
}

/** 找关键词在正文里的位置，整串短语优先，其次单个词。 */
function locate(text, phrase, needles) {
  const haystack = text.toLowerCase();
  if (phrase.length > 1) {
    const at = haystack.indexOf(phrase);
    if (at >= 0) return at;
  }
  let best = -1;
  for (const needle of needles) {
    const at = haystack.indexOf(needle);
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
   * 一份快照的可变状态。正文与工具输出各一份。
   *
   * meta 里记的是「这个会话已经读到第几个事件、停在第九轮」，增量读靠它接续。
   * 两份快照的 eventsRead 不能共用：后建的那份（比如用户第一次切到工具检索）
   * 要从头读，共用会让它缺掉前一段的工具结果。
   */
  function makeSnapshot() {
    return {
      /** @type {Array<{s:string,q:number,r:string,t:number,m:number,i?:string,x:string}>} */
      docs: [],
      /** @type {Map<string, {sizeBytes?:number, eventsRead?:number, lastTurn?:number}>} */
      meta: new Map(),
      ready: false,
      /** @type {Promise<void>|null} */
      building: null,
      /** @type {string|null} */
      error: null,
      builtAt: 0,
    };
  }

  /** @type {{ headers: Map<string, {cwd?:string, createdAt?:number, origin?:string}>, snapshots: readonly object[]|null, lastListAt: number, body: ReturnType<typeof makeSnapshot>, tool: ReturnType<typeof makeSnapshot> }} */
  const state = {
    headers: new Map(),
    snapshots: null,
    lastListAt: 0,
    body: makeSnapshot(),
    tool: makeSnapshot(),
  };

  const snapshotOf = (kind) => (kind === 'tool' ? state.tool : state.body);

  function loadCache(kind) {
    const snap = snapshotOf(kind);
    const file = cacheFile(kind);
    if (!existsSync(file)) return false;
    try {
      const raw = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
      const want = kind === 'tool' ? TOOL_CACHE_VERSION : CACHE_VERSION;
      if (raw?.version !== want || !Array.isArray(raw.docs)) return false;
      // 按时间升序排好：搜索按时间窗口过滤时从末尾往前扫，
      // 遇到早于窗口的第一条就能停，不必把整份语料扫完。
      snap.docs = raw.docs.sort((a, b) => a.m - b.m);
      for (const [id, meta] of Object.entries(raw.meta ?? {})) snap.meta.set(id, meta);
      snap.ready = true;
      snap.builtAt = raw.builtAt ?? 0;
      return true;
    } catch (error) {
      ctx.logger?.warn?.(`dsh-find-in-sessions: ${kind} 缓存不可读，将重建：${String(error)}`);
      return false;
    }
  }

  function saveCache(kind) {
    const snap = snapshotOf(kind);
    const file = cacheFile(kind);
    try {
      mkdirSync(join(homedir(), '.dsh', 'cache', 'dsh-find-in-sessions'), { recursive: true });
      const payload = {
        version: kind === 'tool' ? TOOL_CACHE_VERSION : CACHE_VERSION,
        builtAt: snap.builtAt,
        docs: snap.docs,
        meta: Object.fromEntries(snap.meta),
      };
      // 先写临时文件再改名：中途崩溃不会留下半截缓存，下次读到半截 JSON 会白重建一次。
      const temp = `${file}.tmp`;
      writeFileSync(temp, gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 6 }));
      renameSync(temp, file);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-find-in-sessions: ${kind} 缓存写入失败（不影响本次搜索）：${String(error)}`);
    }
  }

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
   * 对齐一份快照。
   *
   * 两级增量：
   * 1. 会话级——sizeBytes 没变就整条跳过，沿用上次的文档与 meta；
   * 2. 事件级——变了就只 read(已读事件数)，只解析新增那一段。
   *
   * 第二级是打字手感的来源：当前会话每次搜索都在变，全量重读一份 12MB 日志要
   * 108ms（解压 41 + JSON.parse 52），增量后是个位数毫秒。
   */
  async function build(kind, requestedSessionId) {
    const snap = snapshotOf(kind);
    const snapshots = await snapshotsFor(requestedSessionId);
    const keep = [];
    const stale = [];
    for (const snapshot of snapshots) {
      const id = snapshot.header.id;
      const known = snap.meta.get(id);
      const same = known !== undefined && known.sizeBytes === snapshot.sizeBytes;
      if (same) keep.push(id);
      else stale.push(snapshot);
    }

    if (stale.length === 0 && snap.ready) return;

    const freshHeaders = new Map();
    for (const snapshot of snapshots) {
      freshHeaders.set(snapshot.header.id, {
        cwd: snapshot.header.cwd,
        createdAt: snapshot.header.createdAt,
        origin: snapshot.header.origin,
      });
    }

    // 没变过的会话：文档原样留下，meta 也要留——里面的 eventsRead 是下次增量的接续点。
    const keptIds = new Set(keep);
    const carried = snap.docs.filter((doc) => keptIds.has(doc.s));
    const freshMeta = new Map();
    for (const id of keptIds) {
      const known = snap.meta.get(id);
      if (known !== undefined) freshMeta.set(id, known);
    }

    const rebuilt = [];
    // 走增量的会话要把它原有的文档原样放回来，只补新增事件提取的那部分；
    // 全量重读的会话不能带（否则整份历史会被重复一遍）。
    // 先按会话分一次组：直接每次 filter 一遍全量 docs 是 O(N²)。
    const staleIds = new Set(stale.map((snapshot) => snapshot.header.id));
    const priorDocs = new Map();
    for (const doc of snap.docs) {
      if (!staleIds.has(doc.s)) continue;
      const list = priorDocs.get(doc.s);
      if (list === undefined) priorDocs.set(doc.s, [doc]);
      else list.push(doc);
    }

    let index = 0;
    for (const snapshot of stale) {
      const id = snapshot.header.id;
      const known = snap.meta.get(id);
      try {
        const handle = await ctx.sessionPersistence.open(id, 'read');
        try {
          let events = null;
          let startTurn = 0;
          let eventsRead = 0;
          let incremental = false;
          const prevRead = known?.eventsRead ?? 0;
          // 只有在「上次读过一部分」且「文件还变大了」时才走增量。
          // 文件变小说明被截断或回滚过（rewind），增量会把错位的历史接上去，退回全量。
          if (prevRead > 0 && snapshot.sizeBytes > (known?.sizeBytes ?? 0)) {
            const partial = await handle.read(prevRead);
            // 守卫：新增事件的第一条必须正好接在已读位置后面。对不上就是中间被改写，
            // 此时增量读到的不是原来的历史，宁可全量重来。
            if (partial.events.length > 0 && partial.events[0]?.seq === prevRead) {
              events = partial.events;
              startTurn = known?.lastTurn ?? 0;
              eventsRead = prevRead;
              incremental = true;
            }
          }
          if (events === null) {
            const full = await handle.read();
            events = full.events;
            startTurn = 0;
            eventsRead = 0;
          }
          if (incremental) {
            const prior = priorDocs.get(id);
            if (prior !== undefined) rebuilt.push(...prior);
          }
          const endTurn = collectDocs(events, id, rebuilt, startTurn, kind);
          freshMeta.set(id, {
            sizeBytes: snapshot.sizeBytes,
            eventsRead: eventsRead + events.length,
            lastTurn: endTurn,
          });
        } finally {
          await handle.close();
        }
      } catch (error) {
        // 读失败时把这条从 meta 里摘掉：下次对比必然不等，于是会重试。
        // 不能沿用新 snapshot 的值，否则一次失败会让这个会话被永久跳过。
        freshMeta.delete(id);
        ctx.logger?.warn?.(`dsh-find-in-sessions: ${kind} 会话 ${id} 读取失败：${String(error)}`);
      }
      // 大目录下定期让出事件循环，避免长时间占住 Host 线程让 GUI 卡顿。
      index += 1;
      if (index % 64 === 0) await sleep(0);
    }

    snap.docs = carried.concat(rebuilt).sort((a, b) => a.m - b.m);
    snap.meta = freshMeta;
    state.headers = freshHeaders;
    snap.ready = true;
    snap.error = null;
    snap.builtAt = Date.now();
    saveCache(kind);
  }

  /**
   * 首次搜索阻塞到快照可用；之后只触发后台对齐，本次响应立刻用现有快照回答。
   * 否则每 5 秒一次的 list() 会把「按键即出」拖成一百多毫秒的等待。
   *
   * @returns 需要等待的 promise，或 undefined（已有快照，本次不等）。
   */
  /**
   * 磁盘缓存只尝试读一次。
   * 读失败通常意味着提取规则换代（版本号不匹配），随后会全量重建；
   * 反复读同一份过期文件是把 IO 白花在启动路径上。
   */
  const cacheTried = { text: false, tool: false };

  function ensureCache(kind) {
    if (cacheTried[kind]) return;
    cacheTried[kind] = true;
    // 先吃磁盘缓存，哪怕它已经过期——有东西可搜总比空着好，随后增量补齐。
    loadCache(kind);
  }

  function ensureReady(kind, requestedSessionId) {
    ensureCache(kind);
    const snap = snapshotOf(kind);
    if (snap.building === null) {
      snap.building = build(kind, requestedSessionId)
        .catch((error) => {
          snap.error = String(error);
          ctx.logger?.warn?.(`dsh-find-in-sessions: ${kind} 构建失败：${String(error)}`);
        })
        .finally(() => {
          snap.building = null;
        });
    }
    return snap.ready ? undefined : snap.building;
  }

  function search(query, scope, sessionId, role, since, kind = 'text') {
    const docs = snapshotOf(kind).docs;
    const phrase = query.toLowerCase().trim();
    const words = phrase.split(/\s+/).filter(Boolean);
    if (words.length === 0) return { total: 0, hits: [], groups: [], sessionCount: 0, sessions: {} };

    const needles = words.map(compileNeedle);
    // 只有含字母的关键词才需要小写副本。纯中文/数字查询直接在原文上扫，
    // 省掉一次全库 toLowerCase——实测那一步占 22.4ms 里的 21.7ms，真正的 includes 只占 0.6ms。
    const folded = needles.some((needle) => needle.fold) ? foldedDocs(docs) : null;

    const inScope = (doc) => {
      if (scope === 'session' && sessionId !== null && doc.s !== sessionId) return false;
      // role: 'u' 只看用户说的，'a' 只看助手回复，'t' 只看工具输出，null 不过滤
      if (role !== null && doc.r !== role) return false;
      return true;
    };

    // docs 按时间升序，从末尾往前扫：越过时间窗口就停。
    // 时间窗口是纯收益项——它同时缩小候选集和结果集，且不必扫完整份语料。
    // 返回下标而不是文档：多词过滤还要拿同一个下标去小写副本里取对应文本。
    const scan = (accept) => {
      const found = [];
      for (let index = docs.length - 1; index >= 0; index -= 1) {
        const doc = docs[index];
        if (since > 0 && doc.m < since) break;
        if (!inScope(doc)) continue;
        if (accept(doc, index)) found.push(index);
      }
      return found;
    };

    let matchedIndexes = null;
    if (words.length > 1) {
      // 多词查询先当整串短语查。否则 `let me check` 会被拆成三个常见子串做 AND，
      // 命中上百条只是碰巧都包含 let / me / check 的正文，看起来像乱匹配。
      const exact = scan((doc, index) =>
        folded === null ? doc.x.includes(phrase) : folded[index].includes(phrase),
      );
      if (exact.length > 0) matchedIndexes = exact;
    }
    if (matchedIndexes === null) {
      // 先用第一个关键词扫一遍全表拿候选，其余关键词只在候选上验证。
      // 原来每个词都扫一遍全表，三个词就是三次全库扫描；命中集通常只有几百条，
      // 在这上面再过滤一轮的成本可以忽略。
      matchedIndexes = scan((doc, index) => matchesNeedle(doc, needles[0], folded?.[index]));
      for (let k = 1; k < needles.length && matchedIndexes.length > 0; k += 1) {
        const needle = needles[k];
        matchedIndexes = matchedIndexes.filter((index) => matchesNeedle(docs[index], needle, folded?.[index]));
      }
    }

    // scan 已经是时间倒序，这里再排一次是防御：万一某处把 docs 顺序打乱，
    // 排序仍在，只是不会再提前停扫。
    const matched = matchedIndexes.map((index) => docs[index]).sort((a, b) => b.m - a.m);
    const total = matched.length;

    /** 把一条文档转成命中项。anchor 供 Client 在 DOM 里做二次定位。 */
    const makeHit = (doc) => {
      const at = locate(doc.x, phrase, words);
      // 不能拿消息开头当指纹：实测同一轮里有两条消息都以 `http://127.0.0.1:3080/?`
      // 开头，指纹撞车后定位跳到了另一条消息上。关键词一定出现在目标消息里，
      // 用它周围的文本定位，误匹配率低得多。
      const anchorStart = Math.max(0, (at < 0 ? 0 : at) - 24);
      return {
        sessionId: doc.s,
        seq: doc.q,
        role: doc.r,
        turn: doc.t,
        time: doc.m,
        // 有 id 就能一次属性查询定位；旧快照没这个字段时给空串，Client 自动退回指纹。
        messageId: typeof doc.i === 'string' ? doc.i : '',
        anchor: doc.x.slice(anchorStart, anchorStart + 60).replace(/\s+/g, ' '),
        head: doc.x.slice(0, 80).replace(/\s+/g, ' '),
        snippet: makeSnippet(doc.x, at),
      };
    };

    const collectSessions = (hits) => {
      const sessions = {};
      for (const hit of hits) {
        if (sessions[hit.sessionId] === undefined) {
          sessions[hit.sessionId] = state.headers.get(hit.sessionId) ?? {};
        }
      }
      return sessions;
    };

    // 单会话检索不分组，也不按会话采样：结果本来就只有这一条会话的几处，
    // 再套一层「会话清单」只是多一次点击。没有当前会话时 scope 虽为 session
    // 但实际不过滤，那种情况仍走分组。
    if (scope === 'session' && sessionId !== null) {
      const hits = matched.slice(0, MAX_HITS).map(makeHit);
      return {
        total,
        hits,
        groups: [],
        sessionCount: new Set(matched.map((doc) => doc.s)).size,
        sampled: hits.length,
        sessions: collectSessions(hits),
      };
    }

    // 全局检索才分组，每个会话只采样最近 MAX_PER_SESSION 条。
    //
    // 实测「光缆」586 条命中里 423 条来自同一个会话、Top5 会话占 98%：
    // 扁平列表在这里毫无意义，用户要做的是「从 11~32 个会话里挑一个」。
    // 采样上限则挡住另一端——单个会话 400 多条也翻不完。
    const bySession = new Map();
    for (const doc of matched) {
      let entry = bySession.get(doc.s);
      if (entry === undefined) {
        entry = { sessionId: doc.s, count: 0, newest: doc.m, docs: [] };
        bySession.set(doc.s, entry);
      }
      entry.count += 1;
      if (entry.docs.length < MAX_PER_SESSION) entry.docs.push(doc);
    }

    const groups = [...bySession.values()]
      .sort((a, b) => b.newest - a.newest)
      .slice(0, MAX_GROUPS);

    const hits = [];
    const payloadGroups = [];
    for (const group of groups) {
      // 采样总量也要有上限：60 组 × 5 条 = 300 行，全展开会拖慢渲染。
      if (hits.length >= MAX_HITS) break;
      const from = hits.length;
      for (const doc of group.docs) hits.push(makeHit(doc));
      payloadGroups.push({
        sessionId: group.sessionId,
        count: group.count,
        newest: group.newest,
        // from/to 是 hits 数组的下标区间：Client 用同一份扁平列表做「上一处/下一处」，
        // 用区间把它铺成两级展开。
        from,
        to: hits.length,
      });
    }

    // 顺带带出命中会话的工作目录与创建时间：Client 拿它当标题用，
    // 省掉再引一个 useSessions 依赖，少一处版本漂移的接口。
    return {
      total,
      hits,
      groups: payloadGroups,
      sessionCount: bySession.size,
      sampled: hits.length,
      sessions: collectSessions(hits),
    };
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
    // 启动就在后台预热：否则用户第一次 Ctrl+F 要等一次全量重建。
    // 只预热正文快照；工具输出那份要等用户真的切过去才建（体积是正文的数倍）。
    const warm = setTimeout(() => {
      void ensureReady('text');
    }, 2500);
    return () => clearTimeout(warm);
  }, 'dsh-find-in-sessions.warmup');

  ctx.effect(() => {
    const connection = ctx.get('connection');
    return ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          json(res, 405, { error: 'method not allowed' });
          return;
        }
        // 与内置 API 同一条信任围栏：只接受本机会话凭据发起的请求，别把会话正文
        // 暴露给随便一个同网段的人。
        const rejection = connection?.requestRejection({ headers: req.headers });
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
        const query = (url.searchParams.get('q') ?? '').trim();
        const scope = url.searchParams.get('scope') === 'session' ? 'session' : 'all';
        const sessionId = url.searchParams.get('sessionId');
        // 快照二选一：正文（默认）或工具输出。两份分开存，体积差一个数量级，
        // 混装会让扫描时间和内存都被工具输出拖垮。
        const mode = url.searchParams.get('mode') === 'tool' ? 'tool' : 'text';
        const roleParam = url.searchParams.get('role');
        const role = roleParam === 'u' || roleParam === 'a' || roleParam === 't' ? roleParam : null;
        const snap = snapshotOf(mode);
        // 时间窗口：只接受正数毫秒时间戳，缺失或非法值表示不限制。
        const sinceParam = Number(url.searchParams.get('since'));
        const since = Number.isFinite(sinceParam) && sinceParam > 0 ? sinceParam : 0;

        if (query.length === 0) {
          json(res, 200, { total: 0, hits: [], mode, tookMs: 0, ready: snap.ready });
          return;
        }
        if (query.length > 200) {
          json(res, 400, { error: 'query too long' });
          return;
        }

        const started = performance.now();
        const pending = ensureReady(mode, sessionId ?? undefined);
        if (pending !== undefined) {
          try {
            await pending;
          } catch (error) {
            json(res, 500, { error: String(error) });
            return;
          }
        }
        const result = search(query, scope, sessionId, role, since, mode);
        json(res, 200, {
          ...result,
          mode,
          tookMs: Math.round((performance.now() - started) * 10) / 10,
          ready: snap.ready,
          // 工具快照首次构建要读全部会话，客户端据此提示「正在建立工具索引」。
          // 只在「还没可用快照且确实在构建」时为真：ready 之后的每次查询都会
          // 顺手起一个后台对齐，那时不该再报构建中。
          building: !snap.ready && snap.building !== null,
          docs: snap.docs.length,
          builtAt: snap.builtAt,
        });
      },
    });
  }, 'dsh-find-in-sessions.route');
}
