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
| 当前会话 + 正文 + 消息数 ≤ 300 | 就地跳转并高亮 |
| 当前会话 + 正文 + 消息数 > 300 | 侧栏预览 |
| 全局检索 | 侧栏预览 |
| 工具检索（任意范围） | 侧栏预览 |

预览页给「命中的那一条 + 前后各一条」，关键词高亮，右上角「会话定位」固定、不随内容滚动。**这三类落点全部依赖 `dsh-better-sidebar`**，缺它时见「兼容性」一节的降级说明。

三个不那么直观的取舍：

- **超过 300 条的会话不跳**，因为宿主的会话视图没有渲染虚拟化——消息加载后就全量挂成 DOM，设一次 `scrollTop` 要等整个会话重新布局。实测 6773 条消息的会话会直接把浏览器卡死，把官方滚动条拖到顶部同样卡。
- **跳转后不还原原位**。那套「记快照 → 退出时设回 `scrollTop`」在无虚拟化容器上会被宿主的下一次渲染覆盖，只能靠定时器抢，属于和渲染时序赛跑。现在跳过去就停在那儿。
- **全局检索的 ↑↓ 只选不跳**，`Enter` 才过去。跨会话跳转会切走当前阅读位置并重建整屏，翻十条就是十次重建。

## 兼容性

| | 要求 |
|---|---|
| DeepSeek Harness | 在 **0.2.2-rc.1** 上实测通过，其他版本未验证 |
| Node.js | **≥ 24.9.0**（`node:sqlite`，与 dsh 本体一致） |
| **前置依赖** | **`dsh-better-sidebar` ≥ 0.30.0** —— 全局检索、工具检索、超大会话三类的落点全部是它的侧栏预览 |

`dsh-better-sidebar` 没装的话插件不会报错，但**只剩一半功能**：会话内检索照常跳转高亮，全局检索退化成"跳到那个会话"、工具检索直接没有落点、超过 300 条的会话两样都不行。所以按前置依赖对待，先装它。

**为什么只能给版本号、给不出兼容区间**：插件依赖宿主内部实现——`[data-conversation-session]` / `[data-chat-turn]` / `[data-chat-node-key]` / `[data-chat-call-id]` 等 DOM 属性、`sessionPersistence` 的 `list / stat / open`、`webServer.register`、`ISession.loadThrough`。这些都没有稳定性契约。宿主升级后若面板打不开或跳转落空，先查这几处。

## 已知限制

- 召回是**字面子串**，不做分词或语义：搜「本地搜索」不会命中「本地全文搜索」。
- 大小写不敏感（对含字母的关键词），但不做全半角、简繁、拼音归一化。
- **单字中文查询 451–575 ms**：一个汉字凑不出 bigram，索引用不上，只能全表扫。
- 工具输出默认不进索引，第一次切到「工具」才建（读全部会话，约两分钟）。
- 索引库在 `~/.dsh/cache/dsh-find-in-sessions/`，体积随语料增长（本机 1150 个会话 → 178 MB），删掉会自动重建。
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
