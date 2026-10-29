/**
 * `buddyStats` 投影单元 —— 会话视图（conversation.view 的「统计」页签）的宿主半边。
 *
 * 职责划分（契约 docs/session-view.md §3）：
 * - 折叠：完全复用 lib/fold.js 的唯一实现（init/apply 直接是它的两个导出），本文件不重新发明口径；
 * - 聚合：wire.view 把折叠状态「宿主侧」压成 §3.2 的客户端视图（models/tools 排序、tokens 汇总、
 *   命中率百分数、成本、outcomes 展开），客户端只渲染不算数；
 * - 边界：stateSchema / viewSchema 用 zod 4 做严格校验（.strict()），多字段/少字段都会在注册表
 *   「持久化缓存读回」与「wire 出站」两个边界上被拒绝，宁可早失败也不要悄悄漂移。
 *
 * 成本与缓存命中率口径与全局页 lib/aggregate.js 完全一致（每百万 Token × 单价；
 * cacheHitRate = cacheRead / (input + cacheRead + cacheWrite) × 100，分母为 0 时取 0）。
 *
 * 注意：本文件的 `zod` 必须是裸说明符 —— 运行时由插件所在 node_modules 解析；
 * 测试脚本里用解析钩子把它指到本机已安装的 zod（见 test/projection-schema.mjs）。
 */

import { z } from 'zod'

import { applySessionEvent, createSessionState } from './fold.js'

/** 投影 key；客户端用 props.useProjection('buddyStats') 读取。 */
export const PROJECTION_KEY = 'buddyStats'

/** 折叠状态版本：状态字段或折叠语义变化时 +1（会让旧的持久化投影缓存失效）。 */
export const STATE_VERSION = 1

/** 视图 JSON 的 version 字段（契约 §3.2）。 */
export const VIEW_VERSION = 1

/** 单价表里的一个速率值：非有限数一律当 0，和 aggregate.js 的 `p.x || 0` 等价。 */
function rate(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

/** 只保留真正的数字，其余（undefined/NaN/对象）记 0。 */
function num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

function nullableString(value) {
  return typeof value === 'string' ? value : null
}

/**
 * 归一化 config.pricing：只保留「值是对象」的条目；整张表没有可用条目时返回 null
 * （= hasPricing false，与 index.js 里 `Object.keys(pricing).length` 的口径一致）。
 */
export function normalizePricing(raw) {
  if (!raw || typeof raw !== 'object') return null
  const table = {}
  let entries = 0
  for (const [model, price] of Object.entries(raw)) {
    if (!model || !price || typeof price !== 'object') continue
    table[model] = {
      input: rate(price.input),
      output: rate(price.output),
      cacheRead: rate(price.cacheRead),
      cacheWrite: rate(price.cacheWrite),
    }
    entries++
  }
  return entries > 0 ? table : null
}

/**
 * 单个模型的成本（美元）：每百万 Token × 单价，缺单价记 0。
 * 逐字对齐 lib/aggregate.js 的 costUSD 计算。
 */
function costOf(usage, price) {
  if (!price) return 0
  return (
    (usage.i / 1e6) * price.input +
    (usage.o / 1e6) * price.output +
    (usage.cr / 1e6) * price.cacheRead +
    (usage.cw / 1e6) * price.cacheWrite
  )
}

// ---------------------------------------------------------------------------
// schema：与 lib/fold.js 的 state 逐字段对应（见契约 §4）
// ---------------------------------------------------------------------------

/** 每模型折叠桶：p=provider、i/o/cr/cw/r=各 Token 桶、n=有 usage 的 assistant 消息条数。 */
const modelStateSchema = z
  .object({
    p: z.string().nullable(),
    i: z.number().nonnegative(),
    o: z.number().nonnegative(),
    cr: z.number().nonnegative(),
    cw: z.number().nonnegative(),
    r: z.number().nonnegative(),
    n: z.number().nonnegative(),
  })
  .strict()

/** 按天桶：m=消息数、tc=工具调用数、tok=当日各模型 Token。 */
const dayStateSchema = z
  .object({
    m: z.number().nonnegative(),
    tc: z.number().nonnegative(),
    tok: z.record(z.string(), z.number().nonnegative()),
  })
  .strict()

/** 回合结束原因分布（§3.2 的 outcomes）。 */
const outcomesSchema = z
  .object({
    completed: z.number().nonnegative(),
    aborted: z.number().nonnegative(),
    blocked: z.number().nonnegative(),
    error: z.number().nonnegative(),
    maxTokens: z.number().nonnegative(),
    interrupted: z.number().nonnegative(),
    forked: z.number().nonnegative(),
  })
  .strict()

/**
 * 折叠状态 schema（`.strict()`：多一个字段就 parse 失败，防止 fold 悄悄加字段而视图不同步）。
 * 这些状态会进投影持久化缓存，读回时先过这里。
 */
export const stateSchema = z
  .object({
    id: z.string().nullable(),
    createdAt: z.number().nonnegative(),
    cwd: z.string().nullable(),
    parent: z.string().nullable(),
    origin: z.string().nullable(),
    preset: z.string().nullable(),
    title: z.string().nullable(),
    first: z.number().nonnegative(),
    last: z.number().nonnegative(),
    turns: z.number().nonnegative(),
    steps: z.number().nonnegative(),
    msgs: z.number().nonnegative(),
    toolCalls: z.number().nonnegative(),
    toolErrors: z.number().nonnegative(),
    lines: z.array(z.number().nonnegative()).length(2),
    apiMs: z.number().nonnegative(),
    activeMs: z.number().nonnegative(),
    compactions: z.number().nonnegative(),
    retries: z.number().nonnegative(),
    outcomes: outcomesSchema,
    models: z.record(z.string(), modelStateSchema),
    tools: z.record(z.string(), z.number().nonnegative()),
    days: z.record(z.string(), dayStateSchema),
    hours: z.array(z.number().nonnegative()).length(24),
    openStepStart: z.number().nonnegative().nullable(),
    openStepTurn: z.number().nonnegative().nullable(),
    openTurnStart: z.number().nonnegative().nullable(),
  })
  .strict()

/** 每模型一行（§3.2 的 models[]）。 */
const modelViewSchema = z
  .object({
    id: z.string(),
    provider: z.string().nullable(),
    calls: z.number().nonnegative(),
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    reasoning: z.number().nonnegative(),
    total: z.number().nonnegative(),
    costUsd: z.number().nonnegative(),
  })
  .strict()

/** 每工具一行（§3.2 的 tools[]）。 */
const toolViewSchema = z
  .object({
    name: z.string(),
    calls: z.number().nonnegative(),
  })
  .strict()

/** Token 汇总（§3.2 的 tokens；total 含缓存，cacheHitRate 是百分数）。 */
const tokensViewSchema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    reasoning: z.number().nonnegative(),
    total: z.number().nonnegative(),
    cacheHitRate: z.number().nonnegative(),
  })
  .strict()

/**
 * 出站视图 schema（契约 §3.2 冻结）：客户端唯一数据源。
 * 刻意不含 days 与 openStepStart/openStepTurn/openTurnStart —— 按天桶只有全局热力图需要，
 * 放进 wire 只会让每个事件都推送一份长会话的按天表。
 */
export const viewSchema = z
  .object({
    version: z.literal(VIEW_VERSION),
    id: z.string(),
    title: z.string().nullable(),
    cwd: z.string().nullable(),
    parent: z.string().nullable(),
    origin: z.string().nullable(),
    preset: z.string().nullable(),
    createdAt: z.number().nonnegative(),
    first: z.number().nonnegative(),
    last: z.number().nonnegative(),
    spanMs: z.number().nonnegative(),
    turns: z.number().nonnegative(),
    steps: z.number().nonnegative(),
    msgs: z.number().nonnegative(),
    toolCalls: z.number().nonnegative(),
    toolErrors: z.number().nonnegative(),
    linesAdded: z.number().nonnegative(),
    linesDeleted: z.number().nonnegative(),
    apiMs: z.number().nonnegative(),
    activeMs: z.number().nonnegative(),
    compactions: z.number().nonnegative(),
    retries: z.number().nonnegative(),
    outcomes: outcomesSchema,
    tokens: tokensViewSchema,
    models: z.array(modelViewSchema),
    tools: z.array(toolViewSchema),
    hours: z.array(z.number().nonnegative()).length(24),
    costUsd: z.number().nonnegative(),
    hasPricing: z.boolean(),
  })
  .strict()

// ---------------------------------------------------------------------------
// state → view
// ---------------------------------------------------------------------------

/**
 * 把折叠状态聚合成 §3.2 的视图。
 *
 * - models 按 total 降序（同值按 id 升序，保证同一状态永远得到同一顺序）；
 * - tools 按 calls 降序（同值按 name 升序）；
 * - 名为 `unknown`/空的模型与全局页一样跳过（lib/aggregate.js 的同一处判断），
 *   否则它会把没有单价的「幽灵模型」带进 Token 合计；
 * - 成本、命中率口径逐字对齐 lib/aggregate.js。
 *
 * @param {object} state lib/fold.js 的折叠状态
 * @param {object|null} pricing 归一化后的单价表（null = 未配置单价）
 * @param {boolean} hasPricing 视图里的 hasPricing 标记
 */
export function buildView(state, pricing = null, hasPricing = false) {
  const models = []
  const tokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    cacheHitRate: 0,
  }
  let costUsd = 0

  for (const [id, raw] of Object.entries(state.models || {})) {
    if (!id || id === 'unknown') continue
    const usage = {
      i: num(raw && raw.i),
      o: num(raw && raw.o),
      cr: num(raw && raw.cr),
      cw: num(raw && raw.cw),
      r: num(raw && raw.r),
    }
    // 总 Token 用「含缓存」口径：DSH 的 inputTokens 是净输入，缓存读取单独统计。
    const total = usage.i + usage.o + usage.cr + usage.cw
    const cost = costOf(usage, pricing ? pricing[id] : null)
    models.push({
      id,
      provider: nullableString(raw && raw.p),
      calls: num(raw && raw.n),
      input: usage.i,
      output: usage.o,
      cacheRead: usage.cr,
      cacheWrite: usage.cw,
      reasoning: usage.r,
      total,
      costUsd: cost,
    })
    tokens.input += usage.i
    tokens.output += usage.o
    tokens.cacheRead += usage.cr
    tokens.cacheWrite += usage.cw
    tokens.reasoning += usage.r
    costUsd += cost
  }
  models.sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))

  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
  const denom = tokens.input + tokens.cacheRead + tokens.cacheWrite
  tokens.cacheHitRate = denom > 0 ? (tokens.cacheRead / denom) * 100 : 0

  const tools = Object.entries(state.tools || {})
    .map(([toolName, calls]) => ({ name: toolName, calls: num(calls) }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))

  const outcomes = {}
  for (const kind of Object.keys(outcomesSchema.shape)) {
    outcomes[kind] = num(state.outcomes && state.outcomes[kind])
  }

  const lines = Array.isArray(state.lines) ? state.lines : []
  const hours = new Array(24).fill(0)
  if (Array.isArray(state.hours)) {
    for (let h = 0; h < 24; h++) hours[h] = num(state.hours[h])
  }

  const first = num(state.first)
  const last = num(state.last)

  return {
    version: VIEW_VERSION,
    id: typeof state.id === 'string' ? state.id : '',
    title: nullableString(state.title),
    cwd: nullableString(state.cwd),
    parent: nullableString(state.parent),
    origin: nullableString(state.origin),
    preset: nullableString(state.preset),
    createdAt: num(state.createdAt),
    first,
    last,
    spanMs: Math.max(0, last - first),
    turns: num(state.turns),
    steps: num(state.steps),
    msgs: num(state.msgs),
    toolCalls: num(state.toolCalls),
    toolErrors: num(state.toolErrors),
    linesAdded: num(lines[0]),
    linesDeleted: num(lines[1]),
    apiMs: num(state.apiMs),
    activeMs: num(state.activeMs),
    compactions: num(state.compactions),
    retries: num(state.retries),
    outcomes,
    tokens,
    models,
    tools,
    hours,
    costUsd,
    hasPricing: Boolean(hasPricing),
  }
}

/** 结构等值：用于让「不影响视图的内部状态变化」复用同一个视图引用。 */
function sameValue(a, b) {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (!Object.hasOwn(b, key)) return false
    if (!sameValue(a[key], b[key])) return false
  }
  return true
}

/**
 * 创建 `buddyStats` 投影定义（交给 ctx.sessionProjections.register）。
 *
 * init/apply 就是 lib/fold.js 的两个导出，本函数只补 schema、视图与配置。
 *
 * `view` 会在两种情况下复用同一个对象引用：同一 state 重复读取（WeakMap 缓存），
 * 以及内部游标类变化（openStepStart/openTurnStart）导致的等价视图。
 * 投影注册表按 `Object.is` 比较两次 view 结果来决定是否推送，复用引用能避免
 * 每个 step/start 都让客户端重渲染一次。
 *
 * @param {{ pricing?: Record<string, { input?: number, output?: number, cacheRead?: number, cacheWrite?: number }> | null }} [options]
 */
export function createBuddyStatsDefinition(options = {}) {
  const pricing = normalizePricing(options && options.pricing)
  const hasPricing = pricing !== null
  /** state 引用 → 视图引用：同一状态重复读取不再重建对象。 */
  const cache = new WeakMap()
  let last = null

  function view(state) {
    const hit = cache.get(state)
    if (hit) {
      // 命中也要更新「最近一次返回的视图」：否则下一次比较会拿别的定义/别的会话的视图当基线。
      last = hit
      return hit
    }
    const next = buildView(state, pricing, hasPricing)
    const stable = last && sameValue(last, next) ? last : next
    cache.set(state, stable)
    last = stable
    return stable
  }

  return {
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema,
    init: createSessionState,
    apply: applySessionEvent,
    wire: {
      viewSchema,
      view,
      /** 不进会话列表摘要：列表载荷不该背着整张会话统计。 */
      summary: false,
    },
  }
}
