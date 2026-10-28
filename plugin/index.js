/**
 * dsh-buddy-statistics —— 宿主半边。
 *
 * 职责：把本机 DSH 会话折叠成统计结果，并通过一条同源 JSON 路由交给页面。
 * 页面（client.js）不读文件、不算数，只渲染。
 *
 * 路由：GET /buddy-stats/data[?refresh=1]
 *   - 默认走 20s 内存缓存；refresh=1 强制重新聚合（仍复用增量会话缓存）。
 *
 * 数据来源：`ctx.sessionPersistence`（受支持的持久化会话读取通道）。
 * 只读，不写任何会话数据。
 */

import os from 'node:os'
import path from 'node:path'

import { aggregate } from './lib/aggregate.js'
import { collectSummaries } from './lib/collect.js'

export const name = 'buddy-stats'

/** 路由前缀与 package.json 里的插件 id 一致，便于排查。 */
export const ROUTE_PREFIX = '/buddy-stats'
export const ROUTES = { data: `${ROUTE_PREFIX}/data` }

/** 默认配置；行 config 里的同名字段覆盖。 */
function normalize(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return {
    cacheFile:
      raw.cacheFile === null
        ? null
        : typeof raw.cacheFile === 'string' && raw.cacheFile.trim() !== ''
          ? raw.cacheFile
          : path.join(dshHome, 'buddy-statistics', 'sessions-cache.json'),
    ttlMs: Number.isFinite(Number(raw.ttlMs)) && Number(raw.ttlMs) >= 0 ? Number(raw.ttlMs) : 20000,
    // 启动后预热统计（首次冷启动要遍历全部会话，预热能让第一次打开页面就有数据）。
    warmupDelayMs:
      raw.warmupDelayMs === null
        ? 0
        : Number.isFinite(Number(raw.warmupDelayMs)) && Number(raw.warmupDelayMs) >= 0
          ? Number(raw.warmupDelayMs)
          : 5000,
    pricing: raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : null,
  }
}

/** 同源校验：只接受来自本页面的请求。 */
function trusted(req) {
  const headers = (req && req.headers) || {}
  const origin = headers.origin
  if (origin === undefined) return true
  const allowed = new Set()
  for (const rawHost of [headers.host, headers['x-forwarded-host']]) {
    if (typeof rawHost !== 'string') continue
    const host = rawHost.split(',')[0].trim()
    if (host !== '') allowed.add(host)
  }
  if (allowed.size === 0) return false
  try {
    return allowed.has(new URL(origin).host)
  } catch {
    return false
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

export function apply(ctx, config) {
  const options = normalize(config)
  /** 进程内会话摘要缓存：跨刷新复用，只有事件增长时才读增量。 */
  const memo = new Map()
  let cached = null // { at, stats, meta }
  let inflight = null

  /** 采集并聚合；并发调用共享同一次工作。 */
  function build(persistence, force) {
    if (!force && cached && Date.now() - cached.at < options.ttlMs) {
      return Promise.resolve({ ...cached, hit: true })
    }
    if (inflight) return inflight
    inflight = (async () => {
      const collected = await collectSummaries({
        persistence,
        cacheFile: options.cacheFile,
        memo,
      })
      const stats = aggregate(collected.summaries, { pricing: options.pricing })
      const result = {
        at: Date.now(),
        stats,
        meta: {
          ...collected.meta,
          pricing: options.pricing ? Object.keys(options.pricing).length : 0,
        },
      }
      cached = result
      return { ...result, hit: false }
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  ctx.inject(['webServer', 'sessionPersistence'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: ROUTES.data,
          handler: async (req, res) => {
            if (!trusted(req)) {
              sendJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            let query = ''
            try {
              query = new URL(req.url || '/', 'http://localhost').search
            } catch {
              query = ''
            }
            const force = /[?&]refresh=1(&|$)/.test(query)
            try {
              const result = await build(webCtx.sessionPersistence, force)
              if (req.method === 'HEAD') {
                res.writeHead(200, { 'cache-control': 'no-store' })
                res.end()
                return
              }
              sendJson(res, 200, {
                ok: true,
                stats: result.stats,
                meta: { ...result.meta, cacheHit: result.hit, generatedAt: result.at },
              })
            } catch (error) {
              sendJson(res, 500, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          },
        }),
      'buddy-stats: data route',
    )

    if (options.warmupDelayMs > 0) {
      webCtx.effect(
        () => {
          const timer = setTimeout(() => {
            void build(webCtx.sessionPersistence, true).catch(() => {
              /* 预热失败不影响之后的手动刷新 */
            })
          }, options.warmupDelayMs)
          return () => clearTimeout(timer)
        },
        'buddy-stats: warmup',
      )
    }
  })

  // 会话事件到达时让内存结果过期：正在使用的会话不必等 TTL 也能刷新。
  ctx.effect(
    () =>
      ctx.on('session/event', () => {
        if (cached) cached = { ...cached, at: 0 }
      }),
    'buddy-stats: cache invalidation',
  )
}
