/**
 * dsh-find-in-sessions 浏览器半：Ctrl+F 呼出的查找栏。
 *
 * 为什么注册在 shell.overlay：这是宿主给出的整帧浮层，独立于各列的滚动容器，
 * 做「像 IDE 那样压在内容上方的查找栏」正是它的用途；换成 conversation 里的槽位
 * 会跟着会话内容一起滚动。
 *
 * Ctrl+F 被拦下来的代价已确认接受：DSH 跑在浏览器里，这个组合原本是页面内查找。
 *
 * 跳转靠宿主自己的两件东西，不自己猜位置：
 *   1. ISession.loadThrough(seq) 把目标消息所在的历史页拉出来；
 *   2. 对话行的 data-chat-turn 属性做最终锚点（工具命中退化成它所在的那一轮）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-find-in-sessions',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const ROUTE = '/session-search/query';
    const HIT_CLASS = 'dsh-fis-hit';
    const STYLE_ID = 'dsh-find-in-sessions-css';
    const DEBOUNCE_MS = 140;
    const JUMP_TIMEOUT_MS = 9000;

    const CSS = `
.dsh-fis-hit{
  outline:2px solid var(--dsw-alias-brand-primary,#4a9eff)!important;
  outline-offset:4px;
  border-radius:10px;
  background:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a9eff) 12%, transparent)!important;
}
`;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /** 当前打开的会话 id：宿主把它写在对话容器的 data 属性上，比猜服务快也稳。 */
    function currentSessionId() {
      const withAttr = document.querySelector('[data-conversation-session]');
      const value = withAttr?.getAttribute('data-conversation-session');
      return value && value.length > 0 ? value : null;
    }

    function conversationRoot(sessionId) {
      if (sessionId !== null) {
        const exact = document.querySelector(`[data-conversation-session="${escapeAttr(sessionId)}"]`);
        if (exact !== null) return exact;
      }
      return (
        document.querySelector('[data-slot="conversation.view"]') ??
        document.querySelector('[data-conversation-scroll]')
      );
    }

    function escapeAttr(value) {
      return value.replace(/["\\]/g, '\\$&');
    }

    function clearHighlight() {
      for (const element of document.querySelectorAll(`.${HIT_CLASS}`)) {
        element.classList.remove(HIT_CLASS);
      }
    }

    function markHit(element) {
      clearHighlight();
      element.classList.add(HIT_CLASS);
    }

    /**
     * 归一化正文用于比对：宿主的对话行渲染的是 markdown 结果，而 Host 侧给的
     * head 是原始 JSON 文本，直接 includes 会被 `**`、反引号、表格竖线挡住。
     * 两边都去掉这些符号和空白后只剩文字，再比才有意义。
     */
    function normalizeText(value) {
      return (value ?? '').replace(/[\s`*_#>[\]]+|\\+/g, '');
    }

    /**
     * 在对话里挑出命中的那一行。
     *
     * 不能用 data-chat-turn 当锚点：实测同一轮里所有行（用户消息、助手步、
     * 工具卡）都写着同一个 data-chat-turn，而且值不是会话内的轮次号，是
     * 「当前视图里第几组」——真正可靠的轮次号写在 data-chat-node-key 的前缀上，
     * 形如 `13:input-message9683f1ad-...`，冒号前就是轮次。
     *
     * 所以：先按 node-key 前缀圈出那一轮，再用正文头部指纹挑出具体那一条；
     * 指纹对不上才退到同轮同角色的第一行。
     */
    function pickTarget(root, hit) {
      const all = Array.from(root.querySelectorAll('[data-chat-node-key]'));
      if (all.length === 0) return null;

      const prefix = `${hit.turn}:`;
      const byTurn =
        hit.turn > 0 ? all.filter((el) => (el.getAttribute('data-chat-node-key') ?? '').startsWith(prefix)) : [];
      const pool = byTurn.length > 0 ? byTurn : all;

      const probe = normalizeText(hit.head).slice(0, 20);
      if (probe.length >= 8) {
        for (const element of pool) {
          if (normalizeText(element.textContent).includes(probe)) return element;
        }
      }

      const roleKey = hit.role === 'u' ? 'user' : 'assistant';
      const byRole = pool.filter((el) => (el.getAttribute('data-chat-flow-kind') ?? '').includes(roleKey));
      return byRole[0] ?? pool[0] ?? null;
    }

    /** 侧边栏会话行：宿主给每行挂了 data-row-key="session:<id>"，点击等价于用户手点。 */
    function sidebarRow(sessionId) {
      return document.querySelector(`[data-row-key="session:${escapeAttr(sessionId)}"]`);
    }

    /**
     * 切到目标会话，并确认真的切过去了。
     *
     * ctx.uiWorkspace.openSession 在实测里调用了却不换会话（无异常、无日志），
     * 而点侧边栏同一行可以。所以主路径失败后补一次「点侧边栏」，
     * 两条路都失败才认输，绝不假装切成功。
     */
    async function switchSession(ctx, sessionId) {
      if (currentSessionId() === sessionId) return true;
      try {
        ctx.uiWorkspace.openSession(sessionId);
      } catch (error) {
        console.warn('[session-search] openSession threw:', error);
      }
      await sleep(150);
      if (currentSessionId() === sessionId) return true;

      const row = sidebarRow(sessionId);
      if (row !== null) {
        row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        row.click();
        await sleep(150);
      }
      return currentSessionId() === sessionId;
    }

    /**
     * 把对话滚到命中那一行并高亮。
     *
     * 命中可能在还没加载的历史里，所以切完会话先试着找，找不到再用
     * loadThrough(seq) 把那一页拉出来。loadThrough 只调一次：它是
     * 「向前翻页直到覆盖 seq」的语义，每 80ms 调一次会把宿主加载队列打爆，
     * 表现就是点了半天不动。
     */
    async function jumpTo(ctx, hit, isStale) {
      const switched = await switchSession(ctx, hit.sessionId);
      if (!switched) return 'not-switched';

      const deadline = Date.now() + JUMP_TIMEOUT_MS;
      let element = null;
      let pulled = false;
      while (Date.now() < deadline) {
        if (isStale()) return 'stale';
        const root = conversationRoot(hit.sessionId);
        if (root !== null) {
          element = pickTarget(root, hit);
          if (element !== null) break;
        }
        if (!pulled) {
          pulled = true;
          const binding = ctx.sessions.binding(hit.sessionId);
          if (binding !== undefined) {
            try {
              await binding.session.loadThrough(hit.seq);
            } catch {
              // 拉不动也别卡死，继续轮询等宿主自己渲染。
            }
          }
        }
        await sleep(80);
      }

      if (element === null) return 'not-rendered';
      element.scrollIntoView({ block: 'center', behavior: 'smooth' });
      markHit(element);
      return 'ok';
    }

    const S = {
      root: {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        zIndex: 60,
      },
      panel: {
        position: 'absolute',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(760px, calc(100vw - 48px))',
        display: 'flex',
        flexDirection: 'column',
        pointerEvents: 'auto',
        background: 'var(--dsw-alias-bg-overlay, #262626)',
        border: '1px solid var(--dsw-alias-border-l2, #3c3c3c)',
        borderRadius: 8,
        boxShadow: '0 12px 32px rgba(0,0,0,.38)',
        overflow: 'hidden',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
      },
      bar: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px 6px 10px',
        minHeight: 36,
      },
      input: {
        flex: 1,
        minWidth: 0,
        border: 'none',
        outline: 'none',
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
        fontFamily: 'inherit',
        padding: '2px 0',
      },
      count: {
        flex: '0 0 auto',
        color: 'var(--dsw-alias-label-tertiary, #8c8c8c)',
        fontVariantNumeric: 'tabular-nums',
        fontSize: 12,
        padding: '0 2px',
        whiteSpace: 'nowrap',
      },
      iconButton: (active) => ({
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        background: active ? 'var(--dsw-alias-interactive-bg-active, #3a3a3a)' : 'transparent',
        color: 'var(--dsw-alias-label-secondary, #b3b3b3)',
        fontSize: 13,
        lineHeight: 1,
        padding: 0,
      }),
      scope: {
        flex: '0 0 auto',
        border: '1px solid var(--dsw-alias-border-l1, #3c3c3c)',
        borderRadius: 4,
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #b3b3b3)',
        fontSize: 12,
        padding: '2px 8px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      list: {
        borderTop: '1px solid var(--dsw-alias-border-l1, #3c3c3c)',
        maxHeight: 420,
        overflowY: 'auto',
      },
      row: (selected) => ({
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '6px 10px',
        cursor: 'pointer',
        background: selected ? 'var(--dsw-alias-interactive-bg-active, #3a3a3a)' : 'transparent',
      }),
      rowTop: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        fontSize: 11,
        color: 'var(--dsw-alias-label-tertiary, #8c8c8c)',
      },
      rowText: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      status: {
        padding: '6px 10px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-tertiary, #8c8c8c)',
      },
      mark: {
        background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d8a33a) 35%, transparent)',
        color: 'inherit',
        borderRadius: 2,
      },
    };

    /** 片段里把命中的关键词包成高亮，同时把文本按关键词切开——只切一次，避免逐字符 DOM。 */
    function renderSnippet(text, needles) {
      const lowered = text.toLowerCase();
      const spans = [];
      let cursor = 0;
      while (cursor < text.length) {
        let best = -1;
        let bestLen = 0;
        for (const needle of needles) {
          const at = lowered.indexOf(needle, cursor);
          if (at >= 0 && (best < 0 || at < best)) {
            best = at;
            bestLen = needle.length;
          }
        }
        if (best < 0) {
          spans.push(text.slice(cursor));
          break;
        }
        if (best > cursor) spans.push(text.slice(cursor, best));
        spans.push(h('mark', { key: `m${best}`, style: S.mark }, text.slice(best, best + bestLen)));
        cursor = best + bestLen;
      }
      return spans;
    }

    function formatTime(ms) {
      if (!ms) return '';
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    /**
     * apply 的 ctx 存在模块级变量里。
     *
     * 不能像最初那样从 slot 的 props 取：props 里只有 use* 系列 hook，没有 ctx，
     * 取到的是 undefined，uiWorkspace.openSession 每次调用都抛 TypeError 被静默吞掉。
     *
     * 也不能在 apply 里包一层 `function Bound(props) { return SearchOverlay({...props, ctx}) }`
     * 再注册：Bound 是每次 inject 新建的函数，React 视为新的组件类型，会卸载重挂，
     * 组件内的 open / 结果状态被反复重置，表现就是按 Ctrl+F 毫无反应。
     * 所以组件引用必须稳定，ctx 走这个模块级单例。
     */
    let hostContext = null;

    function SearchOverlay(props) {
      const ctx = props.ctx ?? hostContext;
      const [open, setOpen] = useState(false);
      const [query, setQuery] = useState('');
      const [scope, setScope] = useState('session');
      const [autoScope, setAutoScope] = useState(false);
      const [result, setResult] = useState({ hits: [], total: 0, tookMs: 0, docs: 0, sessions: {}, error: null, loading: false });
      const [active, setActive] = useState(0);
      const [status, setStatus] = useState('');
      const [searchSeq, setSearchSeq] = useState(0);
      const inputRef = useRef(null);
      const jumpToken = useRef(0);
      // 命中列表放 ref：go 要稳定，否则每次搜索都重建 go，
      // 依赖它的 effect 就会在每次渲染后重复触发一次跳转。
      const hitsRef = useRef(result.hits);
      hitsRef.current = result.hits;
      const activeRef = useRef(0);

      /** 关闭查找栏。必须一并清掉高亮：它挂在宿主的对话行上，不随浮层卸载消失。 */
      const close = useCallback(() => {
        setOpen(false);
        setStatus('');
        clearHighlight();
      }, []);

      /**
       * 会话标题：用宿主返回的工作目录尾段，取不到就退回短 id。
       * 不引 useSessions 是刻意的——那个 hook 的签名属于宿主 UI 内部约定，
       * 换个版本就可能变，而 cwd 来自会话 header，跨版本稳定。
       */
      const titleOf = useCallback(
        (sessionId) => {
          const meta = result.sessions?.[sessionId];
          const cwd = meta?.cwd;
          if (typeof cwd === 'string' && cwd.length > 0) {
            const parts = cwd.split(/[\\/]/).filter(Boolean);
            if (parts.length > 0) return parts[parts.length - 1];
          }
          if (meta?.origin === 'subagent') return '子会话';
          return sessionId.slice(0, 8);
        },
        [result.sessions],
      );

      useEffect(() => {
        if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return undefined;
        const style = document.createElement('style');
        style.setAttribute('data-plugin-css', STYLE_ID);
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, []);

      // 默认范围跟随「当前有没有打开的会话」：有就只搜它，没有就搜全部。
      useEffect(() => {
        if (!open) return;
        const current = currentSessionId();
        setAutoScope(current === null);
        setScope(current === null ? 'all' : 'session');
      }, [open]);

      useEffect(() => {
        const onKeyDown = (event) => {
          const key = event.key.toLowerCase();
          const isFind = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && key === 'f';
          if (isFind) {
            // 抢掉浏览器原生查找：这是主人点过头的取舍。
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
            return;
          }
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [open, close]);

      useEffect(() => {
        if (!open) return;
        const id = requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
        return () => cancelAnimationFrame(id);
      }, [open]);

      useEffect(() => {
        if (!open) return undefined;
        const text = query.trim();
        if (text.length === 0) {
          setResult({ hits: [], total: 0, tookMs: 0, docs: 0, sessions: {}, error: null, loading: false });
          setStatus('');
          setActive(0);
          return undefined;
        }
        const timer = setTimeout(async () => {
          setResult((prev) => ({ ...prev, loading: true }));
          const sessionId = currentSessionId();
          const url =
            `${ROUTE}?q=${encodeURIComponent(text)}` +
            `&scope=${scope}` +
            (sessionId === null ? '' : `&sessionId=${encodeURIComponent(sessionId)}`);
          try {
            const response = await fetch(url, { headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = await response.json();
            setResult({
              hits: body.hits ?? [],
              total: body.total ?? 0,
              tookMs: body.tookMs ?? 0,
              docs: body.docs ?? 0,
              sessions: body.sessions ?? {},
              error: null,
              loading: false,
            });
            setActive(0);
            activeRef.current = 0;
            // searchSeq 是「这次搜索得跳一次」的信号，effect 只认它。
            setSearchSeq((prev) => prev + 1);
            setStatus('');
          } catch (error) {
            setResult({ hits: [], total: 0, tookMs: 0, docs: 0, sessions: {}, error: String(error), loading: false });
            setStatus('');
          }
        }, DEBOUNCE_MS);
        return () => clearTimeout(timer);
      }, [query, scope, open]);

      const needles = useMemo(
        () => query.toLowerCase().split(/\s+/).filter(Boolean),
        [query],
      );

      const go = useCallback(
        async (index) => {
          const hit = hitsRef.current[index];
          if (hit === undefined) return;
          const token = jumpToken.current + 1;
          jumpToken.current = token;
          const outcome = await jumpTo(ctx, hit, () => jumpToken.current !== token);
          const messages = {
            'not-rendered': '这一处还没渲染出来，再按一次或继续翻页',
            'not-switched': '没能切到那个会话，先从左侧点开它再搜',
          };
          setStatus(messages[outcome] ?? '');
        },
        [ctx],
      );

      // 只有「一次新搜索完成」才自动跳第一处。用户按方向键、点结果都直接调 go，
      // 不走 effect——否则 setActive 和 effect 会各跳一次，跳转互相打断。
      useEffect(() => {
        if (!open || searchSeq === 0) return;
        if (hitsRef.current.length === 0) return;
        void go(0);
      }, [searchSeq, open, go]);

      /** 上下移动命中。用 ref 记当前下标：setState 是异步的，回调里拿不到新值。 */
      const step = useCallback(
        (delta) => {
          const count = hitsRef.current.length;
          if (count === 0) return;
          const next = (activeRef.current + delta + count) % count;
          activeRef.current = next;
          setActive(next);
          void go(next);
        },
        [go],
      );

      const onInputKeyDown = (event) => {
        if (event.key === 'ArrowDown' || (event.key === 'Enter' && !event.shiftKey)) {
          event.preventDefault();
          step(1);
          return;
        }
        if (event.key === 'ArrowUp' || (event.key === 'Enter' && event.shiftKey)) {
          event.preventDefault();
          step(-1);
          return;
        }
        if (event.key === 'F3') {
          event.preventDefault();
          step(event.shiftKey ? -1 : 1);
        }
      };

      useEffect(() => {
        if (!open) return undefined;
        const onGlobal = (event) => {
          if (event.key === 'F3') {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }
          if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            step(event.key === 'ArrowDown' ? 1 : -1);
          }
        };
        window.addEventListener('keydown', onGlobal, true);
        return () => window.removeEventListener('keydown', onGlobal, true);
      }, [open, step]);

      if (!open) return null;

      const counter =
        result.total === 0
          ? '无结果'
          : `${active + 1} / ${result.hits.length}${result.total > result.hits.length ? `（共 ${result.total}）` : ''}`;

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.panel, role: 'search', 'aria-label': '会话搜索' },
          h(
            'div',
            { style: S.bar },
            h('span', { style: { ...S.count, paddingLeft: 0 } }, '查找'),
            h('input', {
              ref: inputRef,
              style: S.input,
              value: query,
              placeholder: '搜索所有会话的对话内容（空格分隔多个关键词）',
              spellCheck: false,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: onInputKeyDown,
            }),
            h('span', { style: S.count }, result.loading ? '搜索中…' : counter),
            h(
              'button',
              { style: S.iconButton(false), title: '上一处 (Shift+Enter / Shift+F3)', onClick: () => step(-1) },
              '↑',
            ),
            h(
              'button',
              { style: S.iconButton(false), title: '下一处 (Enter / F3)', onClick: () => step(1) },
              '↓',
            ),
            h(
              'button',
              {
                style: S.scope,
                title: autoScope ? '当前没有打开的会话，默认搜索全部会话' : '切换搜索范围',
                onClick: () => setScope((prev) => (prev === 'session' ? 'all' : 'session')),
              },
              scope === 'session' ? '当前会话' : '全部会话',
            ),
            h(
              'button',
              { style: S.iconButton(false), title: '关闭 (Esc)', onClick: close },
              '×',
            ),
          ),
          status.length > 0 ? h('div', { style: S.status }, status) : null,
          result.error !== null
            ? h('div', { style: { ...S.status, color: 'var(--dsw-alias-state-error-primary, #e05c5c)' } }, `搜索失败：${result.error}`)
            : null,
          result.hits.length > 0
            ? h(
                'div',
                { style: S.list },
                result.hits.map((hit, index) =>
                  h(
                    'div',
                    {
                      key: `${hit.sessionId}:${hit.seq}`,
                      style: S.row(index === active),
                      onMouseDown: (event) => {
                        event.preventDefault();
                        // 直接跳：点当前已选中的那行时 active 不变，
                        // 靠 setActive 触发 effect 会什么都不发生。
                        activeRef.current = index;
                        setActive(index);
                        void go(index);
                      },
                    },
                    h(
                      'div',
                      { style: S.rowTop },
                      h('span', null, hit.role === 'u' ? '你' : '助手'),
                      h('span', null, titleOf(hit.sessionId)),
                      h('span', null, `第 ${hit.turn} 轮`),
                      h('span', null, formatTime(hit.time)),
                    ),
                    h('div', { style: S.rowText }, renderSnippet(hit.snippet, needles)),
                  ),
                ),
              )
            : null,
        ),
      );
    }

    return {
      inject: ['slots', 'sessions', 'uiWorkspace'],
      apply(host) {
        hostContext = host;
        host.slots.inject('shell.overlay', () =>
          host.slots.register({ name: 'shell.overlay', id: 'session-search', order: 90 }, SearchOverlay),
        );
      },
    };
  },
});
