/**
 * `lib/fold.js` 纯度与语义自检（不依赖 DSH 运行时）。
 *
 * 断言三类东西：
 * 1. **纯度**：不关心的事件返回同一引用；关心的事件返回新引用，且用 JSON 快照
 *    证明**传入的旧 state 一个字节都没被改**（写时复制，不是原地修改）。
 * 2. **结构**：`createSessionState` 的字段集合严格等于契约 §4（投影的 zod stateSchema
 *    是 strict 的，多一个字段都会 parse 失败）；被改的桶是新的对象/数组。
 * 3. **语义**：合成事件流下 turns / steps / msgs / toolCalls / toolErrors / lines /
 *    apiMs / activeMs / compactions / retries / outcomes / models / days / hours 的确定值。
 *
 * 用法：node test/fold-purity.mjs
 */

import assert from 'node:assert/strict'

import { CACHE_VERSION, applySessionEvent, createSessionState, dateKeyOf } from '../lib/fold.js'

let checks = 0
function check(label, fn) {
  try {
    fn()
  } catch (error) {
    console.error(`✗ ${label}`)
    throw error
  }
  checks++
  console.log(`✓ ${label}`)
}

/** 契约 §4 的 state 字段（顺序无关）。 */
const STATE_KEYS = [
  'activeMs',
  'apiMs',
  'compactions',
  'createdAt',
  'cwd',
  'days',
  'first',
  'hours',
  'id',
  'last',
  'lines',
  'models',
  'msgs',
  'openStepStart',
  'openStepTurn',
  'openTurnStart',
  'origin',
  'outcomes',
  'parent',
  'preset',
  'retries',
  'steps',
  'title',
  'toolCalls',
  'toolErrors',
  'tools',
  'turns',
]

const OUTCOME_KEYS = ['aborted', 'blocked', 'completed', 'error', 'forked', 'interrupted', 'maxTokens']

const HEADER = {
  id: 'session-purity-0001',
  createdAt: 1767225600000,
  cwd: '/root/demo',
  parentSession: 'session-parent',
  origin: 'subagent',
  agentPreset: 'standard',
}

const T0 = 1767225600000 // 2026-01-01T00:00:00Z，本地整点附近，桶归属稳定
const DAY = dateKeyOf(T0)
const HOUR = new Date(T0 + 1000).getHours()

/** 合成事件流：[(事件, 是否应当产生新引用)] */
const STREAM = [
  [{ type: 'session/title', time: T0, data: { title: '  hello  ' } }, true],
  [{ type: 'user/message', time: T0 + 1000, data: {} }, true],
  [{ type: 'turn/start', time: T0 + 2000, data: { turn: 1 } }, true],
  [{ type: 'step/start', time: T0 + 3000, data: { turn: 1, step: 1 } }, true],
  [{ type: 'tool/call', time: T0 + 3500, data: { name: 'read', arguments: '{"file_path":"/x"}' } }, true],
  [{ type: 'tool/result', time: T0 + 4000, data: { message: { isError: true } } }, true],
  [
    {
      type: 'assistant/message',
      time: T0 + 5000,
      data: {
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 30, reasoningTokens: 7 },
        message: { source: { model: 'm1', provider: 'p1' } },
      },
    },
    true,
  ],
  [{ type: 'step/end', time: T0 + 6000, data: { turn: 1, step: 1 } }, true],
  [{ type: 'llm/retry-started', time: T0 + 6500, data: { retryId: 'r1', retry: 1 } }, true],
  [{ type: 'turn/end', time: T0 + 7000, data: { turn: 1, reason: { kind: 'completed' } } }, true],
  [
    { type: 'tool/call', time: T0 + 7100, data: { name: 'write', arguments: JSON.stringify({ file_path: '/x', content: 'a\nb\nc' }) } },
    true,
  ],
  [
    { type: 'tool/call', time: T0 + 7200, data: { name: 'edit', arguments: JSON.stringify({ old_string: 'x\ny', new_string: 'z' }) } },
    true,
  ],
  [{ type: 'compaction/start', time: T0 + 8000, data: { compactionId: 'c1', turn: 1 } }, true],
  // 没有开着的 turn：activeMs 不再变，但 turns / outcomes 仍然记。
  [{ type: 'turn/end', time: T0 + 9000, data: { turn: 2, reason: { kind: 'max-tokens' } } }, true],
  // 重复的 step/end：steps 记 2，apiMs 不重复计（游标已清空）。
  [{ type: 'step/end', time: T0 + 9100, data: { turn: 1, step: 1 } }, true],
  // 与统计无关的事件：时间夹在首末之间 → 同一引用（不入任何桶）。
  [{ type: 'plugin:translator/request', time: T0 + 4000, data: {} }, false],
]

console.log(`fold.js CACHE_VERSION = ${CACHE_VERSION}, day=${DAY}, hour=${HOUR}\n`)

// ---------------------------------------------------------------- 1. 结构

check('CACHE_VERSION === 6', () => assert.equal(CACHE_VERSION, 6))

check('createSessionState 字段集合严格等于契约 §4', () => {
  const state = createSessionState(HEADER)
  assert.deepEqual(Object.keys(state).sort(), STATE_KEYS)
  assert.deepEqual(Object.keys(state.outcomes).sort(), OUTCOME_KEYS)
  assert.deepEqual(state.hours.length, 24)
  assert.deepEqual(state.lines, [0, 0])
  assert.equal(state.id, HEADER.id)
  assert.equal(state.createdAt, HEADER.createdAt)
  assert.equal(state.cwd, HEADER.cwd)
  assert.equal(state.parent, HEADER.parentSession)
  assert.equal(state.origin, HEADER.origin)
  assert.equal(state.preset, HEADER.agentPreset)
  assert.equal(state.openStepStart, null)
  assert.equal(state.openStepTurn, null)
  assert.equal(state.openTurnStart, null)
})

check('createSessionState({}) 不抛错且仍是完整 state', () => {
  const state = createSessionState()
  assert.deepEqual(Object.keys(state).sort(), STATE_KEYS)
  assert.equal(state.id, null)
  assert.equal(state.createdAt, 0)
})

check('非法事件返回同一引用', () => {
  const state = createSessionState(HEADER)
  assert.equal(applySessionEvent(state, null), state)
  assert.equal(applySessionEvent(state, undefined), state)
  assert.equal(applySessionEvent(state, {}), state)
  assert.equal(applySessionEvent(state, { type: 42, time: T0 }), state)
  assert.equal(applySessionEvent(null, { type: 'user/message', time: T0 }), null)
})

// ------------------------------------------------- 2. 合成流：纯度 + 语义

const state0 = createSessionState(HEADER)
let state = state0

for (const [event, shouldChange] of STREAM) {
  const snapshot = JSON.stringify(state)
  const next = applySessionEvent(state, event)
  const label = `${event.type} @+${event.time - T0}`
  check(`${label}：旧 state 未被原地修改`, () => {
    assert.equal(JSON.stringify(state), snapshot)
  })
  check(`${label}：${shouldChange ? '产生新引用' : '返回同一引用'}`, () => {
    if (shouldChange) assert.notEqual(next, state, `${label} 应当返回新引用`)
    else assert.equal(next, state, `${label} 应当返回同一引用`)
  })
  state = next
}

check('合成流结束后状态引用与初始 state 不同', () => assert.notEqual(state, state0))

check('未被描述的事件（时间夹在首末之间）返回同一引用', () => {
  const probe = { type: 'plugin:translator/request', time: T0 + 4000, data: {} }
  assert.equal(applySessionEvent(state, probe), state)
})

check('未被描述的事件（无 time）返回同一引用', () => {
  assert.equal(applySessionEvent(state, { type: 'agent/inbox/spliced', data: {} }), state)
})

check('未出错且时间在范围内的 tool/result 返回同一引用', () => {
  assert.equal(applySessionEvent(state, { type: 'tool/result', time: T0 + 4000, data: { message: { isError: false } } }), state)
})

check('空白标题且时间在范围内的 session/title 返回同一引用', () => {
  assert.equal(applySessionEvent(state, { type: 'session/title', time: T0 + 5000, data: { title: '   ' } }), state)
})

check('仅推进 last 的事件：只改 first/last，其余字段整值不变', () => {
  const before = state
  const after = applySessionEvent(state, { type: 'llm/retry', time: T0 + 9900, data: { retryId: 'r2' } })
  assert.notEqual(after, before)
  assert.equal(after.last, T0 + 9900)
  const { last: _l, ...restBefore } = before
  const { last: _l2, ...restAfter } = after
  assert.deepEqual(restAfter, restBefore)
  assert.equal(JSON.stringify(before.last), JSON.stringify(T0 + 9100))
})

// 上面那次 probe 之后单独构造一份终态用于数值断言（避免把 probe 的影响混进来）。
let final = createSessionState(HEADER)
for (const [event] of STREAM) final = applySessionEvent(final, event)

check('计数：turns / steps / msgs / toolCalls / toolErrors / compactions / retries', () => {
  assert.equal(final.turns, 2)
  assert.equal(final.steps, 2)
  assert.equal(final.msgs, 2)
  assert.equal(final.toolCalls, 3)
  assert.equal(final.toolErrors, 1)
  assert.equal(final.compactions, 1)
  assert.equal(final.retries, 1)
})

check('时间：first / last / apiMs / activeMs（重复 step/end 不重复计时）', () => {
  assert.equal(final.first, T0)
  assert.equal(final.last, T0 + 9100)
  assert.equal(final.apiMs, 3000) // step/start +3000 → step/end +6000
  assert.equal(final.activeMs, 5000) // turn/start +2000 → turn/end +7000
})

check('游标在结算后清空', () => {
  assert.equal(final.openStepStart, null)
  assert.equal(final.openStepTurn, null)
  assert.equal(final.openTurnStart, null)
})

check('lines：write(3 行) + edit(new 1 行 / old 2 行)', () => {
  assert.deepEqual(final.lines, [4, 2])
})

check('outcomes：completed 1 + max-tokens → maxTokens 1，其余 0', () => {
  assert.deepEqual(final.outcomes, {
    completed: 1,
    aborted: 0,
    blocked: 0,
    error: 0,
    maxTokens: 1,
    interrupted: 0,
    forked: 0,
  })
})

check('models：四桶 + reasoning 与调用数', () => {
  assert.deepEqual(final.models, { m1: { p: 'p1', i: 100, o: 50, cr: 200, cw: 30, r: 7, n: 1 } })
  const entry = final.models.m1
  assert.equal(entry.i + entry.o + entry.cr + entry.cw, 380) // tokens.total 口径
})

check('tools：按名字计数', () => {
  assert.deepEqual(final.tools, { read: 1, write: 1, edit: 1 })
})

check('days：当日 m=2 / tc=3 / tok[m1]=380', () => {
  assert.deepEqual(final.days, { [DAY]: { m: 2, tc: 3, tok: { m1: 380 } } })
})

check('hours：user 1 + tool/call 3 + assistant 1 = 5，全部落在同一本地小时', () => {
  assert.equal(final.hours.length, 24)
  assert.equal(final.hours.reduce((a, b) => a + b, 0), 5)
  assert.equal(final.hours[HOUR], 5)
})

check('title：取最后一条非空标题并 trim', () => {
  assert.equal(final.title, 'hello')
  const later = applySessionEvent(final, { type: 'session/title', time: T0 + 9200, data: { title: ' second ' } })
  assert.equal(later.title, 'second')
  assert.equal(final.title, 'hello')
})

// --------------------------------------------- 3. 写时复制：桶是新的引用

check('写时复制：被改的桶逐层是新引用', () => {
  const before = createSessionState(HEADER)
  const message = { type: 'user/message', time: T0 + 1000, data: {} }
  const after = applySessionEvent(before, message)
  assert.notEqual(after.days, before.days)
  assert.notEqual(after.days[DAY], before.days[DAY])
  assert.notEqual(after.hours, before.hours)
  // 未涉及的桶保持共享（结构共享，不是无脑深拷贝）。
  assert.equal(after.models, before.models)
  assert.equal(after.tools, before.tools)
  assert.equal(after.lines, before.lines)
  assert.equal(after.outcomes, before.outcomes)

  const toolAfter = applySessionEvent(before, { type: 'tool/call', time: T0 + 1000, data: { name: 'read', arguments: '{}' } })
  assert.notEqual(toolAfter.tools, before.tools)
  assert.deepEqual(before.tools, {})
  assert.deepEqual(toolAfter.tools, { read: 1 })
  assert.equal(toolAfter.models, before.models)

  const writeAfter = applySessionEvent(before, { type: 'tool/call', time: T0 + 1000, data: { name: 'write', arguments: '{"content":"x"}' } })
  assert.notEqual(writeAfter.lines, before.lines)
  assert.deepEqual(before.lines, [0, 0])
  assert.deepEqual(writeAfter.lines, [1, 0])

  const turnAfter = applySessionEvent(before, { type: 'turn/end', time: T0 + 1000, data: { reason: { kind: 'blocked' } } })
  assert.notEqual(turnAfter.outcomes, before.outcomes)
  assert.deepEqual(before.outcomes, { completed: 0, aborted: 0, blocked: 0, error: 0, maxTokens: 0, interrupted: 0, forked: 0 })
  assert.equal(turnAfter.outcomes.blocked, 1)

  const modelEvent = {
    type: 'assistant/message',
    time: T0 + 1000,
    data: { usage: { inputTokens: 1 }, message: { source: { model: 'm2', provider: 'p2' } } },
  }
  const modelAfter = applySessionEvent(before, modelEvent)
  assert.notEqual(modelAfter.models, before.models)
  assert.equal(before.models.m2, undefined)
  assert.deepEqual(modelAfter.models.m2, { p: 'p2', i: 1, o: 0, cr: 0, cw: 0, r: 0, n: 1 })
  assert.notEqual(modelAfter.days, before.days)
  assert.deepEqual(before.days, {})
})

check('未知 outcome kind 不写进 state（strict schema 安全）', () => {
  const before = createSessionState(HEADER)
  const after = applySessionEvent(before, { type: 'turn/end', time: T0 + 1000, data: { reason: { kind: 'brand-new-kind' } } })
  assert.deepEqual(Object.keys(after.outcomes).sort(), OUTCOME_KEYS)
  assert.equal(after.turns, 1)
})

check('无 usage / model=unknown 的 assistant/message 只计 msgs 与天/小时桶', () => {
  const before = createSessionState(HEADER)
  const after = applySessionEvent(before, {
    type: 'assistant/message',
    time: T0 + 1000,
    data: { usage: { inputTokens: 9 }, message: { source: { model: 'unknown' } } },
  })
  assert.equal(after.msgs, 1)
  assert.deepEqual(after.models, {})
  assert.deepEqual(after.days, { [DAY]: { m: 1, tc: 0, tok: {} } })
  assert.deepEqual(before.models, {})
})

check('days 桶按天累积且不互相污染', () => {
  let s = createSessionState(HEADER)
  s = applySessionEvent(s, { type: 'user/message', time: T0, data: {} })
  s = applySessionEvent(s, { type: 'user/message', time: T0 + 86400000, data: {} })
  assert.equal(Object.keys(s.days).length, 2)
  assert.equal(s.days[dateKeyOf(T0)].m, 1)
  assert.equal(s.days[dateKeyOf(T0 + 86400000)].m, 1)
})

check('重放同一事件流两次得到相同 JSON（折叠确定性）', () => {
  const a = STREAM.reduce((acc, [event]) => applySessionEvent(acc, event), createSessionState(HEADER))
  const b = STREAM.reduce((acc, [event]) => applySessionEvent(acc, event), createSessionState(HEADER))
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

console.log(`\nfold-purity: ${checks} 项断言全部通过`)
