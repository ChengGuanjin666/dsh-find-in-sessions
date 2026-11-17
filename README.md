# dsh-find-in-sessions

DeepSeek Harness 插件：`Ctrl+F` 呼出查找栏，按关键词检索**所有历史会话**的对话正文，命中后直接跳到那一段，用 F3 / ↑↓ 在命中之间前后跳。

## 为什么不用宿主自带的搜索

| 宿主自带 | 本插件 |
|---|---|
| 本机 profile 把 `session-query-sqlite` 配成 `openAt: never`，`/api/session/search` 一律返回 `SESSION_QUERY_SEARCH_DISABLED` | 自带搜索通道，直接读会话日志，不依赖那个索引 |
| `unicode61` tokenizer 把连续中文当一个 token，实测「插件」「本地搜索」命中数为 0 | 原生子串匹配，中文两字词照常命中 |
| 每个会话只返回一条最佳片段，没有事件坐标，只能打开会话 | 返回每条命中的 `seq` + `turn`，跳到具体那一轮并高亮 |

## 它是怎么快的

不建倒排索引。实测本机 1096 个会话：

| 项目 | 实测 |
|---|---|
| 压缩日志 / 解压后 | 188.8 MB → 615.7 MB |
| 只取 `user/assistant` 的 `text` 块 | **33.2 MB / 16694 条** |
| 内存里扫这 33 MB | **10–30 ms** |
| 落盘快照（gzip JSON） | 15 MB |
| 冷启动读快照 | ~350 ms |

所以架构就是：宿主半把正文提取成一份内存快照（落盘做冷启动加速），查询时线性扫。会话日志是 append-only 的，用 `sessionPersistence.list()` 的 `sizeBytes` 做增量，日常只会重读当前那个会话。

## 用法

| 操作 | 键 |
|---|---|
| 打开查找栏 | `Ctrl+F` |
| 关闭 | `Esc` |
| 下一处 / 上一处 | `Enter` / `Shift+Enter`，或 `F3` / `Shift+F3`，或 `↓` / `↑` |
| 切换范围 | 点右侧「当前会话 / 全部会话」按钮 |

默认范围跟着当前状态走：有打开的会话就只搜它，没有就搜全部。

`Ctrl+F` 原本是浏览器的页面内查找，本插件会拦掉它。

## 安装

```powershell
dsh plugin --profile web add <本目录或 tarball 路径>
```

装完重启 `dsh web`。插件同时有宿主半和浏览器半，两半都在启动时加载。

## 行为边界

- **只读会话，只写自己的缓存**：会话以 `read` 句柄打开，不改动会话文件；唯一的写入是 `~/.dsh/cache/dsh-find-in-sessions/body.json.gz`。
- **只索引看得见的正文**：`user/message`、`assistant/message` 里 `type: "text"` 的块；不索引 reasoning、工具调用参数、工具输出、流式分片。`<system-reminder>` 注入块整块删除。
- **单条消息上限 200k 字符**，超长内容截断，避免一次工具转储吃掉几百 MB 内存。
- **单次返回上限 200 条命中**，按时间倒序（新的在前）。
- **跳转靠宿主自己的加载器**：`ISession.loadThrough(seq)` 拉历史页，`data-chat-turn` 做锚点。目标轮次还没渲染时提示而不会乱跳。
- **缓存不会自己过期**：会话变了会在下次搜索时增量重建；删掉那个文件也只是触发一次全量重建（约 5 秒）。

## 已知限制

- 召回是字面子串，不是分词或语义：搜「本地搜索」不会命中「本地全文搜索」。
- 大小写不敏感，但不做全半角、简繁、拼音归一化。
- 当前正在写的会话，最新几条可能还没落盘；再搜一次即可。

## 开发

```powershell
node --check lib/index.js
node --check lib/client.js
```

无构建步骤、无第三方运行时依赖：`lib/*.js` 就是分发产物。

`lib/client.js` 的 `Ctrl+F` 监听挂在 `window` 的 capture 阶段并 `preventDefault`，这是刻意的取舍，改动前先确认是否还要抢浏览器原生查找。

## License

MIT
