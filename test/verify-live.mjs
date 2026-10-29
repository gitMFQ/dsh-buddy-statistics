/**
 * verify-live.mjs — 会话视图（buddyStats）改动的**活体检查**骨架（verifier 所有）。
 *
 * 目标：把「契约写了」和「运行时真的挂上、页面真的渲染」分开证明。
 * 本文件在实现者交付后才跑完整检查；默认全部只读，不碰 profile、不改源码。
 *
 * 运行环境事实（2026-10-30 实测，见 docs/verification-notes.md）：
 *   · DSH Web GUI 本机入口  http://127.0.0.1:3080/（pid 16446，--public-url 走 lucky 8443 反代）
 *   · GET /buddy-stats/data 可直接 curl，meta.sessionView 是投影是否挂上的直接信号
 *   · 浏览器/CDP：vendored ego runtime 可用，但 root 下**必须**把它指向
 *     bin/ego-chrome-wrapper.sh（自动补 --no-sandbox），否则 Chrome 起不来
 *   · cordis_inspect 的 **client** 查询在本机**不可用**（即使有已连接的活页面也超时），
 *     所以活体验证不依赖它，走 curl + 真实浏览器 DOM/截图
 *
 * 用法：
 *   node test/verify-live.mjs                 # 只读检查（默认）
 *   node test/verify-live.mjs --browser       # 额外起真实浏览器读 DOM + 截图
 *   node test/verify-live.mjs --install       # 额外执行 link 安装（会改 profile！需 lead 发令）
 *   node test/verify-live.mjs --json          # 机器可读结果
 *
 * 退出码：0 = 全部通过（允许 skip）；1 = 有 fail。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.join(import.meta.dirname, '..')
const ARGS = new Set(process.argv.slice(2))
const JSON_OUT = ARGS.has('--json')
const DO_INSTALL = ARGS.has('--install')
const DO_BROWSER = ARGS.has('--browser')

// ── 环境常量（实测值；换机需同步更新 docs/verification-notes.md） ──────────────
const GUI_LOCAL = 'http://127.0.0.1:3080'
const DATA_ROUTE = `${GUI_LOCAL}/buddy-stats/data?refresh=1`
const PROFILE = '/root/.dsh/profiles/web'
const EGO_CLI = `${PROFILE}/node_modules/dsh-ego-browser/runtime/ego-linux/bin/ego-browser.mjs`
const EGO_WRAPPER = `${PROFILE}/node_modules/dsh-ego-browser/bin/ego-chrome-wrapper.sh`
const ARTIFACT_DIR = path.join(ROOT, 'test', 'artifacts')

// ── 结果收集 ─────────────────────────────────────────────────────────────────
const results = []
function record(name, status, detail, evidence = []) {
  results.push({ name, status, detail, evidence })
  if (!JSON_OUT) {
    const tag = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', info: 'INFO' }[status] ?? status
    console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`)
    for (const line of evidence) console.log(`        ${line}`)
  }
}
function pass(name, detail, ev) { record(name, 'pass', detail, ev) }
function fail(name, detail, ev) { record(name, 'fail', detail, ev) }
function skip(name, detail, ev) { record(name, 'skip', detail, ev) }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 120_000, ...opts })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}
function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return null }
}

/**
 * 把 `const NAME = 'literal'` 这类简单常量内联掉再做模式匹配。
 * 源码把 id/locale/key 抽成了常量（PANEL_ID / NS / PROJECTION_KEY / STATE_VERSION），
 * 不必要的字面量匹配会报出**假缺陷** —— 第一版骨架就踩了这个坑。
 */
function resolveConsts(src) {
  const bindings = new Map()
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`]*)\2/g)) {
    bindings.set(m[1], m[3])
  }
  // 数字常量（PROJECTION_KEY 是字符串，STATE_VERSION 是数字）
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(-?\d+(?:\.\d+)?)\b/g)) {
    if (!bindings.has(m[1])) bindings.set(m[1], m[2])
  }
  return { bindings, text: src.replace(/\b([A-Za-z_$][\w$]*)\b/g, (w) => bindings.get(w) ?? w) }
}

/** 从 `from` 位置起找到第一个 `{`，按大括号配平取回整个对象字面量源码。 */
function objectLiteralAt(src, from) {
  const start = src.indexOf('{', from)
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  return null
}
function curlJson(url, timeoutSec = 90) {
  const r = run('curl', ['-sS', '--max-time', String(timeoutSec), url], { timeout: (timeoutSec + 10) * 1000 })
  if (r.code !== 0) return { ok: false, reason: `curl exit ${r.code}: ${r.stderr.trim()}` }
  try { return { ok: true, json: JSON.parse(r.stdout) } }
  catch (e) { return { ok: false, reason: `non-JSON body: ${r.stdout.slice(0, 200)}` } }
}

// ════════════════════════════════════════════════════════════════════════════
// 1. 静态契约检查（只读源码；实现者交付后再跑）
// ════════════════════════════════════════════════════════════════════════════
function checkArtifacts() {
  const expected = [
    'index.js', 'client.js', 'package.json',
    'lib/fold.js', 'lib/collect.js', 'lib/session-projection.js',
    'test/fold-check.mjs', 'test/fold-purity.mjs', 'test/projection-schema.mjs',
    'test/client-smoke.mjs', 'test/session-view-render.mjs',
  ]
  const missing = expected.filter((f) => !fs.existsSync(path.join(ROOT, f)))
  if (missing.length) fail('artifacts', `缺少交付物: ${missing.join(', ')}`)
  else pass('artifacts', `${expected.length} 个交付物齐全`)
  return missing.length === 0
}

/** lib/fold.js：契约 §4 的导出与 CACHE_VERSION */
async function checkFoldExports() {
  const file = path.join(ROOT, 'lib', 'fold.js')
  if (!fs.existsSync(file)) return skip('fold-exports', 'lib/fold.js 未交付')
  const mod = await import(`file://${file}?t=${Date.now()}`).catch((e) => ({ __error: e }))
  if (mod.__error) return fail('fold-exports', `import 失败: ${mod.__error.message}`)
  const problems = []
  if (mod.CACHE_VERSION !== 6) problems.push(`CACHE_VERSION=${mod.CACHE_VERSION}（契约要求 6）`)
  if (typeof mod.createSessionState !== 'function') problems.push('缺 createSessionState')
  if (typeof mod.applySessionEvent !== 'function') problems.push('缺 applySessionEvent')
  if (problems.length) fail('fold-exports', problems.join('; '))
  else pass('fold-exports', 'CACHE_VERSION=6 + createSessionState/applySessionEvent 存在')
}

/** lib/session-projection.js：契约 §3.1 的注册参数 */
function checkProjectionDefinition() {
  const raw = readIfExists(path.join(ROOT, 'lib', 'session-projection.js'))
  if (raw === null) return skip('projection-definition', 'lib/session-projection.js 未交付')
  const { text: src, bindings } = resolveConsts(raw)
  const problems = []
  if (!/key:\s*['"]?buddyStats['"]?(?![\w])/.test(src)) problems.push("缺 key: 'buddyStats'")
  if (!/stateVersion:\s*1\b/.test(src)) problems.push('缺 stateVersion: 1')
  if (!/summary:\s*false/.test(src)) problems.push('缺 wire.summary = false')
  if (!/viewSchema/.test(src)) problems.push('缺 wire.viewSchema（zod 校验）')
  if (!/\bview\s*[:(]/.test(src) && !/^\s*function\s+view\s*\(/m.test(src)) problems.push('缺 wire.view')
  const evidence = [`内联常量: ${[...bindings].map(([k, v]) => `${k}=${v}`).join(', ') || '(无)'}`]
  if (problems.length) fail('projection-definition', problems.join('; '), evidence)
  else pass('projection-definition', 'buddyStats: stateVersion 1 + summary false + view/viewSchema', evidence)
}

/** index.js 可观测性：meta.sessionView（契约 §7） */
function checkIndexMetaSessionView() {
  const src = readIfExists(path.join(ROOT, 'index.js'))
  if (src === null) return fail('index-meta', 'index.js 缺失')
  if (!/sessionView/.test(src)) return fail('index-meta', "index.js 未出现 meta.sessionView")
  const hasRegistered = /['"]registered['"]/.test(src)
  const hasUnavailable = /['"]unavailable['"]/.test(src)
  if (!hasRegistered || !hasUnavailable) {
    return fail('index-meta', `meta.sessionView 取值不全（registered=${hasRegistered}, unavailable=${hasUnavailable}）`)
  }
  pass('index-meta', "meta.sessionView 三态齐备（registered / unavailable / error: …）")
}

/** client.js 注册项契约（§2） + lead 的契约修正：不得 inject 同名标准 prop */
function checkClientRegistration() {
  const raw = readIfExists(path.join(ROOT, 'client.js'))
  if (raw === null) return fail('client-registration', 'client.js 缺失')
  const { text: src } = resolveConsts(raw)
  const problems = []
  const evidence = []

  const idx = src.indexOf("inject('conversation.view'")
  if (idx === -1) {
    problems.push("未找到 ctx.slots.inject('conversation.view', …)")
  } else {
    // 只取 ctx.slots.register(<对象>, …) 的那个对象字面量，避免把文件尾部的
    // 工厂级 `return { inject: ['slots','locale'] }` 误当成注册项字段。
    const regAt = src.indexOf('ctx.slots.register(', idx)
    const block = regAt === -1 ? null : objectLiteralAt(src, regAt)
    if (block === null) {
      problems.push('无法定位 conversation.view 的 register 对象字面量')
    } else {
      if (!/id:\s*['"]?buddy-stats['"]?(?![\w-])/.test(block)) problems.push("register 对象缺 id: 'buddy-stats'")
      if (!/order:\s*20\b/.test(block)) problems.push('register 对象缺 order: 20')
      if (!/locale:\s*['"]?buddy-stats['"]?(?![\w-])/.test(block)) problems.push("register 对象缺 locale: 'buddy-stats'")
      if (!/label:\s*\(/.test(block)) problems.push('register 对象缺函数式 label: () => t(...)')
      evidence.push(`register 对象: ${block.replace(/\s+/g, ' ').slice(0, 200)}`)
      // lead 的契约修正：注册项**不得** inject 同名标准 prop（sessionId），
      // 否则 assertNoPropOverlap 抛 SlotAssemblyError，页签挂不上。
      const injectMatch = block.match(/\binject\s*:/)
      if (injectMatch) {
        evidence.push('⚠ register 对象出现了 inject 键（契约要求不写 inject）')
        if (/\bsessionId\b/.test(block)) {
          problems.push('注册项 inject 了同名标准 prop sessionId（assertNoPropOverlap 会抛 SlotAssemblyError）')
        } else {
          problems.push('注册项写了 inject（契约 §2 修正版要求不 inject；若确需，必须证明不与标准 prop 重名）')
        }
      } else {
        evidence.push('register 对象无 inject 键 ✓（符合 §2 修正版）')
      }
    }
  }

  // 原有注册不能被挤掉（回归红线）
  for (const [needle, label] of [["'main'", 'main 整页面板'], ["'sidebar.panellist'", 'sidebar.panellist 侧边栏图标']]) {
    if (!src.includes(needle)) problems.push(`原有注册缺失: ${label} (${needle})`)
  }
  evidence.push('main / sidebar.panellist 注册检查见上')

  if (problems.length) fail('client-registration', problems.join('; '), evidence)
  else pass('client-registration', 'buddy-stats 页签字段合规；main / sidebar.panellist 原注册仍在', evidence)
}

// ════════════════════════════════════════════════════════════════════════════
// 2. 非浏览器运行时证据
// ════════════════════════════════════════════════════════════════════════════
/** npm test（实现者的自检套件） */
function checkUnitTests() {
  const r = run('npm', ['test'], { cwd: ROOT, timeout: 600_000 })
  const tail = (r.stdout + r.stderr).trim().split('\n').slice(-12)
  if (r.code === 0) pass('npm-test', 'npm test 通过', tail)
  else fail('npm-test', `npm test 退出码 ${r.code}`, tail)
}

/**
 * 活体信号 1：/buddy-stats/data 的 meta.sessionView。
 * registered  = 投影注册 resolve 成功（唯一可信的「挂上了」信号）
 * unavailable = sessionProjections 服务缺失
 * error: …    = 注册抛错
 * 缺失         = 旧代码 / 插件未加载到新代码
 */
function checkLiveMeta() {
  const res = curlJson(DATA_ROUTE)
  if (!res.ok) return fail('live-meta', `取不到 ${DATA_ROUTE}: ${res.reason}`)
  const meta = res.json?.meta ?? {}
  const sv = meta.sessionView
  const evidence = [
    `GET ${DATA_ROUTE} → ok=${res.json.ok}`,
    `meta.sessionView = ${JSON.stringify(sv)}`,
    `meta 其余键: ${Object.keys(meta).join(', ')}`,
  ]
  if (sv === 'registered') return pass('live-meta', "meta.sessionView = 'registered'", evidence)
  if (sv === 'unavailable') return fail('live-meta', "meta.sessionView = 'unavailable'（sessionProjections 服务缺失）", evidence)
  if (typeof sv === 'string' && sv.startsWith('error')) return fail('live-meta', `注册失败: ${sv}`, evidence)
  if (sv === undefined) return fail('live-meta', 'meta.sessionView 缺失 —— 线上跑的不是新代码（或插件未重载）', evidence)
  fail('live-meta', `未知取值: ${JSON.stringify(sv)}`, evidence)
}

/** 活体信号 2：profile 里装的到底是不是工作树代码（link 安装判据） */
function checkInstalledIsWorkingTree() {
  const installed = path.join(PROFILE, 'node_modules', 'dsh-buddy-statistics')
  if (!fs.existsSync(installed)) return skip('installed-code', `profile 里没有 ${installed}`)
  const isLink = fs.lstatSync(installed).isSymbolicLink()
  const pairs = ['index.js', 'client.js', 'lib/fold.js', 'lib/session-projection.js']
  const diffs = []
  for (const rel of pairs) {
    const a = path.join(ROOT, rel)
    const b = path.join(installed, rel)
    if (!fs.existsSync(a) && !fs.existsSync(b)) continue
    const sa = readIfExists(a), sb = readIfExists(b)
    if (sa !== sb) diffs.push(rel)
  }
  const evidence = [`installed = ${installed}`, `symlink = ${isLink}`, `内容不一致文件: ${diffs.join(', ') || '(无)'}`]
  if (isLink && diffs.length === 0) return pass('installed-code', 'link 安装且内容与工作树一致', evidence)
  if (!isLink) return fail('installed-code', 'profile 里是快照拷贝（非 link），活体验证的不是工作树代码', evidence)
  fail('installed-code', `link 安装但内容不一致: ${diffs.join(', ')}`, evidence)
}

/**
 * link 安装（**会写 profile**，只在 --install 下执行）。
 * plugin_manager MCP 的等价 CLI：dsh plugin --profile web add link:<path>
 * 安装后 profile/package.json 的 dsh-buddy-statistics 应记为 link:/root/dsh-buddy-statistics。
 */
function doInstall() {
  if (!DO_INSTALL) return skip('link-install', '未加 --install（默认只读）；正式验收时由 lead 发令执行')
  const r = run('dsh', ['plugin', '--profile', 'web', 'add', `link:${ROOT}`], { timeout: 300_000 })
  const tail = (r.stdout + r.stderr).trim().split('\n').slice(-8)
  const pkg = JSON.parse(readIfExists(path.join(PROFILE, 'package.json')) ?? '{}')
  const rec = pkg.dependencies?.['dsh-buddy-statistics']
  const evidence = [...tail, `profile 记录: ${JSON.stringify(rec)}`]
  if (r.code === 0 && typeof rec === 'string' && rec.startsWith('link:')) {
    pass('link-install', `link 安装完成，profile 记录 ${rec}`, evidence)
  } else {
    fail('link-install', `安装失败（exit ${r.code}）或记录不是 link:`, evidence)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 3. 浏览器证据（真实 Chromium + CDP；--browser 才跑）
// ════════════════════════════════════════════════════════════════════════════
/**
 * 用 vendored ego runtime 开真页面，读 DOM + 截图。
 *
 * 实测要点（踩过的坑）：
 *   · root 必须设 EGO_LINUX_CHROME=<wrapper>，否则 Chrome 以 root 启动直接失败
 *     （报 "Chrome did not expose a DevTools port within 20000ms"）
 *   · heredoc 里**没有** SKILL.md 那套 helper（snapshotText/cliLog/openOrReuseTab），
 *     可用的是 SDK 风格全局：ego / page / taskSpaces / cdp / snapshot / listTabs / createTab
 *   · 页面 URL 本机不需要 token（http://127.0.0.1:3080/ 直接可开）；
 *     要进具体会话可读 localStorage 的 dsh.sessions.current
 */
function browserEvidence() {
  if (!DO_BROWSER) return skip('browser-dom', '未加 --browser（正式验收时执行）')
  if (!fs.existsSync(EGO_CLI)) return skip('browser-dom', `ego runtime 不可用: ${EGO_CLI}`)

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
  // 先停掉上一次遗留的浏览器：反复跑会累积大量 task space / 标签，
  // 实测会让后续 Page.navigate / Runtime.evaluate 超时。
  run('node', [EGO_CLI, '--stop'], { env: { ...process.env, EGO_LINUX_CHROME: EGO_WRAPPER }, timeout: 90_000 })
  const script = `
const out = { steps: [] };
out.shot = null;
// 用**新建** task space：ego.createTaskSpace 每次都开新的 browser context
// （实测 id 递增），单标签绑定可靠；复用旧 space 时 page 会绑到残留的 about:blank，
// page.info() 直接抛错。代价是新 context 没有历史 localStorage，页面可能停在
// workspace chooser —— 那种情况本检查如实报 SKIP，不判 FAIL。
const readTabs = async function () {
  const t = await page.evaluate("Array.from(document.querySelectorAll('[role=tab]')).map(function(e){return (e.textContent||'').trim()})").catch(() => []);
  return Array.isArray(t) ? t : [];
};
try {
  const sp = await ego.createTaskSpace('dsh-buddy-stats verify-live');
  out.taskSpace = sp && sp.id;
  await ego.createTab(${JSON.stringify(GUI_LOCAL + '/')});
  await page.waitForLoadState('load').catch(e => out.steps.push('waitForLoadState: ' + e.message));
  await page.waitForTimeout(7000);
  out.info = await page.info().catch(e => 'page.info failed: ' + e.message);
  out.currentSession = await page.evaluate("localStorage.getItem('dsh.sessions.current')").catch(() => null);
  out.inlineTabs = await readTabs();
  // 没落在会话视图时，依次尝试两种**只读**恢复动作（都不新建会话、不改设置）：
  //   1) 点侧边栏的全局「统计」面板开关 —— 它打开时会把会话视图整块盖住（实测）；
  //   2) 点会话列表里的条目。
  if (!out.inlineTabs.includes('Chat')) {
    out.toggledGlobalPanel = await page.evaluate("(function(){var bs=Array.from(document.querySelectorAll('button'));var b=bs.filter(function(x){var n=(x.getAttribute('aria-label')||x.textContent||'').trim();return n==='Statistics'||n==='\\u7edf\\u8ba1'})[0];if(!b)return false;b.click();return true})()").catch(() => false);
    await page.waitForTimeout(4000);
    out.inlineTabs = await readTabs();
  }
  if (!out.inlineTabs.includes('Chat')) {
    out.clickedSession = await page.evaluate("(function(){var it=document.querySelector('[role=treeitem]');if(!it)return false;it.click();return true})()").catch(() => false);
    await page.waitForTimeout(4000);
    out.inlineTabs = await readTabs();
  }
  out.onConversation = out.inlineTabs.includes('Chat');
  if (out.onConversation) {
    // buddy-stats（order 20）排 chat(0)/trajectory(10) 之后，
    // 实测被宿主折进「More conversation views」溢出菜单（aria-haspopup=menu）。
    out.overflow = await page.evaluate("(function(){var bs=Array.from(document.querySelectorAll('button'));var b=bs.filter(function(x){var n=(x.getAttribute('aria-label')||'')+' '+(x.textContent||'');return x.getAttribute('aria-haspopup')==='menu'&&/conversation views|\\u4f1a\\u8bdd\\u89c6\\u56fe|\\u66f4\\u591a/.test(n)})[0];if(!b)return{found:false};if(b.getAttribute('aria-expanded')!=='true')b.click();return{found:true,label:b.getAttribute('aria-label')}})()").catch(e => ({ found: false, error: String(e.message || e) }));
    await page.waitForTimeout(1200);
    const items = await page.evaluate("Array.from(document.querySelectorAll('[role=menuitem]')).map(function(e){return (e.textContent||'').trim()})").catch(() => []);
    out.menuItems = Array.isArray(items) ? items : [];
    out.hasBuddyEntry = out.menuItems.some(function (t) { return t === 'Statistics' || t === '\\u7edf\\u8ba1'; });
    out.clicked = await page.evaluate("(function(){var it=Array.from(document.querySelectorAll('[role=menuitem]')).filter(function(e){var t=(e.textContent||'').trim();return t==='Statistics'||t==='\\u7edf\\u8ba1'})[0];if(!it)return false;it.click();return true})()").catch(() => false);
    await page.waitForTimeout(4500);
    const body = await page.evaluate("document.body.innerText").catch(() => '');
    out.markers = {
      cacheHitRate: /Cache hit rate|\\u7f13\\u5b58\\u547d\\u4e2d\\u7387/.test(body),
      tokenComposition: /Token composition|Token \\u6784\\u6210/.test(body),
      turnOutcomes: /Turn outcomes|\\u56de\\u5408\\u7ed3\\u679c/.test(body),
      compactions: /Compactions|\\u538b\\u7f29/.test(body),
      wallSpan: /Wall span|\\u5899\\u949f\\u8de8\\u5ea6/.test(body),
      sessionInfo: /Session info|\\u4f1a\\u8bdd\\u4fe1\\u606f/.test(body),
    };
    out.panelSample = body.slice(-600);
  }
} catch (e) { out.fatal = String((e && e.message) || e); }
console.log('RESULT=' + JSON.stringify(out));
// 截图留证：page.screenshot(options?) → Promise<string>（实测不传 path 返回临时路径）
try { out.shot = await page.screenshot({ path: ${JSON.stringify(path.join(ARTIFACT_DIR, 'gui-session-view.png'))} }); console.log('SHOT=' + out.shot); }
catch (e) { console.log('SHOT=failed: ' + e.message); }
`
  const r = run('node', [EGO_CLI, 'nodejs'], {
    input: script,
    env: { ...process.env, EGO_LINUX_CHROME: EGO_WRAPPER },
    timeout: 300_000,
  })
  const line = (r.stdout + r.stderr).split('\n').find((l) => l.startsWith('RESULT='))
  const shotLine = (r.stdout + r.stderr).split('\n').find((l) => l.startsWith('SHOT='))
  const evidence = [shotLine ?? 'SHOT=(无)', `exit=${r.code}`]
  if (!line) {
    return fail('browser-render', 'browser heredoc 未产出 RESULT（看 stderr）', [
      ...(r.stderr.trim().split('\n').slice(-6)), ...evidence,
    ])
  }
  const out = JSON.parse(line.slice('RESULT='.length))
  evidence.unshift(
    `page.info = ${JSON.stringify(out.info)}`,
    `taskSpace = ${JSON.stringify(out.taskSpace)}  dsh.sessions.current = ${JSON.stringify(out.currentSession)}`,
    `会话内联页签 = ${JSON.stringify(out.inlineTabs)}`,
    `溢出菜单 = ${JSON.stringify(out.overflow)}  菜单项 = ${JSON.stringify(out.menuItems)}`,
    `渲染区块指纹 = ${JSON.stringify(out.markers)}`,
  )
  if (out.fatal && !out.onConversation) {
    return skip('browser-render', `浏览器通道本次不可用（${out.fatal}）—— 未断言渲染，见 notes 的手工复现步骤`, evidence)
  }
  // 页面没落在会话视图时**不判 FAIL**：GUI 的入口状态取决于浏览器 profile 与
  // 用户当前工作区/会话，验收者不得为了看页面去新建会话或改用户状态。
  if (!out.onConversation) {
    return skip('browser-render', `页面未落在会话视图（内联页签=${JSON.stringify(out.inlineTabs)}），未断言渲染`, evidence)
  }
  if (out.fatal) return fail('browser-render', `已在会话视图但断言中途抛错: ${out.fatal}`, evidence)
  const problems = []
  for (const tab of ['Chat', 'Trajectory']) if (!out.inlineTabs.includes(tab)) problems.push(`原有内联页签 ${tab} 不见了`)
  if (!out.overflow?.found) problems.push('找不到「更多会话视图」溢出按钮（宿主 DOM 变了？）')
  if (!out.hasBuddyEntry) problems.push('溢出菜单里没有 Statistics/统计 项 —— buddy-stats 页签没挂上')
  if (!out.clicked) problems.push('无法点击 Statistics 菜单项')
  for (const [k, ok] of Object.entries(out.markers ?? {})) if (!ok) problems.push(`渲染内容缺少区块：${k}`)
  if (problems.length) fail('browser-render', problems.join('; '), evidence)
  else pass('browser-render', '真实页面：溢出菜单出现 buddy-stats 入口，点开后渲染出本插件会话统计各区块', evidence)
}

// ════════════════════════════════════════════════════════════════════════════
function main() {
  console.log(`# verify-live — ${new Date().toISOString()}  (root=${ROOT})`)
  console.log(`# flags: install=${DO_INSTALL} browser=${DO_BROWSER} json=${JSON_OUT}`)
  checkArtifacts()
  checkClientRegistration()
  checkProjectionDefinition()
  checkIndexMetaSessionView()
  checkUnitTests()
  doInstall()
  checkInstalledIsWorkingTree()
  checkLiveMeta()
  browserEvidence()

  const fails = results.filter((r) => r.status === 'fail')
  const summary = {
    pass: results.filter((r) => r.status === 'pass').length,
    fail: fails.length,
    skip: results.filter((r) => r.status === 'skip').length,
  }
  if (JSON_OUT) console.log(JSON.stringify({ summary, results }, null, 2))
  else console.log(`\n# 小计: pass=${summary.pass} fail=${summary.fail} skip=${summary.skip}`)
  process.exitCode = fails.length ? 1 : 0
}

main()
