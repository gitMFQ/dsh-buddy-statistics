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
 *
 * 折叠语义本身在 lib/fold.js（`createSessionState` / `applySessionEvent`）：
 * 纯函数、写时复制，会话视图投影与全局页共用同一份实现。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { CACHE_VERSION, applySessionEvent, createSessionState, dateKeyOf } from './fold.js'

// 旧的本地导出 createState / foldEvent 已由 fold.js 的
// createSessionState / applySessionEvent 取代；这里保留采集层原有的导出面。
export { CACHE_VERSION, dateKeyOf }

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
    const cached = memo.get(id) || (disk.entries[id] ? { ...disk.entries[id] } : null)

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
      let state = cached && cached.state ? cached.state : createSessionState(header)
      // 从上次读完的位置继续；首次只从继承切点开始（跳过 fork 复制进来的父事件）。
      const from = Math.max(inherited, cached && typeof cached.coveredThrough === 'number' ? cached.coveredThrough + 1 : 0)
      const result = await handle.read(from)
      const events = (result && result.events) || []
      // 折叠是纯函数：每次都返回状态（未关心的事件返回同一引用），必须接住返回值。
      for (const event of events) {
        if (Number(event.seq) < inherited) continue
        state = applySessionEvent(state, event)
      }
      // header 里的身份字段可能比缓存新（例如标题/工作目录），折叠后再覆盖一次；
      // 写时复制，不改动任何被共享的旧对象。
      state = {
        ...state,
        id,
        createdAt: state.createdAt || Number(header.createdAt) || 0,
        cwd: header.cwd || state.cwd,
        parent: header.parentSession || state.parent,
        origin: header.origin || state.origin,
        preset: header.agentPreset || state.preset,
      }

      const coveredThrough =
        events.length > 0 ? Number(events[events.length - 1].seq) : (cached && cached.coveredThrough) || inherited - 1
      const entry = {
        state,
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
