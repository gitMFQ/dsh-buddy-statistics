# 会话视图统计（buddyStats）— 冻结契约 v1

本文是本轮改动的**接口契约**：`lib/fold.js`、`lib/session-projection.js`、`client.js` 三处按此实现，
不再各自发明字段名。口径（哪些统计属于会话、哪些只属于全局）见文末表格。

## 1. 目标

在 DSH 的**会话视图**里加一个「统计」页签，显示**当前会话**的统计；
全局大盘（`main` 面板）保持原样。两边共用**同一个折叠函数**，保证同一会话的数字处处一致。

## 2. 落点（已用 `Slots.listSubTree` 核实）

| 项 | 值 |
| --- | --- |
| slot | `conversation.view`（kind list，scope session，`replaceRisk: none`） |
| id | `buddy-stats` |
| order | `20`（宿主 chat=0、trajectory=10；官方诊断视图 stats=40） |
| label | `() => t('stats.session.tab')` |
| locale | `buddy-stats`（注册项带 `locale` 时框架注入绑定好的 `t`） |
| inject | **不要写**（`inject: (sessionId) => ({ sessionId })` 会与标准 prop 重名） |

`conversation.view` 的 owner（`dsh-client-ui-conversation`）会遍历所有注册项自动生成页签，
并把标准 props 注入组件：`sessionId`、`useProjection`、`useSession`、`useChat`、`useConversation`、
`useAccess` 等（见 slot catalog 的 standardProps）。不要依赖宿主 client 包，不要写 DOM。

**踩坑（已核实）**：slot 框架在挂载前会做 `assertNoPropOverlap(kit, injected)`（`dsh-client-ui-renderer`
`lib/client.js`），`kit` 里已经有 `sessionId` 等标准 prop；`inject` 再返回同名键会抛 `SlotAssemblyError`
导致页签挂载失败。因此只取标准 props，`inject` 省略或返回 `{}`。

## 3. 数据来源

### 3.1 新投影单元：`buddyStats`

宿主侧用 `ctx.sessionProjections.register(definition)`（`@deepseek-ai/dsh-session-projection`）注册一个
**client-visible** 投影单元，key = `buddyStats`，`stateVersion = 1`，`wire.summary = false`
（不进会话列表摘要，避免列表载荷变大）。

- `init(header) = createSessionState(header)`
- `apply(state, event) = applySessionEvent(state, event)`（纯函数，见 §4）
- `wire.view(state)` → §3.2 的**已聚合**结构；`wire.viewSchema` 用 zod 校验（zod 4）。

客户端通过 `props.useProjection('buddyStats')` 读取；值由宿主的会话快照基线 + 控制帧推送，
随事件提交自动更新（**不要在客户端折叠事件、不要轮询 HTTP**）。

### 3.2 视图 JSON（冻结；字段名不得改）

```jsonc
{
  "version": 1,
  "id": "…", "title": "…|null", "cwd": "…|null", "parent": "…|null",
  "origin": "subagent|null", "preset": "…|null",
  "createdAt": 0,                 // ms
  "first": 0, "last": 0,          // 本会话首/末计入事件时间（ms；0 = 无）
  "spanMs": 0,                    // max(0, last - first)：墙钟跨度
  "turns": 0, "steps": 0, "msgs": 0,
  "toolCalls": 0, "toolErrors": 0,
  "linesAdded": 0, "linesDeleted": 0,     // write/edit 入参估算，与全局页同口径
  "apiMs": 0,                     // step/start → step/end 之和
  "activeMs": 0,                  // turn/start → turn/end 之和（剔除闲置）
  "compactions": 0, "retries": 0,
  "outcomes": { "completed": 0, "aborted": 0, "blocked": 0, "error": 0,
                "maxTokens": 0, "interrupted": 0, "forked": 0 },
  "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
              "reasoning": 0, "total": 0, "cacheHitRate": 0 },
  "models": [ { "id": "…", "provider": "…|null", "calls": 0,
                "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
                "reasoning": 0, "total": 0, "costUsd": 0 } ],   // 按 total 降序
  "tools": [ { "name": "…", "calls": 0 } ],                    // 按 calls 降序
  "hours": [ 24 个数字 ],                                        // 本地小时分布
  "costUsd": 0, "hasPricing": false
}
```

口径必须与全局页（`lib/aggregate.js`）一致：

- `tokens.total = input + output + cacheRead + cacheWrite`（DSH 的 `inputTokens` 是**净输入**）；
- `tokens.cacheHitRate = cacheRead / (input + cacheRead + cacheWrite) * 100`，分母为 0 时 0（**百分数**，同 aggregate.js）；
- 每个模型 `costUsd = Σ count/1e6 * 单价`，单价表来自插件 config `pricing`（每百万 Token、美元）；
  `hasPricing` = config 里配了非空单价表；
- `models[].provider` 与 `calls`（有 usage 的 assistant 消息条数）来自折叠状态。

视图**不含** `days`（按天桶）与内部游标字段：`days` 只有全局热力图需要，留在 state 里不进 wire，
避免每个事件都推送一份长会话的按天表。

### 3.3 复用的内置投影（可选，读不到就隐藏对应区块）

| key | 提供方 | 用途 |
| --- | --- | --- |
| `contextPressure` | `@deepseek-ai/dsh-token-meter` | 当前上下文占用（`pressureTokens`/`projectedTokens`/`contextWindow`） |
| `contextBreakdown` | 同上 | 上下文组成（`systemTokens`/`toolsTokens`/`messageTokens`，启发式近似） |
| `sessionStats` | `@deepseek-ai/dsh-session-stats` | 首字延迟（`ttftMs`/`ttftSteps`）、工具耗时（`toolMs`）、解码速度（`decodeMs`/`decodeTokens`） |

这三个 key 由官方插件注册，可能不存在；`useProjection` 返回 `undefined` 时必须优雅降级。

## 4. `lib/fold.js`（唯一折叠实现，纯函数）

```js
export const CACHE_VERSION = 6           // 折叠语义/字段变化 +1（本轮 5 → 6）
export function createSessionState(header = {})                          // → state（纯 JSON）
export function applySessionEvent(state, event)                          // → 新 state；不关心的事件返回同一引用
```

state（纯 JSON，可进投影缓存）：

```
id, createdAt, cwd, parent, origin, preset, title,
first, last, turns, steps, msgs, toolCalls, toolErrors, lines: [add, del],
apiMs, activeMs, compactions, retries,
outcomes: { completed, aborted, blocked, error, maxTokens, interrupted, forked },
models: { [id]: { p, i, o, cr, cw, r, n } },
tools: { [name]: count },
days: { 'YYYY-MM-DD': { m, tc, tok: { [model]: tokens } } },
hours: number[24],
openStepStart: number|null, openStepTurn: number|null, openTurnStart: number|null
```

折叠语义（与 v0.2.0 相同，仅新增行）：

| 事件 | 计入 |
| --- | --- |
| `assistant/message` | `msgs`、天/小时桶、`data.usage` 四个 Token 桶 + reasoning、`models[model].n` |
| `user/message` | `msgs`、天/小时桶 |
| `tool/call` | `toolCalls`、天桶 `tc`、小时桶、`tools[name]`；`write`/`edit` 估行 |
| `tool/result` | `data.message.isError` → `toolErrors` |
| `step/start` / `step/end` | `openStepStart` → `apiMs`；`step/end` 另计 `steps` |
| `turn/start` / `turn/end` | `openTurnStart` → `activeMs`；`turn/end` 计 `turns` 与 `outcomes[reason.kind]` |
| `session/title` | `title`（取最后一条） |
| **新增** `compaction/start` | `compactions` |
| **新增** `llm/retry-started` | `retries`（若真实日志里只有 `llm/retry`，以实际为准并记录） |

纯度要求（投影注册表的硬要求）：不关心的事件**必须返回同一引用**；
改动的桶**写时复制**（顶层 `{...state}`，被改的 `models`/`tools`/`days`/`hours`/`lines`/`outcomes` 逐层浅拷贝），
**不得原地改旧 state**。`ref/` 下的真实日志可用于核对事件名与计数。

`lib/collect.js` 改为调用 `lib/fold.js`（`createState`/`foldEvent` 两个旧导出由
`createSessionState`/`applySessionEvent` 取代），`test/fold-check.mjs` 同步改导入；
全局统计的数字必须与改动前一致（用 `ref/verify-stats.output.json` 基线核对）。

## 5. 视角划分：会话视图 vs 全局页

**会话独有（只在这里显示）**

- 会话身份：标题、cwd、preset、origin（是否子代理）、父会话、创建时间、首/末活动时间、墙钟跨度
- 本会话回合内活跃时长（`activeMs`）与模型耗时（`apiMs`）、平均每步耗时
- 本会话回合结果分布（完成 / 中止 / 阻塞 / 出错 / 触顶 / 中断 / fork）
- 本会话 Token 构成与缓存命中率、推理 Token、每步/每回合平均 Token
- 本会话上下文占用与组成（`contextPressure` / `contextBreakdown`）
- 本会话首字延迟与输出速度（`sessionStats`）
- 本会话模型明细（各模型 Token / 调用次数 / 成本）
- 本会话工具排行、工具错误数、成功率
- 本会话文件增删行估算
- 本会话压缩次数、模型重试次数
- 本会话按小时活动分布（24 桶）

**全局独有（会话视图里刻意不显示）**

- 52 周活跃热力图、活跃天数、当前/最长连续、高峰时段
- 会话数、子代理数、工作区数、最长会话
- 跨会话模型排行与每日 Token 趋势、跨会话工具排行
- 趣味事实彩蛋、「统计范围：最近 N 天」

理由：这些量必须**跨会话比较**才有意义；放进单会话视图只会得到一个恒为 1 的“会话数”之类噪声。
反之，`activeMs`、回合结果、上下文占用、压缩/重试等只在单会话内有意义，全局页不显示。

## 6. 写作用域（互斥）

| 归属 | 文件 |
| --- | --- |
| fold-core | `lib/fold.js`、`lib/collect.js`、`test/fold-purity.mjs`、`test/fold-check.mjs` |
| projection-host | `lib/session-projection.js`、`index.js`、`package.json`、`cordis.patch.yml`、`test/projection-schema.mjs` |
| client-view | `client.js`、`locale/*.json`、`test/client-smoke.mjs`、`test/session-view-render.mjs` |
| lead | `docs/session-view.md`、`docs/implementation.md`、`README.md` |
| verifier | `test/verify-live.mjs`、`docs/verification-notes.md`（只读源码，不得改上表文件） |

## 7. 可观测性（必须实现）

`index.js` 的 `/buddy-stats/data` 响应 `meta` 增加一项：

```
meta.sessionView: 'registered' | 'unavailable' | 'error: …'
```

投影注册 resolve 后置 `registered`；`sessionProjections` 服务缺失置 `unavailable`；注册失败记错误串。
这样验收方能用一条 `curl` 判断投影是否真的挂上（浏览器之外的唯一可信信号）。
