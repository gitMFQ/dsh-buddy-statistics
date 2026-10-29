/**
 * 浏览器半边的加载期自检（不做渲染）：
 * 用最小的 module-loader / require / ctx 替身，验证
 *   1. client.js 能被求值（无顶层语法/引用错误）；
 *   2. factory() 返回合法的 { inject, apply, name }；
 *   3. apply() 注册了预期的 locale 字典与三个 slot（main / sidebar.panellist /
 *      conversation.view），且注册项字段（key / id / order / label / locale）符合宿主契约；
 *   4. conversation.view 页签：id=buddy-stats、order=20、locale=buddy-stats、
 *      label 是函数且返回中文「统计」，第二参数是组件函数（而不是包装器）；
 *   5. i18n：zh/en 键集合完全一致，且源码里所有 t('…') 字面量键都存在（缺一个就露 key）；
 *   6. 卸载时可重入（ctx.effect 的 disposer 都被调用，且可以再 apply 一次）。
 *
 * 不渲染 React 组件、不模拟 DOM —— 渲染断言见 test/session-view-render.mjs。
 *
 * 用法：node test/client-smoke.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const file = path.join(import.meta.dirname, '..', 'client.js')
const source = fs.readFileSync(file, 'utf8')

let definition = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(def) {
        definition = def
      },
    },
  },
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

if (!definition) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
if (typeof definition.id !== 'string' || definition.id !== 'dsh-buddy-statistics') {
  throw new Error(`client module id 不对：${definition.id}`)
}
if (typeof definition.factory !== 'function') throw new Error('缺少 factory')

// 极简 React：组件在本测试里不会被渲染，只要求 factory 求值时不自爆。
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}

const plugin = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`未预期的模块依赖：${name}`)
})

if (!plugin || typeof plugin.apply !== 'function') throw new Error('factory 没有返回 apply')
if (!Array.isArray(plugin.inject) || !plugin.inject.includes('slots')) {
  throw new Error('inject 里缺少 slots')
}

/** 每次 apply 都建一套全新的假 ctx，方便验证可重入。 */
function makeHarness() {
  const registrations = []
  const dicts = new Map()
  const effects = []
  const ctx = {
    effect(callback, label) {
      const dispose = callback()
      effects.push({ label, dispose })
      return dispose
    },
    on() {
      return () => {}
    },
    locale: {
      register(ns, dict) {
        dicts.set(ns, dict)
        return () => {}
      },
      bind(ns) {
        return (key, params) => {
          const dict = dicts.get(ns) || {}
          const template =
            dict.zh && dict.zh[key] !== undefined
              ? dict.zh[key]
              : dict.en && dict.en[key] !== undefined
                ? dict.en[key]
                : key
          if (typeof template !== 'string' || !params) return template
          return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
        }
      },
      subscribe() {
        return () => {}
      },
      getSnapshot() {
        return { active: 'zh' }
      },
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
  return { ctx, registrations, dicts, effects }
}

const first = makeHarness()
plugin.apply(first.ctx)

const byName = new Map(first.registrations.map((item) => [item.options.name, item]))
const main = byName.get('main')
const panel = byName.get('sidebar.panellist')
const view = byName.get('conversation.view')

const localeDict = first.dicts.get('buddy-stats')
const zh = (localeDict && localeDict.zh) || {}
const en = (localeDict && localeDict.en) || {}

const checks = []
checks.push(['locale 字典已注册', first.dicts.size === 1 && Boolean(zh && en) && Object.keys(zh).length > 0])
checks.push(['注册了 main 面板', Boolean(main) && main.options.key === 'buddy-stats'])
checks.push(['注册了 sidebar.panellist', Boolean(panel) && panel.options.id === 'buddy-stats'])
checks.push([
  '侧边栏图标有 label 与 locale',
  Boolean(panel) && typeof panel.options.label === 'function' && panel.options.locale === 'buddy-stats',
])
checks.push(['面板 id 与图标 id 一致', Boolean(main && panel) && main.options.key === panel.options.id])

// ── 新增：conversation.view 页签 ────────────────────────────────────────
checks.push(['注册了 conversation.view', Boolean(view)])
checks.push([
  'conversation.view 的 name/id/locale 正确',
  Boolean(view) && view.options.name === 'conversation.view' && view.options.id === 'buddy-stats' && view.options.locale === 'buddy-stats',
])
checks.push(['conversation.view order = 20', Boolean(view) && view.options.order === 20])
checks.push([
  'conversation.view 不写 inject（避免与标准 prop 重名）',
  Boolean(view) && view.options.inject === undefined,
])
checks.push(['conversation.view label 是函数', Boolean(view) && typeof view.options.label === 'function'])
checks.push(['conversation.view label() 返回「统计」', Boolean(view) && view.options.label() === '统计'])
checks.push(['conversation.view 第二参数是组件函数', Boolean(view) && typeof view.component === 'function'])
checks.push([
  '三个注册项 id 一致',
  Boolean(main && panel && view) && main.options.key === 'buddy-stats' && panel.options.id === 'buddy-stats' && view.options.id === 'buddy-stats',
])
checks.push(['注册项顺序：sidebar 40 / conversation 20', Boolean(panel && view) && panel.options.order === 40 && view.options.order === 20])

// ── i18n：zh/en 成对 + 源码字面量键都存在 ───────────────────────────────
const zhKeys = Object.keys(zh).sort()
const enKeys = Object.keys(en).sort()
const missingInEn = zhKeys.filter((key) => !(key in en))
const missingInZh = enKeys.filter((key) => !(key in zh))
checks.push([`zh/en 键数量一致（zh ${zhKeys.length} / en ${enKeys.length}）`, missingInEn.length === 0 && missingInZh.length === 0])
if (missingInEn.length > 0 || missingInZh.length > 0) {
  console.error('  zh 缺：', missingInZh.join(', ') || '(无)')
  console.error('  en 缺：', missingInEn.join(', ') || '(无)')
}

// 重复键：对象字面量里后写的会静默覆盖先写的（曾把全局页的 stats.session.title 覆盖掉）。
function duplicateKeys(block) {
  const keys = [...block.matchAll(/'([^']+)':/g)].map((match) => match[1])
  return [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))]
}
const dictsSource = source.slice(source.indexOf('const DICTS = {'), source.indexOf('\n    }\n', source.indexOf('const DICTS = {')))
const zhBlock = dictsSource.split('zh: {')[1].split(/\n      \},/)[0]
const enBlock = dictsSource.split('en: {')[1].split(/\n      \},/)[0]
const zhDup = duplicateKeys(zhBlock)
const enDup = duplicateKeys(enBlock)
checks.push([`DICTS 无重复键（zh：${zhDup.join(',') || '无'} / en：${enDup.join(',') || '无'}）`, zhDup.length === 0 && enDup.length === 0])
checks.push([
  '全局页既有会话栏文案未被覆盖',
  zh['stats.session.title'] === '当前会话' && en['stats.session.title'] === 'Current session',
  zh['stats.session.recent'] === '最近会话' && en['stats.session.recent'] === 'Latest session',
])

const sessionKeys = zhKeys.filter((key) => key.startsWith('stats.session.'))
checks.push([`stats.session.* 键已补 ${sessionKeys.length} 条`, sessionKeys.length >= 40])
checks.push(['stats.session.tab 中文为「统计」', zh['stats.session.tab'] === '统计'])
checks.push(['stats.session.tab 英文为 Statistics', en['stats.session.tab'] === 'Statistics'])
const OUTCOME_KEYS = ['completed', 'aborted', 'blocked', 'error', 'maxTokens', 'interrupted', 'forked']
checks.push([
  '回合结果七项文案 zh/en 齐全',
  OUTCOME_KEYS.every((key) => {
    const id = `stats.session.outcome.${key}`
    return typeof zh[id] === 'string' && zh[id] !== '' && typeof en[id] === 'string' && en[id] !== ''
  }),
])
checks.push([
  '带占位符的键 zh/en 占位符一致',
  zh['stats.session.contextUsage'].includes('{used}') &&
    en['stats.session.contextUsage'].includes('{total}') &&
    zh['stats.session.hourBucket'].includes('{hour}') &&
    en['stats.session.hourBucket'].includes('{count}') &&
    zh['stats.session.decodeRate'].includes('{value}') &&
    en['stats.session.decodeRate'].includes('{value}'),
])

const literalKeys = new Set()
for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) literalKeys.add(match[1])
// 本轮改动前全局页 OverviewTab 用了 t('stats.activity')，但 DICTS 里没有这个键（页面会露出 key）。
// lead 在集成阶段补齐了 zh/en，从此白名单为空：任何漏键都直接失败。
const PREEXISTING_MISSING = new Set()
const unknownLiterals = [...literalKeys].filter((key) => (!(key in zh) || !(key in en)) && !PREEXISTING_MISSING.has(key))
checks.push([`源码 t('…') 字面量键全部存在（${literalKeys.size} 个，无豁免）`, unknownLiterals.length === 0])
if (unknownLiterals.length > 0) console.error('  未定义：', unknownLiterals.join(', '))
checks.push([
  'stats.session.* 文案全覆盖',
  [...literalKeys].filter((key) => key.startsWith('stats.session.')).every((key) => key in zh && key in en),
])

// ── 卸载 + 可重入 ───────────────────────────────────────────────────────
let unloadError = null
try {
  for (const { dispose } of first.effects.slice().reverse()) {
    if (typeof dispose === 'function') dispose()
  }
} catch (cause) {
  unloadError = cause
}
checks.push([`卸载 ${first.effects.length} 个 effect 无异常`, unloadError === null])

let reapplyError = null
const second = makeHarness()
try {
  plugin.apply(second.ctx)
} catch (cause) {
  reapplyError = cause
}
checks.push([
  '卸载后可重入（第二次 apply 注册齐全）',
  reapplyError === null && second.registrations.length === first.registrations.length,
])

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failed++
}

if (failed > 0) {
  console.error(`\n${failed} 项检查失败`)
  process.exit(1)
}
console.log('\nclient-smoke 通过（渲染效果见 test/session-view-render.mjs 与真实页面）')
