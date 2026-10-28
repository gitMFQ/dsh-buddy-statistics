# dsh-buddy-statistics — 实现说明

用户文档（功能、安装、配置、口径对照）见仓库根目录的 [README](../README.md)。本文只讲实现与维护。

## 数据流

```
DSH 持久化会话（session.v*.jsonl.zstd）
        │  ctx.sessionPersistence.list()      → { header, revision, eventCount }
        ▼
lib/collect.js   open(id,'read') → read(from) → foldEvent()   （增量，跳过 inherited 前缀）
        │  每个会话一份紧凑摘要（state）
        ▼
lib/aggregate.js 纯函数折叠：连续天数 / 按天·按小时分桶 / 模型与工具排行
        │  stats JSON
        ▼
GET /buddy-stats/data  →  index.js 路由（同源校验 + 内存 TTL 缓存）
        │  fetch
        ▼
client.js  main 面板页面（概览 / 模型 / 工具 三个标签）
```

**只有宿主读日志**。浏览器侧不算任何数字，只格式化与渲染，这样口径只有一处实现。

## 宿主约定

- 插件入口：`apply(ctx, config)`；`ctx.inject(['webServer','sessionPersistence'], …)`，
  两个依赖缺一个插件就不激活。
- 路由：`{ kind: 'exact', path: '/buddy-stats/data', handler }`，响应
  `{ ok, stats, meta }`；`?refresh=1` 跳过 TTL。
- 同源校验：`Origin` 存在时必须与 `host` / `x-forwarded-host` 一致（沿用
  `dsh-webhook-notify` 的判定方式），`HEAD` 可用，其它方法 405。
- 缓存失效：`ctx.on('session/event', …)` 把内存结果标记过期（`at: 0`），
  下一次请求重新增量聚合。

## 增量与缓存

| 层 | 键 | 作用 |
| --- | --- | --- |
| 进程内 `memo: Map` | `sessionId` | 保存摘要 state + 上次读到的 `coveredThrough`；只读尾部 |
| 磁盘 `sessions-cache.json` | `sessionId` | 跨进程重启复用（`eventCount` 单调，可安全比较） |
| 结果缓存 | 时间 | `ttlMs` 内直接复用，`session/event` 立刻作废 |

`read(from)` 的 `from = max(inheritedEventCount, coveredThrough + 1)`：

- `inheritedEventCount` 之前的都是 fork / seed 复制进来的父会话事件，**必须跳过**，
  否则 Token 与工具调用会重复计（本机曾因此多算约 40%）；
- 之后的从上次读完的位置继续，稳态下只读几条新事件。

摘要用短字段名（`i/o/cr/cw/r/n`）压体积；`CACHE_VERSION` 变化会整体重建。
折叠语义变化（字段含义或分桶方式）必须同步 +1。

## 折叠语义

| 事件 | 计入 |
| --- | --- |
| `assistant/message` | 消息数、按天/按小时计数、`data.usage` 的 Token、`data.message.source` 的模型 |
| `user/message` | 消息数、按天/按小时计数 |
| `tool/call` | 工具调用数；`write` / `edit` 额外按入参估算增删行 |
| `tool/result` | 错误数（`data.message.isError`） |
| `step/start` + `step/end` | 模型耗时（一个 step = 一次模型调用） |
| `turn/start` + `turn/end` | 会话「工作时间」（剔除跨天闲置） |
| `session/title` | 会话标题（取最后一条） |

根会话判定：`origin !== 'subagent' && !parentSession`。会话数 / 消息数 / 活跃天数 /
连续 / 工具调用 / 高峰时段只统计根会话；Token 统计全部会话（与 CodeBuddy 一致）。

## 页面约定

- 注册两个位置：`main`（key `buddy-stats`）承载整页，`sidebar.panellist`
  （id `buddy-stats`，order 40）承载侧边栏图标与标签。两者 id 必须相同。
- 文案走 `ctx.locale.register(NS, {zh, en})`，键名与 CodeBuddy 的 `stats.*` 对齐；
  页面订阅 `ctx.locale.subscribe` 在语言切换时重渲染。
- 样式只有 `--dsw-alias-*` 主题变量，不引用任何 Harness 客户端包（纯 JS bundle，
  无构建步骤，`client.js` 由 `window.__ModuleLoader__.load` 载入）。
- 挂载时才 `fetch` 数据；卸载时由 `ctx.effect` 统一回收注册。

## 自检

```bash
npm test                    # fold-check + client-smoke
node test/fold-check.mjs    # 用同一套 foldEvent/aggregate 直接从日志折叠，打印统计值
node test/client-smoke.mjs  # 用替身 ctx 校验 slot 注册项、locale 字典与卸载
```

`fold-check` 如果检测到 `../ref/verify-stats.output.json`（开发机上的基线），
会顺便打印与基线的差；仓库里不带该文件，只打印数值。

## 维护提示

- **不要改 `CACHE_VERSION` 之外的折叠字段语义**而不升版本，否则旧缓存会被误用。
- 新增统计项时先加进 `foldEvent` 的 state，再在 `aggregate` 里合并，最后才动 UI。
- 新增 UI 文案必须同时补 `zh` / `en`，否则切换语言会露出 key。
- 会话日志格式属于 DSH 内部实现，只通过 `sessionPersistence` 访问，不要直接读文件。
