# dsh-buddy-statistics

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）复刻 CodeBuddy Code「统计」页的插件：一页看清本机的 Token、模型、工具与活跃度；外加**会话视图里的「统计」页签**，只看当前会话。

<img src="icon.svg" width="72" height="72" alt="dsh-buddy-statistics icon">

装好后侧边栏多一个「统计」图标，点开就是本机用量大盘。数据全部来自本机 DSH 会话日志（`ctx.sessionPersistence`，只读），**不联网、不上报**。

## 功能

| 标签 | 内容 |
| --- | --- |
| **概览** | 最近会话条（模型耗时 / 总时长 / 新增·删除行 / Token）· 三张主卡（最常用模型、总 Token、缓存命中率）· 六张 KPI 卡（会话数、最长会话、活跃天数、当前连续、最长连续、高峰时段）· 52 周 × 7 天活跃热力图（四分位分 5 档 + 悬浮提示）· 趣味事实彩蛋 |
| **模型** | 每日 Token 趋势（前 3 名模型折线 + 渐变面积 + 十字定位 tooltip）· 全部模型排行（输入 / 输出 / 缓存命中率 / 推理 / 成本） |
| **工具** | 工具使用排行（Top 20，相对最高值条形图 + 占比 + 总计） |
| **会话视图页签** | 会话视图里的「统计」页签：只讲当前会话的 KPI、Token 构成、上下文、模型与工具、回合结果、文件增删、压缩/重试、24 小时分布、延迟与速度、会话信息（见下节） |

文案键名与 CodeBuddy Code 的 `stats.*` 一一对应，中英文跟随界面语言；只用宿主主题变量（`--dsw-alias-*`），暗色主题自动适配。

## 会话视图的「统计」页签

打开任意会话，标题栏的视图页签（Chat / Trajectory 之后）会多出一个「统计」。它只讲**当前会话**：数据来自宿主侧注册的 `buddyStats` 会话投影，事件一提交就随会话快照推送过来，**不轮询、不发额外请求**；面板没数据时显示占位而不是报错。

| 区块 | 内容 |
| --- | --- |
| 顶部 KPI | 本会话总 Token、缓存命中率、回合数、步数、消息数、模型耗时、工具耗时、活跃时长、墙钟跨度（配了单价表还有总成本） |
| Token 构成 | 净输入 / 输出 / 缓存读 / 缓存写 / 推理 的绝对值与占比条 |
| 上下文 | 当前占用 / 上下文窗口 + 启发式组成（系统提示 / 工具 / 消息） |
| 模型明细 | 本会话每个模型的调用数、四类 Token、推理 Token、成本 |
| 工具排行 | 本会话 Top 10 工具、调用数、错误数、成功率 |
| 回合结果 | 完成 / 中止 / 阻塞 / 出错 / 触顶 / 中断 / fork 的分布（只显示非零项） |
| 文件与开销 | 增删行估算、压缩次数、模型重试次数 |
| 活动分布 | 本会话的 24 小时分布 + 高峰时段 |
| 延迟与速度 | 首字延迟、输出速度（读宿主的 `sessionStats` 投影） |
| 会话信息 | 标题、cwd、preset、是否子代理、父会话、创建时间、首末活动时间 |

### 为什么这些放全局、那些放会话

单会话视图**故意不显示**需要跨会话比较才有意义的量，否则只会得到「会话数 = 1」这类噪声：

| 只在会话视图（会话独有） | 只在全局页（必须跨会话） |
| --- | --- |
| 本会话 Token 构成、缓存命中率、推理 Token | 52 周活跃热力图、活跃天数、当前/最长连续、高峰时段 |
| 回合数 / 步数 / 消息数、回合结果分布 | 会话数、子代理数、工作区数、最长会话 |
| 回合内活跃时长、模型耗时、墙钟跨度、首末活动 | 跨会话的模型排行、每日 Token 趋势、工具排行 |
| 本会话模型明细与工具排行（含错误、成功率） | 趣味事实彩蛋、「统计范围：最近 N 天」 |
| 当前上下文占用与组成、首字延迟、输出速度 | |
| 本会话压缩次数、模型重试次数、文件增删行估算 | |
| 本会话 24 小时活动分布、会话元信息（cwd/preset/来源/父会话） | |

两边共用**同一份折叠实现**（`lib/fold.js`），所以同一会话在全局页与会话页签里的数字永远一致。

## 安装

仓库根目录就是插件包（`package.json` 在根上），所以可以直接从 GitHub 安装：

```text
plugin_manager install_bundle  target=github:gitMFQ/dsh-buddy-statistics
```

装完刷新页面，侧边栏面板列表里会出现「统计」图标（order 40）；打开任意会话，视图页签里会多一个「统计」（order 20）。

本地开发时可以指向克隆目录（link 安装，改代码即时生效）：

```bash
git clone https://github.com/gitMFQ/dsh-buddy-statistics.git
```

```text
plugin_manager install_bundle  target=<克隆路径>/dsh-buddy-statistics
```

> 升级：重新执行一次 `install_bundle`（或 `remove_bundle` 后重装）即可取到最新提交。
> 从 GitHub 装的是快照，改了本地代码需要重装；只有 link 安装才会即时生效。
>
> v0.3.0 起宿主半边依赖 `zod` 校验投影 schema（`dependencies` 里已声明）。
> 另外 0.3.0 把折叠实现抽成了 `lib/fold.js`，摘要缓存版本 `CACHE_VERSION` 升到 6：
> 升级后**第一次**打开统计页会重新全量折叠一次（本机当前规模约 40–50 秒，预热过的会话通常无感），
> 之后恢复增量刷新。

## 配置

`cordis.patch.yml` 里已有默认值，安装后可在 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- insert:
    - id: buddy-stats
      name: dsh-buddy-statistics
      config:
        ttlMs: 20000         # 内存缓存时间（毫秒）；会话事件到达会自动失效
        warmupDelayMs: 5000  # 启动后预热延迟；0 = 不预热
        cacheFile: ''        # 摘要落盘位置；'' = ~/.dsh/buddy-statistics/sessions-cache.json，null = 不落盘
        pricing: {}          # 可选单价表（每百万 Token，美元），键为模型 id
```

填写单价表后「模型」页才会显示成本（DSH 会话日志本身不含金额）。单价表同样用于会话视图页签的模型成本与总成本 KPI：

```yaml
        pricing:
          deepseek-v4.1-flash:
            input: 0.28
            output: 0.42
            cacheRead: 0.028
```

## 与 CodeBuddy Code 的口径对照

统计规则来自对 CodeBuddy Code `StatsService.calculateStats()` 与 Web UI `StatsView` 的逆向。能对齐的尽量对齐，数据模型不同的地方做了显式调整：

| 项 | CodeBuddy Code | 本插件 | 说明 |
| --- | --- | --- | --- |
| 会话数 / 消息数 / 活跃天数 / 连续天数 / 工具调用 / 高峰时段 | 只算非子代理会话 | 同 | 子代理数量单独显示在「会话数」卡片提示里 |
| Token 用量 | 统计全部会话（含子代理） | 同 | |
| Token 口径 | `inputTokens` 含缓存读取 | `输入 + 缓存读取 + 输出 + 缓存写入` | DSH 的 `inputTokens` 是**净输入**，缓存读取单列 |
| 缓存命中率 | `cacheRead / inputTokens` | `cacheRead / (输入 + 缓存读取 + 缓存写入)` | 直接套 CBC 公式会算出 >100% |
| 会话时长 | 首末消息时间差 | 回合内时长之和（`turn/start`→`turn/end`） | 会话可能跨天挂着，墙钟跨度会失真；会话条另显示墙钟总时长 |
| 模型耗时 | API 时长 | `step/start`→`step/end` 之和 | 一个 step 就是一次模型调用 |
| 新增/删除行 | 宿主自带的文件变更遥测 | 解析 `write` / `edit` 工具参数估算 | DSH 没有行级遥测，数值是估算 |
| 成本 | `costUSD` 后端从不写入（永不显示） | 只在配置单价后显示 | |
| 每会话历史 | 截断到最近 1000 条 | 全量折叠 | |
| 活跃热力图 | 52 列 × 7 行，非零消息数按 P25/P50/P75 分 5 档 | 同 | |
| 趣味事实 | 书籍/活动阈值表 + `(总 Token + 最长会话分钟) % 条数` 确定性挑选 | 同（书单与活动表原样复刻） | |
| 「统计范围：最近 N 天」 | `totalDays` = 全历史首末跨度，不是过滤窗口 | 同 | |
| fork / seed 会话 | 在 SessionStore 层剔除 | 从 `inheritedEventCount` 起只算自有事件 | 否则父会话事件会被重复计入 |
| 压缩次数 / 模型重试次数 / 回合结果分布 | CBC 统计页没有 | 折叠 `compaction/start`、`llm/retry-started`、`turn/end.reason.kind` | 只在会话页签显示；真实日志里 `llm/retry` 与 `llm/retry-started` 一一配对，只计其一避免翻倍 |
| 上下文占用 / 组成、首字延迟、输出速度 | CBC 统计页没有 | 直接读宿主内置投影 `contextPressure` / `contextBreakdown` / `sessionStats` | 这三项由 DSH 自己算，插件不重复实现；读不到就隐藏对应区块 |

## 性能

本机实测（170+ 会话、54 MB 压缩日志、7 万事件）：

- 冷启动全量折叠：**约 26 秒**（本机 170 会话 / 7 万事件规模；日志长到 187 会话 / 8.8 万事件后实测 39–50 秒）。插件激活 5 秒后自动预热，点开面板时通常已就绪
- 稳态刷新：**0.6–1.0 秒**（按 `(sessionId, eventCount)` 增量，只读各会话尾部）
- 摘要缓存落盘约 120 KB，删掉即重建
- 会话页签：`buddyStats` 投影只对**打开过的会话**惰性折叠（首次读该会话时折它的日志），之后随事件提交增量推送；单次推送是 1–2 KB 的 JSON，不影响全局页的采集节奏

## 目录结构

```
.
├── package.json            # bundle 清单：dsh.bundle.patch + dsh.client（宿主依赖 zod）
├── cordis.patch.yml        # 插入 buddy-stats 行与默认配置
├── index.js                # 宿主：GET /buddy-stats/data + 注册 buddyStats 会话投影
├── lib/
│   ├── fold.js             #   折叠（唯一实现）：事件流 → 纯 JSON 会话状态（全局页与会话页签共用）
│   ├── collect.js          #   采集：sessionPersistence 增量读取 + 两级缓存
│   ├── session-projection.js #  会话投影：buddyStats 的 state/view schema 与聚合视图
│   └── aggregate.js        #   聚合：连续天数 / 按天按小时 / 模型与工具排行
├── client.js               # 浏览器：main 面板 + 侧边栏图标 + 会话视图「统计」页签
├── locale/{zh,en}.json     # 插件元数据（插件管理器显示用）
├── icon.svg                # 插件图标
├── test/                   # 离线口径对照 + 客户端加载/渲染自检
├── docs/session-view.md    # 会话视图统计的接口契约（折叠字段、view JSON、口径划分）
├── docs/implementation.md  # 实现细节与维护说明
└── README.md
```

## 开发与自检

```bash
npm install                # 只为拿到宿主依赖 zod（本地跑 index.js / 测试用）
npm test                   # = fold-purity + projection-schema + fold-check + client-smoke + session-view-render
node test/fold-purity.mjs       # 折叠纯函数：同引用/写时复制/确定数值
node test/projection-schema.mjs # 投影 state/view 的 zod schema 与聚合视图
node test/fold-check.mjs        # 直接从持久化日志折叠，和基线数字对照（只跑根会话）
node test/client-smoke.mjs      # 加载客户端模块，校验三个 slot 注册项与卸载
node test/session-view-render.mjs # 用 hooks 替身渲染会话页签，校验空态/降级/数字
```

宿主侧接口只有一条只读路由：

```text
GET /buddy-stats/data[?refresh=1]  →  { ok, stats, meta }
meta.sessionView: 'registered' | 'unavailable' | 'error: …'   # 会话投影是否挂上（排查用）
```

同源校验（拒绝跨源 `Origin`），`HEAD` 可用，`POST` 返回 405。

## 已知限制

- **全局页没有实时推送**：进入面板拉一次、点「刷新」再拉一次，没有 SSE；会话页签则由投影推送，事件提交即更新。
- **行数是估算**：只解析 `write` / `edit` 两种工具的入参。
- **不做 AI 洞察**：CodeBuddy 另有模型分析流（insights），本插件只复刻统计页。
- **热力图固定 52 周**：与 CBC 一致，不提供时间窗切换。
- **会话视图的按天桶不进客户端**：投影只推 24 小时分布，长会话的按天表留在宿主侧给全局热力图用，避免每个事件都推送一份。
- **浏览器渲染未做自动化验收**：本仓库的测试覆盖折叠、schema、slot 注册与组件渲染树；真实页面的观感需要人工刷新确认。

## License

[MIT](LICENSE) © gitMFQ
