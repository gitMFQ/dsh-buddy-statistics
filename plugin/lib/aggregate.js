/**
 * 纯函数聚合层：把「每个会话的紧凑摘要」折叠成统计页需要的全局统计。
 *
 * 设计原则：
 * - 与数据来源解耦（摘要由 lib/collect.js 从会话日志里抽取），本文件不读文件、不碰 ctx；
 * - 口径对齐 CodeBuddy Code 的 StatsService.calculateStats()：
 *   根会话（非子代理）参与会话数/消息数/活跃天数/连续天数/工具调用/高峰时段，
 *   Token 用量则统计全部会话（含子代理），与 CBC 一致。
 *
 * 与 CBC 的差异（有意为之，见 README）：
 * - 缓存命中率分母用 input + cacheRead + cacheWrite，因为 DSH 的 inputTokens 不含缓存读取；
 * - 成本只有在配置了单价时才有值，DSH 会话日志里没有金额字段。
 */

/** 一天的毫秒数。 */
const DAY_MS = 86400000

/** 日期键（本地时区），与 CBC 的 getDateFromTimestamp 一致。 */
export function dateKey(ms) {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 空统计结构（无任何会话时使用）。 */
export function emptyStats() {
  return {
    totalSessions: 0,
    totalSubagentSessions: 0,
    totalMessages: 0,
    totalToolCalls: 0,
    totalDays: 0,
    activeDays: 0,
    workspaces: 0,
    streaks: {
      currentStreak: 0,
      longestStreak: 0,
      currentStreakStart: null,
      longestStreakStart: null,
      longestStreakEnd: null,
    },
    dailyActivity: [],
    dailyModelTokens: [],
    toolUsage: [],
    longestSession: null,
    averageSessionDuration: 0,
    modelUsage: {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
    firstSessionDate: null,
    lastSessionDate: null,
    peakActivityDay: null,
    peakActivityHour: null,
    latestSession: null,
    generatedAt: Date.now(),
    scannedSessions: 0,
  }
}

/**
 * 计算连续天数。移植自 CBC 的 calculateStreaks：
 * 当前连续从今天往前数（今天没有活动就是 0），最长连续遍历全部日期。
 */
export function calculateStreaks(dates) {
  if (dates.size === 0) {
    return {
      currentStreak: 0,
      longestStreak: 0,
      currentStreakStart: null,
      longestStreakStart: null,
      longestStreakEnd: null,
    }
  }
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  let currentStreak = 0
  let currentStreakStart = null
  const cursor = new Date(today)
  for (;;) {
    const key = dateKey(cursor.getTime())
    if (!dates.has(key)) break
    currentStreak++
    currentStreakStart = key
    cursor.setDate(cursor.getDate() - 1)
  }

  let longestStreak = 0
  let longestStreakStart = null
  let longestStreakEnd = null
  const sorted = Array.from(dates).sort()
  let run = 1
  let runStart = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    const gap = Math.round((new Date(sorted[i]).getTime() - new Date(sorted[i - 1]).getTime()) / DAY_MS)
    if (gap === 1) {
      run++
    } else {
      if (run > longestStreak) {
        longestStreak = run
        longestStreakStart = runStart
        longestStreakEnd = sorted[i - 1]
      }
      run = 1
      runStart = sorted[i]
    }
  }
  if (run > longestStreak) {
    longestStreak = run
    longestStreakStart = runStart
    longestStreakEnd = sorted[sorted.length - 1]
  }
  return { currentStreak, longestStreak, currentStreakStart, longestStreakStart, longestStreakEnd }
}

/** 是否为根会话（非子代理）。 */
export function isRootSession(summary) {
  return !(summary.origin === 'subagent' || summary.parent)
}

/**
 * 把会话摘要数组折叠成全局统计。
 * @param {Array<object>} summaries lib/collect.js 产出的会话摘要
 * @param {{ pricing?: Record<string, {input?: number, output?: number, cacheRead?: number, cacheWrite?: number}> }} [options]
 *        pricing：每百万 Token 的单价（美元），键为模型 id；缺省时不计成本。
 */
export function aggregate(summaries, options = {}) {
  const stats = emptyStats()
  if (!Array.isArray(summaries) || summaries.length === 0) return stats

  const pricing = options.pricing && typeof options.pricing === 'object' ? options.pricing : null
  const byDate = new Map() // date -> { date, messageCount, sessionCount, toolCallCount }
  const tokensByDate = new Map() // date -> { date, tokensByModel }
  const toolTotals = new Map() // name -> count
  const modelUsage = {} // model -> { inputTokens, outputTokens, ... }
  const hourCounts = new Array(24).fill(0)
  const activeDates = new Set()
  const workspaces = new Set()
  const sessions = [] // 根会话的时长信息

  let totalMessages = 0
  let totalToolCalls = 0
  let minorFirst = Infinity
  let majorLast = 0
  let latest = null

  for (const s of summaries) {
    const root = isRootSession(s)
    const first = Number(s.first) || Number(s.createdAt) || 0
    const last = Number(s.last) || first

    // Token 用量：全部会话（含子代理），与 CBC 一致。
    for (const [model, u] of Object.entries(s.models || {})) {
      if (!model || model === 'unknown') continue
      let entry = modelUsage[model]
      if (!entry) {
        entry = modelUsage[model] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningTokens: 0,
          requests: 0,
          providers: [],
          costUSD: 0,
        }
      }
      entry.inputTokens += u.i || 0
      entry.outputTokens += u.o || 0
      entry.cacheReadInputTokens += u.cr || 0
      entry.cacheCreationInputTokens += u.cw || 0
      entry.reasoningTokens += u.r || 0
      entry.requests += u.n || 0
      if (u.p && !entry.providers.includes(u.p)) entry.providers.push(u.p)
    }

    // 按天 Token 趋势：全部会话。
    for (const [date, day] of Object.entries(s.days || {})) {
      const tokens = day.tok || {}
      let has = false
      for (const n of Object.values(tokens)) if (n > 0) has = true
      if (!has) continue
      let bucket = tokensByDate.get(date)
      if (!bucket) {
        bucket = { date, tokensByModel: {} }
        tokensByDate.set(date, bucket)
      }
      for (const [model, n] of Object.entries(tokens)) {
        if (!n) continue
        bucket.tokensByModel[model] = (bucket.tokensByModel[model] || 0) + n
      }
    }

    if (!root) {
      stats.totalSubagentSessions++
      continue
    }

    // 以下全部只统计根会话（CBC 的 !isSubAgent 分支）。
    stats.totalSessions++
    sessions.push({
      sessionId: s.id,
      title: s.title || null,
      createdAt: first,
      lastAt: last,
      duration: Math.max(0, Number(s.activeMs) || 0),
      wallMs: Math.max(0, last - first),
      messageCount: s.msgs || 0,
      toolCalls: s.toolCalls || 0,
      apiMs: s.apiMs || 0,
      linesAdded: s.lines ? s.lines[0] : 0,
      linesDeleted: s.lines ? s.lines[1] : 0,
      models: s.models || {},
      cwd: s.cwd || null,
      origin: s.origin || null,
    })
    totalMessages += s.msgs || 0
    totalToolCalls += s.toolCalls || 0
    if (s.cwd) workspaces.add(s.cwd)
    if (first > 0) {
      if (first < minorFirst) minorFirst = first
      const key = dateKey(first)
      let day = byDate.get(key)
      if (!day) {
        day = { date: key, messageCount: 0, sessionCount: 0, toolCallCount: 0 }
        byDate.set(key, day)
      }
      day.sessionCount++
      activeDates.add(key)
    }
    if (last > majorLast) majorLast = last
    if (!latest || last > latest.lastAt) latest = sessions[sessions.length - 1]

    for (const [date, day] of Object.entries(s.days || {})) {
      let bucket = byDate.get(date)
      if (!bucket) {
        bucket = { date, messageCount: 0, sessionCount: 0, toolCallCount: 0 }
        byDate.set(date, bucket)
      }
      bucket.messageCount += day.m || 0
      bucket.toolCallCount += day.tc || 0
      if ((day.m || 0) > 0 || (day.tc || 0) > 0) activeDates.add(date)
    }
    for (let h = 0; h < 24; h++) hourCounts[h] += (s.hours && s.hours[h]) || 0
    for (const [name, count] of Object.entries(s.tools || {})) {
      toolTotals.set(name, (toolTotals.get(name) || 0) + count)
    }
  }

  // 模型汇总
  for (const [model, entry] of Object.entries(modelUsage)) {
    // 总 Token 用「含缓存」口径：DSH 的 inputTokens 是净输入，缓存读取单独统计。
    const total =
      entry.inputTokens + entry.outputTokens + entry.cacheReadInputTokens + entry.cacheCreationInputTokens
    const denom = entry.inputTokens + entry.cacheReadInputTokens + entry.cacheCreationInputTokens
    entry.totalTokens = total
    entry.cacheHitRate = denom > 0 ? (entry.cacheReadInputTokens / denom) * 100 : 0
    if (pricing && pricing[model]) {
      const p = pricing[model]
      entry.costUSD =
        (entry.inputTokens / 1e6) * (p.input || 0) +
        (entry.outputTokens / 1e6) * (p.output || 0) +
        (entry.cacheReadInputTokens / 1e6) * (p.cacheRead || 0) +
        (entry.cacheCreationInputTokens / 1e6) * (p.cacheWrite || 0)
    }
    stats.tokens.input += entry.inputTokens
    stats.tokens.output += entry.outputTokens
    stats.tokens.cacheRead += entry.cacheReadInputTokens
    stats.tokens.cacheWrite += entry.cacheCreationInputTokens
    stats.tokens.reasoning += entry.reasoningTokens
  }
  stats.tokens.total =
    stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite
  stats.modelUsage = modelUsage
  stats.totalMessages = totalMessages
  stats.totalToolCalls = totalToolCalls
  stats.workspaces = workspaces.size

  stats.dailyActivity = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
  stats.dailyModelTokens = Array.from(tokensByDate.values()).sort((a, b) => a.date.localeCompare(b.date))
  stats.toolUsage = Array.from(toolTotals.entries())
    .map(([toolName, count]) => ({ toolName, count }))
    .sort((a, b) => b.count - a.count)

  stats.activeDays = activeDates.size
  stats.streaks = calculateStreaks(activeDates)
  stats.totalDays =
    minorFirst < Infinity && majorLast > 0 ? Math.ceil((majorLast - minorFirst) / DAY_MS) + 1 : 0
  stats.firstSessionDate = minorFirst < Infinity ? new Date(minorFirst).toISOString() : null
  stats.lastSessionDate = majorLast > 0 ? new Date(majorLast).toISOString() : null

  if (sessions.length > 0) {
    // 会话时长按「回合内时长」算：会话可能跨天挂着，墙钟跨度会失真。
    stats.longestSession = sessions.reduce((a, b) => (b.duration > a.duration ? b : a))
    stats.averageSessionDuration =
      sessions.reduce((sum, s) => sum + s.duration, 0) / sessions.length
  }

  const peakDay = stats.dailyActivity.reduce(
    (a, b) => (b.messageCount > a.messageCount ? b : a),
    { date: null, messageCount: -1 },
  )
  stats.peakActivityDay = peakDay.messageCount > 0 ? peakDay.date : null

  let peakHour = -1
  for (let h = 0; h < 24; h++) if (hourCounts[h] > (peakHour < 0 ? 0 : hourCounts[peakHour])) peakHour = h
  stats.peakActivityHour = peakHour >= 0 && hourCounts[peakHour] > 0 ? peakHour : null

  stats.latestSession = latest
  stats.scannedSessions = summaries.length
  stats.generatedAt = Date.now()
  return stats
}
