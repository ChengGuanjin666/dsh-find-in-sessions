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
 * 增量：会话日志是 append-only 的，sessionPersistence.list() 的 snapshot 带
 * sizeBytes/eventCount，跨重启可比；只重读变过的会话，日常通常 1~3 个。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

/** 路由路径。与 Client 半里的 fetch 目标必须一致。 */
const ROUTE = '/session-search/query';

/**
 * 缓存格式版本；字段语义或提取规则变化时递增，旧缓存自动作废。
 * 注意：增量对账只看 sizeBytes/eventCount，改提取规则（比如新增注入过滤）
 * 不会让已有会话"看起来变了"，不 bump 这个版本就会一直用旧快照。
 */
const CACHE_VERSION = 4;

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

function cacheFile() {
  return join(homedir(), '.dsh', 'cache', 'dsh-find-in-sessions', 'body.json.gz');
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
 */
function collectDocs(events, sessionId, sink) {
  let turn = 0;
  for (const event of events) {
    const type = event?.type;
    if (type === 'turn/start') {
      turn = event.data?.turn ?? turn;
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
      x: text,
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

/**
 * 把关键词编译成匹配器。
 *
 * 纯 ASCII 的词必须按**词边界**匹配：否则搜 `assi` 会命中 `assistant-step`、
 * 搜 `dsh` 会命中 `dshw`——结果里全是技术术语，用户看到的就是「命中了不知道哪来的内容」。
 * 中文没有词边界概念，仍用子串：`插件` 要能在 `会话搜索插件` 里命中。
 */
function compileNeedle(text) {
  if (/^[A-Za-z0-9_-]+$/.test(text)) {
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { re: new RegExp(`(^|[^a-z0-9])${escaped}(?![a-z0-9])`, 'i') };
  }
  return { substr: text };
}

function matchesNeedle(doc, needle) {
  if (needle.re !== undefined) return needle.re.test(doc.x);
  return doc.x.toLowerCase().includes(needle.substr);
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
  /** @type {{ docs: Array<{s:string,q:number,r:string,t:number,m:number,x:string}>, meta: Map<string, {sizeBytes?:number,eventCount?:number}>, headers: Map<string, {cwd?:string, createdAt?:number, origin?:string}>, ready: boolean, building: Promise<void>|null, error: string|null, builtAt: number, snapshots: readonly object[]|null, lastListAt: number }} */
  const state = {
    docs: [],
    meta: new Map(),
    headers: new Map(),
    ready: false,
    building: null,
    error: null,
    builtAt: 0,
    snapshots: null,
    lastListAt: 0,
  };

  function loadCache() {
    const file = cacheFile();
    if (!existsSync(file)) return false;
    try {
      const raw = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
      if (raw?.version !== CACHE_VERSION || !Array.isArray(raw.docs)) return false;
      // 按时间升序排好：搜索按时间窗口过滤时从末尾往前扫，
      // 遇到早于窗口的第一条就能停，不必把整份语料扫完。
      state.docs = raw.docs.sort((a, b) => a.m - b.m);
      for (const [id, meta] of Object.entries(raw.meta ?? {})) state.meta.set(id, meta);
      state.ready = true;
      state.builtAt = raw.builtAt ?? 0;
      return true;
    } catch (error) {
      ctx.logger?.warn?.(`dsh-find-in-sessions: 缓存不可读，将重建：${String(error)}`);
      return false;
    }
  }

  function saveCache() {
    const file = cacheFile();
    try {
      mkdirSync(join(homedir(), '.dsh', 'cache', 'dsh-find-in-sessions'), { recursive: true });
      const payload = {
        version: CACHE_VERSION,
        builtAt: state.builtAt,
        docs: state.docs,
        meta: Object.fromEntries(state.meta),
      };
      // 先写临时文件再改名：中途崩溃不会留下半截缓存，下次读到半截 JSON 会白重建一次。
      const temp = `${file}.tmp`;
      writeFileSync(temp, gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 6 }));
      renameSync(temp, file);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-find-in-sessions: 缓存写入失败（不影响本次搜索）：${String(error)}`);
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
   * 对齐一次快照：只重读 sizeBytes/eventCount 变过的会话。
   * 正在写的会话每次都会变，所以它每次搜索都要重读——这是有意的，否则刚说的话搜不到。
   */
  async function build(requestedSessionId) {
    const snapshots = await snapshotsFor(requestedSessionId);
    const keep = [];
    const stale = [];
    for (const snapshot of snapshots) {
      const id = snapshot.header.id;
      const known = state.meta.get(id);
      const same =
        known !== undefined &&
        known.sizeBytes === snapshot.sizeBytes &&
        known.eventCount === snapshot.eventCount;
      if (same) keep.push(id);
      else stale.push(snapshot);
    }

    if (stale.length === 0 && state.ready) return;

    const freshMeta = new Map();
    const freshHeaders = new Map();
    for (const snapshot of snapshots) {
      const id = snapshot.header.id;
      freshMeta.set(id, { sizeBytes: snapshot.sizeBytes, eventCount: snapshot.eventCount });
      freshHeaders.set(id, {
        cwd: snapshot.header.cwd,
        createdAt: snapshot.header.createdAt,
        origin: snapshot.header.origin,
      });
    }

    // 只保留没变过的会话的文档，避免重读时把整份快照重建一遍。
    const keptIds = new Set(keep);
    const carried = state.docs.filter((doc) => keptIds.has(doc.s));

    const rebuilt = [];
    let index = 0;
    for (const snapshot of stale) {
      const id = snapshot.header.id;
      try {
        const handle = await ctx.sessionPersistence.open(id, 'read');
        try {
          const { events } = await handle.read();
          collectDocs(events, id, rebuilt);
        } finally {
          await handle.close();
        }
      } catch (error) {
        // 读失败时把这条从 meta 里摘掉：下次对比必然不等，于是会重试。
        // 不能沿用新 snapshot 的值，否则一次失败会让这个会话被永久跳过。
        freshMeta.delete(id);
        ctx.logger?.warn?.(`dsh-find-in-sessions: 会话 ${id} 读取失败：${String(error)}`);
      }
      // 大目录下定期让出事件循环，避免长时间占住 Host 线程让 GUI 卡顿。
      index += 1;
      if (index % 64 === 0) await sleep(0);
    }

    state.docs = carried.concat(rebuilt).sort((a, b) => a.m - b.m);
    state.meta = freshMeta;
    state.headers = freshHeaders;
    state.ready = true;
    state.error = null;
    state.builtAt = Date.now();
    saveCache();
  }

  /**
   * 首次搜索阻塞到快照可用；之后只触发后台对齐，本次响应立刻用现有快照回答。
   * 否则每 5 秒一次的 list() 会把「按键即出」拖成一百多毫秒的等待。
   *
   * @returns 需要等待的 promise，或 undefined（已有快照，本次不等）。
   */
  function ensureReady(requestedSessionId) {
    if (state.building === null) {
      state.building = build(requestedSessionId)
        .catch((error) => {
          state.error = String(error);
          ctx.logger?.warn?.(`dsh-find-in-sessions: 构建失败：${String(error)}`);
        })
        .finally(() => {
          state.building = null;
        });
    }
    return state.ready ? undefined : state.building;
  }

  function search(query, scope, sessionId, role, since) {
    const phrase = query.toLowerCase().trim();
    const words = phrase.split(/\s+/).filter(Boolean);
    if (words.length === 0) return { total: 0, hits: [], groups: [], sessionCount: 0, sessions: {} };

    const inScope = (doc) => {
      if (scope === 'session' && sessionId !== null && doc.s !== sessionId) return false;
      // role: 'u' 只看用户说的，'a' 只看助手回复，null 不过滤
      if (role !== null && doc.r !== role) return false;
      return true;
    };

    // docs 按时间升序，从末尾往前扫：越过时间窗口就停。
    // 时间窗口是纯收益项——它同时缩小候选集和结果集，且不必扫完整份语料。
    const scan = (accept) => {
      const found = [];
      for (let index = state.docs.length - 1; index >= 0; index -= 1) {
        const doc = state.docs[index];
        if (since > 0 && doc.m < since) break;
        if (!inScope(doc)) continue;
        if (accept(doc)) found.push(doc);
      }
      return found;
    };

    // 多词查询先当整串短语查。否则 `let me check` 会被拆成三个常见子串做 AND，
    // 命中上百条只是碰巧都包含 let / me / check 的正文，看起来像乱匹配。
    let matched = null;
    if (words.length > 1) {
      const exact = scan((doc) => doc.x.toLowerCase().includes(phrase));
      if (exact.length > 0) matched = exact;
    }
    if (matched === null) {
      const needles = words.map(compileNeedle);
      matched = scan((doc) => needles.every((needle) => matchesNeedle(doc, needle)));
    }

    // scan 已经是时间倒序，这里再排一次是防御：万一某处把 docs 顺序打乱，
    // 排序仍在，只是不会再提前停扫。
    matched.sort((a, b) => b.m - a.m);
    const total = matched.length;

    // 按会话分组，每个会话只采样最近 MAX_PER_SESSION 条。
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
      for (const doc of group.docs) {
        const at = locate(doc.x, phrase, words);
        // anchor 是关键词周围的原文，专供 Client 在 DOM 里做二次定位。
        //
        // 不能拿消息开头当指纹：实测同一轮里有两条消息都以 `http://127.0.0.1:3080/?`
        // 开头，指纹撞车后定位跳到了另一条消息上。关键词一定出现在目标消息里，
        // 用它周围的文本定位，误匹配率低得多。
        const anchorStart = Math.max(0, (at < 0 ? 0 : at) - 24);
        hits.push({
          sessionId: doc.s,
          seq: doc.q,
          role: doc.r,
          turn: doc.t,
          time: doc.m,
          anchor: doc.x.slice(anchorStart, anchorStart + 60).replace(/\s+/g, ' '),
          head: doc.x.slice(0, 80).replace(/\s+/g, ' '),
          snippet: makeSnippet(doc.x, at),
        });
      }
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
    const sessions = {};
    for (const hit of hits) {
      if (sessions[hit.sessionId] === undefined) {
        sessions[hit.sessionId] = state.headers.get(hit.sessionId) ?? {};
      }
    }
    return {
      total,
      hits,
      groups: payloadGroups,
      sessionCount: bySession.size,
      sampled: hits.length,
      sessions,
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
    const warm = setTimeout(() => {
      void ensureReady();
    }, 2500);
    return () => clearTimeout(warm);
  }, 'dsh-find-in-sessions.warmup');

  ctx.effect(() => {
    // 先吃磁盘缓存，哪怕它已经过期——有东西可搜总比空着好，随后增量补齐。
    loadCache();
  }, 'dsh-find-in-sessions.cache-load');

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
        const roleParam = url.searchParams.get('role');
        const role = roleParam === 'u' || roleParam === 'a' ? roleParam : null;
        // 时间窗口：只接受正数毫秒时间戳，缺失或非法值表示不限制。
        const sinceParam = Number(url.searchParams.get('since'));
        const since = Number.isFinite(sinceParam) && sinceParam > 0 ? sinceParam : 0;

        if (query.length === 0) {
          json(res, 200, { total: 0, hits: [], tookMs: 0, ready: state.ready });
          return;
        }
        if (query.length > 200) {
          json(res, 400, { error: 'query too long' });
          return;
        }

        const started = performance.now();
        const pending = ensureReady(sessionId ?? undefined);
        if (pending !== undefined) {
          try {
            await pending;
          } catch (error) {
            json(res, 500, { error: String(error) });
            return;
          }
        }
        const result = search(query, scope, sessionId, role, since);
        json(res, 200, {
          ...result,
          tookMs: Math.round((performance.now() - started) * 10) / 10,
          ready: state.ready,
          docs: state.docs.length,
          builtAt: state.builtAt,
        });
      },
    });
  }, 'dsh-find-in-sessions.route');
}
