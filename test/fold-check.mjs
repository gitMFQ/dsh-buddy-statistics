/**
 * 离线自检：不依赖 DSH 运行时，直接从持久化日志解析事件，
 * 用与插件相同的 applySessionEvent / aggregate 折叠，打印统计值。
 *
 * 局限：离线拿不到 inheritedEventCount，所以只统计**根会话**
 * （根会话没有继承事件，数字可直接对照宿主的 rootOnly 口径）。
 *
 * 开发机上若存在 ../ref/verify-stats.output.json（基线），会额外打印差值。
 *
 * 用法：node test/fold-check.mjs [sessionRoot]
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { aggregate } from '../lib/aggregate.js'
import { applySessionEvent, createSessionState } from '../lib/fold.js'

const ROOT = process.argv[2] || path.join(process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh'), 'sessions')

/** 可选基线：开发机上 ref/verify-stats.output.json 的 rootOnly 段。 */
function readBaseline() {
  try {
    const file = path.join(import.meta.dirname, '..', 'ref', 'verify-stats.output.json')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const root = parsed && parsed.rootOnly
    if (!root) return null
    return {
      sessions: root.sessions,
      toolCalls: root.messages && root.messages.toolCalls,
      tokensTotal: root.tokens && root.tokens.total,
    }
  } catch {
    return null
  }
}

function readEvents(file) {
  const bytes = fs.readFileSync(file)
  const text = file.endsWith('.zstd') ? zlib.zstdDecompressSync(bytes).toString('utf8') : bytes.toString('utf8')
  const events = []
  let header = null
  for (const line of text.split('\n')) {
    if (line.length < 8) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed.type === 'session') header = parsed
    else events.push(parsed)
  }
  return { header, events }
}

const summaries = []
let files = 0
for (const project of fs.readdirSync(ROOT)) {
  const projectDir = path.join(ROOT, project)
  if (!fs.statSync(projectDir).isDirectory()) continue
  for (const session of fs.readdirSync(projectDir)) {
    const dir = path.join(projectDir, session)
    if (!fs.statSync(dir).isDirectory()) continue
    const candidate = fs
      .readdirSync(dir)
      .filter((name) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name))
      .sort()
      .pop()
    if (!candidate) continue
    files++
    const { header, events } = readEvents(path.join(dir, candidate))
    if (!header) continue
    // 只跑根会话：子代理与 fork 子会话有继承事件，离线无法判定切点。
    if (header.origin === 'subagent' || header.parentSession) continue
    // 折叠是纯函数：每次返回新 state（未关心的事件返回同一引用），必须接住返回值。
    let state = createSessionState(header)
    for (const event of events) state = applySessionEvent(state, event)
    summaries.push(state)
  }
}

const stats = aggregate(summaries)
const baseline = readBaseline()
const delta = (value, reference) =>
  baseline && typeof reference === 'number' ? `  (baseline ${reference}, delta ${value - reference})` : ''
console.log('files scanned       :', files)
console.log('root sessions       :', stats.totalSessions, delta(stats.totalSessions, baseline && baseline.sessions))
console.log('messages (root)     :', stats.totalMessages)
console.log('tool calls (root)   :', stats.totalToolCalls, delta(stats.totalToolCalls, baseline && baseline.toolCalls))
console.log('tokens total        :', stats.tokens.total, delta(stats.tokens.total, baseline && baseline.tokensTotal))
console.log('  input / output    :', stats.tokens.input, '/', stats.tokens.output)
console.log('  cacheRead / write :', stats.tokens.cacheRead, '/', stats.tokens.cacheWrite)
console.log('activeDays / span   :', stats.activeDays, '/', stats.totalDays)
console.log('streaks             :', stats.streaks)
console.log('peak hour / day     :', stats.peakActivityHour, '/', stats.peakActivityDay)
console.log('models              :', Object.keys(stats.modelUsage).length)
console.log('top tools           :', stats.toolUsage.slice(0, 6))
console.log('longest session     :', stats.longestSession && Math.round(stats.longestSession.duration / 1000) + 's', 'msgs', stats.longestSession && stats.longestSession.messageCount)

// 新增计数器（契约 §4 新增行）的离线真值，便于人工核对：
// turns/steps/apiMs/activeMs/compactions/retries/outcomes/toolErrors 只能这么看。
const newCounters = summaries.reduce(
  (acc, s) => {
    acc.turns += s.turns || 0
    acc.steps += s.steps || 0
    acc.apiMs += s.apiMs || 0
    acc.activeMs += s.activeMs || 0
    acc.compactions += s.compactions || 0
    acc.retries += s.retries || 0
    acc.toolErrors += s.toolErrors || 0
    for (const [kind, n] of Object.entries(s.outcomes || {})) acc.outcomes[kind] = (acc.outcomes[kind] || 0) + n
    return acc
  },
  { turns: 0, steps: 0, apiMs: 0, activeMs: 0, compactions: 0, retries: 0, toolErrors: 0, outcomes: {} },
)
console.log('turns / steps       :', newCounters.turns, '/', newCounters.steps)
console.log('apiMs / activeMs    :', Math.round(newCounters.apiMs / 1000) + 's', '/', Math.round(newCounters.activeMs / 1000) + 's')
console.log('compactions / retries:', newCounters.compactions, '/', newCounters.retries)
console.log('toolErrors          :', newCounters.toolErrors)
console.log('outcomes            :', newCounters.outcomes)
