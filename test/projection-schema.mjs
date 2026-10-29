#!/usr/bin/env node
/**
 * test/projection-schema.mjs —— `buddyStats` 投影的边界测试（宿主侧）。
 *
 * 覆盖契约 docs/session-view.md §3.2 / §4：
 * 1. 合成一条真实形状的事件流（turn/step/tool/assistant/user/compaction/retry/title），
 *    用 lib/fold.js 逐事件折叠，**每步都过 stateSchema.parse** —— 折叠状态多字段/少字段立即暴露；
 * 2. wire.view 的输出过 viewSchema.parse，并逐项核对聚合口径：
 *    models 按 total 降序、tools 按 calls 降序、tokens.total 含缓存、
 *    cacheHitRate 百分数、每模型与合计 costUsd、spanMs、行数、outcomes 展开；
 * 3. 视图不含 days 与 openStep*（契约要求：按天表只有全局热力图需要）；
 * 4. 配了 pricing 时成本正确、hasPricing=true；未配置/空表时全 0、hasPricing=false；
 * 5. schema 真的严格：多一个字段就 parse 失败。
 *
 * 关于 zod：插件代码必须写裸说明符 `zod`（运行时由插件的 node_modules 解析）。
 * 本仓库没有 node_modules，所以这里在 import 插件之前装一个解析钩子，把 `zod`
 * 指到本机已安装的那份（候选顺序见 findZod；可用 BUDDY_STATS_ZOD=<path> 覆盖）。
 *
 * 用法：node test/projection-schema.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')

/** 找出本机的 zod（裸说明符的解析目标）。 */
function findZod() {
  const candidates = []
  if (process.env.BUDDY_STATS_ZOD) candidates.push(process.env.BUDDY_STATS_ZOD)
  candidates.push(path.join(repo, 'node_modules/zod/index.js'))
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const profiles = path.join(dshHome, 'profiles')
  try {
    for (const name of fs.readdirSync(profiles).sort()) {
      candidates.push(path.join(profiles, name, 'node_modules/zod/index.js'))
    }
  } catch {
    /* 没有 profiles 目录就跳过 */
  }
  candidates.push(path.join(dshHome, 'node_modules/zod/index.js'))
  candidates.push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/zod/index.js')
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

const zodPath = findZod()
if (zodPath) {
  const zodUrl = pathToFileURL(zodPath).href
  // 用命名空间取值而不是具名导入：老版本 Node 没有 registerHooks，具名导入会在链接期直接报错。
  const nodeModule = await import('node:module')
  const registerHooks = nodeModule.registerHooks
  const register = nodeModule.register
  const resolve = (specifier, context, next) =>
    specifier === 'zod' ? { url: zodUrl, shortCircuit: true } : next(specifier, context)
  if (typeof registerHooks === 'function') {
    // Node ≥ 22.15：同步钩子（无弃用警告）。
    registerHooks({ resolve })
  } else if (typeof register === 'function') {
    // 旧版 Node：异步钩子。
    register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === 'zod') return { url: ${JSON.stringify(zodUrl)}, shortCircuit: true }
  return next(specifier, context)
}
`))
  } else {
    console.error('当前 Node 既没有 registerHooks 也没有 register，无法把裸说明符 zod 指到本机安装')
    process.exit(1)
  }
} else {
  console.error('找不到本机 zod：设置 BUDDY_STATS_ZOD=/path/to/zod/index.js 后重试')
  process.exit(1)
}

/** 被测模块。 */
let projection
let fold
try {
  projection = await import('../lib/session-projection.js')
} catch (error) {
  console.error('无法加载 lib/session-projection.js：', error && error.message)
  process.exit(1)
}
try {
  fold = await import('../lib/fold.js')
} catch (error) {
  console.error(
    '无法加载 lib/fold.js（fold-core 的交付物，接口见契约 §4）：',
    error && error.message,
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 迷你断言框架：全部跑完再汇总，避免第一个失败掩盖后面的信息
// ---------------------------------------------------------------------------

const failures = []
const passed = []

function check(name, fn) {
  try {
    fn()
    passed.push(name)
  } catch (error) {
    failures.push(`${name}\n      ${error && error.message ? error.message.split('\n').join('\n      ') : error}`)
  }
}

function closeTo(actual, expected, eps = 1e-9) {
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) <= eps,
    `期望 ≈${expected}，实际 ${actual}`,
  )
}

// ---------------------------------------------------------------------------
// 合成事件流（字段形状取自本机真实会话日志）
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 0, 15, 9, 0, 0)
const at = (offset) => T0 + offset

const HEADER = {
  id: 'session-synthetic-1',
  createdAt: T0 - 1000,
  cwd: '/tmp/ws',
  parentSession: 'session-parent-1',
  origin: 'subagent',
  agentPreset: 'default',
  title: null,
}

/** 一写一改：write 行数 = content 行数；edit 行数 = new_string / old_string 行数。 */
const WRITE_CONTENT = 'l1\nl2\nl3' // 3 行
const EDIT_NEW = 'x\ny\nz' // 3 行
const EDIT_OLD = 'a\nb' // 2 行

function events() {
  let seq = 0
  return [
    { type: 'turn/start', time: at(0), data: { turn: 1 } },
    { type: 'step/start', time: at(1000), data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      time: at(3000),
      data: {
        turn: 1,
        step: 1,
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 4000,
          cacheWriteTokens: 500,
          reasoningTokens: 100,
        },
        message: { role: 'assistant', source: { kind: 'model', provider: 'qodercn', model: 'model-a' } },
      },
    },
    {
      type: 'tool/call',
      time: at(3100),
      data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: '/tmp/a.txt', content: WRITE_CONTENT }) },
    },
    {
      type: 'tool/result',
      time: at(3200),
      data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, isError: true } },
    },
    { type: 'step/end', time: at(4000), data: { turn: 1, step: 1 } },
    { type: 'step/start', time: at(5000), data: { turn: 1, step: 2 } },
    {
      type: 'assistant/message',
      time: at(7000),
      data: {
        turn: 1,
        step: 2,
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 4000,
          cacheWriteTokens: 500,
          reasoningTokens: 100,
        },
        message: { role: 'assistant', source: { kind: 'model', provider: 'qodercn', model: 'model-a' } },
      },
    },
    {
      type: 'tool/call',
      time: at(7100),
      data: { turn: 1, step: 2, callId: 'c2', name: 'edit', arguments: JSON.stringify({ file_path: '/tmp/a.txt', old_string: EDIT_OLD, new_string: EDIT_NEW }) },
    },
    {
      type: 'tool/result',
      time: at(7200),
      data: { turn: 1, step: 2, message: { role: 'tool', source: { kind: 'tool', callId: 'c2' }, isError: false } },
    },
    { type: 'user/message', time: at(7500), data: { content: [{ type: 'text', text: '继续' }] } },
    { type: 'step/end', time: at(8000), data: { turn: 1, step: 2 } },
    { type: 'turn/end', time: at(9000), data: { turn: 1, reason: { kind: 'completed' } } },

    { type: 'turn/start', time: at(10000), data: { turn: 2 } },
    { type: 'step/start', time: at(11000), data: { turn: 2, step: 1 } },
    {
      type: 'assistant/message',
      time: at(13000),
      data: {
        turn: 2,
        step: 1,
        usage: { inputTokens: 2000, outputTokens: 100, cacheWriteTokens: 1000 },
        message: { role: 'assistant', source: { kind: 'model', provider: 'buddy', model: 'model-b' } },
      },
    },
    { type: 'compaction/start', time: at(13500), data: { compactionId: 'cmp-1', turn: 2 } },
    { type: 'llm/retry-started', time: at(14000), data: { retryId: 'retry-1', turn: 2, step: 1, retry: 1 } },
    { type: 'step/end', time: at(15000), data: { turn: 2, step: 1 } },
    { type: 'turn/end', time: at(16000), data: { turn: 2, reason: { kind: 'aborted' } } },

    { type: 'turn/start', time: at(17000), data: { turn: 3 } },
    { type: 'turn/end', time: at(18000), data: { turn: 3, reason: { kind: 'max-tokens' } } },

    { type: 'session/title', time: at(18500), data: { title: '合成会话' } },
  ].map((event) => ({ ...event, seq: seq++ }))
}

const PRICING = {
  'model-a': { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 },
}

/** 跑一遍真实折叠：每步 parse state，返回最终 state。 */
function foldStream(definition, list = events(), header = HEADER) {
  let state = definition.init(header)
  definition.stateSchema.parse(state)
  for (const event of list) {
    state = definition.apply(state, event)
    definition.stateSchema.parse(state)
  }
  return state
}

const definition = projection.createBuddyStatsDefinition({ pricing: PRICING })
const bare = projection.createBuddyStatsDefinition()
const emptyPricing = projection.createBuddyStatsDefinition({ pricing: {} })

// 折叠+schemas 是后面所有断言的前提；这里失败就直接给出可读原因（zod 会指出具体路径）。
let state
let view
let bareView
let emptyView
try {
  state = foldStream(definition)
  view = definition.wire.view(state)
  bareView = bare.wire.view(foldStream(bare))
  emptyView = emptyPricing.wire.view(foldStream(emptyPricing))
} catch (error) {
  console.error('✗ 合成事件流折叠 / schema 校验在中途失败（state 或 view 与 schema 不匹配）：\n')
  console.error(error && error.message ? error.message : error)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 1. 定义本身的形状
// ---------------------------------------------------------------------------

check('定义：key = buddyStats、stateVersion = 1、wire.summary = false', () => {
  assert.equal(definition.key, 'buddyStats')
  assert.equal(definition.key, projection.PROJECTION_KEY)
  assert.equal(definition.stateVersion, 1)
  assert.equal(definition.wire.summary, false)
  assert.ok(definition.stateSchema && typeof definition.stateSchema.parse === 'function')
  assert.ok(definition.wire.viewSchema && typeof definition.wire.viewSchema.parse === 'function')
  assert.equal(definition.stateSchema, projection.stateSchema)
  assert.equal(definition.wire.viewSchema, projection.viewSchema)
})

check('定义：init/apply 就是 lib/fold.js 的两个导出', () => {
  assert.equal(definition.init, fold.createSessionState)
  assert.equal(definition.apply, fold.applySessionEvent)
})

// ---------------------------------------------------------------------------
// 2. schema 严格性
// ---------------------------------------------------------------------------

check('stateSchema：init 与每一步折叠结果都 parse 通过（已在 foldStream 中断言）', () => {
  projection.stateSchema.parse(state)
})

check('stateSchema：多一个字段就 parse 失败', () => {
  assert.throws(() => projection.stateSchema.parse({ ...state, extraField: 1 }))
  assert.throws(() =>
    projection.stateSchema.parse({ ...state, outcomes: { ...state.outcomes, 'max-tokens': 0 } }),
  )
  assert.throws(() => projection.stateSchema.parse({ ...state, models: { 'model-x': { p: null, i: 0, o: 0, cr: 0, cw: 0, r: 0 } } }))
})

check('viewSchema：多一个字段就 parse 失败（days / openStepStart 不得进 wire）', () => {
  assert.throws(() => projection.viewSchema.parse({ ...view, days: {} }))
  assert.throws(() => projection.viewSchema.parse({ ...view, openStepStart: 1 }))
})

check('viewSchema：wire.view 输出 parse 通过，且是纯 JSON（可进 wire / 可深拷贝）', () => {
  projection.viewSchema.parse(view)
  projection.viewSchema.parse(bareView)
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
})

check('空会话（刚 init、还没有任何事件）也能出合法 wire：全 0、命中率分母为 0 取 0', () => {
  const fresh = definition.init({ id: 'session-empty', createdAt: T0 })
  projection.stateSchema.parse(fresh)
  const freshView = definition.wire.view(fresh)
  projection.viewSchema.parse(freshView)
  assert.equal(freshView.id, 'session-empty')
  assert.equal(freshView.title, null)
  assert.equal(freshView.turns, 0)
  assert.equal(freshView.steps, 0)
  assert.equal(freshView.spanMs, 0)
  assert.equal(freshView.tokens.total, 0)
  assert.equal(freshView.tokens.cacheHitRate, 0)
  assert.deepEqual(freshView.models, [])
  assert.deepEqual(freshView.tools, [])
  assert.deepEqual(freshView.hours, new Array(24).fill(0))
  assert.equal(freshView.costUsd, 0)
  assert.equal(freshView.hasPricing, true)
  assert.deepEqual(Object.keys(freshView.outcomes), [
    'completed',
    'aborted',
    'blocked',
    'error',
    'maxTokens',
    'interrupted',
    'forked',
  ])
})

check('unknown 模型不进 Token 合计与模型列表（与 lib/aggregate.js 同一处判断）', () => {
  const withUnknown = {
    ...state,
    models: { ...state.models, unknown: { p: null, i: 999999, o: 0, cr: 0, cw: 0, r: 0, n: 1 } },
  }
  projection.stateSchema.parse(withUnknown)
  const unknownView = definition.wire.view(withUnknown)
  projection.viewSchema.parse(unknownView)
  assert.equal(unknownView.tokens.input, view.tokens.input)
  assert.ok(!unknownView.models.some((m) => m.id === 'unknown'))
})

check('view：不含 days / openStep*（契约 §3.2 明确排除）', () => {
  assert.ok(!Object.hasOwn(view, 'days'), 'view 不应有 days')
  for (const key of Object.keys(view)) {
    assert.ok(!key.startsWith('open'), `view 不应有内部游标字段 ${key}`)
  }
})

// ---------------------------------------------------------------------------
// 3. 身份字段与计数
// ---------------------------------------------------------------------------

check('身份字段来自 header / session/title', () => {
  assert.equal(view.version, 1)
  assert.equal(view.id, HEADER.id)
  assert.equal(view.cwd, HEADER.cwd)
  assert.equal(view.parent, HEADER.parentSession)
  assert.equal(view.origin, HEADER.origin)
  assert.equal(view.preset, HEADER.agentPreset)
  assert.equal(view.title, '合成会话')
  assert.equal(view.createdAt, HEADER.createdAt)
})

check('计数：turns/steps/msgs/toolCalls/toolErrors/compactions/retries', () => {
  assert.equal(view.turns, 3)
  assert.equal(view.steps, 3)
  assert.equal(view.msgs, 4) // 3 assistant + 1 user
  assert.equal(view.toolCalls, 2)
  assert.equal(view.toolErrors, 1)
  assert.equal(view.compactions, 1)
  assert.equal(view.retries, 1)
})

check('outcomes：展开为七个数字键，reason.kind 映射正确（max-tokens → maxTokens）', () => {
  assert.deepEqual(Object.keys(view.outcomes).sort(), [
    'aborted',
    'blocked',
    'completed',
    'error',
    'forked',
    'interrupted',
    'maxTokens',
  ])
  assert.equal(view.outcomes.completed, 1)
  assert.equal(view.outcomes.aborted, 1)
  assert.equal(view.outcomes.maxTokens, 1)
  for (const kind of ['blocked', 'error', 'interrupted', 'forked']) {
    assert.equal(view.outcomes[kind], 0, `outcomes.${kind} 应为 0`)
  }
})

check('时间：apiMs = Σ(step/end - step/start)、activeMs = Σ(turn/end - turn/start)', () => {
  assert.equal(view.apiMs, 3000 + 3000 + 4000)
  assert.equal(view.activeMs, 9000 + 6000 + 1000)
})

check('时间：first/last/spanMs 自洽（spanMs 是墙钟跨度，非回合内时长）', () => {
  assert.equal(view.first, at(0))
  assert.equal(view.last, at(18500))
  assert.equal(view.spanMs, Math.max(0, view.last - view.first))
  assert.equal(view.spanMs, 18500)
})

check('行数：write.content + edit.new_string / edit.old_string', () => {
  assert.equal(view.linesAdded, 3 + 3)
  assert.equal(view.linesDeleted, 2)
})

check('hours：24 桶，与折叠状态一致，且计入 assistant/user/tool 事件', () => {
  assert.equal(view.hours.length, 24)
  assert.deepEqual(view.hours, state.hours)
  const sum = view.hours.reduce((a, b) => a + b, 0)
  assert.equal(sum, 6) // 3 assistant + 1 user + 2 tool/call
})

// ---------------------------------------------------------------------------
// 4. Token / 命中率 / 成本口径（对齐 lib/aggregate.js）
// ---------------------------------------------------------------------------

check('tokens：四个桶 + reasoning 汇总，total 含缓存', () => {
  assert.equal(view.tokens.input, 4000)
  assert.equal(view.tokens.output, 500)
  assert.equal(view.tokens.cacheRead, 8000)
  assert.equal(view.tokens.cacheWrite, 2000)
  assert.equal(view.tokens.reasoning, 200)
  assert.equal(view.tokens.total, 4000 + 500 + 8000 + 2000)
})

check('tokens.cacheHitRate = cacheRead / (input + cacheRead + cacheWrite) * 100（百分数）', () => {
  closeTo(view.tokens.cacheHitRate, (8000 / (4000 + 8000 + 2000)) * 100)
  assert.ok(view.tokens.cacheHitRate > 1, '命中率必须是百分数而不是 0~1 的小数')
})

check('models：按 total 降序，逐模型 calls/各桶/costUsd', () => {
  assert.deepEqual(
    view.models.map((m) => m.id),
    ['model-a', 'model-b'],
  )
  const a = view.models[0]
  const b = view.models[1]
  assert.equal(a.provider, 'qodercn')
  assert.equal(a.calls, 2)
  assert.equal(a.total, 2000 + 400 + 8000 + 1000)
  assert.equal(a.reasoning, 200)
  closeTo(
    a.costUsd,
    (2000 / 1e6) * 0.28 + (400 / 1e6) * 0.42 + (8000 / 1e6) * 0.028 + (1000 / 1e6) * 0.28,
  )
  assert.equal(b.provider, 'buddy')
  assert.equal(b.calls, 1)
  assert.equal(b.total, 2000 + 100 + 1000)
  assert.equal(b.costUsd, 0, '没有单价的模型 costUsd 必须记 0')
})

check('costUsd 合计 = 各模型之和；hasPricing = true（配了非空单价表）', () => {
  assert.equal(view.hasPricing, true)
  closeTo(
    view.costUsd,
    view.models.reduce((sum, m) => sum + m.costUsd, 0),
  )
  closeTo(
    view.costUsd,
    (2000 / 1e6) * 0.28 + (400 / 1e6) * 0.42 + (8000 / 1e6) * 0.028 + (1000 / 1e6) * 0.28,
  )
})

check('未配置 pricing：costUsd 全 0、hasPricing = false；空表 {} 同样视为未配置', () => {
  assert.equal(bareView.hasPricing, false)
  assert.equal(bareView.costUsd, 0)
  assert.ok(bareView.models.every((m) => m.costUsd === 0))
  assert.equal(emptyView.hasPricing, false)
  assert.equal(emptyView.costUsd, 0)
  assert.ok(emptyView.models.every((m) => m.costUsd === 0))
  // 除成本外，其余聚合结果与配置了 pricing 时完全一致
  assert.deepEqual(
    { ...bareView, costUsd: 0, hasPricing: true },
    { ...view, costUsd: 0, models: view.models.map((m) => ({ ...m, costUsd: 0 })) },
  )
})

// ---------------------------------------------------------------------------
// 5. 工具排行与引用稳定性
// ---------------------------------------------------------------------------

check('tools：按 calls 降序（本次 write/edit 各 1 次）', () => {
  assert.deepEqual(
    view.tools.map((t) => t.name).sort(),
    ['edit', 'write'],
  )
  assert.ok(view.tools.every((t) => t.calls === 1))
})

check('view 引用稳定：同一 state 重复读取返回同一对象（注册表按 Object.is 决定是否推送）', () => {
  assert.equal(definition.wire.view(state), view)
  assert.equal(definition.wire.view(state), definition.wire.view(state))
})

check('view 引用稳定：只有内部游标变化（openStepStart/openTurnStart）时复用同一视图引用', () => {
  const before = definition.wire.view(state)
  const clone = { ...state, openStepStart: at(9999), openStepTurn: 4, openTurnStart: at(9999) }
  projection.stateSchema.parse(clone) // 只动内部游标，仍是合法状态
  assert.equal(definition.wire.view(clone), before)
  // 但真正影响视图的字段一变，就必须给出新引用（否则客户端收不到推送）
  const changed = { ...clone, toolErrors: state.toolErrors + 1 }
  assert.notEqual(definition.wire.view(changed), before)
})

check('apply 纯度：不关心的事件在首末范围内返回同一 state 引用', () => {
  // 时间落在 [first, last] 内，所以连 first/last 都不变（fold 的 spanOf 短路）→ 必须同一引用。
  const same = definition.apply(state, { type: 'job/registered', seq: 998, time: at(8500), data: {} })
  assert.equal(same, state)
})

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const total = passed.length + failures.length
if (failures.length > 0) {
  console.error(`✗ projection-schema: ${failures.length}/${total} 项断言失败\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}\n`)
  process.exit(1)
}
console.log(`✓ projection-schema: ${total} 项断言全部通过（zod: ${zodPath}）`)
