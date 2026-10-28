/**
 * 离线自检：不依赖 DSH 运行时，直接从持久化日志解析事件，
 * 用与插件相同的 foldEvent / aggregate 折叠，打印统计值。
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
import { createState, foldEvent } from '../lib/collect.js'

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
    const state = createState(header)
    const stepStarts = new Map()
    for (const event of events) foldEvent(state, event, stepStarts)
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
