# dsh-buddy-statistics

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）复刻 CodeBuddy Code「统计」页的插件：一页看清本机的 Token、模型、工具与活跃度。

<img src="icon.svg" width="72" height="72" alt="dsh-buddy-statistics icon">

装好后侧边栏多一个「统计」图标，点开就是本机用量大盘。数据全部来自本机 DSH 会话日志（`ctx.sessionPersistence`，只读），**不联网、不上报**。

## 功能

| 标签 | 内容 |
| --- | --- |
| **概览** | 最近会话条（模型耗时 / 总时长 / 新增·删除行 / Token）· 三张主卡（最常用模型、总 Token、缓存命中率）· 六张 KPI 卡（会话数、最长会话、活跃天数、当前连续、最长连续、高峰时段）· 52 周 × 7 天活跃热力图（四分位分 5 档 + 悬浮提示）· 趣味事实彩蛋 |
| **模型** | 每日 Token 趋势（前 3 名模型折线 + 渐变面积 + 十字定位 tooltip）· 全部模型排行（输入 / 输出 / 缓存命中率 / 推理 / 成本） |
| **工具** | 工具使用排行（Top 20，相对最高值条形图 + 占比 + 总计） |

文案键名与 CodeBuddy Code 的 `stats.*` 一一对应，中英文跟随界面语言；只用宿主主题变量（`--dsw-alias-*`），暗色主题自动适配。

## 安装

仓库根目录就是插件包（`package.json` 在根上），所以可以直接从 GitHub 安装：

```text
plugin_manager install_bundle  target=github:gitMFQ/dsh-buddy-statistics
```

装完刷新页面，侧边栏面板列表里会出现「统计」图标（order 40）。

本地开发时可以指向克隆目录（link 安装，改代码即时生效）：

```bash
git clone https://github.com/gitMFQ/dsh-buddy-statistics.git
```

```text
plugin_manager install_bundle  target=<克隆路径>/dsh-buddy-statistics
```

> 升级：重新执行一次 `install_bundle`（或 `remove_bundle` 后重装）即可取到最新提交。
> 从 GitHub 装的是快照，改了本地代码需要重装；只有 link 安装才会即时生效。

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

填写单价表后「模型」页才会显示成本（DSH 会话日志本身不含金额）：

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

## 性能

本机实测（170+ 会话、54 MB 压缩日志、7 万事件）：

- 冷启动全量折叠：**约 26 秒**（插件激活 5 秒后自动预热，点开面板时通常已就绪）
- 稳态刷新：**0.6–1.0 秒**（按 `(sessionId, eventCount)` 增量，只读各会话尾部）
- 摘要缓存落盘约 120 KB，删掉即重建

## 目录结构

```
.
├── package.json            # bundle 清单：dsh.bundle.patch + dsh.client
├── cordis.patch.yml        # 插入 buddy-stats 行与默认配置
├── index.js                # 宿主：GET /buddy-stats/data
├── lib/
│   ├── collect.js          #   采集：sessionPersistence 增量读取 + 两级缓存
│   └── aggregate.js        #   聚合：连续天数 / 按天按小时 / 模型与工具排行
├── client.js               # 浏览器：main 面板 + 侧边栏图标 + 整页渲染
├── locale/{zh,en}.json     # 插件元数据（插件管理器显示用）
├── icon.svg                # 插件图标
├── test/                   # 离线口径对照 + 客户端加载自检
├── docs/implementation.md  # 实现细节与维护说明
└── README.md
```

## 开发与自检

```bash
npm test                   # = fold-check + client-smoke
node test/fold-check.mjs   # 直接从持久化日志折叠，和基线数字对照（只跑根会话）
node test/client-smoke.mjs # 加载客户端模块，校验 slot 注册项与卸载
```

宿主侧接口只有一条只读路由：

```text
GET /buddy-stats/data[?refresh=1]  →  { ok, stats, meta }
```

同源校验（拒绝跨源 `Origin`），`HEAD` 可用，`POST` 返回 405。

## 已知限制

- **没有实时推送**：进入面板拉一次、点「刷新」再拉一次，没有 SSE。
- **行数是估算**：只解析 `write` / `edit` 两种工具的入参。
- **不做 AI 洞察**：CodeBuddy 另有模型分析流（insights），本插件只复刻统计页。
- **热力图固定 52 周**：与 CBC 一致，不提供时间窗切换。

## License

[MIT](LICENSE) © gitMFQ
