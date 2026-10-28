/**
 * dsh-buddy-statistics —— 浏览器半边。
 *
 * 复刻 CodeBuddy Code 的「统计」页：概览 / 模型 / 工具 三个标签页、
 * 活跃热力图、每日 Token 趋势、模型用量排行、工具使用排行与彩蛋文案。
 *
 * 数据全部来自宿主半边（GET /buddy-stats/data）；这里只做渲染与格式化，
 * 不读文件、不折叠会话事件。
 */

window.__ModuleLoader__.load({
  id: 'dsh-buddy-statistics',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const NS = 'buddy-stats'
    const PANEL_ID = 'buddy-stats'
    const ENDPOINT = '/buddy-stats/data'

    // ── 文案：键名与 CodeBuddy Code 的 stats.* 一一对应，便于对照 ──────────
    const DICTS = {
      zh: {
        'stats.panel': '统计',
        'stats.title': '统计',
        'stats.pageDesc': '当前主机会话的 Token、模型与工具使用概况',
        'stats.loading': '正在加载统计数据…',
        'stats.refresh': '刷新',
        'stats.noData': '暂无统计数据',
        'stats.tab.overview': '概览',
        'stats.tab.models': '模型',
        'stats.tab.tools': '工具',
        'stats.sessions': '会话数',
        'stats.messages': '消息数',
        'stats.activeDays': '活跃天数',
        'stats.currentStreak': '当前连续',
        'stats.longestStreak': '最长连续',
        'stats.peakHour': '高峰时段',
        'stats.longestSession': '最长会话',
        'stats.favoriteModel': '最常用模型',
        'stats.totalTokens': '总 Token',
        'stats.timeRange': '统计范围：最近 {days} 天',
        'stats.heatmap.less': '少',
        'stats.heatmap.more': '多',
        'stats.days': '天',
        'stats.tokensPerDay': '每日 Token 趋势',
        'stats.allModels': '所有模型',
        'stats.input': '输入',
        'stats.output': '输出',
        'stats.cacheRead': '缓存读取',
        'stats.cacheHitRate': '缓存命中率',
        'stats.cost': '成本',
        'stats.topTools': '工具使用排行',
        'stats.session.title': '当前会话',
        'stats.session.recent': '最近会话',
        'stats.session.apiDuration': '模型耗时',
        'stats.session.wallTime': '总时长',
        'stats.session.linesAdded': '新增行',
        'stats.session.linesDeleted': '删除行',
        'stats.session.tokens': 'Token',
        'stats.na': 'N/A',
        'stats.heatmap.messages': '条消息',
        'stats.funFact.moreTokens': '你已使用约 {times} 倍于《{book}》的 Token 量',
        'stats.funFact.sameTokens': '你使用的 Token 量约等于一本《{book}》',
        'stats.funFact.longerSession': '你最长的会话时长约为「{activity}」的 {times} 倍',
        'stats.subagents': '子代理',
        'stats.workspaces': '工作区',
        'stats.toolCalls': '工具调用',
        'stats.reasoning': '推理',
        'stats.local.sessionHint': '按会话日志的最后一条事件统计',
        'stats.local.loadFailed': '统计加载失败',
        'stats.local.retry': '重试',
        'stats.local.slowHint': '首次统计需要解压本机会话日志，请稍候…',
        'stats.local.sampleHint': '共 {files} 个会话文件 · 用时 {ms}ms',
      },
      en: {
        'stats.panel': 'Statistics',
        'stats.title': 'Statistics',
        'stats.pageDesc': 'Token, model and tool usage across sessions on the current host',
        'stats.loading': 'Loading statistics…',
        'stats.refresh': 'Refresh',
        'stats.noData': 'No statistics available',
        'stats.tab.overview': 'Overview',
        'stats.tab.models': 'Models',
        'stats.tab.tools': 'Tools',
        'stats.sessions': 'Sessions',
        'stats.messages': 'Messages',
        'stats.activeDays': 'Active Days',
        'stats.currentStreak': 'Current Streak',
        'stats.longestStreak': 'Longest Streak',
        'stats.peakHour': 'Peak Hour',
        'stats.longestSession': 'Longest Session',
        'stats.favoriteModel': 'Favorite Model',
        'stats.totalTokens': 'Total Tokens',
        'stats.timeRange': 'Stats from the last {days} days',
        'stats.heatmap.less': 'Less',
        'stats.heatmap.more': 'More',
        'stats.days': 'days',
        'stats.tokensPerDay': 'Daily token trend',
        'stats.allModels': 'All models',
        'stats.input': 'Input',
        'stats.output': 'Output',
        'stats.cacheRead': 'Cache read',
        'stats.cacheHitRate': 'Cache hit rate',
        'stats.cost': 'Cost',
        'stats.topTools': 'Top tools used',
        'stats.session.title': 'Current session',
        'stats.session.recent': 'Latest session',
        'stats.session.apiDuration': 'Model time',
        'stats.session.wallTime': 'Wall time',
        'stats.session.linesAdded': 'Lines added',
        'stats.session.linesDeleted': 'Lines deleted',
        'stats.session.tokens': 'Tokens',
        'stats.na': 'N/A',
        'stats.heatmap.messages': 'messages',
        'stats.funFact.moreTokens': 'You have used about {times}x the tokens of "{book}"',
        'stats.funFact.sameTokens': 'You have used about one "{book}" worth of tokens',
        'stats.funFact.longerSession': 'Your longest session lasts about {times}x "{activity}"',
        'stats.subagents': 'subagents',
        'stats.workspaces': 'workspaces',
        'stats.toolCalls': 'tool calls',
        'stats.reasoning': 'reasoning',
        'stats.local.sessionHint': 'Measured from the last event in the session log',
        'stats.local.loadFailed': 'Failed to load statistics',
        'stats.local.retry': 'Retry',
        'stats.local.slowHint': 'The first run decompresses local session logs, please wait…',
        'stats.local.sampleHint': '{files} session files · {ms}ms',
      },
    }

    // ── 格式化 ────────────────────────────────────────────────────────────
    /** 千分位缩写，与 CBC 的 token 格式化一致：1.2k / 3.4M。 */
    function fmtNum(value) {
      const n = Number(value) || 0
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
      return String(n)
    }

    /** 时长：1h 2m 3s / 4m 5s / 6s；≤0 显示短横线。 */
    function fmtDuration(ms) {
      const value = Number(ms) || 0
      if (value <= 0) return '-'
      const totalSec = Math.floor(value / 1000)
      const minutes = Math.floor(totalSec / 60)
      const hours = Math.floor(minutes / 60)
      if (hours > 0) return `${hours}h ${minutes % 60}m ${totalSec % 60}s`
      if (minutes > 0) return `${minutes}m ${totalSec % 60}s`
      return `${totalSec}s`
    }

    /** 模型短名：去掉常见 provider 前缀与日期/版本尾巴。 */
    function shortModel(name) {
      return String(name || '')
        .replace(/^(anthropic|openai|deepseek|google|gemini|qwen|kimi|glm|minimax|moonshot)\./, '')
        .replace(/-\d{8}$/, '')
        .replace(/@.*$/, '')
    }

    function shortDate(ms) {
      try {
        return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      } catch {
        return ''
      }
    }

    function fullDate(ms) {
      try {
        return new Date(ms).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
      } catch {
        return ''
      }
    }

    /** 本地日期键，与宿主一致。 */
    function dateKeyOf(ms) {
      const d = new Date(ms)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    function pct(part, total) {
      const t = Number(total) || 0
      if (t <= 0) return 0
      return Math.max(0, Math.min(100, (Number(part) / t) * 100))
    }

    // ── 图标（自绘，线性风格，与宿主图标同尺寸语言）───────────────────────
    const ICON_PATHS = {
      chart: 'M3 3v18h18M7 15l3-4 3 3 4-6',
      star: 'M12 3l2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.4l6.1-.8z',
      trophy: 'M8 4h8v4a4 4 0 0 1-8 0zM6 4H4v2a3 3 0 0 0 3 3M18 4h2v2a3 3 0 0 1-3 3M9 16h6M9 20h6M10 16v4M14 16v4',
      flame: 'M12 3s4 3.5 4 8a4 4 0 0 1-8 0c0-1.6.6-2.8 1.4-3.8C10 8.6 12 6 12 3z',
      timer: 'M12 8v4l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
      wrench: 'M15 3a5 5 0 0 0-4.6 7L3 17.4V21h3.6l7.4-7.4A5 5 0 1 0 15 3z',
      zap: 'M13 2 4 14h6l-1 8 9-12h-6z',
      users: 'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 7.5a3 3 0 1 0 0 4 3 3 0 0 0 0-4M17 12a3 3 0 1 0-1.5-5.6M21 20v-1a4 4 0 0 0-3-3.9',
      calendar: 'M8 2v4M16 2v4M3 10h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01',
      refresh: 'M21 12a9 9 0 1 1-3-6.7M21 4v5h-5',
      alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
      spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
      layers: 'M12 3 3 8l9 5 9-5zM3 13l9 5 9-5',
    }

    function Icon({ name, size = 14, strokeWidth = 1.8, className, style }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          className,
          style,
        },
        h('path', { d: ICON_PATHS[name] || ICON_PATHS.spark }),
      )
    }

    // ── 配色 ──────────────────────────────────────────────────────────────
    function toneColor(tone) {
      switch (tone) {
        case 'blue':
          return 'var(--dsw-alias-brand-primary)'
        case 'green':
          return 'var(--dsw-alias-state-success-primary)'
        case 'orange':
          return 'var(--dsw-alias-state-warn-primary)'
        case 'purple':
          return 'color-mix(in srgb, var(--dsw-alias-brand-primary) 62%, var(--dsw-alias-state-error-primary))'
        case 'red':
          return 'var(--dsw-alias-state-error-primary)'
        default:
          return 'var(--dsw-alias-label-secondary)'
      }
    }

    function toneChip(tone) {
      const color = toneColor(tone)
      return {
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
      }
    }

    const SERIES_TONES = ['blue', 'green', 'orange']

    // ── 样式 ──────────────────────────────────────────────────────────────
    const CSS = `
.bs-page{width:100%;min-width:0;height:100%;min-height:0;display:flex;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}
.bs-scroll{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto;scrollbar-gutter:stable}
.bs-content{width:100%;max-width:960px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px;box-sizing:border-box}
.bs-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:16px;padding-top:28px;margin-bottom:18px}
.bs-head h1{margin:0;font-size:20px;font-weight:500;line-height:28px}
.bs-desc{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.bs-refresh{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:16px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
.bs-refresh:hover{background:var(--dsw-alias-bg-layer-2)}
.bs-refresh:disabled{cursor:default;color:var(--dsw-alias-label-secondary);opacity:.7}
.bs-refresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.bs-tabsrow{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:16px}
.bs-tabs{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.bs-tab{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:0;border-radius:14px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
.bs-tab:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.bs-tab[aria-selected=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.bs-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.bs-range{margin-left:auto;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.bs-grid{display:grid;gap:12px}
.bs-grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.bs-grid-2{grid-template-columns:repeat(3,minmax(0,1fr))}
.bs-card{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:16px;padding:14px 16px;min-width:0}
.bs-card-lg{padding:18px 20px}
.bs-kpi{display:flex;flex-direction:column;gap:8px;min-width:0}
.bs-kpi-top{display:flex;align-items:center;gap:8px;min-width:0}
.bs-kpi-icon{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:9px}
.bs-kpi-label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bs-kpi-value{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bs-card-lg .bs-kpi-value{font-size:26px;line-height:32px}
.bs-kpi-hint{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bs-bar{height:6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);overflow:hidden}
.bs-bar>span{display:block;height:100%;border-radius:999px;background:currentColor;transition:width .35s ease}
.bs-sessionbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 24px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:16px;padding:12px 16px;margin-bottom:12px}
.bs-sessionbar-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;min-width:0}
.bs-sessionbar-title span.bs-session-name{font-weight:400;color:var(--dsw-alias-label-secondary);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bs-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none;box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);animation:bs-pulse 2s infinite}
@keyframes bs-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}
.bs-divider{width:1px;height:24px;background:var(--dsw-alias-border-l1);flex:none}
.bs-mini{display:flex;flex-direction:column;gap:1px;min-width:0}
.bs-mini-label{display:flex;align-items:center;gap:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.bs-mini-value{font-size:13px;line-height:18px;font-weight:600;font-variant-numeric:tabular-nums}
.bs-section{margin-top:20px}
.bs-section-head{display:flex;align-items:center;gap:8px;margin:0 0 8px}
.bs-section-title{margin:0;font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.bs-section-count{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.bs-section-actions{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.bs-heat-wrap{width:100%;overflow-x:auto;padding-bottom:2px}
.bs-heat-inner{position:relative;margin:0 auto}
.bs-heat-legend{display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.bs-heat-legend i{display:inline-block;width:10px;height:10px;border-radius:3px}
.bs-tooltip{position:absolute;z-index:10;pointer-events:none;padding:6px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 6px 20px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);font-size:11.5px;line-height:16px;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.bs-tooltip .bs-tooltip-dim{color:var(--dsw-alias-label-secondary)}
.bs-callout{display:flex;align-items:flex-start;gap:10px;margin-top:20px;padding:12px 14px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.bs-list{display:flex;flex-direction:column}
.bs-row{display:flex;flex-direction:column;gap:8px;padding:12px 16px;border-top:.5px solid var(--dsw-alias-border-l1)}
.bs-row:first-child{border-top:0}
.bs-row:hover{background:var(--dsw-alias-bg-layer-2)}
.bs-row-main{display:flex;align-items:center;gap:10px;min-width:0}
.bs-row-dot{width:8px;height:8px;border-radius:50%;flex:none}
.bs-row-name{flex:1;min-width:0;font-size:13px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bs-row-value{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.bs-row-pct{width:52px;text-align:right;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.bs-row-sub{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.bs-row-sub b{font-weight:600;color:var(--dsw-alias-label-primary)}
.bs-toolrow{display:flex;align-items:center;gap:12px;padding:7px 10px;border-radius:10px}
.bs-toolrow:hover{background:var(--dsw-alias-bg-layer-2)}
.bs-tool-rank{width:20px;flex:none;text-align:right;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.bs-tool-name{width:128px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary)}
.bs-tool-bar{flex:1;min-width:0}
.bs-tool-count{width:56px;flex:none;text-align:right;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.bs-tool-pct{width:48px;flex:none;text-align:right;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.bs-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:64px 20px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:14px}
.bs-empty p{margin:0;font-size:13px;line-height:20px}
.bs-loading{display:flex;flex-direction:column;align-items:center;gap:10px;padding:64px 20px;color:var(--dsw-alias-label-secondary);font-size:14px}
.bs-spinner{width:22px;height:22px;border-radius:50%;border:2px solid color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);border-top-color:var(--dsw-alias-brand-primary);animation:bs-spin .8s linear infinite}
@keyframes bs-spin{to{transform:rotate(360deg)}}
.bs-chart{width:100%;overflow-x:auto}
.bs-chart svg{display:block}
.bs-legend{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.bs-legend span{display:inline-flex;align-items:center;gap:6px}
.bs-legend i{width:8px;height:8px;border-radius:50%;display:inline-block}
.bs-legend b{color:var(--dsw-alias-label-primary);font-weight:600}
.bs-foot{margin-top:20px;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary);text-align:right;font-variant-numeric:tabular-nums}
@media (max-width:860px){.bs-grid-3,.bs-grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.bs-grid-3,.bs-grid-2{grid-template-columns:minmax(0,1fr)}.bs-tool-name{width:84px}}
`

    // ── 通用小组件 ────────────────────────────────────────────────────────
    function Progress({ value, tone, height = 6 }) {
      const color = toneColor(tone)
      return h(
        'div',
        { className: 'bs-bar', style: { height, color }, 'aria-hidden': true },
        h('span', { style: { width: `${Math.max(0, Math.min(100, Number(value) || 0))}%` } }),
      )
    }

    function KpiCard({ icon, label, value, hint, tone = 'neutral', progress, large }) {
      return h(
        'div',
        { className: `bs-card bs-kpi${large ? ' bs-card-lg' : ''}` },
        h(
          'div',
          { className: 'bs-kpi-top' },
          h('span', { className: 'bs-kpi-icon', style: toneChip(tone) }, h(Icon, { name: icon, size: large ? 16 : 14 })),
          h('span', { className: 'bs-kpi-label', title: label }, label),
        ),
        h('div', { className: 'bs-kpi-value', title: String(value) }, value),
        typeof progress === 'number' ? h(Progress, { value: progress, tone }) : null,
        hint ? h('div', { className: 'bs-kpi-hint', title: hint }, hint) : null,
      )
    }

    function MiniStat({ label, value, tone, icon }) {
      return h(
        'div',
        { className: 'bs-mini' },
        h('span', { className: 'bs-mini-label' }, icon ? h(Icon, { name: icon, size: 11 }) : null, label),
        h('span', { className: 'bs-mini-value', style: tone ? { color: toneColor(tone) } : undefined }, value),
      )
    }

    function Empty({ title, description, action }) {
      return h(
        'div',
        { className: 'bs-empty' },
        h(Icon, { name: 'alert', size: 24, strokeWidth: 1.6 }),
        h('strong', { style: { fontWeight: 500 } }, title),
        description ? h('p', null, description) : null,
        action || null,
      )
    }

    // ── 活跃热力图（移植 CBC 的 52 周 × 7 天矩阵）─────────────────────────
    function ActivityHeatmap({ dailyActivity, t }) {
      const CELL = 12
      const PITCH = 15
      const OFFSET_X = 30
      const OFFSET_Y = 18
      const WEEKS = 52
      const WIDTH = OFFSET_X + WEEKS * PITCH + 8
      const HEIGHT = OFFSET_Y + 7 * PITCH + 8
      const [hover, setHover] = useState(null)

      const model = useMemo(() => {
        const byDate = new Map()
        for (const day of dailyActivity || []) byDate.set(day.date, day.messageCount || 0)
        const counts = (dailyActivity || [])
          .map((d) => d.messageCount || 0)
          .filter((n) => n > 0)
          .sort((a, b) => a - b)
        const q1 = counts.length ? counts[Math.floor(counts.length * 0.25)] : 0
        const q2 = counts.length ? counts[Math.floor(counts.length * 0.5)] : 0
        const q3 = counts.length ? counts[Math.floor(counts.length * 0.75)] : 0
        const level = (n) => (n <= 0 || counts.length === 0 ? 0 : n >= q3 ? 4 : n >= q2 ? 3 : n >= q1 ? 2 : 1)

        const today = new Date()
        today.setHours(0, 0, 0, 0)
        const start = new Date(today)
        start.setDate(today.getDate() - today.getDay()) // 本周日
        start.setDate(start.getDate() - 7 * (WEEKS - 1))

        const cells = []
        const months = []
        let lastMonth = -1
        const cursor = new Date(start)
        for (let week = 0; week < WEEKS; week++) {
          for (let day = 0; day < 7; day++) {
            if (cursor > today) {
              cursor.setDate(cursor.getDate() + 1)
              continue
            }
            const key = dateKeyOf(cursor.getTime())
            const count = byDate.get(key) || 0
            if (day === 0 && cursor.getMonth() !== lastMonth) {
              months.push({ text: cursor.toLocaleDateString(undefined, { month: 'short' }), x: OFFSET_X + week * PITCH })
              lastMonth = cursor.getMonth()
            }
            cells.push({
              key,
              x: OFFSET_X + week * PITCH,
              y: OFFSET_Y + day * PITCH,
              level: level(count),
              count,
              date: new Date(cursor),
            })
            cursor.setDate(cursor.getDate() + 1)
          }
        }
        if (months.length > 1 && months[1].x - months[0].x < 30) months.shift()
        return { cells, months, width: WIDTH, height: HEIGHT }
      }, [dailyActivity])

      const weekdayLabels = useMemo(() => {
        const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
        // 2024-01-01 是周一：取 1/3/5（周一/三/五）作为行标。
        return [1, 3, 5].map((day) => ({
          day,
          text: fmt.format(new Date(2024, 0, day)),
        }))
      }, [])

      const levels = [
        'color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)',
        'color-mix(in srgb, var(--dsw-alias-state-success-primary) 28%, var(--dsw-alias-bg-layer-1))',
        'color-mix(in srgb, var(--dsw-alias-state-success-primary) 50%, var(--dsw-alias-bg-layer-1))',
        'color-mix(in srgb, var(--dsw-alias-state-success-primary) 74%, var(--dsw-alias-bg-layer-1))',
        'var(--dsw-alias-state-success-primary)',
      ]

      return h(
        'div',
        { className: 'bs-heat-wrap' },
        h(
          'div',
          { className: 'bs-heat-inner', style: { width: `${model.width}px` } },
          h(
            'svg',
            {
              width: model.width,
              height: model.height,
              viewBox: `0 0 ${model.width} ${model.height}`,
              role: 'img',
              onMouseLeave: () => setHover(null),
            },
            model.months.map((month) =>
              h(
                'text',
                { key: `m-${month.x}`, x: month.x, y: 11, fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' },
                month.text,
              ),
            ),
            weekdayLabels.map((label) =>
              h(
                'text',
                {
                  key: `w-${label.day}`,
                  x: 24,
                  y: OFFSET_Y + label.day * PITCH + CELL - 2,
                  fontSize: 10,
                  textAnchor: 'end',
                  fill: 'var(--dsw-alias-label-secondary)',
                },
                label.text,
              ),
            ),
            model.cells.map((cell) =>
              h('rect', {
                key: cell.key,
                x: cell.x,
                y: cell.y,
                width: CELL,
                height: CELL,
                rx: 3,
                style: {
                  fill: levels[cell.level],
                  stroke: hover && hover.key === cell.key ? 'var(--dsw-alias-label-primary)' : 'transparent',
                  strokeWidth: 1.5,
                  transition: 'stroke 120ms',
                },
                onMouseEnter: () => setHover(cell),
                'aria-label': `${cell.key}: ${cell.count} ${t('stats.heatmap.messages')}`,
              }),
            ),
          ),
          hover
            ? h(
                'div',
                {
                  className: 'bs-tooltip',
                  role: 'tooltip',
                  style: {
                    left: `${Math.min(Math.max(hover.x + CELL / 2, 70), model.width - 70)}px`,
                    top: hover.y < 63 ? `${hover.y + CELL + 8}px` : `${hover.y - 8}px`,
                    transform: hover.y < 63 ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
                  },
                },
                h('strong', { style: { fontVariantNumeric: 'tabular-nums' } }, `${hover.count} `),
                h('span', null, t('stats.heatmap.messages')),
                h('span', { className: 'bs-tooltip-dim', style: { marginLeft: 6 } }, fullDate(hover.date.getTime())),
              )
            : null,
        ),
        h(
          'div',
          { className: 'bs-heat-legend' },
          h('span', { style: { marginRight: 2 } }, t('stats.heatmap.less')),
          levels.map((bg, index) => h('i', { key: index, style: { background: bg } })),
          h('span', { style: { marginLeft: 2 } }, t('stats.heatmap.more')),
        ),
      )
    }

    // ── 每日 Token 趋势（CBC 的多模型折线 + 面积图）────────────────────────
    function TokenTrend({ dailyModelTokens, models, t }) {
      const WIDTH = 720
      const HEIGHT = 230
      const PAD = { top: 16, right: 16, bottom: 30, left: 52 }
      const innerW = WIDTH - PAD.left - PAD.right
      const innerH = HEIGHT - PAD.top - PAD.bottom
      const [hoverIndex, setHoverIndex] = useState(null)
      const svgRef = useRef(null)

      const series = useMemo(() => {
        const days = dailyModelTokens || []
        if (days.length === 0) return null
        const totals = new Map()
        for (const day of days) {
          for (const [model, n] of Object.entries(day.tokensByModel || {})) {
            if (!n) continue
            totals.set(model, (totals.get(model) || 0) + n)
          }
        }
        const top = (models && models.length ? models : Array.from(totals.keys()).sort((a, b) => totals.get(b) - totals.get(a)))
          .slice(0, 3)
        let max = 0
        for (const day of days) {
          let sum = 0
          for (const model of top) sum += (day.tokensByModel || {})[model] || 0
          if (sum > max) max = sum
        }
        if (max <= 0) max = 1
        const x = (i) => PAD.left + (days.length <= 1 ? innerW / 2 : (i / (days.length - 1)) * innerW)
        const y = (v) => PAD.top + innerH - (v / max) * innerH
        const lines = top.map((model, index) => {
          const points = days.map((day, i) => ({ x: x(i), y: y((day.tokensByModel || {})[model] || 0), value: (day.tokensByModel || {})[model] || 0 }))
          const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
          const area =
            points.length > 1
              ? `${path} L${points[points.length - 1].x.toFixed(2)},${(PAD.top + innerH).toFixed(2)} L${points[0].x.toFixed(2)},${(PAD.top + innerH).toFixed(2)} Z`
              : ''
          const total = points.reduce((sum, p) => sum + p.value, 0)
          return { id: model, label: shortModel(model), points, path, area, tone: SERIES_TONES[index % SERIES_TONES.length], total }
        })
        const ticks = Array.from({ length: 4 }, (_, i) => {
          const value = (max / 4) * i
          return { value, y: y(value) }
        })
        const labelEvery = Math.max(1, Math.ceil(days.length / 7))
        const xLabels = days
          .map((day, i) => ({ i, text: shortDate(new Date(`${day.date}T00:00:00`).getTime()) }))
          .filter((item) => item.i % labelEvery === 0)
        return { days, lines, max, ticks, xLabels, x: (i) => PAD.left + (days.length <= 1 ? innerW / 2 : (i / (days.length - 1)) * innerW) }
      }, [dailyModelTokens, models])

      if (!series || series.lines.length === 0) return null

      const onMove = (event) => {
        try {
          const rect = event.currentTarget.getBoundingClientRect()
          const ratio = (event.clientX - rect.left) / Math.max(1, rect.width)
          const x = ratio * WIDTH
          const step = series.days.length <= 1 ? innerW : innerW / (series.days.length - 1)
          const index = Math.round((x - PAD.left) / step)
          setHoverIndex(Math.max(0, Math.min(series.days.length - 1, index)))
        } catch {
          setHoverIndex(null)
        }
      }

      const hoveredDay = hoverIndex === null ? null : series.days[hoverIndex]

      return h(
        'div',
        { className: 'bs-chart' },
        h(
          'div',
          { style: { position: 'relative', width: `${WIDTH}px`, maxWidth: '100%' } },
          h(
            'svg',
            {
              ref: svgRef,
              width: WIDTH,
              height: HEIGHT,
              viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
              onMouseMove: onMove,
              onMouseLeave: () => setHoverIndex(null),
            },
            h(
              'defs',
              null,
              series.lines.map((line, index) =>
                h(
                  'linearGradient',
                  { key: line.id, id: `bs-grad-${index}`, x1: 0, y1: 0, x2: 0, y2: 1 },
                  h('stop', { offset: '0%', stopColor: toneColor(line.tone), stopOpacity: 0.28 }),
                  h('stop', { offset: '100%', stopColor: toneColor(line.tone), stopOpacity: 0.02 }),
                ),
              ),
            ),
            series.ticks.map((tick) =>
              h(
                'g',
                { key: `tick-${tick.value}` },
                h('line', {
                  x1: PAD.left,
                  x2: WIDTH - PAD.right,
                  y1: tick.y,
                  y2: tick.y,
                  stroke: 'var(--dsw-alias-border-l1)',
                  strokeWidth: 1,
                }),
                h(
                  'text',
                  {
                    x: PAD.left - 8,
                    y: tick.y + 4,
                    fontSize: 10,
                    textAnchor: 'end',
                    fill: 'var(--dsw-alias-label-secondary)',
                  },
                  fmtNum(Math.round(tick.value)),
                ),
              ),
            ),
            series.xLabels.map((label) =>
              h(
                'text',
                {
                  key: `x-${label.i}`,
                  x: series.x(label.i),
                  y: HEIGHT - 10,
                  fontSize: 10,
                  textAnchor: 'middle',
                  fill: 'var(--dsw-alias-label-secondary)',
                },
                label.text,
              ),
            ),
            series.lines.map((line, index) =>
              line.area ? h('path', { key: `a-${line.id}`, d: line.area, fill: `url(#bs-grad-${index})` }) : null,
            ),
            series.lines.map((line) =>
              h('path', {
                key: `l-${line.id}`,
                d: line.path,
                fill: 'none',
                stroke: toneColor(line.tone),
                strokeWidth: 1.8,
                strokeLinejoin: 'round',
                strokeLinecap: 'round',
              }),
            ),
            hoveredDay
              ? h('line', {
                  x1: series.x(hoverIndex),
                  x2: series.x(hoverIndex),
                  y1: PAD.top,
                  y2: PAD.top + innerH,
                  stroke: 'var(--dsw-alias-label-secondary)',
                  strokeWidth: 1,
                  strokeDasharray: '3 3',
                })
              : null,
            hoveredDay
              ? series.lines.map((line) =>
                  h('circle', {
                    key: `p-${line.id}`,
                    cx: series.x(hoverIndex),
                    cy: line.points[hoverIndex] ? line.points[hoverIndex].y : 0,
                    r: 2.6,
                    fill: toneColor(line.tone),
                  }),
                )
              : null,
          ),
          hoveredDay
            ? h(
                'div',
                {
                  className: 'bs-tooltip',
                  role: 'tooltip',
                  style: {
                    left: `${Math.min(Math.max(series.x(hoverIndex) + 8, 8), WIDTH - 168)}px`,
                    top: '8px',
                    minWidth: '150px',
                  },
                },
                h(
                  'div',
                  { style: { marginBottom: 4, color: 'var(--dsw-alias-label-secondary)' } },
                  hoveredDay.date,
                ),
                series.lines.map((line) =>
                  h(
                    'div',
                    { key: line.id, style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    h('i', {
                      style: {
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: toneColor(line.tone),
                        display: 'inline-block',
                        flex: 'none',
                      },
                    }),
                    h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, line.label),
                    h('b', { style: { fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, fmtNum((hoveredDay.tokensByModel || {})[line.id] || 0)),
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'bs-legend' },
          series.lines.map((line) =>
            h(
              'span',
              { key: line.id },
              h('i', { style: { background: toneColor(line.tone) } }),
              line.label,
              h('b', null, fmtNum(line.total)),
            ),
          ),
        ),
      )
    }

    // ── 彩蛋文案（CBC 的书籍 / 活动对照表）────────────────────────────────
    const BOOKS_EN = [
      { name: 'The Little Prince', tokens: 22e3 },
      { name: 'The Old Man and the Sea', tokens: 35e3 },
      { name: 'A Christmas Carol', tokens: 37e3 },
      { name: 'Animal Farm', tokens: 39e3 },
      { name: 'Fahrenheit 451', tokens: 6e4 },
      { name: 'The Great Gatsby', tokens: 62e3 },
      { name: 'Brave New World', tokens: 83e3 },
      { name: "Harry Potter and the Philosopher's Stone", tokens: 103e3 },
      { name: '1984', tokens: 123e3 },
      { name: 'Pride and Prejudice', tokens: 156e3 },
      { name: 'Dune', tokens: 244e3 },
      { name: 'A Game of Thrones', tokens: 381e3 },
      { name: 'The Lord of the Rings', tokens: 576e3 },
      { name: 'War and Peace', tokens: 73e4 },
    ]
    const BOOKS_ZH = [
      { name: '朝花夕拾', tokens: 18e3 },
      { name: '骆驼祥子', tokens: 6e4 },
      { name: '活着', tokens: 72e3 },
      { name: '围城', tokens: 84e3 },
      { name: '三体', tokens: 126e3 },
      { name: '射雕英雄传', tokens: 234e3 },
      { name: '红楼梦', tokens: 438e3 },
      { name: '三国演义', tokens: 48e4 },
      { name: '西游记', tokens: 492e3 },
      { name: '水浒传', tokens: 576e3 },
      { name: '平凡的世界', tokens: 6e5 },
      { name: '金庸全集', tokens: 636e4 },
    ]
    const ACTIVITIES = [
      { en: 'a TED talk', zh: '一场 TED 演讲', minutes: 18 },
      { en: 'an episode of The Office', zh: '一集《办公室》', minutes: 22 },
      { en: 'listening to Abbey Road', zh: '听一遍《Abbey Road》专辑', minutes: 47 },
      { en: 'a yoga class', zh: '一节瑜伽课', minutes: 60 },
      { en: 'watching Titanic', zh: '电影《泰坦尼克号》', minutes: 195 },
      { en: 'a transatlantic flight', zh: '一趟跨大西洋航班', minutes: 420 },
      { en: 'a full night of sleep', zh: '一整晚的睡眠', minutes: 480 },
    ]

    function funFact(stats, lang) {
      const facts = []
      const books = lang === 'zh' ? BOOKS_ZH : BOOKS_EN
      const total = stats.tokens ? stats.tokens.total : 0
      if (total > 0) {
        for (const book of books) {
          if (total >= book.tokens) {
            const ratio = total / book.tokens
            facts.push(
              ratio >= 2
                ? {
                    key: 'more',
                    text: (lang === 'zh' ? DICTS.zh : DICTS.en)['stats.funFact.moreTokens']
                      .replace('{times}', String(Math.floor(ratio)))
                      .replace('{book}', book.name),
                  }
                : {
                    key: 'same',
                    text: (lang === 'zh' ? DICTS.zh : DICTS.en)['stats.funFact.sameTokens'].replace('{book}', book.name),
                  },
            )
          }
        }
      }
      if (stats.longestSession && stats.longestSession.duration > 0) {
        const minutes = stats.longestSession.duration / 60000
        for (const activity of ACTIVITIES) {
          const ratio = minutes / activity.minutes
          if (ratio >= 2) {
            facts.push({
              key: 'longer',
              text: (lang === 'zh' ? DICTS.zh : DICTS.en)['stats.funFact.longerSession']
                .replace('{times}', String(Math.floor(ratio)))
                .replace('{activity}', lang === 'zh' ? activity.zh : activity.en),
            })
          }
        }
      }
      if (facts.length === 0) return ''
      const seed = Math.floor((stats.longestSession ? stats.longestSession.duration / 60000 : 0) + total)
      return facts[Math.abs(seed) % facts.length].text
    }

    // ── 页面 ──────────────────────────────────────────────────────────────
    function useLocaleRevision(ctx) {
      const [, force] = useState(0)
      useEffect(() => {
        if (!ctx || !ctx.locale || typeof ctx.locale.subscribe !== 'function') return undefined
        return ctx.locale.subscribe(() => force((n) => n + 1))
      }, [ctx])
    }

    function localeId(ctx) {
      try {
        const snapshot = ctx && ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : null
        const id = snapshot && (snapshot.active || snapshot.locale || snapshot.id)
        return typeof id === 'string' ? id : 'zh'
      } catch {
        return 'zh'
      }
    }

    function StatsPage({ ctx, t }) {
      useLocaleRevision(ctx)
      const lang = localeId(ctx) === 'en' ? 'en' : 'zh'

      const [tab, setTab] = useState('overview')
      const [payload, setPayload] = useState(null)
      const [meta, setMeta] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [refreshing, setRefreshing] = useState(false)

      const load = useCallback(
        async (force) => {
          setLoading(true)
          setError(null)
          try {
            const response = await fetch(`${ENDPOINT}${force ? '?refresh=1' : ''}`, { cache: 'no-store' })
            const body = await response.json().catch(() => null)
            if (!response.ok || !body || body.ok !== true) {
              throw new Error((body && body.error) || `HTTP ${response.status}`)
            }
            setPayload(body.stats || null)
            setMeta(body.meta || null)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setLoading(false)
            setRefreshing(false)
          }
        },
        [],
      )

      useEffect(() => {
        void load(false)
      }, [load])

      const stats = payload
      const models = useMemo(() => {
        if (!stats || !stats.modelUsage) return []
        return Object.entries(stats.modelUsage)
          .map(([id, usage]) => ({
            id,
            name: shortModel(id),
            provider: (usage.providers && usage.providers[0]) || '',
            inputTokens: usage.inputTokens || 0,
            outputTokens: usage.outputTokens || 0,
            cacheReadTokens: usage.cacheReadInputTokens || 0,
            cacheWriteTokens: usage.cacheCreationInputTokens || 0,
            reasoningTokens: usage.reasoningTokens || 0,
            costUSD: usage.costUSD || 0,
            requests: usage.requests || 0,
            cacheHitRate: usage.cacheHitRate || 0,
            total:
              typeof usage.totalTokens === 'number'
                ? usage.totalTokens
                : (usage.inputTokens || 0) +
                  (usage.outputTokens || 0) +
                  (usage.cacheReadInputTokens || 0) +
                  (usage.cacheCreationInputTokens || 0),
          }))
          .sort((a, b) => b.total - a.total)
      }, [stats])

      const modelTotal = useMemo(() => models.reduce((sum, m) => sum + m.total, 0), [models])
      const tabs = [
        { id: 'overview', label: t('stats.tab.overview'), icon: 'layers' },
        { id: 'models', label: t('stats.tab.models'), icon: 'star' },
        { id: 'tools', label: t('stats.tab.tools'), icon: 'wrench' },
      ]

      const refresh = () => {
        if (refreshing) return
        setRefreshing(true)
        void load(true)
      }

      const refreshButton = h(
        'button',
        {
          type: 'button',
          className: 'bs-refresh',
          onClick: refresh,
          disabled: loading || refreshing,
          title: t('stats.refresh'),
        },
        h(Icon, { name: 'refresh', size: 14 }),
        t('stats.refresh'),
      )

      const header = h(
        'div',
        { className: 'bs-head' },
        h(
          'div',
          { style: { minWidth: 0 } },
          h('h1', null, t('stats.title')),
          h('p', { className: 'bs-desc' }, t('stats.pageDesc')),
        ),
        refreshButton,
      )

      const tabButtons = (tabs || []).map((item) =>
        h(
          'button',
          {
            key: item.id,
            type: 'button',
            role: 'tab',
            className: 'bs-tab',
            'aria-selected': tab === item.id,
            onClick: () => setTab(item.id),
          },
          h(Icon, { name: item.icon, size: 13 }),
          item.label,
        ),
      )

      const tabsRow = h(
        'div',
        { className: 'bs-tabsrow' },
        h(
          'div',
          { className: 'bs-tabs', role: 'tablist', 'aria-label': t('stats.title') },
          tabButtons,
        ),
        stats
          ? h(
              'span',
              { className: 'bs-range' },
              t('stats.timeRange').replace('{days}', String(stats.totalDays || 0)),
            )
          : null,
      )

      const content = loading && !stats
        ? h(
            'div',
            { className: 'bs-loading', role: 'status' },
            h('div', { className: 'bs-spinner' }),
            h('span', null, t('stats.loading')),
            h('span', { style: { fontSize: 12 } }, t('stats.local.slowHint')),
          )
        : !stats
          ? h(Empty, { title: t('stats.noData') })
          : h(
              React.Fragment,
              null,
              tab === 'overview' ? h(OverviewTab, { stats, models, modelTotal, t, lang }) : null,
              tab === 'models' ? h(ModelsTab, { stats, models, modelTotal, t }) : null,
              tab === 'tools' ? h(ToolsTab, { stats, t }) : null,
              h(
                'div',
                { className: 'bs-foot' },
                meta
                  ? t('stats.local.sampleHint')
                      .replace('{files}', String(meta.files || 0))
                      .replace('{ms}', String(meta.tookMs || 0))
                  : '',
              ),
            )

      const body = error && !stats
        ? h(Empty, {
            title: t('stats.local.loadFailed'),
            description: error,
            action: h(
              'button',
              { type: 'button', className: 'bs-refresh', onClick: refresh },
              h(Icon, { name: 'refresh', size: 14 }),
              t('stats.local.retry'),
            ),
          })
        : h(React.Fragment, null, tabsRow, content)

      return h(
        'div',
        { className: 'bs-page' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'bs-scroll' }, h('div', { className: 'bs-content' }, header, body)),
      )
    }

    function SessionBar({ stats, t }) {
      const session = stats.latestSession
      if (!session) return null
      const tokens = Object.values(session.models || {}).reduce((sum, usage) => sum + (usage.i || 0) + (usage.o || 0), 0)
      return h(
        'div',
        { className: 'bs-sessionbar' },
        h(
          'div',
          { className: 'bs-sessionbar-title', title: t('stats.local.sessionHint') },
          h('span', { className: 'bs-dot', 'aria-hidden': true }),
          t('stats.session.recent'),
          session.title ? h('span', { className: 'bs-session-name' }, session.title) : null,
        ),
        h('span', { className: 'bs-divider', 'aria-hidden': true }),
        h(MiniStat, { label: t('stats.session.apiDuration'), value: fmtDuration(session.apiMs) }),
        h(MiniStat, { label: t('stats.session.wallTime'), value: fmtDuration(session.wallMs || session.duration) }),
        h(MiniStat, {
          label: t('stats.session.linesAdded'),
          value: `+${session.linesAdded || 0}`,
          tone: 'green',
        }),
        h(MiniStat, {
          label: t('stats.session.linesDeleted'),
          value: `-${session.linesDeleted || 0}`,
          tone: 'red',
        }),
        h(MiniStat, { label: t('stats.session.tokens'), value: fmtNum(tokens) }),
      )
    }

    function OverviewTab({ stats, models, modelTotal, t, lang }) {
      const favorite = models[0] || null
      const activeRate = pct(stats.activeDays, stats.totalDays)
      const favRate = favorite ? pct(favorite.total, modelTotal) : 0
      // 总体缓存命中率：分母含输入 + 缓存读写，避免出现 >100%。
      let cacheRead = 0
      let cacheDenom = 0
      for (const model of models) {
        cacheRead += model.cacheReadTokens
        cacheDenom += model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens
      }
      const overallCacheHit = cacheDenom > 0 ? (cacheRead / cacheDenom) * 100 : 0

      if (models.length === 0 && stats.totalSessions === 0) return h(Empty, { title: t('stats.noData') })

      return h(
        React.Fragment,
        null,
        h(SessionBar, { stats, t }),
        h(
          'div',
          { className: 'bs-grid bs-grid-3', style: { marginTop: 12 } },
          h(KpiCard, {
            large: true,
            tone: 'purple',
            icon: 'star',
            label: t('stats.favoriteModel'),
            value: favorite ? favorite.name : t('stats.na'),
            progress: favRate,
            hint: favorite ? `${fmtNum(favorite.total)} · ${favRate.toFixed(0)}%` : '',
          }),
          h(KpiCard, {
            large: true,
            tone: 'blue',
            icon: 'zap',
            label: t('stats.totalTokens'),
            value: fmtNum(stats.tokens.total),
            hint: `${t('stats.input')} ${fmtNum(stats.tokens.input)} · ${t('stats.output')} ${fmtNum(stats.tokens.output)} · ${t('stats.cacheRead')} ${fmtNum(stats.tokens.cacheRead)}`,
          }),
          h(KpiCard, {
            large: true,
            tone: 'green',
            icon: 'timer',
            label: t('stats.cacheHitRate'),
            value: `${overallCacheHit.toFixed(1)}%`,
            progress: overallCacheHit,
            hint: `${t('stats.cacheRead')} ${fmtNum(stats.tokens.cacheRead)}`,
          }),
        ),
        h(
          'div',
          { className: 'bs-grid bs-grid-2', style: { marginTop: 12 } },
          h(KpiCard, {
            icon: 'chart',
            label: t('stats.sessions'),
            value: fmtNum(stats.totalSessions),
            hint: `${t('stats.messages')} ${fmtNum(stats.totalMessages)} · ${t('stats.subagents')} ${stats.totalSubagentSessions}`,
          }),
          h(KpiCard, {
            icon: 'timer',
            label: t('stats.longestSession'),
            value: stats.longestSession ? fmtDuration(stats.longestSession.duration) : t('stats.na'),
            hint: stats.longestSession
              ? `${t('stats.toolCalls')} ${fmtNum(stats.longestSession.toolCalls)}`
              : '',
          }),
          h(KpiCard, {
            icon: 'calendar',
            label: t('stats.activeDays'),
            value: `${stats.activeDays}/${stats.totalDays}`,
            progress: activeRate,
            hint: `${t('stats.workspaces')} ${stats.workspaces}`,
          }),
          h(KpiCard, {
            tone: stats.streaks.currentStreak > 0 ? 'orange' : 'neutral',
            icon: 'flame',
            label: t('stats.currentStreak'),
            value: `${stats.streaks.currentStreak} ${t('stats.days')}`,
            hint: stats.streaks.currentStreakStart || '',
          }),
          h(KpiCard, {
            icon: 'trophy',
            label: t('stats.longestStreak'),
            value: `${stats.streaks.longestStreak} ${t('stats.days')}`,
            hint:
              stats.streaks.longestStreakStart && stats.streaks.longestStreakEnd
                ? `${stats.streaks.longestStreakStart} → ${stats.streaks.longestStreakEnd}`
                : '',
          }),
          h(KpiCard, {
            icon: 'zap',
            label: t('stats.peakHour'),
            value:
              stats.peakActivityHour === null || stats.peakActivityHour === undefined
                ? t('stats.na')
                : `${stats.peakActivityHour}:00-${stats.peakActivityHour + 1}:00`,
            hint: stats.peakActivityDay ? fullDate(new Date(`${stats.peakActivityDay}T00:00:00`).getTime()) : '',
          }),
        ),
        stats.dailyActivity.length > 0
          ? h(
              'div',
              { className: 'bs-section' },
              h(
                'div',
                { className: 'bs-section-head' },
                h('h2', { className: 'bs-section-title' }, t('stats.activity')),
              ),
              h('div', { className: 'bs-card' }, h(ActivityHeatmap, { dailyActivity: stats.dailyActivity, t })),
            )
          : null,
        (() => {
          const fact = funFact(stats, lang)
          if (!fact) return null
          return h(
            'div',
            { className: 'bs-callout' },
            h(Icon, { name: 'spark', size: 14, style: { marginTop: 3, flex: 'none', color: toneColor('purple') } }),
            h('span', null, fact),
          )
        })(),
      )
    }

    function ModelsTab({ stats, models, modelTotal, t }) {
      if (models.length === 0) return h(Empty, { title: t('stats.noData') })
      const topModels = models.slice(0, 3).map((m) => m.id)
      return h(
        React.Fragment,
        null,
        stats.dailyModelTokens.length >= 2
          ? h(
              'div',
              { className: 'bs-section', style: { marginTop: 0 } },
              h(
                'div',
                { className: 'bs-section-head' },
                h('h2', { className: 'bs-section-title' }, t('stats.tokensPerDay')),
              ),
              h(
                'div',
                { className: 'bs-card' },
                h(TokenTrend, { dailyModelTokens: stats.dailyModelTokens, models: topModels, t }),
              ),
            )
          : null,
        h(
          'div',
          { className: 'bs-section' },
          h(
            'div',
            { className: 'bs-section-head' },
            h('h2', { className: 'bs-section-title' }, t('stats.allModels')),
            h('span', { className: 'bs-section-count' }, String(models.length)),
          ),
          h(
            'div',
            { className: 'bs-card', style: { padding: 0, overflow: 'hidden' } },
            h(
              'div',
              { className: 'bs-list' },
              models.map((model, index) => {
                const share = pct(model.total, modelTotal)
                const tone = SERIES_TONES[index] || 'neutral'
                return h(
                  'div',
                  { key: model.id, className: 'bs-row' },
                  h(
                    'div',
                    { className: 'bs-row-main' },
                    h('span', {
                      className: 'bs-row-dot',
                      style: { background: toneColor(tone), opacity: tone === 'neutral' ? 0.5 : 1 },
                      'aria-hidden': true,
                    }),
                    h('span', { className: 'bs-row-name', title: model.id }, model.name),
                    h('span', { className: 'bs-row-value' }, fmtNum(model.total)),
                    h('span', { className: 'bs-row-pct' }, `${share.toFixed(1)}%`),
                  ),
                  h(Progress, { value: share, tone }),
                  h(
                    'div',
                    { className: 'bs-row-sub' },
                    h('span', null, `${t('stats.input')} `, h('b', null, fmtNum(model.inputTokens))),
                    h('span', null, `${t('stats.output')} `, h('b', null, fmtNum(model.outputTokens))),
                    model.cacheReadTokens > 0
                      ? h(
                          'span',
                          null,
                          `${t('stats.cacheHitRate')} `,
                          h('b', null, `${model.cacheHitRate.toFixed(1)}%`),
                        )
                      : null,
                    model.reasoningTokens > 0
                      ? h('span', null, `${t('stats.reasoning')} `, h('b', null, fmtNum(model.reasoningTokens)))
                      : null,
                    model.costUSD > 0
                      ? h('span', null, `${t('stats.cost')} `, h('b', null, `$${model.costUSD.toFixed(2)}`))
                      : null,
                  ),
                )
              }),
            ),
          ),
        ),
      )
    }

    function ToolsTab({ stats, t }) {
      const rows = (stats.toolUsage || []).slice(0, 20)
      if (rows.length === 0) return h(Empty, { title: t('stats.noData') })
      const top = rows[0].count || 0
      const sum = (stats.toolUsage || []).reduce((acc, row) => acc + row.count, 0)
      return h(
        'div',
        { className: 'bs-section', style: { marginTop: 0 } },
        h(
          'div',
          { className: 'bs-section-head' },
          h('h2', { className: 'bs-section-title' }, t('stats.topTools')),
          h('span', { className: 'bs-section-count' }, String(rows.length)),
          h('span', { className: 'bs-section-actions' }, 'Σ ', fmtNum(sum)),
        ),
        h(
          'div',
          { className: 'bs-card', style: { padding: '8px 8px' } },
          rows.map((row, index) => {
            const relative = top > 0 ? (row.count / top) * 100 : 0
            const share = sum > 0 ? (row.count / sum) * 100 : 0
            return h(
              'div',
              { key: row.toolName, className: 'bs-toolrow', title: `${row.toolName}: ${row.count} (${share.toFixed(1)}%)` },
              h(
                'span',
                {
                  className: 'bs-tool-rank',
                  style: index < 3 ? { color: 'var(--dsw-alias-label-primary)' } : undefined,
                },
                String(index + 1),
              ),
              h('span', { className: 'bs-tool-name' }, row.toolName),
              h('div', { className: 'bs-tool-bar' }, h(Progress, { value: relative, tone: index < 3 ? 'blue' : 'neutral', height: 8 })),
              h('span', { className: 'bs-tool-count' }, fmtNum(row.count)),
              h('span', { className: 'bs-tool-pct' }, `${share.toFixed(1)}%`),
            )
          }),
        ),
      )
    }

    // ── 侧边栏图标 ────────────────────────────────────────────────────────
    function PanelIcon({ size }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size || 18,
          height: size || 18,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M4 20V10M10 20V4M16 20v-7M22 20H2' }),
      )
    }

    // ── 注册 ──────────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'buddy-stats: dictionaries')
      const t = ctx.locale.bind(NS)
      // 页面通过闭包拿到宿主 ctx 与绑定好的 t：不依赖 slot 注入了哪些 props。
      const Page = () => h(StatsPage, { ctx, t })

      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                locale: NS,
                inject: () => ({}),
              },
              Page,
            ),
          ),
        'buddy-stats: main panel',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 40,
                locale: NS,
                label: () => t('stats.panel'),
              },
              PanelIcon,
            ),
          ),
        'buddy-stats: sidebar icon',
      )
    }

    return { inject: ['slots', 'locale'], apply, name: 'dsh-buddy-statistics-client' }
  },
})
