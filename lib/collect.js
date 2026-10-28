/**
 * 会话采集层：把 DSH 的持久化会话折叠成「每个会话一份紧凑摘要」。
 *
 * 走的是受支持的通道 `ctx.sessionPersistence`：
 * - `list()` 只读 header 帧，拿到每个会话的 `revision` / `eventCount`；
 * - 只对变化的会话 `open(id, 'read')`，并从上次读完的位置 `read(from)` 读增量；
 * - 从 `handle.inheritedEventCount` 开始读，天然跳过 fork / seed 复制进来的父事件。
 *
 * 为什么必须这样：直接扫 `$DSH_HOME/sessions/**` 会把被 fork 会话里复制的
 * 父会话事件重复计入（本机 8989 条），Token 直接翻倍；而且日志格式、分帧、
 * 版本迁移都属于后端内部实现。
 *
 * 摘要按 (sessionId, eventCount) 做内存 + 磁盘两级缓存，稳态刷新只读各会话尾部。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** 缓存结构版本：折叠语义变化时必须 +1。 */
export const CACHE_VERSION = 5

/** 数一段文本的行数（空串记为 0）。 */
function countLines(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/** 本地日期键。 */
export function dateKeyOf(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return null
  const d = new Date(n)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 一天桶：m=消息数、tc=工具调用数、tok=当日各模型 Token。 */
function dayBucket(state, key) {
  let day = state.days[key]
  if (!day) day = state.days[key] = { m: 0, tc: 0, tok: {} }
  return day
}

/** 新的空摘要。短字段名是为了让磁盘缓存更小。 */
export function createState(header = {}) {
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
    apiMs: 0,
    activeMs: 0,
    turns: 0,
    msgs: 0,
    toolCalls: 0,
    toolErrors: 0,
    lines: [0, 0],
    tools: {},
    models: {},
    days: {},
    hours: new Array(24).fill(0),
  }
}

/**
 * 把一个会话事件折叠进摘要。纯函数式更新：只改 state，不读外部。
 * @param {object} state createState() 的结果
 * @param {object} event 会话事件 {type, seq, time, data}
 * @param {Map<string, number>} stepStarts step 起始时间表（跨事件共享）
 */
export function foldEvent(state, event, stepStarts) {
  if (!event || typeof event.type !== 'string') return
  const data = event.data || {}
  const time = Number(event.time) || 0
  if (time > 0) {
    if (!state.first || time < state.first) state.first = time
    if (time > state.last) state.last = time
  }
  const key = dateKeyOf(time)
  const hour = time > 0 ? new Date(time).getHours() : -1

  switch (event.type) {
    case 'assistant/message': {
      state.msgs++
      if (key) dayBucket(state, key).m++
      if (hour >= 0 && hour < 24) state.hours[hour]++
      const usage = data.usage
      const source = data.message && data.message.source
      const model = source && typeof source.model === 'string' ? source.model : null
      if (usage && model && model !== 'unknown') {
        const input = Number(usage.inputTokens) || 0
        const output = Number(usage.outputTokens) || 0
        const cacheRead = Number(usage.cacheReadTokens) || 0
        const cacheWrite = Number(usage.cacheWriteTokens) || 0
        const entry =
          state.models[model] || (state.models[model] = { p: source.provider || null, i: 0, o: 0, cr: 0, cw: 0, r: 0, n: 0 })
        if (!entry.p && source && source.provider) entry.p = source.provider
        entry.i += input
        entry.o += output
        entry.cr += cacheRead
        entry.cw += cacheWrite
        entry.r += Number(usage.reasoningTokens) || 0
        entry.n++
        // 每日 Token 与「总 Token」用同一含缓存口径（DSH 的 inputTokens 是净输入）。
        const total = input + output + cacheRead + cacheWrite
        if (key && total > 0) {
          const tok = dayBucket(state, key).tok
          tok[model] = (tok[model] || 0) + total
        }
      }
      break
    }
    case 'user/message': {
      state.msgs++
      if (key) dayBucket(state, key).m++
      if (hour >= 0 && hour < 24) state.hours[hour]++
      break
    }
    case 'tool/call': {
      state.toolCalls++
      if (key) dayBucket(state, key).tc++
      if (hour >= 0 && hour < 24) state.hours[hour]++
      const name = typeof data.name === 'string' ? data.name : ''
      if (name) {
        state.tools[name] = (state.tools[name] || 0) + 1
        // 只有写文件类工具解析参数，其余不碰参数体。
        if (name === 'write' || name === 'edit') {
          try {
            const args = JSON.parse(data.arguments)
            if (name === 'write') {
              state.lines[0] += countLines(args.content)
            } else {
              state.lines[0] += countLines(args.new_string)
              state.lines[1] += countLines(args.old_string)
            }
          } catch {
            /* 参数不是 JSON 就跳过行数统计 */
          }
        }
      }
      break
    }
    case 'tool/result': {
      if (data.message && data.message.isError) state.toolErrors++
      break
    }
    case 'turn/start': {
      if (stepStarts) stepStarts.set(`turn:${data.turn}`, time)
      break
    }
    case 'step/start': {
      if (stepStarts) stepStarts.set(`${data.turn}:${data.step}`, time)
      break
    }
    case 'step/end': {
      const started = stepStarts ? stepStarts.get(`${data.turn}:${data.step}`) : undefined
      if (started && time > started) state.apiMs += time - started
      break
    }
    case 'turn/end': {
      state.turns++
      // 回合内时长 = 真正在干活的时间，剔除会话闲置间隔（会话可能跨天挂着）。
      const started = stepStarts ? stepStarts.get(`turn:${data.turn}`) : undefined
      if (started && time > started) state.activeMs += time - started
      break
    }
    case 'session/title': {
      if (typeof data.title === 'string' && data.title.trim()) state.title = data.title.trim()
      break
    }
    default:
      break
  }
}

function readCacheFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw && raw.version === CACHE_VERSION && raw.entries && typeof raw.entries === 'object') return raw
  } catch {
    /* 无缓存或缓存损坏：重新采集 */
  }
  return { version: CACHE_VERSION, entries: {} }
}

async function writeCacheFile(file, payload) {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8')
    await fsp.rename(tmp, file)
  } catch {
    /* 缓存写失败不影响统计 */
  }
}

/**
 * 采集所有会话摘要（增量）。
 *
 * @param {object} options
 * @param {object} options.persistence ctx.sessionPersistence
 * @param {string|null} [options.cacheFile] 磁盘缓存文件；null = 不落盘
 * @param {Map<string, object>} [options.memo] 进程内缓存（由调用方持有，跨刷新复用）
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{summaries: object[], meta: object}>}
 */
export async function collectSummaries(options) {
  const startedAt = Date.now()
  const persistence = options.persistence
  if (!persistence) throw new Error('sessionPersistence 不可用')
  const memo = options.memo instanceof Map ? options.memo : new Map()
  const cacheFile = options.cacheFile || null
  const disk = cacheFile ? readCacheFile(cacheFile) : { version: CACHE_VERSION, entries: {} }

  const snapshots = await persistence.list(options.signal ? { signal: options.signal } : undefined)
  const summaries = []
  let opened = 0
  let reused = 0
  let eventsRead = 0
  let failed = 0
  let mutated = false

  for (const snapshot of snapshots) {
    const header = snapshot.header || {}
    const id = header.id
    if (!id) continue
    const eventCount = typeof snapshot.eventCount === 'number' ? snapshot.eventCount : null
    const cached = memo.get(id) || (disk.entries[id] ? { ...disk.entries[id], stepStarts: new Map() } : null)

    // 未变化：直接复用（eventCount 单调，跨进程重启也成立）。
    const unchanged =
      cached &&
      cached.state &&
      ((eventCount !== null && cached.eventCount === eventCount) ||
        (eventCount === null && cached.revision === snapshot.revision))
    if (unchanged) {
      summaries.push(cached.state)
      memo.set(id, cached)
      reused++
      continue
    }

    let handle
    try {
      handle = await persistence.open(id, 'read', options.signal ? { signal: options.signal } : undefined)
      const inherited = Number(handle.inheritedEventCount) || 0
      const state = cached && cached.state ? cached.state : createState(header)
      const stepStarts = cached && cached.stepStarts ? cached.stepStarts : new Map()
      // 从上次读完的位置继续；首次只从继承切点开始（跳过 fork 复制进来的父事件）。
      const from = Math.max(inherited, cached && typeof cached.coveredThrough === 'number' ? cached.coveredThrough + 1 : 0)
      const result = await handle.read(from)
      const events = (result && result.events) || []
      for (const event of events) {
        if (Number(event.seq) < inherited) continue
        foldEvent(state, event, stepStarts)
      }
      state.id = id
      if (!state.createdAt) state.createdAt = Number(header.createdAt) || 0
      state.cwd = header.cwd || state.cwd
      state.parent = header.parentSession || state.parent
      state.origin = header.origin || state.origin
      state.preset = header.agentPreset || state.preset

      const coveredThrough =
        events.length > 0 ? Number(events[events.length - 1].seq) : (cached && cached.coveredThrough) || inherited - 1
      const entry = {
        state,
        stepStarts,
        eventCount,
        revision: snapshot.revision,
        coveredThrough,
      }
      memo.set(id, entry)
      disk.entries[id] = { state, eventCount, revision: snapshot.revision, coveredThrough }
      summaries.push(state)
      opened++
      eventsRead += events.length
      mutated = true
    } catch {
      failed++
      if (cached && cached.state) summaries.push(cached.state)
    } finally {
      if (handle && typeof handle.close === 'function') {
        try {
          await handle.close()
        } catch {
          /* 关闭失败不影响统计 */
        }
      }
    }
  }

  // 丢掉已经不存在的会话。
  const alive = new Set(snapshots.map((s) => s.header && s.header.id).filter(Boolean))
  for (const key of Object.keys(disk.entries)) {
    if (!alive.has(key)) {
      delete disk.entries[key]
      mutated = true
    }
  }
  for (const key of Array.from(memo.keys())) {
    if (!alive.has(key)) memo.delete(key)
  }
  if (cacheFile && mutated) await writeCacheFile(cacheFile, { version: CACHE_VERSION, entries: disk.entries })

  return {
    summaries,
    meta: {
      files: snapshots.length,
      opened,
      reused,
      failed,
      eventsRead,
      tookMs: Date.now() - startedAt,
    },
  }
}

/** 清空磁盘缓存并重置调用方传入的 memo。 */
export async function resetCache(cacheFile, memo) {
  if (memo instanceof Map) memo.clear()
  if (cacheFile) {
    try {
      await fsp.rm(cacheFile, { force: true })
    } catch {
      /* 忽略 */
    }
  }
}
