# dsh-find-in-sessions

DeepSeek Harness 插件：跨会话检索历史对话的正文与工具输出，命中后跳到那一段，用 F3 / ↑↓ 前后翻。

**两种检索范围，由快捷键决定，面板上没有范围按钮：**

| | 触发 | 检索范围 | ↑↓ 的行为 | 落点 |
|---|---|---|---|---|
| 会话内检索 | `Ctrl+F` | 当前这一个对话 | 边选边跳 | 就地高亮 |
| 全局检索 | **双击 `Ctrl`** | 所有历史会话，按会话分组 | 只移动选中，`Enter` 才过去 | 侧栏预览 |

输入框的 placeholder 会写明当前是「搜索当前对话」还是「搜索所有会话」。

## 安装

需要先装前置插件 `dsh-better-sidebar`，否则全局检索、工具检索和超大会话的预览都没有落点（详见「兼容性」）。

```powershell
# 1. 前置依赖
dsh plugin --profile web add dsh-better-sidebar

# 2. 本插件（npm）
dsh plugin --profile web add dsh-find-in-sessions
```

`dsh-better-sidebar` 需要 ≥ 0.30.0（实测 0.32.0 也可以，它的 peer 要求是 dsh `^0.2.2-rc.1`）；要锁定版本就写 `dsh-better-sidebar@0.32.0`。

也可以直接从 GitHub 装（跟最新 main，或锁定 tag）：

```powershell
dsh plugin --profile web add github:ChengGuanjin666/dsh-find-in-sessions
dsh plugin --profile web add github:ChengGuanjin666/dsh-find-in-sessions#v0.2.0
```

从仓库本地装（改代码时用）：

```powershell
dsh plugin --profile web add D:\DSH\创造模式\dsh-find-in-sessions
```

装完重启 `dsh web`。只改 `lib/client.js` 时刷新页面即可；改 `lib/index.js` / `lib/store.js` 必须重启。

## 用法

| 操作 | 键 |
|---|---|
| 会话内检索 | `Ctrl+F`（只搜当前这一个对话） |
| 全局检索 | 双击 `Ctrl`（搜所有历史会话） |
| 关闭 | `Esc` |
| 在候选间移动 | `↑` `↓` / `F3` / `Shift+F3` / `Shift+Enter`（上一处） |
| 打开选中的那一处 | `Enter`，或双击结果行 |
| 切换检索对象 | 点「正文 / 工具」 |
| 切换时间窗口 | 点右侧下拉（1 / 3 / 7 / 30 天 / 全部，默认 7 天） |
| 切换角色 | 点「全部 / 我 / 助手」（工具检索下无效，工具输出不区分角色） |

`Ctrl+F` 原本是浏览器的页面内查找，本插件会拦掉它。面板窄时右侧控件按断点分级让位，输入框和命中导航始终保留。

## 打开命中：四种落点

| 形态 | 落点 |
|---|---|
| 当前会话 + 正文 + 目标距末尾 ≤ 200 条（或已渲染） | 就地跳转并高亮 |
| 当前会话 + 正文 + 目标距末尾 > 200 条且未渲染 | 侧栏预览 |
| 全局检索 | 侧栏预览 |
| 工具检索（任意范围） | 侧栏预览 |

预览页给「命中的那一条 + 前后各一条」，关键词高亮，右上角「会话定位」固定、不随内容滚动。**这三类落点全部依赖 `dsh-better-sidebar`**，缺它时见「兼容性」一节的降级说明。

三个不那么直观的取舍：

- **目标离已加载窗口太远时不跳**。宿主的会话历史是分页加载的：打开先加载约一页（最多 500 条），更早的内容靠 `loadThrough` 循环拉页（每页 200–500 条，无页数上限）。实测跳到窗口外要 **26.8 秒**、DOM 从 198 涨到 1686 个节点；而目标已在窗口内时只需设一次 `scrollTop`。所以判据是「距离」而不是「会话总大小」。
- **跳转后不还原原位**。那套「记快照 → 退出时设回 `scrollTop`」在无虚拟化容器上会被宿主的下一次渲染覆盖，只能靠定时器抢，属于和渲染时序赛跑。现在跳过去就停在那儿。
- **全局检索的 ↑↓ 只选不跳**，`Enter` 才过去。跨会话跳转会切走当前阅读位置并重建整屏，翻十条就是十次重建。

## 兼容性

| | 要求 |
|---|---|
| DeepSeek Harness | **`>=0.2.2-rc.1 <0.3.0-0`**，见下方「已实测的版本」 |
| Node.js | **≥ 24.9.0**（`node:sqlite`，与 dsh 本体一致） |
| **前置依赖** | **`dsh-better-sidebar` ≥ 0.30.0** —— 全局检索、工具检索、超大会话三类的落点全部是它的侧栏预览 |

范围同时写在 `package.json` 的 `engines.dsh` 里。DSH 的插件兼容性检查优先读这个字段（没有它才回退到 `peerDependencies`），所以装到区间外的版本会在安装或启动时被直接拒绝，而不是加载后静默退化。上界是 `0.3.0-0` 而不是 `0.3.0`：`<0.3.0` 在 `includePrerelease` 下会放行 `0.3.0-rc.1` 这类预发布版。

**已实测的版本**：

| 版本 | 状态 |
|---|---|
| 0.2.2-rc.1 | 当时版本实测通过 |
| 0.2.2-rc.5 | 0.2.3 逐项核对宿主契约后实测通过 |
| 0.2.2-rc.2 / rc.3 / rc.4 | 未单独实测；同期 DSH 升级指南只有 `deepseek-refusal-code`（LLM 层）和 `web-search-deepseek-model-default` 两条，未涉及本插件依赖的 API 与 DOM |

`dsh-better-sidebar` 没装的话插件不会报错，但**只剩一半功能**：会话内检索照常跳转高亮，全局检索退化成"跳到那个会话"、工具检索直接没有落点、目标在窗口外的命中两样都不行。所以按前置依赖对待，先装它。

**区间下界为什么不能再低**：插件依赖宿主内部实现——`[data-conversation-session]` / `[data-chat-turn]` / `[data-chat-node-key]` / `[data-chat-call-id]` 等 DOM 属性、`sessionPersistence` 的 `list / stat / open`、`webServer.register`、`ISession.loadThrough`。这些都没有稳定性契约，0.2.1 及更早没有 `webServer.register` 与 `ISession.loadThrough` 的现有形态。宿主升级后若面板打不开或跳转落空，先查这几处。

## 已知限制

- 召回是**字面子串**，不做分词或语义：搜「本地搜索」不会命中「本地全文搜索」。
- 大小写不敏感（对含字母的关键词），但不做全半角、简繁、拼音归一化。
- **单字中文查询 451–575 ms**：一个汉字凑不出 bigram，索引用不上，只能全表扫。
- 工具输出默认不进索引，第一次切到「工具」才建（读全部会话，约两分钟）。
- 索引库在 `~/.dsh/cache/dsh-find-in-sessions/`，体积随语料增长（本机 1313 个会话 → 197 MB），删掉会自动重建。旧版本留下的 `body.json.gz` / `tool.json.gz` 从 0.2.0 起不再读取，可以直接删。
- 正在写的会话，最新几条可能还没落盘，再搜一次即可。

## 开发

```powershell
node --check lib/index.js
node --check lib/client.js
node --check lib/store.js
```

无构建步骤、无第三方运行时依赖，`lib/*.js` 就是分发产物。索引与匹配的实现取舍写在 `lib/store.js` 的注释里。

## License

MIT
