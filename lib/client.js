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

    /**
     * 查询与上下文共用一个路由，`op` 区分。
     *
     * 宿主半只有一处鉴权围栏；原来两个路径各写一份，改一处忘另一处就是裸奔。
     */
    const ROUTE = '/session-search';

    /**
     * 就地跳转的轮次阈值。
     *
     * 宿主的会话视图**没有虚拟化**（实测 bundle 里 Virtualizer / overscan / estimateSize
     * 全部零命中，`replaceWindow` 只是数据分页）——一个会话的消息全量挂成 DOM。
     * 本机最长的一个会话有 6773 条消息（858 轮）、解压 91 MB，在这种容器上设一次
     * scrollTop 要把中间全部内容参与布局，浏览器直接卡死；把官方滚动条拖到顶也一样卡。
     *
     * 为什么用「轮」而不是「消息条数」：用户判断一个会话大不大，用的是轮次。
     * 实测全库平均 3.74 条消息/轮，所以 100 轮约等于 374 条消息——
     * 比原先的 300 条宽松约 25%，把「312 条 / 51 轮」这类中等会话放回就地跳转，
     * 同时仍然拦住 645 条以上的（180 轮起）。
     *
     * 注意：轮次只是规模的**代理指标**，真正决定渲染开销的是 DOM 节点数。
     * 两者正相关但不相等——同一轮里工具调用越多，节点数越偏离轮次。
     * 若哪天出现「轮次少但照样卡」的会话，应当改判据而不是继续调阈值。
     */
    const SMALL_SESSION_TURNS = 100;

    /** 注册到 better-sidebar 的 tab 类型 id。 */
    const TAB_TYPE = 'session-search';
    const MARK_CLASS = 'dsh-fis-mark';
    /** 列表展开状态存在 localStorage：跨会话、跨刷新都保持上次的选择。 */
    const EXPAND_KEY = 'dsh-find-in-sessions:expanded';
    /** 收起时不渲染列表（只留搜索栏），展开时露约 10 行。 */
    const EXPANDED_MAX = 420;

    /**
     * 时间窗口档位。
     *
     * 默认 7 天：实测全部语料里 71.5% 落在 30 天内，所以 30 天这一档几乎等于「全部」；
     * 而 7 天能把常见词的命中压到四分之一上下（光缆 588→83、日志 675→156），
     * 同时不丢上周的工作。1 天/3 天留给「就是刚才那条」的场景。
     */
    const RANGE_KEY = 'dsh-find-in-sessions:range';
    /** 检索对象：正文还是工具输出。两份快照是分开的，切换时重新请求。 */
    const MODE_KEY = 'dsh-find-in-sessions:mode';
    const RANGES = [
      // 标签统一成「数字 + 天」：原来 1 天那档写「今天」，其余是「3 天 / 7 天 / 30 天」，
      // 混着两种说法读起来像两种不同的筛选维度。
      { id: '1d', label: '1天', days: 1 },
      { id: '3d', label: '3 天', days: 3 },
      { id: '7d', label: '7 天', days: 7 },
      { id: '30d', label: '30 天', days: 30 },
      { id: 'all', label: '全部', days: 0 },
    ];
    const DEFAULT_RANGE = '7d';
    const STYLE_ID = 'dsh-find-in-sessions-css';
    const DEBOUNCE_MS = 140;
    const JUMP_TIMEOUT_MS = 9000;

    const STYLE_TEXT = `
::highlight(dsh-fis-match){
  background:#ffd54a;
  color:#1f1f1f;
}
mark.dsh-fis-mark{
  background:#ffd54a;
  color:#1f1f1f;
  border-radius:2px;
  padding:0 1px;
  box-shadow:0 0 0 1px rgba(0,0,0,.15);
}
/* 窄面板里按优先级让位：输入框保底，其余从最不重要的开始收起。
   断点按「收起后 input 能回到 200px 以上」反推，容器是工具栏自身（见 S.bar 的
   containerType）。顺序：角色筛选 → 时间筛选 → 计数 → 展开按钮，
   ↑ ↓ × 与「正文/工具」不让位。
   用 range 语法（width<=）而不是 max-width：宿主 CSS 里就是这种写法，
   同一环境验证过。 */
@container (width<=588px){
  [data-fis="role"]{display:none}
}
@container (width<=526px){
  [data-fis="range"]{display:none}
}
@container (width<=452px){
  [data-fis="count"]{display:none}
}
@container (width<=396px){
  [data-fis="expand"]{display:none}
}
`;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * better-sidebar 的服务句柄；没装那个插件时为 null。
     *
     * 不写进 inject：cordis 的声明式依赖在服务缺失时会让整个 apply 不执行，
     * 那样连搜索本身都没了。侧栏只是增强，取不到就退回「跳转」这条旧路径。
     */
    let hostSidebar = null;

    /**
     * 前置插件是否缺失。只在轮询结束、确认拿不到服务时才置 true。
     *
     * 为什么不直接用 `hostSidebar === null` 判断：轮询期间它也是 null，
     * 面板一打开就会误报。三态语义：初值 false 表示「还在检测」，
     * 由 mountSidebarTab 在有了定论之后改写。
     */
    let sidebarMissing = false;

    /**
     * 缺失状态的订阅者。
     *
     * 检测发生在 apply 阶段（React 之外），而提示要显示在 React 面板里，
     * 所以得有一个最小订阅桥把外部状态变化推给组件——模块级变量本身不会触发重渲染。
     */
    const sidebarWatchers = new Set();

    function watchSidebar(fn) {
      sidebarWatchers.add(fn);
      return () => sidebarWatchers.delete(fn);
    }

    function setSidebarMissing(next) {
      if (sidebarMissing === next) return;
      sidebarMissing = next;
      for (const fn of sidebarWatchers) fn(next);
    }

    /** 正则转义：关键词要原样参与高亮切分。 */
    const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    /**
     * 把文本按关键词切成 React 片段，命中处包 mark。
     * 关键词先按长度降序，避免短词把长词切开（`会话` 抢在 `会话搜索` 前面匹配）。
     */
    function highlightText(text, needles) {
      const words = needles.filter((word) => word.length > 0).slice().sort((a, b) => b.length - a.length);
      if (words.length === 0) return text;
      const parts = text.split(new RegExp(`(${words.map(escapeRe).join('|')})`, 'gi'));
      return parts.map((part, index) =>
        index % 2 === 1 ? h('mark', { key: `m${index}`, style: T.mark }, part) : part,
      );
    }

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

    const HIGHLIGHT_NAME = 'dsh-fis-match';
    const NAV_POLL_MS = 50;
    const CONTENT_WAIT_MS = 1500;
    let navigationVersion = 0;
    let stopHighlight = null;

    function clearMarks() {
      navigationVersion += 1;
      stopHighlight?.();
      stopHighlight = null;
      CSS.highlights?.delete(HIGHLIGHT_NAME);
      // 清理旧版本留下的 mark；新高亮不再改写 React 管理的文本节点。
      for (const mark of document.querySelectorAll('mark.' + MARK_CLASS)) {
        const parent = mark.parentNode;
        if (!parent) continue;
        parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
        parent.normalize();
      }
    }

    /** Range 跨文本节点匹配，兼容语法高亮把 tool 拆成多个 span 的情况。 */
    function keywordRanges(root, needles) {
      const words = [...new Set(needles.filter(Boolean))].sort((a, b) => b.length - a.length);
      if (words.length === 0 || !root?.isConnected) return [];
      const nodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let text = '';
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement?.closest('script, style, textarea, [hidden], [aria-hidden="true"], [data-disclosure-header]')) continue;
        const value = node.nodeValue ?? '';
        if (!value) continue;
        nodes.push({ node, start: text.length, end: text.length + value.length });
        text += value;
      }
      const pattern = new RegExp(words.map(escapeRe).join('|'), 'gi');
      const ranges = [];
      let index = 0;
      for (const match of text.matchAll(pattern)) {
        const start = match.index, end = start + match[0].length;
        while (index < nodes.length && nodes[index].end <= start) index += 1;
        let last = index;
        while (last < nodes.length && nodes[last].end < end) last += 1;
        if (!nodes[index] || !nodes[last]) continue;
        const range = document.createRange();
        range.setStart(nodes[index].node, start - nodes[index].start);
        range.setEnd(nodes[last].node, end - nodes[last].start);
        if ([...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) ranges.push(range);
      }
      return ranges;
    }

    /** 只跟踪当前命中卡片；手动折叠/展开或异步输出重挂载后重建 Range。 */
    function watchHighlight(scope, resolveTarget, needles, stale) {
      let frame = null;
      let target = resolveTarget();
      const refresh = () => {
        if (stale() || !scope.isConnected) { dispose(); return []; }
        target = resolveTarget();
        const ranges = keywordRanges(target, needles);
        if (CSS.highlights && typeof Highlight === 'function') {
          const highlight = new Highlight();
          for (const range of ranges) highlight.add(range);
          CSS.highlights.set(HIGHLIGHT_NAME, highlight);
        }
        return ranges;
      };
      const observer = new MutationObserver(records => {
        const related = !target?.isConnected || records.some(record =>
          target.contains(record.target) ||
          (record.type === 'attributes' && record.target.contains(target)) ||
          [...record.removedNodes].some(node => node === target || node.contains?.(target)),
        );
        if (!related || frame !== null) return;
        frame = requestAnimationFrame(() => { frame = null; refresh(); });
      });
      observer.observe(scope, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['hidden', 'aria-expanded', 'data-open', 'data-expanded', 'data-chat-motion'],
      });
      function dispose() {
        observer.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        CSS.highlights?.delete(HIGHLIGHT_NAME);
      }
      stopHighlight = dispose;
      return { refresh };
    }

    /** 从内层输出滚动区向外逐层居中，滚到字符而非整张长卡片的开头。 */
    function scrollMatch(range, scope) {
      for (let element = range.startContainer.parentElement; element && scope.contains(element); element = element.parentElement) {
        const style = getComputedStyle(element);
        const rect = range.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight) {
          element.scrollTop += rect.top - box.top - element.clientHeight / 2 + rect.height / 2;
        }
        if (/(auto|scroll)/.test(style.overflowX) && element.scrollWidth > element.clientWidth) {
          element.scrollLeft += rect.left - box.left - element.clientWidth / 2 + rect.width / 2;
        }
      }
    }

    async function waitFor(check, deadline, stale) {
      while (!stale()) {
        if (check()) return true;
        if (Date.now() >= deadline) return false;
        await sleep(NAV_POLL_MS);
      }
      return false;
    }

    /**
     * 归一化正文用于比对：宿主的对话行渲染的是 markdown 结果，而 Host 侧给的
     * head 是原始 JSON 文本，直接 includes 会被 `**`、反引号、表格竖线挡住。
     * 两边都去掉这些符号和空白后只剩文字，再比才有意义。
     */
    function normalizeText(value) {
      return (value ?? '').replace(/[\s`*_#>[\]]+|\\+/g, '');
    }

    /** 工具缓存的 messageId 历史上存的是 callId，与普通消息 id 分开解释。 */
    function toolCallId(hit) {
      return hit.role === 't' || hit.mode === 'tool' ? (hit.callId || hit.messageId || '') : '';
    }

    function pickTarget(root, hit) {
      const callId = toolCallId(hit);
      if (callId) return root.querySelector('[data-chat-call-id="' + escapeAttr(callId) + '"]');
      if (hit.mode === 'tool' || hit.role === 't') return null;
      if (typeof hit.messageId === 'string' && hit.messageId.length >= 8) {
        const exact = root.querySelector('[data-chat-node-key$="' + escapeAttr(hit.messageId) + '"]');
        if (exact !== null) return exact;
      }
      // 旧正文记录缺 id 才使用内容指纹；工具命中绝不退到同轮其他消息。
      const all = [...root.querySelectorAll('[data-chat-node-key]')];
      for (const source of [hit.anchor, hit.head]) {
        if (typeof source !== 'string') continue;
        const probe = normalizeText(source).slice(0, 30);
        if (probe.length < 8) continue;
        const matches = all.filter(element => normalizeText(element.textContent).includes(probe));
        matches.sort((a, b) => a.textContent.length - b.textContent.length);
        if (matches.length > 0) return matches[0];
      }
      return null;
    }

    /**
     * 宿主 useSearchableHidden 监听 beforematch 来更新折叠状态。
     * 逐层通知真实祖先，替代 removeAttribute：只去掉 hidden 会被下次 React 渲染覆盖。
     */
    async function revealTarget(resolveTarget, scope, deadline, stale) {
      while (!stale()) {
        const target = resolveTarget();
        if (!target) return false;
        const hidden = [];
        for (let node = target; node && scope.contains(node); node = node.parentElement) {
          if (node.hasAttribute('hidden')) hidden.push(node);
        }
        if (hidden.length === 0) return true;
        const outer = hidden[hidden.length - 1];
        if (outer.getAttribute('hidden') !== 'until-found') return false;
        outer.dispatchEvent(new Event('beforematch'));
        if (!await waitFor(() => !outer.isConnected || !outer.hasAttribute('hidden'), deadline, stale)) return false;
      }
      return false;
    }

    /**
     * 展开工具卡片，直到它的正文里出现关键词。
     *
     * 两层折叠都要过：外层是 `data-disclosure-row`（卡片头），内层是
     * 「… 其余 N 行」这种分段渲染按钮——read / search / diff 类卡片受
     * maxLines 限制（实测 read 只给前 8 行），命中在第 147 行时那段 DOM
     * 根本不存在，Range 当然找不到，表现为「定位到了但没高亮」。
     *
     * 只动 callId 所属这张卡片，不碰同轮的其他工具调用。
     *
     * @returns 展开动作是否完成（能否高亮交给后续 Range 判定）
     */
    async function revealToolDetails(resolveTarget, needles, deadline, stale) {
      const target = resolveTarget();
      if (!target) return false;
      const hasNeedle = (node) => {
        const text = (node.textContent ?? '').toLowerCase();
        return needles.some((needle) => text.includes(needle));
      };
      const findRow = (node) =>
        [...node.querySelectorAll('[data-disclosure-row][aria-expanded]')]
          .find((element) => element.closest('[data-chat-call-id]') === node) ?? null;

      const row = findRow(target);
      if (row !== null && row.getAttribute('aria-expanded') !== 'true') {
        row.click();
        // click 后 state 在下一次 React 提交才更新，同一 JS 调用栈内读旧值不代表点击无效。
        if (!await waitFor(() => findRow(resolveTarget())?.getAttribute('aria-expanded') === 'true', deadline, stale)) {
          return false;
        }
      }

      // 内层分段渲染：一直点「其余 N 行」，直到出现关键词或没有更多可展开。
      for (let round = 0; round < 8; round += 1) {
        const current = resolveTarget();
        if (!current) return false;
        if (hasNeedle(current)) return true;
        const more = [...current.querySelectorAll('button')].find((button) =>
          /其余|expand/i.test(button.getAttribute('aria-label') ?? '') ||
          /其余|more lines/i.test(button.textContent ?? ''),
        );
        if (more === undefined) return true;
        more.click();
        await sleep(80);
      }
      return true;
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

    /** 坐标定位 → 展开该目标的折叠链 → 持续高亮；不扫描附近轮次。 */
    async function jumpTo(ctx, hit, isStale, needles) {
      clearMarks();
      const version = navigationVersion;
      const stale = () => version !== navigationVersion || isStale();
      const switched = await switchSession(ctx, hit.sessionId);
      if (stale()) return 'stale';
      if (!switched) return 'not-switched';
      const root = document.querySelector('[data-conversation-session="' + escapeAttr(hit.sessionId) + '"]');
      if (!root) return 'not-rendered';
      const resolveTarget = () => pickTarget(root, hit);
      const deadline = Date.now() + JUMP_TIMEOUT_MS;
      if (!resolveTarget()) {
        const binding = ctx.sessions?.binding(hit.sessionId);
        if (binding) await binding.session.loadThrough(hit.seq);
        if (!await waitFor(() => !!resolveTarget(), deadline, stale)) return stale() ? 'stale' : 'not-rendered';
      }
      if (!await revealTarget(resolveTarget, root, deadline, stale)) return stale() ? 'stale' : 'not-visible';
      if (toolCallId(hit) && !await revealToolDetails(resolveTarget, needles, deadline, stale)) return stale() ? 'stale' : 'not-visible';
      if (stale()) return 'stale';
      if (!CSS.highlights || typeof Highlight !== 'function') return 'highlight-unsupported';
      const highlight = watchHighlight(root, resolveTarget, needles, stale);
      let ranges = [];
      const found = await waitFor(() => {
        ranges = highlight.refresh();
        return ranges.length > 0;
      }, Math.min(deadline, Date.now() + CONTENT_WAIT_MS), stale);
      if (stale()) return 'stale';
      if (found) {
        scrollMatch(ranges[0], root);
        return 'ok';
      }
      resolveTarget()?.scrollIntoView({ block: 'center', behavior: 'auto' });
      // 观察者继续跟踪这一张卡片，手动展开/异步挂载后仍会刷新高亮，不强制再次展开。
      return 'no-keyword';
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
        // 让工具栏成为容器查询的基准：下面的 @container 断点按它的宽度决定
        // 收起哪些控件，纯 CSS 生效，不用 JS 测量再回写状态。
        containerType: 'inline-size',
      },
      input: {
        flex: 1,
        // 最后一道防线：所有可让位的控件收起后，输入框自己也不许再被压没。
        minWidth: 140,
        border: 'none',
        outline: 'none',
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
        fontFamily: 'inherit',
        padding: '2px 0',
      },
      // 右侧工具区：整体作为一个不伸缩的块，内部间距由它自己控制。
      // 单独划出来是因为这里的每个控件都必须定宽——否则计数文案一变长
      // （「14 处（共 14）」→「1 / 3 · Enter 预览（共 40）」），整排按钮都被推着走。
      tools: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flex: '0 0 auto',
      },
      // 定宽 + 右对齐 + 省略：内容在几种形态间切换时宽度不动，后面的按钮就不会位移。
      // 宽度按「最短形态」定（`4 / 51`、`13 处`、`索引中…`），完整计数放 title——
      // 以前按最长形态留 124px，实际只用到 40px 左右，白占掉输入框一大截。
      // 放大镜占位符：原来这里是一段「查找」文字，靠它说明用途，但输入框已经
      // 有描述用途的 placeholder，文字重复占掉 28px。改用内联 SVG 而不是宿主
      // 的图标 sprite（`#dsw-icon-*`）：换版本就失效，自绘 14px 更稳。
      searchIcon: {
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--dsw-alias-label-tertiary, #8c8c8c)',
      },
      count: {
        flex: '0 0 auto',
        width: 46,
        textAlign: 'right',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
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
        userSelect: 'none',
      }),
      // 固定宽度：文案在「全部 / 我 / 助手」之间切换时不能让整条工具栏跟着伸缩。
      role: {
        flex: '0 0 auto',
        width: 56,
        textAlign: 'center',
        border: '1px solid var(--dsw-alias-border-l1, #3c3c3c)',
        borderRadius: 4,
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #b3b3b3)',
        fontSize: 12,
        padding: '2px 0',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      },
      // 原生 select：深色主题下靠这三个属性对齐，比自己实现下拉省几十行。
      range: {
        flex: '0 0 auto',
        width: 68,
        border: '1px solid var(--dsw-alias-border-l1, #3c3c3c)',
        borderRadius: 4,
        background: 'var(--dsw-alias-bg-overlay, #262626)',
        color: 'var(--dsw-alias-label-secondary, #b3b3b3)',
        fontSize: 12,
        padding: '2px 2px',
        cursor: 'pointer',
        outline: 'none',
      },
      list: {
        borderTop: '1px solid var(--dsw-alias-border-l1, #3c3c3c)',
        // 只露 5 行：列表再高会把下面的会话内容整片挡住，其余滚轮看。
        maxHeight: 205,
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
      // 长消息的分块标记：靠右、不参与省略号竞争（rowTop 里的时间戳已经会截了）。
      rowChunk: {
        flex: '0 0 auto',
        marginLeft: 'auto',
        color: 'var(--dsw-alias-label-tertiary, #8c8c8c)',
        opacity: 0.85,
      },
      // 会话头：一级行，点一下展开或收起它的命中。
      groupRow: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        padding: '5px 10px',
        cursor: 'pointer',
        background: 'var(--dsw-alias-bg-layer-2, #2a2a2a)',
        borderTop: '1px solid var(--dsw-alias-border-l1, #3c3c3c)',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
        userSelect: 'none',
      },
      groupCaret: { flex: '0 0 auto', width: 10, color: 'var(--dsw-alias-label-tertiary, #8c8c8c)' },
      groupTitle: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      groupCount: { flex: '0 0 auto', color: 'var(--dsw-alias-brand-primary, #4a9eff)', fontSize: 11 },
      groupTime: { flex: '0 0 auto', color: 'var(--dsw-alias-label-tertiary, #8c8c8c)', fontSize: 11 },
  groupMore: { flex: '0 0 auto', color: 'var(--dsw-alias-brand-primary, #4a9eff)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' },
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
      /**
       * 前置依赖缺失的提示条。
       *
       * 用 warn 色做左边框而不是整块底色：它要能和下面的搜索结果区分开，
       * 又不能抢掉搜索本身的视觉重心。
       */
      warn: {
        padding: '8px 10px',
        margin: '0 0 2px',
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary, #b3b3b3)',
        borderLeft: '3px solid var(--dsw-alias-state-warn-primary, #d8a33a)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d8a33a) 10%, transparent)',
      },
      warnCode: {
        display: 'inline-block',
        marginTop: 4,
        padding: '2px 6px',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: 11,
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
        background: 'var(--dsw-alias-bg-layer-2, #2a2a2a)',
        borderRadius: 3,
        // 允许整段选中复制：这行命令是给用户拿去终端跑的。
        userSelect: 'all',
      },
      warnHint: {
        marginTop: 4,
        fontSize: 11,
        color: 'var(--dsw-alias-label-tertiary, #8c8c8c)',
      },
      mark: {
        background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d8a33a) 35%, transparent)',
        color: 'inherit',
        borderRadius: 2,
      },
    };

    /**
     * 侧栏 tab 的样式。侧栏比查找面板窄，且要跟随主题浅/深切换，
     * 所以只用 --dsw-alias-* token，不写死颜色。
     *
     * 布局是「头部固定 + 正文独立滚动」，不是「整块滚动」：
     * 原来 root 自己 `overflow: auto`，标题和操作按钮跟着内容一起滚走，
     * 读到长正文中段就找不到「会话定位」了。改成 flex 列之后，
     * 头部是布局的一部分，天然不参与滚动，也比 position: sticky 省掉
     * 「sticky 相对 padding box 定位」那套负偏移调整。
     */
    const T = {
      root: {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '10px 12px',
        boxSizing: 'border-box',
        fontSize: 12,
        lineHeight: 1.65,
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
      },
      /** 正文区：唯一可滚动的一层。minHeight: 0 是 flex 子项能真正收缩的前提。 */
      scroll: {
        flex: '1 1 auto',
        minHeight: 0,
        overflow: 'auto',
      },
      /** 固定层的底边：正文滚到头部下方时不会和标题糊在一起。 */
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 8,
        flex: '0 0 auto',
      },
      title: {
        flex: '1 1 auto',
        minWidth: 0,
        fontWeight: 600,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      action: {
        flex: '0 0 auto',
        // 定宽：文案在「会话定位 / 定位中…」之间切换时不能让按钮自己伸缩，
        // 否则按一次整行会跳一下，和查找栏里那几个循环按钮是同一个坑。
        minWidth: 62,
        boxSizing: 'border-box',
        textAlign: 'center',
        fontSize: 11,
        padding: '2px 8px',
        border: '1px solid var(--dsw-alias-border-l1, #3c3c3c)',
        borderRadius: 4,
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #b3b3b3)',
        cursor: 'pointer',
      },
      item: { borderTop: '1px solid var(--dsw-alias-border-l1, #3c3c3c)', padding: '8px 0' },
      itemFirst: { paddingTop: 0, borderTop: 'none' },
      itemMeta: {
        display: 'flex',
        gap: 8,
        fontSize: 11,
        color: 'var(--dsw-alias-label-tertiary, #8c8c8c)',
        marginBottom: 4,
      },
      anchor: { color: 'var(--dsw-alias-brand-primary, #4a9eff)' },
      text: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 },
      mark: {
        background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d8a33a) 35%, transparent)',
        color: 'inherit',
        borderRadius: 2,
      },
      hint: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #8c8c8c)' },
      error: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary, #e05c5c)' },
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

    /**
     * 搜索栏里的小按钮。
     *
     * 刻意不用 <button>：浏览器在点击后会把它设成焦点元素，之后用户按 Enter / 空格
     * 就是「再次点击这个按钮」而不是「跳下一处」，↑↓ 也不再落到输入框上。
     * 这里用 span 且在 mousedown 上 preventDefault，焦点始终留在输入框。
     */
    /**
     * @param attrs - 额外属性（这里是 `data-fis`），供容器查询按宽度分级隐藏。
     */
    function barButton(label, title, onActivate, style, attrs) {
      return h(
        'span',
        {
          style: style ?? S.iconButton(false),
          title,
          role: 'presentation',
          ...attrs,
          onMouseDown: (event) => {
            event.preventDefault();
            onActivate();
          },
        },
        label,
      );
    }
    /** 放大镜。自绘，不依赖宿主图标 sprite 的符号名。 */
    const magnifier = (size = 14) =>
      h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: 7, cy: 7, r: 4.6 }),
        h('line', { x1: 10.4, y1: 10.4, x2: 14, y2: 14 }),
      );

    /**
     * 侧栏里的命中预览。
     *
     * 刻意只做「只读片段 + 跳回原会话」：不复制宿主的对话渲染——markdown、
     * 工具卡片那些要靠宿主的组件树，自己重画一遍必然两边不一致。
     *
     * 坐标全在 tab.meta 里（sessionId / seq / 关键词），刷新后按坐标重取，
     * 所以正文不进持久化状态，侧栏布局存下来也不会被大段文本撑爆。
     */
    function SessionSearchView(props) {
      const rawMeta = props.tab === null || props.tab === undefined ? undefined : props.tab.meta;
      const meta = rawMeta !== null && typeof rawMeta === 'object' ? rawMeta : {};
      const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : '';
      const seq = typeof meta.seq === 'number' ? meta.seq : -1;
      // 与命中来源同一份快照：工具命中要拿工具输出，不是附近的正文。
      const mode = meta.mode === 'tool' ? 'tool' : 'text';
      const needles = Array.isArray(meta.needles) ? meta.needles.map(String) : [];
      const [view, setView] = useState({ loading: true, items: [], anchorSeq: -1, error: null });

      useEffect(() => {
        if (sessionId.length === 0 || seq < 0) {
          setView({ loading: false, items: [], anchorSeq: -1, error: '这个标签没有记录命中位置' });
          return undefined;
        }
        let cancelled = false;
        (async () => {
          setView((prev) => ({ ...prev, loading: true }));
          try {
            const url =
              `${ROUTE}?op=context&sessionId=${encodeURIComponent(sessionId)}&seq=${seq}&before=1&after=1` +
              // phrase 给宿主半用：分块之后命中可能不在 chunk 0，它靠这个在块里
              // 找出真正命中的那一块，否则预览永远停在消息开头。
              `&phrase=${encodeURIComponent(needles.join(' '))}` +
              (mode === 'tool' ? '&mode=tool' : '');
            const response = await fetch(url, { headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = await response.json();
            if (cancelled) return;
            setView({
              loading: false,
              items: body.items ?? [],
              anchorSeq: typeof body.anchorSeq === 'number' ? body.anchorSeq : -1,
              error: null,
            });
          } catch (error) {
            if (!cancelled) setView({ loading: false, items: [], anchorSeq: -1, error: String(error) });
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [sessionId, seq, mode]);

      const [switchNote, setSwitchNote] = useState('');
      const [opening, setOpening] = useState(false);
      const openVersion = useRef(0);
      const mounted = useRef(true);
      // 切原会话会卸载当前侧栏；卸载只停止 UI 回写，导航本身继续完成。
      useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
      }, []);
      const openSession = async () => {
        const version = ++openVersion.current;
        const stale = () => version !== openVersion.current;
        const anchor = view.items.find(item => item.seq === view.anchorSeq);
        const role = mode === 'tool' ? 't' : (meta.role ?? anchor?.role ?? 'a');
        const hit = {
          sessionId, seq, mode, role,
          turn: anchor?.turn ?? (typeof meta.turn === 'number' ? meta.turn : 0),
          messageId: typeof meta.messageId === 'string' ? meta.messageId : '',
          callId: mode === 'tool' ? (meta.callId || meta.messageId || '') : '',
          anchor: typeof meta.anchor === 'string' ? meta.anchor : '',
          head: typeof meta.head === 'string' ? meta.head : (anchor?.text?.slice(0, 80) ?? ''),
        };
        setOpening(true);
        setSwitchNote('正在定位…');
        try {
          const outcome = await jumpTo(hostContext ?? props.ctx, hit, stale, needles);
          if (stale() || !mounted.current) return;
          const messages = {
            'not-rendered': '目标记录尚未加载，未跳到其他消息',
            'not-switched': '目标会话未打开',
            'not-visible': '目标折叠层尚未展开',
            'no-keyword': '已定位该记录；当前显示内容未含关键词，展开详情后会自动更新高亮',
            'highlight-unsupported': '当前浏览器未支持文本范围高亮',
          };
          setSwitchNote(outcome === 'ok' || outcome === 'stale' ? '' : (messages[outcome] ?? outcome));
        } catch (error) {
          if (!stale() && mounted.current) setSwitchNote('定位失败：' + String(error));
        } finally {
          if (!stale() && mounted.current) setOpening(false);
        }
      };

      const head = h(
        'div',
        { style: T.head },
        h('span', { style: T.title }, props.tab?.title ?? '命中预览'),
        sessionId.length > 0
          ? h(
              'button',
              {
                type: 'button',
                style: T.action,
                disabled: opening,
                onClick: () => void openSession(),
              },
              opening ? '定位中…' : '会话定位',
            )
          : null,
      );

      const note = switchNote.length > 0 ? h('div', { style: { ...T.hint, flex: '0 0 auto' } }, switchNote) : null;

      /**
       * 外壳：头部与提示常驻，只有 children 那一层滚动。
       *
       * 必须是 rest 参数：调用处按 `shell(...items.map(...))` 展开传进来，
       * 写成 `(children)` 只接到第一条，其余静默丢掉——预览里就只剩一屏，
       * 而且因为第一条恰好很长，看上去像「正常」。
       */
      const shell = (...children) => h('div', { style: T.root }, head, note, h('div', { style: T.scroll }, ...children));

      if (view.loading) {
        return shell(h('div', { style: T.hint }, '读取中…'));
      }
      if (view.error !== null) {
        return shell(h('div', { style: T.error }, view.error));
      }
      if (view.items.length === 0) {
        return shell(h('div', { style: T.hint }, '这条命中没有正文可显示'));
      }

      return shell(
        ...view.items.map((item, index) =>
          h(
            'div',
            { key: `c${item.seq}`, style: index === 0 ? { ...T.item, ...T.itemFirst } : T.item },
            h(
              'div',
              { style: T.itemMeta },
              h('span', null, item.role === 'u' ? '你' : item.role === 't' ? '工具' : '助手'),
              h('span', null, `第 ${item.turn} 轮`),
              h('span', null, formatTime(item.time)),
              item.seq === view.anchorSeq ? h('span', { style: T.anchor }, '命中') : null,
            ),
            h('div', { style: T.text }, highlightText(item.text, needles)),
          ),
        ),
      );
    }

    function SearchOverlay(props) {
      const ctx = props.ctx ?? hostContext;

      const [open, setOpen] = useState(false);
      const [query, setQuery] = useState('');
      // 范围：auto 表示「跟随当前有没有打开的会话」，session / all 是用户手动锁定。
      // 不能在打开查找栏那一刻判一次就定死：那时候对话可能还没渲染，
      // currentSessionId() 拿到 null，从此一直搜全部会话——用户以为在搜本会话，
      // 结果混进了别处的内容。所以每次搜索都重新判。
      const [scopeMode, setScopeMode] = useState('auto');
      const [effectiveScope, setEffectiveScope] = useState('session');
      // 前置插件缺失提示。初值取模块级变量：面板可能在检测结束之后才第一次打开，
      // 那时状态已经定论了，不需要再等一次订阅回调。
      const [missingSidebar, setMissingSidebar] = useState(sidebarMissing);
      useEffect(() => watchSidebar(setMissingSidebar), []);
      // 角色筛选：'all' 不过滤，'u' 只看用户说的，'a' 只看助手回复。
      const [roleFilter, setRoleFilter] = useState('all');
      // 时间窗口档位，存 localStorage；默认 7 天。
      const [timeRange, setTimeRange] = useState(() => {
        try {
          const saved = localStorage.getItem(RANGE_KEY);
          return RANGES.some((item) => item.id === saved) ? saved : DEFAULT_RANGE;
        } catch {
          return DEFAULT_RANGE;
        }
      });
      // 默认收起；读过一次用户的选择就一直跟着，不受会话切换影响。
      const [expanded, setExpanded] = useState(() => {
        try {
          return localStorage.getItem(EXPAND_KEY) === '1';
        } catch {
          return false;
        }
      });
      // 哪几个会话的命中列表是展开的。检索结果按会话分组，默认只看会话清单。
      const [openGroups, setOpenGroups] = useState(() => new Set());
      // 展开到全部的会话：服务端每组只采样 5 条，点「显示全部」时单独要一次该会话的全量命中。
      const [fullGroups, setFullGroups] = useState(() => new Map());
      // 检索对象二选一：正文（默认）或工具输出。工具快照体积是正文的数倍，服务端懒建。
      const [mode, setMode] = useState(() => {
        try {
          return localStorage.getItem(MODE_KEY) === 'tool' ? 'tool' : 'text';
        } catch {
          return 'text';
        }
      });
      // 只有用户主动切换命中（↑↓ / 点击）才自动展开对应的会话组；
      // 检索刚完成时 active=0 不该把第一组撑开。
      const autoExpand = useRef(false);
      const [result, setResult] = useState({ hits: [], total: 0, tookMs: 0, docs: 0, sessions: {}, groups: [], sessionCount: 0, building: false, error: null, loading: false });
      const [active, setActive] = useState(-1);
      const [status, setStatus] = useState('');
      const [searchSeq, setSearchSeq] = useState(0);
      const inputRef = useRef(null);
      const jumpToken = useRef(0);
      /**
       * 有效结果列表：把「展开到全部」的会话用全量命中替换掉采样。
       *
       * 必须在这里统一算，不能在渲染时才替换：↑↓ 的选中下标、go 用的
       * hits[index]、状态栏的 N/M 读的必须是同一份列表，两处各算一次必然对不上。
       */
      const effective = useMemo(() => {
        if (result.groups.length === 0) return { hits: result.hits, groups: [] };
        const hits = [];
        const groups = [];
        for (const group of result.groups) {
          const full = fullGroups.get(group.sessionId);
          const from = hits.length;
          if (full !== undefined) hits.push(...full);
          else hits.push(...result.hits.slice(group.from, group.to));
          groups.push({ ...group, from, to: hits.length, full: full !== undefined });
        }
        return { hits, groups };
      }, [result, fullGroups]);

      // 命中列表放 ref：go 要稳定，否则每次搜索都重建 go，
      // 依赖它的 effect 就会在每次渲染后重复触发一次跳转。
      const hitsRef = useRef(effective.hits);
      hitsRef.current = effective.hits;
      // 分组信息也要给 step 读：扁平（当前会话）与分组（全局）两种模式的
      // ↑↓ 行为不同——前者边选边跳，后者只选。
      const groupsRef = useRef(effective.groups);
      groupsRef.current = effective.groups;
      const activeRef = useRef(0);
      // 关键词也放 ref：go 要保持稳定（依赖里不能带每次输入都变的 needles）。
      const needlesRef = useRef([]);
      // 会话切换计数。除了触发重搜，还要让面板重新测一次几何——放在这里是因为
      // 下面那个几何 effect 要用它做依赖。
      const [sessionTick, setSessionTick] = useState(0);

      // 面板几何：相对**会话内容区**居中，而不是整个视口。
      // 左栏折叠、右栏展开都会改变内容区宽度，所以用 ResizeObserver 跟着量。
      const [geom, setGeom] = useState({ left: null, width: null });
      // 跳转完成后要把观察者重挂到新的内容容器上（见 go 里的调用）。
      const remeasureRef = useRef(() => {});

      useEffect(() => {
        if (!open) return undefined;
        const target = () =>
          document.querySelector('[data-conversation-session]') ??
          document.querySelector('[data-slot="conversation.view"]');
        const measure = () => {
          const rect = target()?.getBoundingClientRect();
          if (rect === undefined || rect.width === 0) {
            setGeom({ left: null, width: null });
            return;
          }
          setGeom({
            left: Math.round(rect.left + rect.width / 2),
            width: Math.round(Math.min(760, Math.max(320, rect.width - 48))),
          });
        };
        const observer = new ResizeObserver(measure);
        let observed = null;
        /**
         * 把观察者绑到当前的内容容器上。
         *
         * 切会话会把 [data-conversation-session] 整个换掉，而跳转过程中
         * sessionTick 是被有意压住的（见会话轮询里的 jumping 判断），所以
         * 不能只靠依赖重建——必须由跳转结束方主动调一次重挂。
         * 只按 [open] 挂一次的话，跳转之后侧栏收起/展开都不再触发测量，
         * 面板就停在偏左的位置。
         */
        const attach = () => {
          const element = target();
          if (element === null) return;
          if (observed !== null) observer.unobserve(observed);
          observer.observe(element);
          observed = element;
        };
        attach();
        measure();
        remeasureRef.current = () => {
          attach();
          measure();
        };
        window.addEventListener('resize', measure);
        return () => {
          remeasureRef.current = () => {};
          observer.disconnect();
          window.removeEventListener('resize', measure);
        };
      }, [open, sessionTick]);

      /**
       * 清掉正文里的高亮。
       *
       * 跳转把原位撑开之后**不再还原回去**——「记快照 → 退出时设回 scrollTop」
       * 这一整套在宿主的无虚拟化容器上不成立：设一次要等全部布局算完，而清掉 mark
       * 会改变内容高度触发重排、宿主的「跟随末尾」还会在下一帧再滚一次，
       * 于是要靠 rAF + 120ms 二次补设去抢，抢不抢得赢取决于宿主的渲染时序。
       * 那就是「设了又被覆盖」反复出现的来源。
       *
       * 现在的口径：跳过去就停在那儿，想回原处用宿主自己的滚动条或 Ctrl+Home。
       * 代价是失去「退出即回到原位」，换来没有时序竞争，且超大会话不再参与这条路径。
       */
      const dropHighlight = useCallback(() => {
        clearMarks();
      }, []);

      /**
       * 关闭查找栏。
       *
       * 必须清掉关键词和命中列表：
       * - 关键词不清，下次 Ctrl+F 会沿用旧词立即搜索并跳到第一条命中；
       * - hitsRef 不清，搜索 effect 是异步的，自动跳转 effect 先跑到时仍能读到
       *   上一次的命中，于是「输入框明明是空的，位置却跳走了」。
       * 同时清高亮——mark 节点挂在宿主正文里，不随浮层卸载消失。
       */
      const close = useCallback(() => {
        setOpen(false);
        setQuery('');
        setStatus('');
        hitsRef.current = [];
        setResult({ hits: [], total: 0, tookMs: 0, docs: 0, sessions: {}, groups: [], sessionCount: 0, building: false, error: null, loading: false });
        dropHighlight();
      }, [dropHighlight]);

      /**
       * 按指定范围打开查找栏。
       *
       * 快捷键直接决定范围：Ctrl+F 是「找当前这段对话」，Ctrl+Ctrl 是「翻所有对话」。
       * 打开时强制覆盖范围，而不是沿用上次手动切换的选择——否则快捷键的语义会漂移。
       */
      const openWith = useCallback((mode) => {
        // 没有打开的会话时 session 无从谈起，直接落到 all——placeholder 也要跟着对。
        const effective = mode === 'session' && currentSessionId() === null ? 'all' : mode;
        setScopeMode(mode);
        setEffectiveScope(effective);
        setOpen(true);
      }, []);

      // 跳转自己也会切换会话。会话轮询必须能区分「用户从侧栏切的」和
      // 「命中跳转切过去的」——后者如果也触发重搜，active 会被重置回 0，
      // 表现就是「按下一处永远停在第一条」。
      // 用计数而不是布尔：连续按方向键会有多次跳转并发，先结束的那个不能把标记清零。
      const jumping = useRef(0);

      // 查找栏开着时用户可能在左侧切换会话，切换后结果要跟着新会话重查。
      //
      // 用 MutationObserver 而不是轮询（原来是 400 ms 一次 setInterval）：
      // 会话容器切换只有两种形态——换掉整个元素（childList）或改它的
      // `data-conversation-session`（attributes）——都是可观察的同步事件。
      // 轮询的 400 ms 是纯延迟 + 空转，而观察者漏不掉任何一次切换。
      //
      // 回调里用 rAF 合并：流式输出会不停往对话里塞节点，childList 触发极密，
      // 每帧最多检查一次就够（一次 querySelector 是微秒级，但没必要每秒做几十次）。
      //
      // 基线放 ref 而不是 effect 局部变量：跳转结束时要把基线同步成跳转后的会话。
      // 一次跨会话跳转如果比观察回调还快，jumping 已经归零、基线却还停在跳转前，
      // 下一次回调就会把「我们自己切过去的」当成用户切换，触发重搜并清掉选中，
      // 表现就是「跨到下一个会话之后前后跳失灵」。
      const lastSessionRef = useRef(null);
      useEffect(() => {
        if (!open) return undefined;
        lastSessionRef.current = currentSessionId();
        let timer = 0;
        let retries = 0;
        /** @returns 是否真的读到了新会话 */
        const check = () => {
          const now = currentSessionId();
          if (now === lastSessionRef.current) return false;
          lastSessionRef.current = now;
          // 跳转本身就是切会话：认下这次变化，但不再触发重搜，否则选中会被清掉。
          if (jumping.current > 0) return true;
          setSessionTick((prev) => prev + 1);
          return true;
        };
        /**
         * 观察者是**边沿触发**的，这是和原来 400ms 轮询最本质的差别。
         *
         * 宿主切换会话时，结构先变、`data-conversation-session` 的新值晚一帧才落到
         * DOM 上。回调里立刻读，读到的还是旧值；而 observer 不会因为「值后来变了」
         * 再通知一次——于是这次切换就永久丢了。轮询是电平触发，下一秒再读总能读到，
         * 所以这个坑原来不存在。
         *
         * 对策：延迟 120ms 再读（给宿主留一帧渲染），仍没读到就再重试，最多两次。
         * 每次 observer 回调都把计数清零，所以新的一次切换永远有完整的重试机会。
         */
        const schedule = () => {
          if (timer !== 0) return;
          timer = setTimeout(() => {
            timer = 0;
            if (!check() && retries < 2) {
              retries += 1;
              schedule();
            } else {
              retries = 0;
            }
          }, 120);
        };
        const observer = new MutationObserver(() => {
          retries = 0;
          schedule();
        });
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['data-conversation-session'],
        });
        return () => {
          observer.disconnect();
          if (timer !== 0) clearTimeout(timer);
        };
      }, [open]);

      /** 展开 / 收起结果列表，并把选择记进 localStorage。 */
      const toggleExpanded = useCallback(() => {
        setExpanded((prev) => {
          const next = !prev;
          try {
            localStorage.setItem(EXPAND_KEY, next ? '1' : '0');
          } catch {
            // 隐私模式禁用存储时忽略：状态在本次会话内仍然生效。
          }
          return next;
        });
      }, []);

      /**
       * 展开 / 收起某一个会话的命中列表。
       *
       * 必须先清掉 autoExpand——它是「下一次选中要自动展开所在组」的一次性标记。
       * 若选中项没变（点的正是已选中的那条），消费它的 effect 不会重跑，标记就滞留；
       * 此时点收起，那个 effect 反而因为 openGroups 变化而被触发，把组又加回来，
       * 表现就是「第一次收起没反应，第二次才收起」。手动操作优先级高于自动展开。
       */
      const toggleGroup = useCallback((sessionId) => {
        autoExpand.current = false;
        setOpenGroups((prev) => {
          const next = new Set(prev);
          if (next.has(sessionId)) next.delete(sessionId);
          else next.add(sessionId);
          return next;
        });
      }, []);

      /**
       * 把某个会话的命中从采样换成全部。
       *
       * 服务端每组只采样 5 条（挡住「单会话 400 多条」把列表刷爆），代价是
       * 卡片上写着「共 47 处」却只列 5 条。点「显示全部」时按同一套条件再要一次
       * 该会话的全量——复用 scope=session 的既有路径，不需要额外接口。
       */
      const expandGroup = useCallback(
        async (sessionId) => {
          const text = query.trim();
          if (text.length === 0) return;
          const range = RANGES.find((item) => item.id === timeRange) ?? RANGES[2];
          const since = range.days > 0 ? Date.now() - range.days * 86400000 : 0;
          const url =
            `${ROUTE}?op=query&q=${encodeURIComponent(text)}` +
            `&scope=session&sessionId=${encodeURIComponent(sessionId)}` +
            (roleFilter === 'all' ? '' : `&role=${roleFilter}`) +
            (since > 0 ? `&since=${since}` : '') +
            (mode === 'tool' ? '&mode=tool' : '');
          setStatus('正在读取该会话的全部命中…');
          try {
            const response = await fetch(url, { headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = await response.json();
            setFullGroups((prev) => new Map(prev).set(sessionId, body.hits ?? []));
            setStatus('');
          } catch (error) {
            setStatus(`展开失败：${String(error)}`);
          }
        },
        [query, timeRange, roleFilter, mode],
      );

      /**
       * 让结果列表跟着选中项走。
       *
       * 用 ↑↓ 或 F3 切换命中时，跳转发生在对话区，列表自己的滚动位置不会变——
       * 选中行跑出可视区后就看不到自己在第几条了。block:'nearest' 只在越界时滚动，
       * 不会把已经可见的行反复摆到中间。
       *
       * 结果按会话分组时，命中可能落在收起的组里：先展开那一组，等它渲染完再滚。
       */
      useEffect(() => {
        // 这个标记只消费一次：常开的话，用户点收起会立刻被再展开回去
        // （收起改的是 openGroups，effect 重跑又把它加回来）。
        if (autoExpand.current) {
          autoExpand.current = false;
          const group = effective.groups.find((item) => active >= item.from && active < item.to);
          if (group !== undefined && !openGroups.has(group.sessionId)) {
            setOpenGroups((prev) => new Set(prev).add(group.sessionId));
            return;
          }
        }
        const row = document.querySelector(`[data-hit-index="${active}"]`);
        row?.scrollIntoView({ block: 'nearest' });
      }, [active, effective.groups, openGroups]);

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
        style.textContent = STYLE_TEXT;
        document.head.appendChild(style);
        return () => style.remove();
      }, []);

      // 双击 Ctrl 的判定：单独计时 Control 键自身的 keydown。
      // 不能用「两次 ctrlKey=true 的事件」——按住任意键再按别的都会带 ctrlKey。
      const lastCtrlTap = useRef(0);
      // 两次 Ctrl 之间按过别的键就不算双击：Ctrl → F → Ctrl 是「先按了 F」，
      // 不是「连按两次 Ctrl」，此时只该认 Ctrl+F。
      const ctrlInterrupted = useRef(false);

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Control') {
            if (event.repeat) return;
            const now = Date.now();
            const gap = now - lastCtrlTap.current;
            const clean = !ctrlInterrupted.current;
            lastCtrlTap.current = now;
            ctrlInterrupted.current = false;
            if (gap > 0 && gap < 400 && clean) {
              lastCtrlTap.current = 0;
              event.preventDefault();
              openWith('all');
            }
            return;
          }

          // 任何非 Ctrl 的键都算打断双击窗口。
          ctrlInterrupted.current = true;

          const key = event.key.toLowerCase();
          const isFind = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && key === 'f';
          if (isFind) {
            // 抢掉浏览器原生查找：这是主人点过头的取舍。
            event.preventDefault();
            event.stopPropagation();
            openWith('session');
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
      }, [open, close, openWith]);

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
          // 从「有词」退回「空输入」时撤掉高亮。位置不还原——见 dropHighlight 的说明。
          dropHighlight();
          setResult({ hits: [], total: 0, tookMs: 0, docs: 0, sessions: {}, groups: [], sessionCount: 0, building: false, error: null, loading: false });
          setStatus('');
          setActive(-1);
          activeRef.current = -1;
          return undefined;
        }
        const timer = setTimeout(async () => {
          setResult((prev) => ({ ...prev, loading: true }));
          const sessionId = currentSessionId();
          // 诊断：跨会话跳转后若出现这行，说明会话轮询仍把它判成了用户切换。
          const effective = scopeMode === 'auto' ? (sessionId === null ? 'all' : 'session') : scopeMode;
          setEffectiveScope(effective);
          const range = RANGES.find((item) => item.id === timeRange) ?? RANGES[2];
          const since = range.days > 0 ? Date.now() - range.days * 86400000 : 0;
          const url =
            `${ROUTE}?op=query&q=${encodeURIComponent(text)}` +
            `&scope=${effective}` +
            (sessionId === null ? '' : `&sessionId=${encodeURIComponent(sessionId)}`) +
            (roleFilter === 'all' ? '' : `&role=${roleFilter}`) +
            (since > 0 ? `&since=${since}` : '') +
            (mode === 'tool' ? '&mode=tool' : '');
          try {
            const response = await fetch(url, { headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = await response.json();
            setResult({
              hits: body.hits ?? [],
              groups: body.groups ?? [],
              sessionCount: body.sessionCount ?? 0,
              total: body.total ?? 0,
              tookMs: body.tookMs ?? 0,
              docs: body.docs ?? 0,
              sessions: body.sessions ?? {},
              building: body.building === true,
              error: null,
              loading: false,
            });
            // 检索完毕不选中任何命中：列表全收起，↑↓ 也先禁用。
            // 用户想前后跳，得先点开某个会话、点中其中一条。
            setActive(-1);
            activeRef.current = -1;
            setOpenGroups(new Set());
            setFullGroups(new Map());
            // searchSeq 是「这次搜索得跳一次」的信号，effect 只认它。
            setSearchSeq((prev) => prev + 1);
            // 两种「为什么这次不一样」要说清楚，否则用户只会觉得插件坏了：
            // 单字中文没有 bigram 可切，索引帮不上忙，宿主半退化成全表扫（~575ms）；
            // 超大会话不能就地跳，是因为宿主渲染没有虚拟化（见 SMALL_SESSION_TURNS）。
            const first = (body.hits ?? [])[0];
            const overLarge =
              first !== undefined &&
              (body.groups ?? []).length === 0 &&
              (first.sessionTurns ?? 0) > SMALL_SESSION_TURNS;
            setStatus(
              body.exact === false
                ? '单字（或跨字）查询只能全表扫，慢是正常的；多打一个字会快很多'
                : overLarge
                  ? `本会话 ${first.sessionTurns} 轮，超过 ${SMALL_SESSION_TURNS} 轮不能就地跳转；Enter 走侧栏预览`
                  : '',
            );
          } catch (error) {
            setResult({ hits: [], total: 0, tookMs: 0, docs: 0, sessions: {}, groups: [], sessionCount: 0, error: String(error), loading: false });
            setStatus('');
          }
        }, DEBOUNCE_MS);
        return () => clearTimeout(timer);
      }, [query, scopeMode, roleFilter, timeRange, sessionTick, open, dropHighlight, mode]);

      /**
       * 索引还在建的时候自己再来问一次。
       *
       * `building` 是**一次响应的快照**，不是订阅——建完之后只要用户不再敲键，
       * 就没有任何东西会去刷新它，界面就永远停在「索引中…」。
       * 工具索引是懒建的，首次要读完 1150 个会话（实测两分钟量级），这段空窗足够
       * 让用户以为插件卡死了。所以只要还报 building，就隔两秒再查一次，
       * 直到它变成 false 为止；没有上限，因为「还在建」本来就是真话，
       * 反复问的代价只是每两秒一次毫秒级查询。
       */
      useEffect(() => {
        if (!open || !result.building) return undefined;
        const timer = setTimeout(() => setSessionTick((prev) => prev + 1), 2000);
        return () => clearTimeout(timer);
      }, [open, result.building, sessionTick]);

      const needles = useMemo(
        () => query.toLowerCase().split(/\s+/).filter(Boolean),
        [query],
      );
      needlesRef.current = needles;

      const go = useCallback(
        async (index) => {
          const hit = hitsRef.current[index];
          if (hit === undefined) return;
          const token = jumpToken.current + 1;
          jumpToken.current = token;
          jumping.current += 1;
          let outcome;
          try {
            outcome = await jumpTo(ctx, hit, () => jumpToken.current !== token, needlesRef.current);
          } finally {
            jumping.current -= 1;
            // 最后一个跳转结束时把轮询基线同步成当前会话：跳转本身就是切会话，
            // 不同步的话下一轮轮询会把它误判为用户切换，重搜并清掉选中。
            if (jumping.current === 0) {
              lastSessionRef.current = currentSessionId();
            }
          }
          // no-keyword 不提示：markdown 渲染把关键词拆开的情况不少，
          // 每出现一次就多一行状态，面板高度跟着跳，看着晃眼。
          const messages = {
            'not-rendered': '这一处还没渲染出来，再按一次或继续翻页',
            'not-switched': '没能切到那个会话，先从左侧点开它再搜',
            'not-visible': '找到了这一处但它是折叠的，展开那一块后再试',
          };
          setStatus(messages[outcome] ?? '');
          // 跳转会把焦点带到别处：switchSession 的侧边栏兜底要点行、切会话后
          // 宿主的会话容器也可能接管焦点。焦点一离开搜索框，方向键就没人接了
          // （全局监听遇到输入类元素会主动让路），表现就是「跨一次会话后键盘失灵」。
          // 宿主会在切会话后的渲染里再抢一次焦点，所以下一帧和 200ms 各补一次。
          if (outcome === 'ok') {
            const refocus = () => inputRef.current?.focus({ preventScroll: true });
            refocus();
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refocus);
            setTimeout(refocus, 200);
            // 切会话把内容容器整个换掉了，几何观察者还绑在旧节点上——不重挂的话，
            // 之后侧栏收起/展开都不再触发测量，搜索框会停在偏左的位置。
            // rAF 赶下一帧，200ms 兜住宿主的布局过渡。
            const remeasure = () => remeasureRef.current();
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(remeasure);
            setTimeout(remeasure, 200);
          }
        },
        [ctx],
      );

      // 只有「一次新搜索完成」才自动跳第一处。用户按方向键、点结果都直接调 go，
      // 不走 effect——否则 setActive 和 effect 会各跳一次，跳转互相打断。
      useEffect(() => {
        if (!open || searchSeq === 0) return;
        // 检索完毕不自动跳转、不选中任何命中：列表保持收起，↑↓ 保持禁用。
        // 用户点开某个会话、点中其中一条，前后跳才启用。
        autoExpand.current = false;
      }, [searchSeq, open]);

      /**
       * 上下移动选中项。
       *
       * 两种模式的取舍不同：
       * - **当前会话内（扁平列表）**：边选边跳。命中就几处，跳转不换会话、
       *   不用重建对话视图，翻起来连按即可，省掉每次一次 Enter。
       * - **全局检索（按会话分组）**：只移动、不跳。跨会话跳转会切走当前阅读位置、
       *   重建整屏，翻十条就是十次重建，反悔还得靠滚动还原找回去。
       *   这里与 IDE 的全局搜索一致：↑↓ 挑，Enter 才过去。
       *
       * 用 ref 记当前下标：setState 是异步的，回调里拿不到新值。
       */
      const step = useCallback(
        (delta) => {
          const count = hitsRef.current.length;
          if (count === 0) return;
          let next;
          if (activeRef.current < 0) {
            // 未选中时从端点开始。
            next = delta > 0 ? 0 : count - 1;
          } else {
            // 回绕：第一条按「上一条」回到最后一条，最后一条按「下一条」回到第一条。
            next = (activeRef.current + delta + count) % count;
            if (next === activeRef.current) return;
          }
          activeRef.current = next;
          // 用户主动切换：允许自动展开命中所在的会话组。
          autoExpand.current = true;
          setActive(next);
          // 全局检索要跨会话重建对话视图，只在 Enter 时才动作；
          // 工具命中的详情通常折叠，保持只选择的交互，
          // 同样交给 Enter 去开侧栏。
          if (mode === 'tool' || groupsRef.current.length > 0) return;
          // 超大会话不自动跳：边选边跳意味着每按一次方向键就整屏重布局一次，
          // 6773 条消息的会话上按三下就够把浏览器按死。这类会话统一走 Enter → 侧栏。
          if ((hitsRef.current[next]?.sessionTurns ?? 0) > SMALL_SESSION_TURNS) return;
          // 先让选中态渲染出来再跳：跳转会重建对话视图，和 setActive 落在同一批
          // 提交里时，那一行高亮会被重渲染拖慢半拍。
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => void go(next));
          } else {
            void go(next);
          }
        },
        [go, mode],
      );

      /**
       * 在侧栏打开一条命中。
       *
       * 用 tab.meta 携带坐标而不是正文：侧栏布局会被持久化，把几百 KB 的正文
       * 塞进去，每次刷新都要反序列化一遍；坐标让 tab 自己按需取。
       *
       * @returns 是否成功交给侧栏（没装插件或调用失败时返回 false）
       */
      const openPreview = useCallback(
        (hit) => {
          if (hostSidebar === null) return false;
          try {
            hostSidebar.openTab({
              type: TAB_TYPE,
              // id 里带上 mode：同一处 seq 在正文与工具里是两份不同内容，
              // 只按 sessionId:seq 去重的话，先开过正文预览再开工具预览
              // 只会聚焦那个旧 tab（meta 里还是旧口径），看着像没修好。
              id: `${TAB_TYPE}:${mode}:${hit.sessionId}:${hit.seq}`,
              title: `${mode === 'tool' ? '工具 · ' : ''}${titleOf(hit.sessionId)} · 第 ${hit.turn} 轮`,
              meta: {
                sessionId: hit.sessionId,
                seq: hit.seq,
                // 预览要按命中来源取对应快照：工具命中在正文快照里没有对应条目。
                mode,
                role: hit.role,
                callId: mode === 'tool' ? hit.messageId : '',
                anchor: hit.anchor ?? '',
                head: hit.head ?? '',
                // 定位用的两件东西：messageId 精确命中 DOM 键的后缀，
                // turn 是 messageId 缺失时的退化锚点（`-step{turn}:`）。
                turn: hit.turn,
                messageId: typeof hit.messageId === 'string' ? hit.messageId : '',
                needles: needlesRef.current,
              },
              reveal: true,
            });
            return true;
          } catch (error) {
            console.warn('[session-search] openTab threw:', error);
            return false;
          }
        },
        [titleOf, mode],
      );

      /**
       * 打开当前选中项。
       *
       * 分两种落点：
       * - 全局检索 → 侧栏预览。不切走当前会话，也就不需要定位、高亮、滚动还原
       *   那一整套，跨会话翻结果不再打断阅读。
       * - 当前会话内 → 直接跳。命中和当前视图在同一屏，跳过去比开个 tab 还快。
       *
       * 没有选中项时直接取第一条：敲完关键词按 Enter 是最自然的动作。
       */
      const activate = useCallback(() => {
        if (hitsRef.current.length === 0) return;
        const target = activeRef.current < 0 ? 0 : activeRef.current;
        if (activeRef.current < 0) {
          activeRef.current = 0;
          autoExpand.current = true;
          setActive(0);
        }
        const hit = hitsRef.current[target];
        if (hit === undefined) return;
        // 三种落点，按「能不能安全地在会话里跳」排序：
        // 1. 工具命中：callId 在会话视图里没有对应节点，跳过去必然落空 → 侧栏；
        // 2. 全局检索：跨会话跳会切走当前阅读位置并重建整屏 → 侧栏；
        // 3. 会话过大：宿主没有虚拟化，设一次 scrollTop 要把整个会话重新布局
        //    （本机实测 6773 条消息 / 858 轮的会话把浏览器卡死，官方滚动条拖到顶同样卡）
        //    → 侧栏，并说明为什么不让跳。
        const tooLarge = (hit.sessionTurns ?? 0) > SMALL_SESSION_TURNS;
        const preferPreview = mode === 'tool' || groupsRef.current.length > 0 || tooLarge;
        if (preferPreview) {
          if (openPreview(hit)) {
            if (tooLarge && mode !== 'tool' && groupsRef.current.length === 0) {
              setStatus(`本会话 ${hit.sessionTurns} 轮，超过 ${SMALL_SESSION_TURNS} 轮不做就地跳转（会卡死），已开预览`);
            }
            return;
          }
          // 没装侧栏：工具命中没有别的落点，超大会话也不该退化成一次注定卡死的跳转。
          if (mode === 'tool') {
            setStatus('工具命中需要在侧栏预览；未检测到 better-sidebar');
            return;
          }
          if (tooLarge) {
            setStatus(`本会话 ${hit.sessionTurns} 轮，超过 ${SMALL_SESSION_TURNS} 轮不做就地跳转；需要 better-sidebar 才能预览`);
            return;
          }
        }
        void go(target);
      }, [go, openPreview, mode]);

      const onInputKeyDown = (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          step(1);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          step(-1);
          return;
        }
        // Enter 才是「打开」。↑↓ 只负责在候选里挑，和 IDE 的全局搜索一致：
        // 每移动一格就切一次会话的写法，翻看起来代价太大。
        if (event.key === 'Enter') {
          event.preventDefault();
          activate();
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
          const active = document.activeElement;
          // 焦点在自己的输入框：交给输入框的 onKeyDown，避免同一次按键走两遍。
          if (active === inputRef.current) return;
          // 焦点在别的输入区（会话输入框、时间下拉等）：用户正在操作，不要抢。
          if (
            active !== null &&
            (active.tagName === 'INPUT' ||
              active.tagName === 'TEXTAREA' ||
              active.tagName === 'SELECT' ||
              active.isContentEditable)
          ) {
            return;
          }

          // 其余情况下（焦点在页面空白、或点了工具栏按钮但没抢走焦点），
          // 移动选中绑在查找栏上：F3 / Shift+F3、↑↓、Alt+↑↓ 都可移动，
          // Enter 打开当前选中项。
          if (event.key === 'F3') {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
            return;
          }
          if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            step(event.key === 'ArrowDown' ? 1 : -1);
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            activate();
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            step(event.key === 'ArrowDown' ? 1 : -1);
          }
        };
        window.addEventListener('keydown', onGlobal, true);
        return () => window.removeEventListener('keydown', onGlobal, true);
      }, [open, step, activate]);

      if (!open) return null;

      /**
       * 一条命中：二级行，缩进展示。
       *
       * 单击只选中（等价于 ↑↓），双击才打开。单点就跳的话，在列表里看一眼
       * 相邻几条就会连着把当前阅读位置冲掉，而滚动还原只能找回最后一次。
       */
      const hitRow = (hit, index) =>
        h(
          'div',
          {
            key: `${hit.sessionId}:${hit.seq}`,
            'data-hit-index': index,
            style: { ...S.row(index === active), paddingLeft: 26 },
            onMouseDown: (event) => {
              event.preventDefault();
              // 选中项确实变了才请求自动展开：点已选中的那行时 setActive 同值、
              // effect 不会重跑，标记会滞留到下一次点收起时才被消费。
              if (activeRef.current !== index) autoExpand.current = true;
              activeRef.current = index;
              setActive(index);
            },
            onDoubleClick: (event) => {
              event.preventDefault();
              activeRef.current = index;
              setActive(index);
              // 走和 Enter 同一条分派：全局检索开侧栏预览，当前会话内跳转。
              activate();
            },
          },
          h(
            'div',
            { style: S.rowTop },
            h('span', null, hit.role === 'u' ? '你' : hit.role === 't' ? '工具' : '助手'),
            h('span', null, `第 ${hit.turn} 轮`),
            h('span', null, formatTime(hit.time)),
            // 长消息的边界要看得见。索引是按 4000 字分块建的，一条超长正文会有多块；
            // 不打这个标记，用户会以为「命中就在消息开头」，也分不清「这条就这么长」
            // 和「后面被切掉了」——旧实现真的会切掉（正文 200k / 工具 20k 硬上限），
            // 那正是「搜不到」与「不存在」无法区分的原因。
            (hit.chunks ?? 1) > 1
              ? h('span', { style: S.rowChunk }, `${Math.round((hit.len ?? 0) / 1000)}k · 第 ${(hit.chunk ?? 0) + 1}/${hit.chunks} 段`)
              : null,
          ),
          h('div', { style: S.rowText }, renderSnippet(hit.snippet, needles)),
        );

      // 计数只放数量。操作提示（Enter 预览 / 打开）挪到导航按钮的 title——
      // 它挤在计数里会把「N / M」推到省略号，而计数本身定宽是为了防位移。
      // 显示用短形态（宽度只够最短那句），完整计数进 title。
      // 54px 的定宽塞不下「1 / 3 · 3 会话（共 40）」，但那串信息悬停能看到。
      const counter =
        result.total === 0
          ? result.building
            ? '索引中…'
            : '无结果'
          : active < 0
            ? `${effective.hits.length} 处`
            : `${active + 1} / ${effective.hits.length}`;

      const counterDetail =
        result.total === 0
          ? result.building
            ? '正在建立工具索引…'
            : '无结果'
          : active < 0
            ? `${effective.hits.length} 处` +
              (result.sessionCount > 1 ? ` · ${result.sessionCount} 会话` : '') +
              `（共 ${result.total}）`
            : `${active + 1} / ${effective.hits.length}` +
              (result.sessionCount > 1 ? ` · ${result.sessionCount} 会话` : '') +
              (result.total > effective.hits.length ? `（共 ${result.total}）` : '');

      // Enter 会做什么：工具检索与全局检索开侧栏，当前会话内直接跳。
      const enterHint = mode === 'tool' || effective.groups.length > 0 ? 'Enter 在侧栏预览' : 'Enter 跳转';
      const counterTitle = `${result.loading ? '搜索中' : counterDetail} · ↑↓ 切换 · ${enterHint}`;

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          {
            style: {
              ...S.panel,
              // 量到会话内容区就跟着它居中，量不到（比如对话还没渲染）退回视口居中。
              left: geom.left ?? '50%',
              width: geom.width ?? 'min(760px, calc(100vw - 48px))',
            },
            role: 'search',
            'aria-label': '会话搜索',
          },
          h(
            'div',
            { style: S.bar },
            h('span', { style: S.searchIcon, title: '查找' }, magnifier()),
            h('input', {
              ref: inputRef,
              style: S.input,
              value: query,
              // 搜索范围不占按钮位，改用 placeholder 说明：Ctrl+F 是这段对话，
              // 双击 Ctrl 是全部会话，两者在输入提示上就能分辨。
              placeholder:
                mode === 'tool'
                  ? '搜索工具输出（命令回显、文件内容、报错）'
                  : effectiveScope === 'session'
                    ? '搜索当前对话的内容（空格分隔多个关键词）'
                    : '搜索所有会话的对话内容（空格分隔多个关键词）',
              spellCheck: false,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: onInputKeyDown,
            }),
            // 输入框右边这一整块当作一个不可伸缩的单元：内部每个控件都定宽，
            // 计数文案伸缩、「全部」在工具模式下失效，都不会让整排按钮跟着位移。
            h(
              'div',
              { style: S.tools },
              h(
                'span',
                { style: S.count, title: counterTitle, 'data-fis': 'count' },
                result.loading ? '索引中…' : counter,
              ),
              barButton('↑', `上一条 (Shift+Enter / Shift+F3) · ${enterHint}`, () => step(-1)),
              barButton('↓', `下一条 (Enter / F3) · ${enterHint}`, () => step(1)),
              barButton(
                expanded ? '▴' : '▾',
                expanded ? '收起结果列表' : '展开结果列表',
                toggleExpanded,
                undefined,
                { 'data-fis': 'expand' },
              ),
              // 角色筛选排在检索对象左边：它只在正文检索时有效，工具模式下置灰占位
              // 而不是隐藏——隐藏会让右边的「正文/工具」按钮整体左移一格。
              barButton(
                roleFilter === 'all' ? '全部' : roleFilter === 'u' ? '我' : '助手',
                mode === 'tool' ? '工具输出检索不区分角色' : '切换角色筛选：全部 → 我 → 助手',
                () => {
                  if (mode === 'tool') return;
                  setRoleFilter((prev) => (prev === 'all' ? 'u' : prev === 'u' ? 'a' : 'all'));
                },
                mode === 'tool' ? { ...S.role, opacity: 0.45, cursor: 'default' } : S.role,
                { 'data-fis': 'role' },
              ),
              // 检索对象二选一：正文 / 工具输出。两份是独立快照，
              // 切到工具那一份时首次会触发一次全量构建（读完全部会话，几秒），
              // 所以按钮上直接写着当前选的是哪一份。
              barButton(
                mode === 'tool' ? '工具' : '正文',
                '切换检索对象：正文 ↔ 工具输出（工具索引首次建立需要几秒）',
                () => {
                  const next = mode === 'tool' ? 'text' : 'tool';
                  setMode(next);
                  // 工具快照里没有「你 / 助手」的区分，角色筛选先归位。
                  setRoleFilter('all');
                  try {
                    localStorage.setItem(MODE_KEY, next);
                  } catch {
                    // 隐私模式禁用存储时忽略：本次会话内仍然生效。
                  }
                },
                S.role,
              ),
              h(
                'select',
                {
                  style: S.range,
                  value: timeRange,
                  title: '按消息时间筛选',
                  'data-fis': 'range',
                  onChange: (event) => {
                    const next = event.target.value;
                    setTimeRange(next);
                    try {
                      localStorage.setItem(RANGE_KEY, next);
                    } catch {
                      // 隐私模式禁用存储时忽略：本次会话内仍然生效。
                    }
                    // 选完把焦点还给输入框：否则下拉框继续持有焦点，
                    // 接着按 ↑↓ 会被它拿去切换选项，而不是在结果里移动。
                    inputRef.current?.focus({ preventScroll: true });
                  },
                  // 下拉框聚焦期间方向键仍归结果列表：正在看结果时手不会离开方向键，
                  // 而被一个刚碰过的下拉框截走会让人以为搜索坏了。
                  // 鼠标点开下拉照样能用方向键选时间（那时 open 状态由浏览器接管）。
                  onKeyDown: (event) => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault();
                      step(event.key === 'ArrowUp' ? -1 : 1);
                    }
                  },
                },
                RANGES.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
              ),
              barButton('×', '关闭 (Esc)', close),
            ),
          ),
          // 前置插件缺失：常驻在搜索栏下方，不走 status（那是逐次搜索的临时反馈，
          // 会被下一次搜索清掉）。缺失是持续状态，提示也该持续存在。
          missingSidebar
            ? h(
                'div',
                { style: S.warn, 'data-fis': 'missing-sidebar' },
                h(
                  'div',
                  null,
                  '未检测到前置插件 dsh-better-sidebar：全局检索、工具检索和超大会话的预览都打不开，只剩当前会话内的就地跳转。',
                ),
                h('code', { style: S.warnCode }, 'dsh plugin --profile web add dsh-better-sidebar'),
                h('div', { style: S.warnHint }, '装完重启 dsh web，再刷新本页面。'),
              )
            : null,
          status.length > 0 ? h('div', { style: S.status }, status) : null,
          result.error !== null
            ? h('div', { style: { ...S.status, color: 'var(--dsw-alias-state-error-primary, #e05c5c)' } }, `搜索失败：${result.error}`)
            : null,
          expanded && effective.hits.length > 0
            ? h(
                'div',
                { style: { ...S.list, maxHeight: EXPANDED_MAX } },
                effective.groups.length === 0
                  ? // 旧版宿主不返回 groups 时退回扁平列表，不至于空白
                    effective.hits.map((hit, index) => hitRow(hit, index))
                  : effective.groups.flatMap((group) => {
                      const isOpen = openGroups.has(group.sessionId);
                      const shown = group.to - group.from;
                      const head = h(
                        'div',
                        {
                          key: `g:${group.sessionId}`,
                          style: S.groupRow,
                          onMouseDown: (event) => {
                            event.preventDefault();
                            toggleGroup(group.sessionId);
                          },
                        },
                        h('span', { style: S.groupCaret }, isOpen ? '▾' : '▸'),
                        h('span', { style: S.groupTitle }, titleOf(group.sessionId)),
                        h('span', { style: S.groupCount }, `${group.count} 处`),
                        h('span', { style: S.groupTime }, formatTime(group.newest)),
                        // 卡片写着「共 47 处」却只列 5 条，用户会以为搜丢了。
                        // 这一行给他一个把该会话全部取回来的入口。
                        group.count > shown && !group.full
                          ? h(
                              'span',
                              {
                                style: S.groupMore,
                                onMouseDown: (event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setOpenGroups((prev) => new Set(prev).add(group.sessionId));
                                  void expandGroup(group.sessionId);
                                },
                              },
                              `显示全部 ${group.count} 条`,
                            )
                          : null,
                      );
                      if (!isOpen) return [head];
                      return [
                        head,
                        ...effective.hits.slice(group.from, group.to).map((hit, offset) => hitRow(hit, group.from + offset)),
                      ];
                    }),
              )
            : null,
        ),
      );
    }

    /**
     * 把预览 tab 注册到 better-sidebar。
     *
     * 侧栏是真·可选依赖：服务拿不到就保持 hostSidebar 为 null，搜索结果退回
     * 「跳转」那条老路，搜索本身不受影响。服务可能比本插件晚就绪（bundle 里
     * 加载顺序不定），所以先试一次、拿不到就短轮询几次再放弃。
     *
     * 放弃时要让用户在界面上看见，而不只是控制台：缺了它全局检索和工具检索
     * 都点不开，表现是「点了没反应」，不给提示就只能当成 bug 报。
     */
    function mountSidebarTab(host) {
      let tries = 0;
      const attempt = () => {
        const sidebar = host.get('betterSidebar');
        if (sidebar === undefined || sidebar === null) return false;
        hostSidebar = sidebar;
        setSidebarMissing(false);
        host.effect(() =>
          sidebar.registerTab({
            id: TAB_TYPE,
            title: '命中预览',
            description: '搜索命中的上下文片段',
            // 不进 + 菜单：这一页只能由搜索结果带坐标打开，没有独立入口。
            hidden: true,
            // 同一处命中反复打开只聚焦同一个 tab，不堆一列重复页。
            dedupeKey: (tab) => tab.id,
            component: SessionSearchView,
          }),
        );
        return true;
      };
      if (attempt()) return;
      const timer = setInterval(() => {
        tries += 1;
        if (attempt() || tries >= 10) {
          clearInterval(timer);
          if (hostSidebar === null) {
            setSidebarMissing(true);
            console.warn(
              '[session-search] 未检测到 dsh-better-sidebar：全局检索、工具检索与超大会话的预览都不可用，只剩当前会话内的就地跳转',
            );
          }
        }
      }, 300);
    }

    return {
      inject: ['slots', 'sessions', 'uiWorkspace'],
      apply(host) {
        hostContext = host;
        host.slots.inject('shell.overlay', () =>
          host.slots.register({ name: 'shell.overlay', id: 'session-search', order: 90 }, SearchOverlay),
        );
        mountSidebarTab(host);
        host.effect(() => () => clearMarks());
      },
    };
  },
});
