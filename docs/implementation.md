# dsh-buddy-statistics — 实现说明

用户文档（功能、安装、配置、口径对照）见仓库根目录的 [README](../README.md)。本文只讲实现与维护。

仓库根目录就是插件包：`package.json` 带 `dsh.bundle.patch` 与 `dsh.client`，
所以 `plugin_manager install_bundle target=github:gitMFQ/dsh-buddy-statistics` 可直接安装。

## 数据流

```
DSH 持久化会话（session.v*.jsonl.zstd）
        │  ctx.sessionPersistence.list()      → { header, revision, eventCount }
        ▼
lib/collect.js   open(id,'read') → read(from) → lib/fold.js 的 applySessionEvent()（增量，跳过 inherited 前缀）
        │  每个会话一份紧凑摘要（state）
        ▼
lib/aggregate.js 纯函数折叠：连续天数 / 按天·按小时分桶 / 模型与工具排行
        │  stats JSON
        ▼
GET /buddy-stats/data  →  index.js 路由（同源校验 + 内存 TTL 缓存）
        │  fetch
        ▼
client.js  main 面板页面（概览 / 模型 / 工具 三个标签）

同一份 lib/fold.js 还有第二条出口（会话视图）：
ctx.sessionProjections.register(buddyStats)        ← lib/session-projection.js
        │  wire.view = 已聚合的会话视图 JSON（stateVersion 1，summary: false）
        ▼  会话快照基线 + 控制帧推送（事件提交即更新，不轮询）
client.js  conversation.view 的「统计」页签（只渲染，不算数）
```

**只有宿主读日志、只有一处折叠实现**。浏览器侧不算任何统计数字，只格式化与渲染；
两条出口共用 `lib/fold.js`，所以同一会话在全局页与会话页签里的数字必然一致。

## 宿主约定

- 插件入口：`apply(ctx, config)`；`ctx.inject(['webServer','sessionPersistence'], …)`，
  两个依赖缺一个插件就不激活。
- 路由：`{ kind: 'exact', path: '/buddy-stats/data', handler }`，响应
  `{ ok, stats, meta }`；`?refresh=1` 跳过 TTL。
- 同源校验：`Origin` 存在时必须与 `host` / `x-forwarded-host` 一致（沿用
  `dsh-webhook-notify` 的判定方式），`HEAD` 可用，其它方法 405。
- 缓存失效：`ctx.on('session/event', …)` 把内存结果标记过期（`at: 0`），
  下一次请求重新增量聚合。
- 会话投影：另起一次 `ctx.inject(['sessionProjections'], …)`（与路由那次注入分开，
  缺 `webServer` 的部署里投影照样注册），成功/失败写进 `meta.sessionView`
  （`registered` / `unavailable` / `error: …`），供排查与验收断言。
- `lib/session-projection.js` 静态依赖 `zod`，所以 index.js 用**动态 `import()`** 引入它：
  zod 缺失或依赖没装全时只退化成「会话页签不可用」，不会把全局页一起拖死。

## 折叠实现（lib/fold.js，唯一一处）

`lib/fold.js` 导出 `CACHE_VERSION`、`createSessionState(header)`、`applySessionEvent(state, event)`
（另有 `countLines` / `dateKeyOf`）。全局采集与会话投影都用它，**禁止再写第二份折叠**。

纯度是投影注册表的硬要求，也是本文件的实现约束：

- 不关心的事件**返回同一引用**（注册表据此判断「没变化」，不推送、不重算视图）；
  时间戳夹在首末之间的无关事件也走这条短路。
- 关心的事件**写时复制**：顶层 `{...state}`，被改的 `models` / `tools` / `days` / `hours` /
  `lines` / `outcomes` 逐层浅拷贝，绝不原地改传入的 state（旧 state 可能被缓存或共享）。
- state 必须是纯 JSON（投影缓存的前提），所以 v0.2.0 里跨事件共享的 `stepStarts` Map
  被搬进 state（`openStepStart` / `openStepTurn` / `openTurnStart`）。

## 会话投影（buddyStats）

| 项 | 值 |
| --- | --- |
| key | `buddyStats`（客户端 `props.useProjection('buddyStats')`） |
| stateVersion | `1`（字段或折叠语义变化必须 +1，否则旧缓存会被误用） |
| stateSchema / viewSchema | zod 4 `.strict()`：多一个字段就 parse 失败，防止 fold 悄悄加字段而视图不同步 |
| `wire.view` | 已聚合的视图（models/tools 排序、tokens 汇总、命中率百分数、成本、outcomes 展开、`spanMs`） |
| `wire.summary` | `false`：不进会话列表摘要，列表载荷不背整张会话统计 |
| 视图不含 | `days` 按天桶与 `open*` 内部游标；只推 24 小时桶，避免每个事件都推一份长会话的按天表 |

口径与全局页逐字对齐：`tokens.total = 输入 + 输出 + 缓存读 + 缓存写`，
`cacheHitRate = cacheRead / (输入 + 缓存读 + 缓存写) × 100`（分母 0 取 0），
成本 = Σ(各桶 / 1e6 × 单价)。

完整字段与口径划分见 [session-view.md](./session-view.md)。

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

摘要用短字段名（`i/o/cr/cw/r/n`）压体积；`CACHE_VERSION`（当前 **6**）变化会整体重建。
折叠语义变化（字段含义或分桶方式）必须同步 +1。

## 折叠语义

| 事件 | 计入 |
| --- | --- |
| `assistant/message` | 消息数、按天/按小时计数、`data.usage` 的 Token、`data.message.source` 的模型 |
| `user/message` | 消息数、按天/按小时计数 |
| `tool/call` | 工具调用数；`write` / `edit` 额外按入参估算增删行 |
| `tool/result` | 错误数（`data.message.isError`） |
| `step/start` + `step/end` | 步数、模型耗时（一个 step = 一次模型调用）；结算后清空游标，重复的 `step/end` 不再重复计时 |
| `turn/start` + `turn/end` | 回合数、会话「工作时间」（剔除跨天闲置）、`reason.kind` → `outcomes` |
| `session/title` | 会话标题（取最后一条） |
| `compaction/start` | 压缩次数（`compaction/prune` 是逐条裁剪，不计） |
| `llm/retry-started` | 模型重试次数（真实日志里与 `llm/retry` 一一配对，只计其一） |
| 任何带时间戳的事件 | `first` / `last`（v0.2.0 语义，决定墙钟跨度） |

`outcomes` 的键是驼峰（`max-tokens` → `maxTokens`）；未知 `reason.kind` 不写入 state，
否则 strict `stateSchema` 会失败。

根会话判定：`origin !== 'subagent' && !parentSession`。会话数 / 消息数 / 活跃天数 /
连续 / 工具调用 / 高峰时段只统计根会话；Token 统计全部会话（与 CodeBuddy 一致）。

## 页面约定

- 注册三个位置：
  - `main`（key `buddy-stats`）承载整页；
  - `sidebar.panellist`（id `buddy-stats`，order 40）承载侧边栏图标与标签；
  - `conversation.view`（id `buddy-stats`，order 20）承载会话视图的「统计」页签。
    前三者 id/key 必须同名，方便排查。
- `conversation.view` 的注册项**不要写 `inject`**：slot 框架挂载前会
  `assertNoPropOverlap(kit, injected)`（`@deepseek-ai/dsh-client-ui-renderer`），
  `sessionId` / `useProjection` 已是标准 prop，`inject` 返回同名键会抛
  `SlotAssemblyError` 导致页签挂不上。组件直接读标准 props 即可；`t` 由注册项的
  `locale` 注入。
- 文案走 `ctx.locale.register(NS, {zh, en})`，键名与 CodeBuddy 的 `stats.*` 对齐，
  会话页签的键统一用 `stats.session.*`；页面订阅 `ctx.locale.subscribe` 在语言切换时重渲染。
- 样式只有 `--dsw-alias-*` 主题变量，不引用任何 Harness 客户端包（纯 JS bundle，
  无构建步骤，`client.js` 由 `window.__ModuleLoader__.load` 载入）。
- 全局页挂载时才 `fetch` 数据；会话页签只读投影，不 fetch、不折叠事件、不读 DOM。
  卸载时由 `ctx.effect` 统一回收注册。

## 自检

```bash
npm install                     # 宿主依赖 zod（本地跑 index.js / 投影测试用）
npm test                        # 五段：fold-purity → projection-schema → fold-check → client-smoke → session-view-render
node test/fold-purity.mjs       # 折叠纯函数：同引用、写时复制、确定数值
node test/projection-schema.mjs # buddyStats 的 state/view schema 与聚合视图（真实 zod）
node test/fold-check.mjs        # 用 fold + aggregate 直接从日志折叠，打印统计值与新计数器
node test/client-smoke.mjs      # 替身 ctx 校验三个 slot 注册项、locale 字典与卸载
node test/session-view-render.mjs # hooks 替身渲染会话页签：空态、降级、关键数字
```

`fold-check` 如果检测到 `../ref/verify-stats.output.json`（开发机上的基线），
会顺便打印与基线的差；仓库里不带该文件（`ref/` 已在 `.gitignore` 中），只打印数值。
注意该基线是**时间点快照**：日志一直在长，绝对值对不上不代表回归，
判断口径回归要用「同一批日志跑旧实现 vs 新实现」的方式（见 `git show HEAD:lib/collect.js`）。

## 维护提示

- **改折叠字段或语义必须同时改三处**：`lib/fold.js` 的 state、`lib/session-projection.js`
  的 `stateSchema` / `viewSchema`（strict，多一个字段就 parse 失败）、`docs/session-view.md`
  的契约表；语义变化还要 `CACHE_VERSION` 与 `STATE_VERSION` 一起 +1，否则旧缓存会被误用。
- 新增统计项时先加进 `lib/fold.js` 的 `applySessionEvent`，再决定是否进 `wire.view`
  （进 view 就要同步 `viewSchema`、契约与客户端渲染），最后才动 UI。
- 新增 UI 文案必须同时补 `zh` / `en`，否则切换语言会露出 key；
  `client-smoke` 会检查字面量键与中英键集合一致。
- 会话日志格式属于 DSH 内部实现，只通过 `sessionPersistence` 访问，不要直接读文件。
