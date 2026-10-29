# 会话视图（buddyStats）验收记录

> 验收者：verifier（独立验收，只读源码；本文件与 `test/verify-live.mjs` 是仅有的两处写入）。
> 验收对象：会话视图「统计」页签这一轮改动（`lib/fold.js` / `lib/session-projection.js` / `client.js` / `index.js`）。
> 结论口径：**已验证** = 有命令与真实输出；**未验证** = 明确写清楚没做。

## 0. 结论摘要（≤20 行）

1. **通过**。契约 §2/§3/§4/§7 逐条核对一致，离线自检 `npm test` exit 0（fold-purity 57、projection-schema 25、fold-check、client-smoke、session-view-render 68 断言）。
2. **口径未变**：我独立把 HEAD 的旧实现与工作区新实现喂同一批真实日志对比 —— 187 个会话 / 88,360 事件，**旧有 20 个字段 0 差异**（只在两边都有的字段上比，本轮新增字段另列）。
3. **新计数器真值**：149 个根会话 / 66,995 事件，turns=242、steps=8453、retries=76、toolErrors=280，与我自己按事件类型数的**原始计数逐项 0 不符**；outcomes 分布 completed 176 / error 28 / aborted 26 / maxTokens 3 / interrupted 9 全部对上。
4. `llm/retry` 与 `llm/retry-started` 全库 176:176、27 个会话按 retryId **全部配对**，只计后者不会翻倍；`compaction/prune` 不计入的正确性在唯一一个有压缩的会话上得到验证（1×start + 3×prune + 1×summary + 1×end → compactions=1）。
5. **契约 §3.2 view 逐字段**：真实会话折叠后 `stateSchema`/`wire.viewSchema` 各 8/8 通过，字段既不缺也不多，不含 `days` 与 `open*` 内部游标，`hours` 24 桶，outcomes/tokens 键齐全；载荷实测 1205–1887 B。
6. **活体**：link 安装后 `GET /buddy-stats/data` → `meta.sessionView = "registered"`、`ok=true`、`meta.files=187`（HTTP 200，热路径 1.48s）。
7. **原注册未被挤掉**：源码级 `main`/`sidebar.panellist` 仍在；真实页面上全局统计面板正常渲染（Sessions 149、Total Tokens 1298.1M，与 curl 的 `tokens.total=1295967936` 一致），会话视图 Chat / Trajectory 内联页签仍在。
8. **页面真的渲染（手工，原始输出已留档）**：真实 Chromium 打开 GUI → 会话视图溢出菜单里出现 `Statistics` 入口 → 点开后渲染出本插件全部区块（Token 构成 / 缓存命中率 / 上下文占用 / 模型明细 / 工具排行 / 回合结果 / 压缩重试 / 小时分布 / 会话信息）。
9. **数字真值交叉核对**：渲染面板 `Turns 5 / Steps 21 / Messages 30 / tool calls 19 / Tool errors 5 / Wall span 225h 4m 33s`，与我自己离线折叠 `dsh.sessions.current` 那个会话的结果（turns 5、steps 21、msgs 30、toolCalls 19、toolErrors 5、spanMs 810273193 = 225h4m33s）**完全一致**。
10. **缺陷 0 个**，无需 owner 修复。lead 列的 7 条已知偏差我逐条实测后判定**均可接受**（§6）。
11. 两处**未验证**：①真实页面上的中文标签（离线断言覆盖，真页面当前是英文 UI，只观测到 `Statistics`）；②浏览器自动断言脚本在当前 GUI 状态下会 SKIP（手工已验，见 §5.4）。
12. 唯一需要 lead 处理的遗留：profile 目前是 **link 安装**（指向工作树），需按 §7 还原成 github 源。

---

## 1. 冻结版本

验收期间工作树冻结。以下 hash 是本记录的基准（任何后续改动都不在本记录覆盖范围内）。

```
HEAD  ef5698489c8f876039a4a9af53fd157fec675aeb

7e92be50a21ea0c48e006f09ef0c8aca  client.js
cb00610ceaffe8b2d108e8a826cb7b80  index.js
045f5a561e1a7df2396e99f725ae5188  package.json
0a79acc20b74ad48c9b0d28f6b39e14a  cordis.patch.yml
0c981c753120bcdf38a0b9b1ca2aeb53  lib/aggregate.js      (未改动)
550776f85bb564e9b4c5e374734a5cec  lib/collect.js
c1241eff0c1ad8f7636b7669bcf4fbac  lib/fold.js
d71e9355db9010c9045bb1492dacaca5  lib/session-projection.js
bf2fe895fe1d0b7ad738b4dfc793d100  test/client-smoke.mjs
7de03d0ddc2b71faefd2be7c2be11e3e  test/fold-check.mjs
91d1089c8abe16d4d9f4606f1ea3011a  test/fold-purity.mjs
23016daa39aca440d174b6c2dc18a6a9  test/projection-schema.mjs
3e47aaff38bd181ee40dc151a941cee6  test/session-view-render.mjs
7673cc96f6a554342e4e17037ffd70be  test/verify-live.mjs
b2503db92b2bf6998a952f3b4700e6a2  locale/en.json
188f85bd5f8cb1a3a803b895cd17e171  locale/zh.json
```

---

## 2. 验收矩阵（每条结论 → 命令 → 真实输出）

| # | 结论 | 命令 | 状态 |
| --- | --- | --- | --- |
| V1 | 交付物齐全、离线自检全绿 | `npm test` | 已验证 |
| V2 | 口径未变（旧 vs 新，全库） | `node /tmp/parity-all.mjs` | 已验证 |
| V3 | 新计数器为真值、无重复计 | `node /tmp/verify-counters.mjs` | 已验证 |
| V4 | retry 配对 / compaction 语义 | `node /tmp/audit2.mjs`、`/tmp/find-compaction.mjs` | 已验证 |
| V5 | 契约 §3.2 view 逐字段 + zod + 载荷 | `node /tmp/audit2.mjs` | 已验证 |
| V6 | 注册项字段 / 无 inject 重名 / 原注册 | `node test/verify-live.mjs` → `client-registration` | 已验证 |
| V7 | link 安装 + 装了工作树代码 | `plugin_manager remove_bundle` → `install_bundle` | 已验证 |
| V8 | 投影真的挂上 | `curl /buddy-stats/data` → `meta.sessionView` | 已验证 |
| V9 | 全局页未被挤掉 | 真页面点击侧边栏「统计」 | 已验证 |
| V10 | 会话视图页签真的渲染 + 数字真值 | 真页面溢出菜单 → Statistics | 已验证（手工） |
| V11 | 真实页面中文标签 | — | **未验证** |
| V12 | 客户端 `Slots` inspect 占用者 | `cordis_inspect_query client Slots` | **不可用**（超时） |

### V1 — 离线自检

```console
$ npm test
EXIT=0
fold-purity: 57 项断言全部通过
✓ projection-schema: 25 项断言全部通过（zod: /root/dsh-buddy-statistics/node_modules/zod/index.js）
client-smoke 通过（渲染效果见 test/session-view-render.mjs 与真实页面）
session-view-render 通过（68 项断言，无 react-dom）
```

覆盖度核对（不只复述）：`fold-purity` 断言了「不关心的事件返回同一引用」「关心的事件返回新引用且旧 state 不被改」「合成事件流下 turns/steps/apiMs/activeMs/tokens/tools 数值」；`projection-schema` 用真 zod 校验 state/view；`session-view-render` 用自写 tree-walker 覆盖空态/数据态/缺 `buddyStats` 降级/只有 buddyStats 降级/无定价/畸形投影。与契约 §4 的纯度要求逐条对应，**覆盖是真的**。

### V2 — 独立复核「口径未变」（我自己写的对比脚本，不复用实现者的测试）

做法：`git show HEAD:lib/collect.js > /tmp/old-collect.js`（旧实现原地改 state + 外部 `stepStarts` Map），与 `lib/fold.js`（新实现，返回新引用）**喂同一份完整事件列表**，逐字段深比较（只比两边都有的字段；本轮新增的 `steps/compactions/retries/outcomes/open*` 排除）。

```console
$ node /tmp/cmp-oldnew.mjs          # 只根会话（离线可判定继承切点的那批）
scanned files            : 187
root sessions compared   : 149
skipped child/fork       : 38
events folded (root)     : 66975
sessions with any diff   : 0
diff field histogram     : {}

$ node /tmp/parity-all.mjs          # 全部 187 个会话（纯折叠语义对比）
sessions compared (ALL, incl. children) : 187
events folded                           : 88360
sessions with any pre-existing-field diff: 0
diff histogram                          : {}
```

结论：**旧有字段逐字节一致**，本轮新增字段之外没有口径漂移。这比「复述实现者的 187/187」更强：我覆盖了 187 个会话（含子代理/fork）的全部 88,360 个事件。

### V3 — 新计数器真值（我自己按事件类型数）

```console
$ node /tmp/verify-counters.mjs
root sessions            : 149
events folded            : 66995
--- 折叠状态 vs 原始计数 ---
turns                    : 242 | outcomes: {"completed":176,"error":28,"aborted":26,"maxTokens":3,"interrupted":9}
steps                    : 8453 | apiMs: 229280s
compactions              : 0
retries                  : 76
toolErrors               : 280
mismatches               : 0 []
--- 推送频率 ---
apply 返回新引用的比例     : 66994/66995 = 100.00%
```

- `turns/steps/retries/toolErrors/outcomes` 与原始事件计数**逐项相等**，`mismatches = 0`。
- 根会话里 `compactions = 0`：不是漏计，而是**根会话里根本没有压缩事件**（见 V4）。
- 事件类型分布（前 8）：`tool/call 10138`、`tool/result 10136`、`step/start 8455`、`step/end 8453`、`assistant/message 8408`、`job/registered 5960`、`job/settled 5954`、`user/message 1017`；`turn/start 244` vs `turn/end 242`（有会话在回合中途结束，合理）。

### V4 — retry 配对与 compaction 语义

```console
$ node /tmp/audit2.mjs
=== (a) 全库事件类型（含子代理/fork，187 个会话） ===
distinct event types     : 47
compaction 相关事件类型   : [["compaction/prune",3],["compaction/start",1],["compaction/summary",1],["compaction/end",1]]
retry 相关事件类型        : [["llm/retry",176],["llm/retry-started",176]]
=== (b) 逐会话（根会话）重复审计 ===
会话内 (turn,step) 有多次 step/end : 0 个会话
会话内同一 turn 有多次 turn/start  : 0 个会话
出现「连续两个 step/end」的会话     : 0 个会话（这是新旧实现唯一会分歧的形态）

$ node /tmp/parity-all.mjs   # retry 配对段
  有 retry 事件的会话数                  : 27
  存在未配对 retryId 的会话数            : 0
```

全库**只有一个**会话有压缩事件，我把它单独提出来验证：

```console
$ node /tmp/find-compaction.mjs
session        : session-4198bc18-9ebb-44dd-9030-9b943a7a4671
origin/parent  : (root) / session-00753b94-5705-4f4c-a6b4-f3c642a67254
compaction 事件 : [prune@1597, prune@1599, prune@1601, start@1603, summary@1604, end@1606]
fold.compactions: 1
原始 compaction/start 计数: 1
```

→ 一次压缩只发 1 条 `compaction/start`；3 条 `prune` 是裁剪**不是**压缩，不计入 —— 与 fold.js 的注释一致，**且已用真实数据验证**。
→ 新旧实现在本机语料上不会分歧的原因也测清楚了：**会话内不存在 (turn,step) 重复**（旧实现按 `turn:step` 键取值、新实现单槽结算后清空，只有会话内重复才会分歧）。

### V5 — 契约 §3.2 view 逐字段 + zod + 载荷

```console
$ node /tmp/audit2.mjs
=== (c) 契约 §3.2 view 核对（含 pricing 的模型） ===
PASS session-a8041f15-...  events=962  view=1280B spanMs=33496759  models=2 tools=4  cost=0                hasPricing=true
PASS session-1850c6a7-...  events=1219 view=1780B spanMs=38931433  models=2 tools=19 cost=1.198906884      hasPricing=true
PASS session-e1dd93e9-...  events=1863 view=1773B spanMs=6466869   models=1 tools=24 cost=0                hasPricing=true
PASS session-1dd1ad14-...  events=2520 view=1643B spanMs=21856009  models=4 tools=7  cost=0                hasPricing=true
PASS session-a7152151-...  events=2524 view=1340B spanMs=1098041024 models=1 tools=10 cost=2.121817936     hasPricing=true
PASS session-bd609600-...  events=1626 view=1887B spanMs=50462877  models=2 tools=21 cost=0.8888343519999999 hasPricing=true
PASS session-441fa35c-...  events=1956 view=1205B spanMs=1162114737 models=1 tools=7  cost=0               hasPricing=true
PASS session-7fa06f1a-...  events=1327 view=1235B spanMs=4437554   models=1 tools=8  cost=0.377092268      hasPricing=true
view 载荷大小范围        : 1205 ~ 1887 bytes
子代理会话 view.origin   : "subagent" | id: ok | parent: "session-e6a44af7-33d1-4a34-b9a9-4366eb59afe1"
header 无 id 时 view.id  : "" (lead 记录的偏差)
```

核对方式：对每个真实会话折叠 → `stateSchema.parse(state)` → `wire.view(state)` → `wire.viewSchema.parse(view)`；同时断言 §3.2 的 29 个顶层字段**既不缺也不多**、`outcomes` 7 键、`tokens` 7 键、`hours` 恰好 24 桶、view 里**不存在** `days` 与任何 `openStep*/openTurn*` 内部游标。→ 8/8 全 PASS。

口径抽样复核（与 `lib/aggregate.js` 同口径）：
- `tokens.total = input + output + cacheRead + cacheWrite`；
- `cacheHitRate = cacheRead / (input+cacheRead+cacheWrite) × 100`（分母 0 取 0）。真实页面上的会话：`Cache read 18.2k`、`Input 347.9k`、`Cache hit rate 5.0%` → 18200/(347900+18200+0) = **4.97%** ✓；`Total 371.2k = 347.9k+5.1k+18.2k+0` ✓。

### V6 — 注册项与「原注册未被挤掉」

```console
$ node test/verify-live.mjs
[PASS] client-registration — buddy-stats 页签字段合规；main / sidebar.panellist 原注册仍在
        register 对象: { name: 'conversation.view', id: buddy-stats, order: 20, locale: buddy-stats, label: () => t('stats.session.tab'), }
        register 对象无 inject 键 ✓（符合 §2 修正版）
[PASS] projection-definition — buddyStats: stateVersion 1 + summary false + view/viewSchema
        内联常量: PROJECTION_KEY=buddyStats, STATE_VERSION=1, VIEW_VERSION=1
[PASS] index-meta — meta.sessionView 三态齐备（registered / unavailable / error: …）
```

`client.js` 的注册项**没有** `inject` 键 —— lead 那条契约修正（inject 同名标准 prop `sessionId` 会触发 `assertNoPropOverlap` 抛 `SlotAssemblyError`）在源码与**真实页面**两处都得到确认：页签真的挂上了（若冲突，它根本挂不上）。

**全局页文案变化复核（lead 指定）**：`client.js` 本轮 +1005 行，hunk 只有 6 处：

```
@@ -43,6 +43,7 @@     ← zh 字典，+1 行
@@ -73,6 +74,62 @@    ← 新增 zh 的 stats.session.* 块
@@ -96,6 +153,7 @@    ← en 字典，+1 行
@@ -126,6 +184,62 @@   ← 新增 en 的 stats.session.* 块
@@ -1343,6 +1457,878 @@ ← 新增 SessionStatsView 组件
@@ -1402,6 +2388,25 @@ ← 新增 conversation.view 注册
```

```console
$ git diff client.js | grep -E '^[-+].*(stats\.activity)'
+        'stats.activity': '活动',
+        'stats.activity': 'Activity',
```

→ 全局页只有这两行字典新增（zh/en 各一条，键名与此前漏键一致），`-` 行 0 条；渲染逻辑的改动全部落在 1457 行之后的新组件里，**旧有全局页渲染代码未被触碰**。

### V7/V8 — link 安装与投影挂载

`plugin_manager install_bundle target=/root/dsh-buddy-statistics` 直接返回 `already-installed`（profile 里记的是 `github:gitMFQ/dsh-buddy-statistics`，`link:` 前缀也一样被拒）。按工具自己的 `nextStep` 走了先删后装：

```console
$ plugin_manager remove_bundle dsh-buddy-statistics
{"stage":"remove","changed":true,"application":"applied",
 "packageResult":{"exitCode":0,"output":"dependencies:\n- dsh-buddy-statistics 0.2.0\n..."}}

$ plugin_manager install_bundle /root/dsh-buddy-statistics
{"stage":"enable","changed":true,"application":"applied","bundle":"dsh-buddy-statistics","version":"0.3.0",
 "packageResult":{"exitCode":0,"output":"dependencies:\n+ dsh-buddy-statistics <- ../../../dsh-buddy-statistics\n..."}}
```

```console
$ grep -n buddy-statistics /root/.dsh/profiles/web/package.json
12:    "dsh-buddy-statistics": "link:/root/dsh-buddy-statistics",

$ ls -ld .../node_modules/dsh-buddy-statistics
lrwxrwxrwx ... -> ../../../../dsh-buddy-statistics
$ cmp index.js / client.js / lib/fold.js / lib/session-projection.js  → 全部 SAME
```

```console
$ curl -sS -o /tmp/x.json -w 'http=%{http_code} bytes=%{size_download} time=%{time_total}\n' \
      'http://127.0.0.1:3080/buddy-stats/data'
http=200 bytes=15811 time=1.483791
ok= true
meta= {"files":187,"opened":2,"reused":185,"failed":0,"eventsRead":18,"tookMs":1461,
       "pricing":0,"cacheHit":false,"generatedAt":1793291559343,"sessionView":"registered"}
stats.totalSessions= 149 toolCalls= 10147 tokens.total= 1295967936
```

重载后**首次**请求是冷路径：`tookMs:50004`、`eventsRead:79434`、`time=38.58s`（比 README 写的 26s 慢，见 §8 R4）。

### V9/V10 — 真实页面

浏览器通道（详见 §5）：vendored ego runtime，`EGO_LINUX_CHROME=<插件>/bin/ego-chrome-wrapper.sh` 后可用。

会话视图（**手工复现，原始输出**）：点「More conversation views」（`aria-haspopup="menu"`）→ 菜单里出现 `Statistics` menuitem → 点开后 `document.body.innerText` 尾部：

```
Chat  Trajectory  你好  /root
Total Tokens 371.2k   Input 347.9k · Output 5.1k
Cache hit rate 5.0%   Cache read 18.2k
Turns 5   Avg tokens/turn 74.2k
Steps 21  Avg tokens/step 17.7k
Messages 30   tool calls 19
Model time 3m 53s   Tool time 1m 41s   Active time 4m 2s   Wall span 225h 4m 33s
Token composition  Total 371.2k  Input 347.9k 93.7%  Output 5.1k 1.4%  Cache read 18.2k 4.9%  Cache write 0 0.0%  reasoning 2.3k 0.6%
Context usage 21.9k / 192.0k (11.4%)          ← 来自官方 contextPressure 投影
Context composition System prompt 1.9k / Tool definitions 5.7k / Messages 12.9k   ← contextBreakdown
Model breakdown  hy3 371.2k 100.0%  Calls 19 ...
Top tools  5  Tool errors 5 · Success rate 73.7%   1 bash 11  2 web_fetch 5  3 multi_search 1 ...
Turn outcomes 5  Completed 3  Aborted 1  Error 1     ← 零值项不显示（blocked/maxTokens/interrupted/forked）
File changes +0 / -0      Compactions 0      Retries 0
Activity by hour  Peak Hour 8:00
Latency & speed  First token 1m 27s 19×   Decode speed 111.1 tok/s   ← sessionStats
Session info  Title 你好  cwd /root  Origin Main session  Created Oct 20, 2026, 03:08 PM  First/Last activity ...
```

数字真值交叉核对（我自己离线折叠该会话，不看任何插件输出）：

```
{"id":"im:weixin_openilink_052bd5d5:dm:o9cq80xDAgVqi-FGsPqRPFxhMCec@im.wechat","title":"你好",
 "turns":5,"steps":21,"msgs":30,"toolCalls":19,"toolErrors":5,"models":["hy3"],"spanMs":810273193}
```

- `810273193 ms = 225.08 h = 225h 4m 33s` → 与面板 `Wall span` **完全一致**。
- 该 id 正是页面上 `localStorage['dsh.sessions.current']` 的值 → 证明我看的就是这个会话。
- 成功率的展示层算术：工具错误 5 / 调用 19 → `(19-5)/19 = 73.7%` ✓（展示层算术，符合 §「只允许展示层简单算术」）。
- 三个可选官方投影（`contextPressure`/`contextBreakdown`/`sessionStats`）在真实页面上**都读到了** → 降级分支没被触发（降级由 `session-view-render` 离线覆盖）。

全局页未被挤掉：点侧边栏「Statistics」→ `Overview / Models / Tools` 三标签与「Stats from the last 18 days」、`Sessions 149`、`Total Tokens 1298.1M`、`Cache hit rate 96.2%`、`Active Days 18/18` 全部正常，且 `1298.1M ≈ tokens.total 1295967936`。

截图留档：`/tmp/buddystats-live.png`（会话视图）、`/tmp/buddystats-global.png`（全局页）。仓库内不留二进制（`test/artifacts/` 由脚本按需生成，已删除）。

---

## 3. 侦察结论：能不能真的看到页面（含哪些路径不可行）

| 通道 | 结论 | 依据 |
| --- | --- | --- |
| 固定 CDP / 9222 | **不可用** | `ss -ltnp` 无 9222；本机平时没有 Chromium 进程 |
| puppeteer / playwright | **不可用** | `node_modules` 无 `puppeteer*`/`playwright*`/`@puppeteer`，无 `~/.cache/ms-playwright` |
| `dsh-ego-browser` vendored runtime CLI | **可用**（本次就靠它拿到渲染证据） | `runtime/ego-linux/bin/ego-browser.mjs` + 持久 profile；`--status/--stop` + heredoc |
| root 下直接跑 | **不可用，必须加 wrapper** | 不加报 `Chrome did not expose a DevTools port within 20000ms`；必须 `EGO_LINUX_CHROME=<插件>/bin/ego-chrome-wrapper.sh`（插件自己给 root 设的就是它） |
| heredoc 的 helper 面 | **与 SKILL.md 不符** | `snapshotText/cliLog/openOrReuseTab/useOrCreateTaskSpace` 全 `ReferenceError`；实际是 SDK 风格全局 `ego/page/taskSpaces/cdp/snapshot/listTabs/createTab/help`，`page` 上用 `goto/info/snapshot/evaluate/screenshot/locator/getByRole/...` |
| `cordis_inspect` **client** 查询 | **不可用** | `Slots.listSubTree(conversation.view)`、`Theme.listTokens` 共 3+ 次**全部 10s 超时**，**即使我先用 ego 浏览器打开了活的 GUI 页面**（`window.__DSH_BOOT__` 为 object、标题已本地化仍超时）→ 不能拿它核对占用者 |
| `cordis_inspect` **host** 查询 | 可用 | `Service.listService(sessionProjections)` 给出注册契约；`Config.listConfigs(name=dsh-buddy-statistics)` 给出 `id=include:buddy-stats / patchId=buddy-stats / status=absent`（`absent` = 没导出 Config schema，不代表没挂载） |
| `curl` 本机路由 | 可用 | `GET http://127.0.0.1:3080/buddy-stats/data` 免 token 直接可读 |
| `dsh --profile web --dump-config` | 可用 | 能看到 `- id: buddy-stats` 组合行与默认 config |
| Xvfb | 由 ego 启动器自动拉起 | `$DISPLAY` 未设时它自己起 `Xvfb :99` 并以 **headed** 模式跑（`--status` 报 `"headless": false`）；验收后我已停浏览器并 kill Xvfb |

`ego.createTaskSpace` **每次都会开新的 browser context**（实测 id 16/17/18…24/25 递增），所以复用它做「稳定复现」不可靠；`page` 在复用 space 的多标签场景还会绑到残留的 `about:blank`（`page.info()` 直接抛错）。这是 `browser-render` 检查保守 SKIP 的原因。

---

## 4. `test/verify-live.mjs`（可重复执行的活体检查）

```bash
node test/verify-live.mjs              # 只读检查（默认）
node test/verify-live.mjs --browser    # 额外起真实浏览器做页面断言
node test/verify-live.mjs --install    # 额外做 link 安装（会写 profile）
node test/verify-live.mjs --json       # 机器可读
```

最终一次默认运行（冻结版本）：

```console
$ node test/verify-live.mjs
[PASS] artifacts — 11 个交付物齐全
[PASS] client-registration — buddy-stats 页签字段合规；main / sidebar.panellist 原注册仍在
[PASS] projection-definition — buddyStats: stateVersion 1 + summary false + view/viewSchema
[PASS] index-meta — meta.sessionView 三态齐备（registered / unavailable / error: …）
[PASS] npm-test — npm test 通过
[SKIP] link-install — 未加 --install（默认只读）
[PASS] installed-code — link 安装且内容与工作树一致（symlink=true，内容不一致文件: (无)）
[PASS] live-meta — meta.sessionView = 'registered'
[SKIP] browser-dom — 未加 --browser

# 小计: pass=7 fail=0 skip=2      EXIT=0
```

`--browser` 的行为（诚实降级）：只有在页面确实落在会话视图（存在 `Chat` 内联页签）时才做硬断言（溢出菜单必须有 `Statistics/统计` 入口、点开后必须渲染出 6 个区块指纹、Chat/Trajectory 必须还在）；否则记 **SKIP** 并打印诊断，**不判 FAIL** —— 因为 GUI 的入口状态取决于浏览器 profile 与用户当前工作区，验收者不得为了看页面去新建会话或改用户状态。浏览器通道报错/超时同样 SKIP。

脚本自身的两个历史假缺陷（已修，记录以防重犯）：源码把 id/locale/key 抽成常量（`PANEL_ID`/`NS`/`PROJECTION_KEY`/`STATE_VERSION`），第一版只认字面量 → 报出「缺 id」「缺 key」两个假 FAIL；现已内联字符串与数字常量，并且只截取 `ctx.slots.register(` 的**花括号配平对象**（否则会把文件尾 `return { inject: ['slots','locale'] }` 误当注册项字段，误报 inject 违规）。

---

## 5. 已知偏差逐条判定（lead 列的 7 条 + 我补的观察）

| 偏差 | 我的判定 | 依据 |
| --- | --- | --- |
| `view.id` 在 header 无 id 时兜底 `""` | **可接受** | 实测 `view.id === ""`；注册表读投影时 session 一定带 id，只有手工/合成 state 才会无 id；不影响任何真实路径 |
| `stateSchema` 数值用 `nonnegative` 不加 `int` | **可接受** | 折叠只产生整数（计数 +1、`time` 差）；`nonnegative` 仍拒绝负数/NaN；真实 state 8/8 parse 通过 |
| 排序同值时按 id/name 升序 | **可接受** | 确定性输出，便于断言与复现；无正确性含义 |
| `llm/retry` 与 `llm/retry-started` 一一配对，只计后者 | **可接受（已验证）** | 全库 176:176、27 个会话按 retryId **0 未配对**；计两个会翻倍 |
| `compaction/prune` 不计入 compactions | **可接受（已验证）** | 唯一有压缩的会话：1×start + 1×summary + 1×end + 3×prune → `compactions=1`；prune 是逐条裁剪 |
| `outcomes` 未知 kind 不写入 state | **可接受** | stateSchema 是 strict，多键即 parse 失败；真实 kind 只有 5 种且全部有映射（completed/error/aborted/interrupted/max-tokens） |
| first/last「任何带时间戳事件都参与」→ 几乎每个事件都推送 | **可接受，但实测是 100%** | `applySessionEvent` 返回新引用的比例 **66994/66995 = 100.00%**；view 载荷 1205–1887 B；`wire.summary=false` 所以会话列表摘要不带它。契约要求 first/last 反映任意带时间戳事件，这个推送是语义固有的，不是实现缺陷。代价：该会话每来一个事件就向它的客户端推一份 1–2 KB view |
| **补充观察**：页签落在「More conversation views」溢出菜单，而不是内联页签 | **可接受（宿主布局）** | order 20 排在 chat(0)/trajectory(10) 之后，宿主把非前两个折进溢出菜单；这是 `conversation.view` owner 的行为，不是本插件的字段错误 |

---

## 6. 未验证项与残余风险

| 编号 | 项 | 说明 |
| --- | --- | --- |
| U1 | 真实页面上的**中文**标签 | 真页面当前是英文 UI，观测到的是 `t('stats.session.tab')` → `Statistics`；中文「统计」由 `client-smoke` 离线断言覆盖，**未在真实页面验证** |
| U2 | 浏览器**自动**断言 | 手工已验证并留档（§2 V10）；脚本在 GUI 未落在会话视图时按设计 SKIP，未做到稳定复现 |
| U3 | `/buddy-stats/data` 的同源校验 / `HEAD` / `POST→405` | 本轮没改路由，未复测 |
| U4 | 子代理/fork 会话的**活体**数字 | 离线无法判定 `inheritedEventCount`，只有走 `sessionPersistence` 的宿主路径才准；本轮活体只核对了根会话级路由与 `meta`，未逐会话核对子代理数字 |
| U5 | 冷启动耗时基线 | README 写「约 26 秒」，实测重载后首次请求 `tookMs=50004` / 墙钟 `38.58s`（日志规模已增长）。验收脚本给 90s 超时是够的 |
| R1 | 投影注册是 fire-and-forget（`ctx.inject` 里 `.then` 链） | 实测 `meta.sessionView` 很快变 `registered` 且页面渲染正常；但「注册与客户端首个快照的竞态」没做压力测试 |
| R2 | client inspect 不可用 | 页签是否真渲染只能靠浏览器 DOM；宿主侧只能靠 `meta.sessionView` 间接判定 |
| R3 | profile 现在是 **link 安装** | 与发布形态（github 快照）不同；**需要 lead 还原**（§7）。link 依赖工作树存在，若工作树被移动/删除，插件会加载失败 |
| R4 | ego 浏览器自动起 `Xvfb :99` 且 headed 运行 | 并发跑多个 ego 实例会争用同一 `~/.local/share/ego-lite-linux/profile`；验收时已串行执行并清理 |
| R5 | `plugin_manager install_bundle` 对已装同名包直接拒绝 | `target=/root/...` 与 `link:/root/...` 都返回 `already-installed`，必须 `remove_bundle` 后再装；这意味着 link 安装过程中插件会短暂消失 |

---

## 7. 复现步骤与还原

```bash
# 1) 冻结版本核对
cd /root/dsh-buddy-statistics && git rev-parse HEAD && md5sum client.js index.js lib/*.js

# 2) 离线
npm test
node /tmp/parity-all.mjs        # 口径未变（脚本见 §2 V2 做法）
node /tmp/verify-counters.mjs   # 新计数器真值

# 3) link 安装（把 github 快照换成工作树）
#    plugin_manager: remove_bundle dsh-buddy-statistics  →  install_bundle /root/dsh-buddy-statistics
#    等价 CLI: dsh plugin --profile web add link:/root/dsh-buddy-statistics

# 4) 活体
curl -sS 'http://127.0.0.1:3080/buddy-stats/data?refresh=1' | head -c 300   # 看 meta.sessionView
node test/verify-live.mjs
node test/verify-live.mjs --browser

# 5) 手工看页面（可选；会起 Xvfb + headed Chromium，用完 --stop）
EGO=/root/.dsh/profiles/web/node_modules/dsh-ego-browser/runtime/ego-linux/bin/ego-browser.mjs
EGO_LINUX_CHROME=/root/.dsh/profiles/web/node_modules/dsh-ego-browser/bin/ego-chrome-wrapper.sh \
  node "$EGO" nodejs <<'JS'
await ego.createTaskSpace('dsh-buddy-stats manual')
await ego.createTab('http://127.0.0.1:3080/')
await page.waitForLoadState('load'); await page.waitForTimeout(7000)
// 若全局统计面板盖住了会话视图，先点侧边栏 Statistics 关掉它；
// 然后在会话视图点「More conversation views」→ 点 Statistics
console.log(await page.evaluate("Array.from(document.querySelectorAll('[role=tab]')).map(e=>e.textContent.trim())"))
JS
node "$EGO" --stop        # 收工；Xvfb 记得 kill
```

**还原成发布形态（lead 执行）**：

```text
plugin_manager remove_bundle dsh-buddy-statistics
plugin_manager install_bundle target=github:gitMFQ/dsh-buddy-statistics
```

（安装前 profile 记录是 `"dsh-buddy-statistics": "github:gitMFQ/dsh-buddy-statistics"`，`dsh.profile.bundles` 里也有同名条目 —— 两处都由 plugin_manager 维护。）

---

## 8. 工作区与副作用记录

- 我只新增/修改了 `test/verify-live.mjs` 与 `docs/verification-notes.md`；未改动 `client.js` / `lib/*.js` / `index.js` / `package.json` / `locale/*`。
- 验收过程中的**唯一** profile 写入是 §2 V7 的 remove+install（link 安装），已在上文留档与还原步骤。
- 侦察与验收期间启动过的浏览器/Xvfb 已停止并清理（`--stop` + kill Xvfb；`test/artifacts/` 已删除）。
- 临时脚本放在 `/tmp`（`cmp-oldnew.mjs`、`parity-all.mjs`、`verify-counters.mjs`、`audit2.mjs`、`find-compaction.mjs`、`match-ui.mjs`），不在仓库内。
