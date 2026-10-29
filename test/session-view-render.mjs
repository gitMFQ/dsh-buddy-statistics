/**
 * 会话视图页签（conversation.view）的渲染自检 —— 不需要 react-dom。
 *
 * 做法：
 *   1. 用 vm + window.__ModuleLoader__ + require 替身加载 client.js；
 *   2. 从 slots.register(options, Component) 的第二参数抓到 SessionStatsView；
 *   3. 用最小 hooks 替身（useState/useMemo/useRef/useCallback/useEffect）直接调用组件，
 *      自写 tree-walker 展开函数组件并收集文本 / title / aria-label；
 *   4. 断言四个场景：空态、含数据态（关键数字出现）、缺 buddyStats 降级、
 *      只有 buddyStats 而没有官方投影时降级。
 *
 * 不启动浏览器、不装插件、不请求网络。
 *
 * 用法：node test/session-view-render.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

// ── 1. 加载 client.js，抓取 conversation.view 的组件 ─────────────────────
const file = path.join(import.meta.dirname, '..', 'client.js')
const source = fs.readFileSync(file, 'utf8')

let definition = null
const sandbox = {
  window: { __ModuleLoader__: { load(def) { definition = def } } },
  globalThis: {},
  console: { log() {}, warn() {}, error() {} },
  URL,
  Date,
  Math,
  JSON,
  Intl,
  fetch: async () => ({ ok: true, json: async () => ({ ok: true, stats: null, meta: null }) }),
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)

const Fragment = Symbol('Fragment')

function flatten(children) {
  const out = []
  for (const child of children) {
    if (Array.isArray(child)) out.push(...flatten(child))
    else if (child === null || child === undefined || typeof child === 'boolean') continue
    else out.push(child)
  }
  return out
}

const React = {
  createElement(type, props, ...children) {
    const flat = flatten(children)
    const next = { type, props: { ...(props || {}) }, children: flat }
    if (flat.length === 1) next.props.children = flat[0]
    else if (flat.length > 1) next.props.children = flat
    return next
  },
  Fragment,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}

const plugin = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`未预期的模块依赖：${name}`)
})

const dicts = new Map()
const registrations = []
const ctx = {
  effect(callback) {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    register(ns, dict) {
      dicts.set(ns, dict)
      return () => {}
    },
    bind(ns) {
      return (key, params) => {
        const dict = dicts.get(ns) || {}
        const template = dict.zh && dict.zh[key] !== undefined ? dict.zh[key] : key
        if (typeof template !== 'string' || !params) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
    },
    subscribe: () => () => {},
    getSnapshot: () => ({ active: 'zh' }),
  },
  slots: {
    inject(key, callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
plugin.apply(ctx)

const zh = dicts.get('buddy-stats').zh
const view = registrations.find((item) => item.options.name === 'conversation.view')
if (!view || typeof view.component !== 'function') {
  throw new Error('没有从 slots.register 第二参数抓到 conversation.view 组件')
}
const SessionStatsView = view.component

// ── tree-walker：展开函数组件，收集文本与可读属性 ─────────────────────────
function collect(node, out, depth = 0) {
  if (depth > 60) return
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out, depth + 1)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node))
    return
  }
  if (typeof node !== 'object') return
  const { type, props, children } = node
  if (typeof type === 'function') {
    collect(type({ ...(props || {}) }), out, depth + 1)
    return
  }
  if (type === Fragment || type === React.Fragment) {
    collect(children, out, depth + 1)
    return
  }
  if (typeof type === 'string') {
    out.tags.add(type)
    for (const attr of ['title', 'aria-label', 'role']) {
      const value = props && props[attr]
      if (typeof value === 'string' && value !== '') out.attrs.push(value)
    }
  }
  collect(children, out, depth + 1)
  if (props && props.children !== undefined && props.children !== children) collect(props.children, out, depth + 1)
}

/** 渲染一次：render(projections) → { text, attrs, tags, all, error } */
function render(projections, { withUseProjection = true } = {}) {
  const useProjection = withUseProjection
    ? (key) => {
        if (projections && typeof projections === 'object' && Object.prototype.hasOwnProperty.call(projections, key)) {
          return projections[key]
        }
        return undefined
      }
    : undefined
  const props = { sessionId: 'session-1', useProjection, useSession: () => ({}), t: ctx.locale.bind('buddy-stats') }
  const out = { text: [], attrs: [], tags: new Set() }
  let error = null
  try {
    collect(SessionStatsView(props), out)
  } catch (cause) {
    error = cause
  }
  const all = [...out.text, ...out.attrs].join(' | ')
  return { ...out, all, error }
}

function has(result, needle) {
  return result.all.includes(needle)
}

// ── 2. 测试数据 ─────────────────────────────────────────────────────────
const HOURS = Array.from({ length: 24 }, (_, hour) => (hour === 9 ? 12 : hour === 14 ? 6 : hour === 20 ? 3 : 0))
const BUDDY_STATS = {
  version: 1,
  id: 'session-1',
  title: '修复登录重试',
  cwd: '/root/demo',
  parent: 'parent-session-9',
  origin: 'subagent',
  preset: 'default',
  createdAt: Date.UTC(2026, 0, 2, 3, 4),
  first: Date.UTC(2026, 0, 2, 3, 4),
  last: Date.UTC(2026, 0, 2, 4, 34),
  spanMs: 5_400_000,
  turns: 7,
  steps: 19,
  msgs: 42,
  toolCalls: 31,
  toolErrors: 2,
  linesAdded: 128,
  linesDeleted: 37,
  apiMs: 754_000,
  activeMs: 1_234_000,
  compactions: 2,
  retries: 3,
  outcomes: { completed: 5, aborted: 1, blocked: 0, error: 1, maxTokens: 0, interrupted: 0, forked: 0 },
  tokens: { input: 120_000, output: 34_000, cacheRead: 880_000, cacheWrite: 44_000, reasoning: 9_000, total: 1_078_000, cacheHitRate: 84.6 },
  models: [
    {
      id: 'anthropic.claude-sonnet-4-20250514',
      provider: 'anthropic',
      calls: 19,
      input: 120_000,
      output: 34_000,
      cacheRead: 880_000,
      cacheWrite: 44_000,
      reasoning: 9_000,
      total: 1_078_000,
      costUsd: 3.5,
    },
  ],
  tools: [
    { name: 'bash', calls: 14 },
    { name: 'edit', calls: 9 },
    { name: 'read', calls: 8 },
  ],
  hours: HOURS,
  costUsd: 3.5,
  hasPricing: true,
}
const PRESSURE = { pressureTokens: 150_000, projectedTokens: 165_000, contextWindow: 200_000 }
const BREAKDOWN = { systemTokens: 4_000, toolsTokens: 9_000, messageTokens: 152_000 }
const SESSION_STATS = { turns: 7, steps: 19, llmMs: 754_000, toolMs: 210_000, ttftMs: 1_200, ttftSteps: 19, decodeMs: 45_000, decodeTokens: 34_000 }

const checks = []
function check(label, ok) {
  checks.push([label, Boolean(ok)])
}

// ── 3. 场景 A：空态（无 buddyStats）──────────────────────────────────────
const empty = render({})
check('空态：无异常', empty.error === null)
check('空态：显示 stats.session.pending', has(empty, zh['stats.session.pending']))
check('空态：不出现 Token 构成区块', !has(empty, zh['stats.session.tokenComposition']))

// ── 4. 场景 B：完整数据态 ───────────────────────────────────────────────
const full = render({
  buddyStats: BUDDY_STATS,
  contextPressure: PRESSURE,
  contextBreakdown: BREAKDOWN,
  sessionStats: SESSION_STATS,
})
check('数据态：无异常', full.error === null)
check('数据态：标题出现', has(full, '修复登录重试'))
check('数据态：总 Token = 1.1M', has(full, '1.1M'))
check('数据态：缓存命中率 84.6%', has(full, '84.6%'))
check('数据态：回合 7 / 步数 19 / 消息 42 / 工具 31', has(full, '7') && has(full, '19') && has(full, '42') && has(full, '31'))
check('数据态：模型耗时 754s → 12m 34s', has(full, '12m 34s'))
check('数据态：工具耗时 210s → 3m 30s', has(full, '3m 30s'))
check('数据态：活跃时长 1234s → 20m 34s', has(full, '20m 34s'))
check('数据态：墙钟跨度 1h 30m 0s', has(full, '1h 30m 0s'))
check('数据态：每步均 Token hint', has(full, zh['stats.session.avgTokensPerStep']))
check('数据态：每回合均 Token hint', has(full, zh['stats.session.avgTokensPerTurn']))
check('数据态：每步均耗时 hint', has(full, zh['stats.session.avgStepMs']))

check('数据态：Token 构成标题', has(full, zh['stats.session.tokenComposition']))
check('数据态：输入 120.0k / 缓存读 880.0k', has(full, '120.0k') && has(full, '880.0k'))
check('数据态：缓存写入文案', has(full, zh['stats.session.cacheWrite']))
check('数据态：推理文案', has(full, zh['stats.reasoning']))

check('数据态：上下文占用标题', has(full, zh['stats.session.context']))
check('数据态：占用 165.0k / 200.0k', has(full, '165.0k / 200.0k'))
check('数据态：占用百分比 82.5%', has(full, '82.5%'))
check('数据态：上下文组成三项', has(full, zh['stats.session.systemTokens']) && has(full, zh['stats.session.toolsTokens']) && has(full, zh['stats.session.messageTokens']))

check('数据态：模型明细标题', has(full, zh['stats.session.modelDetail']))
check('数据态：模型短名', has(full, 'claude-sonnet-4'))
check('数据态：模型调用次数', has(full, `${zh['stats.session.colCalls']} `))
check('数据态：hasPricing 时显示成本 $3.50', has(full, '$3.50'))

check('数据态：工具排行标题', has(full, zh['stats.session.tools']))
check('数据态：工具名 bash/edit/read', has(full, 'bash') && has(full, 'edit') && has(full, 'read'))
check('数据态：工具错误 2 与成功率 93.5%', has(full, `${zh['stats.session.toolErrors']} 2`) && has(full, '93.5%'))

check('数据态：回合结果标题', has(full, zh['stats.session.outcomes']))
check('数据态：完成/中止/出错三项', has(full, zh['stats.session.outcome.completed']) && has(full, zh['stats.session.outcome.aborted']) && has(full, zh['stats.session.outcome.error']))
check('数据态：零值结果（阻塞/触顶/中断/派生）不显示', !has(full, zh['stats.session.outcome.blocked']) && !has(full, zh['stats.session.outcome.maxTokens']) && !has(full, zh['stats.session.outcome.interrupted']) && !has(full, zh['stats.session.outcome.forked']))

check('数据态：文件变更 +128 / -37', has(full, '+128') && has(full, '-37'))
check('数据态：压缩次数 2', has(full, zh['stats.session.compactions']) && has(full, '2'))
check('数据态：重试次数 3', has(full, zh['stats.session.retries']) && has(full, '3'))

check('数据态：按小时活动标题', has(full, zh['stats.session.hours']))
check('数据态：小时桶 aria-label', has(full, '9:00 · 12') && has(full, '20:00 · 3'))
check('数据态：高峰时段 9:00', has(full, `${zh['stats.peakHour']} 9:00`))

check('数据态：会话信息标题', has(full, zh['stats.session.meta']))
check('数据态：标题行标签（未复用全局会话栏文案）', has(full, zh['stats.session.metaTitle']) && !has(full, zh['stats.session.title']))
check('数据态：cwd 出现', has(full, '/root/demo'))
check('数据态：parent 出现', has(full, 'parent-session-9'))
check('数据态：parent 标签', has(full, zh['stats.session.parent']))
check('数据态：origin=子代理', has(full, zh['stats.session.originSubagent']))
check('数据态：preset 出现', has(full, 'default'))
check('数据态：创建时间标签', has(full, zh['stats.session.createdAt']))
check('数据态：首末活动标签', has(full, zh['stats.session.firstActive']) && has(full, zh['stats.session.lastActive']))

check('数据态：首字延迟 1.2s', has(full, zh['stats.session.ttft']) && has(full, '1s'))
check('数据态：解码速度 755.6 tok/s', has(full, zh['stats.session.decodeSpeed']) && has(full, '755.6 tok/s'))
check('数据态：延迟与速度区块标题', has(full, zh['stats.session.latency']))
check('数据态：hasPricing 时顶部显示总成本', has(full, `${zh['stats.cost']}`) && has(full, '$3.50'))

// ── 5. 场景 C：缺 buddyStats（值缺失 + useProjection 本身缺失 + 取值抛错）──
const noValue = render({ contextPressure: PRESSURE, contextBreakdown: BREAKDOWN, sessionStats: SESSION_STATS })
check('缺 buddyStats：无异常并显示 pending', noValue.error === null && has(noValue, zh['stats.session.pending']))

const noHook = render({}, { withUseProjection: false })
check('props 无 useProjection：无异常并显示 pending', noHook.error === null && has(noHook, zh['stats.session.pending']))

let throwing = null
{
  const out = { text: [], attrs: [], tags: new Set() }
  let error = null
  try {
    collect(
      SessionStatsView({
        sessionId: 'session-1',
        useProjection: () => {
          throw new Error('projection unavailable')
        },
        t: ctx.locale.bind('buddy-stats'),
      }),
      out,
    )
  } catch (cause) {
    error = cause
  }
  throwing = { all: [...out.text, ...out.attrs].join(' | '), error }
}
check('useProjection 抛错：不崩且降级为空态', throwing.error === null && throwing.all.includes(zh['stats.session.pending']))

// ── 6. 场景 D：只有 buddyStats，没有官方投影 ─────────────────────────────
const solo = render({ buddyStats: BUDDY_STATS })
check('仅 buddyStats：无异常', solo.error === null)
check('仅 buddyStats：仍渲染 Token 构成', has(solo, zh['stats.session.tokenComposition']))
check('仅 buddyStats：隐藏上下文区块', !has(solo, zh['stats.session.contextComposition']))
check('仅 buddyStats：工具耗时降级为 N/A', has(solo, zh['stats.na']))
check('仅 buddyStats：隐藏首字延迟区块', !has(solo, zh['stats.session.ttft']))
check('仅 buddyStats：工具排行仍在', has(solo, 'bash'))

// ── 7. 场景 E：无定价表时不显示成本 ─────────────────────────────────────
const noPricing = render({ buddyStats: { ...BUDDY_STATS, hasPricing: false, costUsd: 0, models: BUDDY_STATS.models.map((m) => ({ ...m, costUsd: 0 })) } })
check('无定价：不出现成本金额', noPricing.error === null && !has(noPricing, '$3.50') && !has(noPricing, '$0.00'))
check('无定价：模型明细仍在', has(noPricing, 'claude-sonnet-4'))
check('无定价：顶部无总成本 KPI', !has(noPricing, '总成本') && !has(noPricing, 'Cost'))

// ── 8. 场景 F：畸形输入不崩 ─────────────────────────────────────────────
const nullValue = render({ buddyStats: null })
check('buddyStats 为 null：降级为空态', nullValue.error === null && has(nullValue, zh['stats.session.pending']))

const emptyObject = render({ buddyStats: {} })
check('buddyStats 为空对象：按 0 渲染且不崩', emptyObject.error === null && has(emptyObject, zh['stats.session.tokenComposition']) && has(emptyObject, '0.0%'))

const malformed = render({
  buddyStats: { tokens: null, models: 'nope', tools: 5, hours: 'bad', outcomes: 3, linesAdded: 'x', createdAt: null },
  contextPressure: 'nope',
  contextBreakdown: [],
  sessionStats: 42,
})
check(
  '字段类型全错：不崩、无数据区块按 0 降级',
  malformed.error === null && has(malformed, zh['stats.session.tokenComposition']) && !has(malformed, zh['stats.session.tools']),
)
check('畸形 contextPressure/sessionStats：隐藏上下文与延迟区块', !has(malformed, zh['stats.session.contextComposition']) && !has(malformed, zh['stats.session.latency']))

// ── 输出 ────────────────────────────────────────────────────────────────
let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failed++
}

if (failed > 0) {
  console.error(`\n${failed}/${checks.length} 项检查失败`)
  process.exit(1)
}
console.log(`\nsession-view-render 通过（${checks.length} 项断言，无 react-dom）`)
