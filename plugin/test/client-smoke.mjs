/**
 * 浏览器半边的加载期自检（不做渲染）：
 * 用最小的 module-loader / require / ctx 替身，验证
 *   1. client.js 能被求值（无顶层语法/引用错误）；
 *   2. factory() 返回合法的 { inject, apply, name }；
 *   3. apply() 注册了预期的 locale 字典与两个 slot（main / sidebar.panellist），
 *      且注册项字段（key / id / label / locale）符合宿主契约；
 *   4. 卸载时可重入（ctx.effect 的 disposer 都被调用）。
 *
 * 不渲染 React 组件、不模拟 DOM —— 视觉效果仍需在真实页面里确认。
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

const registrations = []
const dicts = []
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
      dicts.push({ ns, locales: Object.keys(dict) })
      return () => {}
    },
    bind() {
      return (key) => key
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
    register(options) {
      registrations.push(options)
      return () => {}
    },
  },
}

plugin.apply(ctx)

const byName = new Map(registrations.map((item) => [item.name, item]))
const main = byName.get('main')
const panel = byName.get('sidebar.panellist')

const checks = []
checks.push(['locale 字典已注册', dicts.length === 1 && dicts[0].locales.length === 2])
checks.push(['注册了 main 面板', Boolean(main) && main.key === 'buddy-stats'])
checks.push(['注册了 sidebar.panellist', Boolean(panel) && panel.id === 'buddy-stats'])
checks.push(['侧边栏图标有 label 与 locale', Boolean(panel) && typeof panel.label === 'function' && panel.locale === 'buddy-stats'])
checks.push(['面板 id 与图标 id 一致', Boolean(main && panel) && main.key === panel.id])

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failed++
}

// 卸载：按逆序释放，且不允许抛错。
for (const { dispose } of effects.slice().reverse()) {
  if (typeof dispose === 'function') dispose()
}
console.log(`✓ 卸载 ${effects.length} 个 effect 无异常`)

if (failed > 0) {
  console.error(`\n${failed} 项检查失败`)
  process.exit(1)
}
console.log('\nclient-smoke 通过（渲染效果仍需真实页面确认）')
