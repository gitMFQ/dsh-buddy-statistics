/**
 * 会话折叠：把一个会话的事件流折叠成一份**纯 JSON** 的会话状态。
 *
 * 这是全插件**唯一**的折叠实现：
 * - 全局页（`lib/collect.js` → `lib/aggregate.js`）用它把会话日志变成摘要；
 * - 会话视图投影（`lib/session-projection.js`）用它把 `session/event` 折成投影 state。
 * 两边共用同一份语义，保证同一会话的数字处处一致。
 *
 * 纯度（`@deepseek-ai/dsh-session-projection` 的驱动要求）：
 * - **不关心的事件返回同一引用**，注册表据此判断「没有变化」，不再推送；
 * - 关心的事件一律**写时复制**：顶层 `{...state}`，被改的
 *   `models` / `tools` / `days` / `hours` / `lines` / `outcomes` 逐层浅拷贝，
 *   **绝不原地修改传入的 state**（旧的 state 可以被缓存 / 回滚 / 共享）。
 *
 * 语义与 v0.2.0（`lib/collect.js` 里的旧 `foldEvent`）逐条一致，仅新增
 * `steps` / `compactions` / `retries` / `outcomes` / `openStep*` / `openTurnStart`。
 * 其中时间游标从「跨事件共享的 Map」搬进了 state（投影只有一个 state，没有外部表）：
 * - `openStepStart` / `openStepTurn`：`step/start` 记下，`step/end` 结算 `apiMs` 后清空；
 * - `openTurnStart`：`turn/start` 记下，`turn/end` 结算 `activeMs` 后清空。
 * 结算后清空意味着**重复的结束事件（再次 step/end 或 turn/end）不会重复计时**
 * （旧实现里 Map 保留旧起点，重复的 end 会重复累加）。
 *
 * 真实日志核对（`$DSH_HOME/sessions`，187 个会话文件，本机口径）：
 * - `llm/retry` 174 条、`llm/retry-started` 174 条，**一一配对**（同一 `retryId` 每次尝试
 *   各发一条，`data.retry` 为第几次尝试）；所以只计其中一个即可，计两个会翻倍。
 *   本文件计 `llm/retry-started`（契约指定）。
 * - 压缩相关事件有 `compaction/start` / `compaction/summary` / `compaction/end` / `compaction/prune`，
 *   一次压缩只发 **1 条 `compaction/start`**（`prune` 是逐条裁剪，不是一次压缩，不能计入）。
 * - `turn/end` 的 `data.reason.kind` 实际出现：`completed` 203 / `error` 51 / `aborted` 29 /
 *   `interrupted` 20 / `max-tokens` 5；契约里的七种（另加 `blocked` / `forked`）见
 *   `TurnEndReasonMap`。state 的 `outcomes` 键是驼峰，`max-tokens` → `maxTokens`。
 */

/** 缓存结构版本：折叠语义 / 字段变化时必须 +1（本轮 5 → 6）。 */
export const CACHE_VERSION = 6

/** `turn/end` 的 `reason.kind` → state 的 `outcomes` 键（唯一一处别名）。 */
const OUTCOME_KEYS = {
  completed: 'completed',
  aborted: 'aborted',
  blocked: 'blocked',
  error: 'error',
  'max-tokens': 'maxTokens',
  interrupted: 'interrupted',
  forked: 'forked',
}

/** 契约 §4 的七种回合结果（顺序即 state / view 的字段顺序）。 */
function emptyOutcomes() {
  return { completed: 0, aborted: 0, blocked: 0, error: 0, maxTokens: 0, interrupted: 0, forked: 0 }
}

/** 数一段文本的行数（空串记为 0）。 */
export function countLines(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/** 本地日期键（'YYYY-MM-DD'）。 */
export function dateKeyOf(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return null
  const d = new Date(n)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 本地小时（0-23），时间无效时为 -1。 */
function hourOf(ms) {
  const n = Number(ms)
  return Number.isFinite(n) && n > 0 ? new Date(n).getHours() : -1
}

/**
 * 新的空会话状态。字段严格按契约 §4（投影的 zod stateSchema 是 strict 的，
 * 多一个字段都会 parse 失败）。
 * @param {object} [header] 会话 header（`id` / `createdAt` / `cwd` / `parentSession` / `origin` / `agentPreset`）
 */
export function createSessionState(header = {}) {
  return {
    id: header.id || null,
    createdAt: Number(header.createdAt) || 0,
    cwd: header.cwd || null,
    parent: header.parentSession || null,
    origin: header.origin || null,
    preset: header.agentPreset || null,
    title: null,
    first: 0,
    last: 0,
    turns: 0,
    steps: 0,
    msgs: 0,
    toolCalls: 0,
    toolErrors: 0,
    lines: [0, 0],
    apiMs: 0,
    activeMs: 0,
    compactions: 0,
    retries: 0,
    outcomes: emptyOutcomes(),
    models: {},
    tools: {},
    days: {},
    hours: new Array(24).fill(0),
    openStepStart: null,
    openStepTurn: null,
    openTurnStart: null,
  }
}

/**
 * 只更新 `first` / `last`（v0.2.0 对**任何**带时间的事件都做这件事）。
 * 两个值都没变时返回同一引用，这样夹在首末之间的无关事件不会引起推送。
 */
function spanOf(state, time) {
  if (!(time > 0)) return state
  const first = !state.first || time < state.first ? time : state.first
  const last = time > state.last ? time : state.last
  if (first === state.first && last === state.last) return state
  return { ...state, first, last }
}

/** 写时复制地更新一天的桶：m=消息数、tc=工具调用数、tok=当日各模型 Token。 */
function daysWith(days, key, change) {
  if (!key) return days
  const current = (days && days[key]) || null
  const base = current || { m: 0, tc: 0, tok: {} }
  const next = { ...base }
  if (change.m) next.m = (base.m || 0) + change.m
  if (change.tc) next.tc = (base.tc || 0) + change.tc
  if (change.tokModel && change.tokDelta > 0) {
    next.tok = { ...(base.tok || {}), [change.tokModel]: ((base.tok && base.tok[change.tokModel]) || 0) + change.tokDelta }
  }
  return { ...(days || {}), [key]: next }
}

/** 写时复制地给某个本地小时 +1。 */
function hoursWith(hours, hour) {
  const base = Array.isArray(hours) && hours.length === 24 ? hours : new Array(24).fill(0)
  const next = base.slice()
  next[hour] = (next[hour] || 0) + 1
  return next
}

/** 归一化 outcomes（防御旧 state / 手写 state 缺键）。 */
function outcomesOf(state) {
  const base = (state && state.outcomes) || {}
  const next = emptyOutcomes()
  for (const key of Object.keys(next)) next[key] = Number(base[key]) || 0
  return next
}

/**
 * 把一个会话事件折叠进状态。纯函数：不读外部、不写参数。
 *
 * @param {object} state `createSessionState()` 产出的状态
 * @param {{type: string, time?: number, data?: object, seq?: number}} event 会话事件
 * @returns {object} 新状态；事件不关心（且没有把时间游标推出首末范围）时返回 `state` 本身
 */
export function applySessionEvent(state, event) {
  if (!state || !event || typeof event.type !== 'string') return state
  const data = event.data || {}
  const time = Number(event.time) || 0

  switch (event.type) {
    case 'assistant/message': {
      const base = spanOf(state, time)
      const key = dateKeyOf(time)
      const hour = hourOf(time)
      const usage = data.usage
      const source = data.message && data.message.source
      const model = source && typeof source.model === 'string' ? source.model : null
      let models = base.models || {}
      let days = daysWith(base.days || {}, key, { m: 1 })
      if (usage && model && model !== 'unknown') {
        const input = Number(usage.inputTokens) || 0
        const output = Number(usage.outputTokens) || 0
        const cacheRead = Number(usage.cacheReadTokens) || 0
        const cacheWrite = Number(usage.cacheWriteTokens) || 0
        const current = models[model] || { p: null, i: 0, o: 0, cr: 0, cw: 0, r: 0, n: 0 }
        models = {
          ...models,
          [model]: {
            p: current.p || source.provider || null,
            i: (current.i || 0) + input,
            o: (current.o || 0) + output,
            cr: (current.cr || 0) + cacheRead,
            cw: (current.cw || 0) + cacheWrite,
            r: (current.r || 0) + (Number(usage.reasoningTokens) || 0),
            n: (current.n || 0) + 1,
          },
        }
        // 每日 Token 与「总 Token」用同一含缓存口径（DSH 的 inputTokens 是净输入）。
        const total = input + output + cacheRead + cacheWrite
        days = daysWith(days, key, { tokModel: model, tokDelta: total })
      }
      return {
        ...base,
        msgs: (base.msgs || 0) + 1,
        models,
        days,
        hours: hour >= 0 && hour < 24 ? hoursWith(base.hours, hour) : base.hours || new Array(24).fill(0),
      }
    }

    case 'user/message': {
      const base = spanOf(state, time)
      const key = dateKeyOf(time)
      const hour = hourOf(time)
      return {
        ...base,
        msgs: (base.msgs || 0) + 1,
        days: daysWith(base.days || {}, key, { m: 1 }),
        hours: hour >= 0 && hour < 24 ? hoursWith(base.hours, hour) : base.hours || new Array(24).fill(0),
      }
    }

    case 'tool/call': {
      const base = spanOf(state, time)
      const key = dateKeyOf(time)
      const hour = hourOf(time)
      const name = typeof data.name === 'string' ? data.name : ''
      let lines = Array.isArray(base.lines) ? base.lines : [0, 0]
      let tools = base.tools || {}
      if (name) {
        tools = { ...tools, [name]: (tools[name] || 0) + 1 }
        // 只有写文件类工具解析参数，其余不碰参数体。
        if (name === 'write' || name === 'edit') {
          try {
            const args = JSON.parse(data.arguments)
            if (name === 'write') {
              lines = [lines[0] + countLines(args.content), lines[1]]
            } else {
              lines = [lines[0] + countLines(args.new_string), lines[1] + countLines(args.old_string)]
            }
          } catch {
            /* 参数不是 JSON 就跳过行数统计 */
          }
        }
      }
      return {
        ...base,
        toolCalls: (base.toolCalls || 0) + 1,
        tools,
        lines,
        days: daysWith(base.days || {}, key, { tc: 1 }),
        hours: hour >= 0 && hour < 24 ? hoursWith(base.hours, hour) : base.hours || new Array(24).fill(0),
      }
    }

    case 'tool/result': {
      const base = spanOf(state, time)
      if (!(data.message && data.message.isError)) return base
      return { ...base, toolErrors: (base.toolErrors || 0) + 1 }
    }

    case 'step/start': {
      const base = spanOf(state, time)
      const turn = Number(data.turn)
      return { ...base, openStepStart: time > 0 ? time : null, openStepTurn: Number.isFinite(turn) ? turn : null }
    }

    case 'step/end': {
      const started = state.openStepStart
      const delta = started != null && time > started ? time - started : 0
      const base = spanOf(state, time)
      return {
        ...base,
        steps: (base.steps || 0) + 1,
        apiMs: (base.apiMs || 0) + delta,
        openStepStart: null,
        openStepTurn: null,
      }
    }

    case 'turn/start': {
      const base = spanOf(state, time)
      return { ...base, openTurnStart: time > 0 ? time : null }
    }

    case 'turn/end': {
      const started = state.openTurnStart
      const delta = started != null && time > started ? time - started : 0
      const base = spanOf(state, time)
      const outcomes = outcomesOf(base)
      const reason = data.reason
      const kind = reason && typeof reason.kind === 'string' ? reason.kind : null
      const key = kind ? OUTCOME_KEYS[kind] : null
      // 未知 kind 不写进 state：投影的 stateSchema 是 strict 的，多键即失败。
      if (key) outcomes[key] += 1
      return {
        ...base,
        turns: (base.turns || 0) + 1,
        activeMs: (base.activeMs || 0) + delta,
        outcomes,
        openTurnStart: null,
      }
    }

    case 'compaction/start': {
      const base = spanOf(state, time)
      return { ...base, compactions: (base.compactions || 0) + 1 }
    }

    case 'llm/retry-started': {
      const base = spanOf(state, time)
      return { ...base, retries: (base.retries || 0) + 1 }
    }

    case 'session/title': {
      const base = spanOf(state, time)
      if (typeof data.title !== 'string' || !data.title.trim()) return base
      return { ...base, title: data.title.trim() }
    }

    default:
      // 其余事件只可能影响首末时间（v0.2.0 语义），否则原样返回。
      return spanOf(state, time)
  }
}
