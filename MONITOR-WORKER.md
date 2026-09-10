# 监控阈值通知 Worker（详细文档）

> 这是 [README.md](./README.md) 中「监控阈值通知 Worker」部分的详细展开文档，涵盖功能、配置、参数解释、部署与本地开发。返回总览请回 [README.md](./README.md)。

监控 Worker（`monitor/worker.js`）由 Cron 定时触发，遍历各产品免费用量，用量达到阈值时通过 Server酱(微信) / Telegram 推送告警，并用 KV 标志位按产品周期去重、避免重复打扰。Pages 不支持定时任务，故监控必须放在独立 Worker 上。

## ⏰ 功能

在仪表盘基础上，监控 Worker 提供**多产品免费用量监控与阈值自动通知**：

- **·** 多产品监控 - 监控 **KV、R2、D1、Pages构建** 等核心免费用量指标（读取/写入、存储、R2 按 A类/B类操作分别统计、D1 读写行数、Pages 每月构建数等）
- **·** 阈值通知 - 各计费指标用量达到合理默认阈值时自动提醒；也可用 `THRESHOLD_<产品>_<指标>` 自定义绝对阈值
- **·** 非计费指标只展示 - `errors`、`subrequests`、CPU耗时 等不产生账单的指标**不触发告警**，避免误报
- **·** 👥 按账户独立监控 - 每个账户单独判断、各自触发通知
- **·** 📆 按产品周期去重 - 同一阈值一个周期只提醒一次
- **·** 💬 多渠道推送 - 同时支持 Server酱(微信) 与 Telegram Bot，可分别开关
- **·** ⏰ 自动执行 - Worker + Cron 定时任务，无需打开页面也会自动检查并推送

**各计费指标的合理默认阈值**（可用 `THRESHOLD_<产品>_<指标>` 覆盖）：

| 指标 | 免费额度 | 周期 | 默认告警阈值 |
|--|--|--|--|
| Workers 请求 | 10万/天 | 日 | 5万 / 8万 / 9.5万 |
| KV 读 | 10万/天 | 日 | 5万 / 8万 / 9.5万 |
| KV 写 | 1千/天 | 日 | 800 / 950 |
| KV 存储 | 1GB | 日 | 80% / 95% |
| R2 A类操作 | 100万/账期 | 账期 | 80万 / 95万 |
| R2 B类操作 | 1000万/账期 | 账期 | 800万 / 950万 |
| R2 存储 | 10GB | 账期 | 80% / 95% |
| D1 读行 | 500万/天 | 日 | 400万 / 475万 |
| D1 写行 | 10万/天 | 日 | 8万 / 9.5万 |
| D1 存储 | 5GB | 日 | 80% / 95% |
| Pages 构建 | 500/月 | 自然月 | 250 / 400 / 475 |

## ⚙️ 配置

### wrangler.toml（monitor/）参数

| 参数 | 说明 |
|--|--|
| `name` / `main` | Worker 名称与入口（`worker.js`） |
| `compatibility_date` | Workers 运行时兼容日期 |
| `keep_vars` | 设为 `true`，防止部署时清空控制台 Variables/Secrets |
| `[observability.logs]` | 开启 invocation_logs 以保留运行日志 |
| `kv_namespaces` | KV 绑定；`binding = "KV_STATE"`，`id` 为命名空间 ID（仓库内为示例值，个人使用请替换） |
| `triggers.crons` | 定时触发表达式；默认每小时整点 `0 * * * *`。toml 中保持注释，在控制台 Triggers 管理，避免 push 覆盖 |
| `[vars]` | 非敏感变量（`MONITOR_PRODUCTS`、`THRESHOLD_*`），或保持注释由控制台 Variables 覆盖 |

### 监控参数详解（产品 / 指标）

> 下表集中说明每个被监控指标：**参数名**（`THRESHOLD_<PRODUCT>_<METRIC>` 覆盖变量名）、**在 CF 中的含义**、**免费额度**、**监控内容**（数据来源与统计方式）与**默认警戒阈值**。
> 覆盖方式：环境变量/控制台变量名 = `THRESHOLD_<产品>_<指标>`，值为**逗号分隔的升序绝对数值**；设 `0` 表示不监控该指标。未设置时使用下表默认值。
> 存储类指标默认阈值写的是**绝对字节数**（80%、95%），也可用同名变量覆盖。
> 周期中的"**账期**"= Cloudflare 月度计费周期（**按订阅账单元日重置，非自然月**），工具自动从订阅接口读取；读取失败时降级为自然月并推送告警。**Pages 构建**按**自然月**（当月1日 UTC 00:00）重置，不随账单周期。

**· Workers**

| 指标 | 参数名 | 在 CF 中的含义 | 免费额度 | 监控内容 / 数据来源 | 周期 | 默认警戒阈值 |
|--|--|--|--|--|--|--|
| 请求数 `requests` | `THRESHOLD_WORKERS_REQUESTS`（旧版 `THRESHOLDS`） | Worker 脚本 + Pages Functions 的 HTTP 调用次数 | 10 万/天 | GraphQL `workersInvocations` + `pagesFunctionsInvocations` 的 `sum(requests)` | 日（UTC 零点重置） | 50000 / 80000 / 95000 |
| 错误数 `errors` | —（仅展示） | 请求执行抛出的错误数量 | —（非计费） | `sum(errors)` | —（不告警） | — |
| 子请求数 `subrequests` | —（仅展示） | 单个请求内发起的子请求数量 | —（非计费） | `sum(subrequests)` | —（不告警） | — |
| CPU 耗时 `cpuTimeMs` | —（仅展示） | 各请求累计 CPU 耗时（μs→ms） | —（非计费） | `sum(cpuTimeUs) / 1000` | —（不告警） | — |

**· KV**

| 指标 | 参数名 | 在 CF 中的含义 | 免费额度 | 监控内容 / 数据来源 | 周期 | 默认警戒阈值 |
|--|--|--|--|--|--|--|
| 读取 `reads` | `THRESHOLD_KV_READS` | KV 的 GET 读取次数 | 10 万/天 | `sum(requests)`，`actionType = read` | 日 | 50000 / 80000 / 95000 |
| 写入 `writes` | `THRESHOLD_KV_WRITES` | KV 的 PUT 写入次数（注：每日免费额度为**写入/删除/列出 合计** 1 千次） | 1 千/天 | `sum(requests)`，`actionType = write` | 日 | 800 / 950 |
| 存储 `storageBytes` | `THRESHOLD_KV_STORAGEBYTES` | KV 命名空间当前存储占用字节数 | 1 GB | 最新时间窗 `max(byteCount)` 求和 | 日 | 858993459（80%） / 1020054733（95%） |

**· R2**

| 指标 | 参数名 | 在 CF 中的含义 | 免费额度 | 监控内容 / 数据来源 | 周期 | 默认警戒阈值 |
|--|--|--|--|--|--|--|
| A 类操作 `classAOperations` | `THRESHOLD_R2_CLASSAOPERATIONS` | 写/复制/列/分片等变更类操作次数 | 100 万/账期 | `sum(requests)`，分类为 A 类 | 账期 | 800000（80%） / 950000（95%） |
| B 类操作 `classBOperations` | `THRESHOLD_R2_CLASSBOPERATIONS` | 读/查询等读取类操作次数（未知分类归 B，保守不误报计费） | 1000 万/账期 | `sum(requests)`，分类为 B 类 | 账期 | 8000000（80%） / 9500000（95%） |
| 存储 `storageBytes` | `THRESHOLD_R2_STORAGEBYTES` | R2 桶存储字节占用 | 10 GB | 最新时间窗 `max(payloadSize)+max(metadataSize)` 求和 | 账期 | 8589934592（80%） / 10200547328（95%） |

**· D1**

| 指标 | 参数名 | 在 CF 中的含义 | 免费额度 | 监控内容 / 数据来源 | 周期 | 默认警戒阈值 |
|--|--|--|--|--|--|--|
| 读行 `rowsRead` | `THRESHOLD_D1_ROWSREAD` | 查询实际扫描读取的行数 | 500 万行/天 | `sum(rowsRead)` | 日 | 4000000（80%） / 4750000（95%） |
| 写行 `rowsWritten` | `THRESHOLD_D1_ROWSWRITTEN` | INSERT/UPDATE/DELETE 影响的行数 | 10 万行/天 | `sum(rowsWritten)` | 日 | 80000（80%） / 95000（95%） |
| 存储 `databaseSizeBytes` | `THRESHOLD_D1_DATABASESIZEBYTES` | 账户下全部 D1 数据库存储占用（合计） | 5 GB | 最新时间窗 `max(databaseSizeBytes)` 求和 | 日 | 4294967296（80%） / 5100273664（95%） |

**· Pages**

| 指标 | 参数名 | 在 CF 中的含义 | 免费额度 | 监控内容 / 数据来源 | 周期 | 默认警戒阈值 |
|--|--|--|--|--|--|--|
| 构建 `builds` | `THRESHOLD_PAGES_BUILDS` | 本月 Pages 部署/构建次数 | 500 次/月 | REST `/deployments` 按 `created_on` 统计本月（自然月当月1日起） | 自然月 | 250（50%） / 400（80%） / 475（95%） |

### 监控产品与去重

- 监控产品由 `MONITOR_PRODUCTS` 控制（默认 `workers,kv,r2,d1,pages`）；产品/指标/免费额度注册表在 `monitor/worker.js` 的 `FREE` 与 `functions/api.js` 的 `PRODUCT_DEFS`。
- 周期去重键：Workers/KV/D1 按**日**（`YYYY-MM-DD`），R2 按**账单周期**记元日（`YYYY-MM-DD`），Pages 构建按**自然月**（`YYYY-MM`）。同一阈值在一个周期内只提醒一次。
- 账单周期读取失败时降级为自然月统计，并向 Server酱/Telegram 推送一条"账单周期检测失败"告警（每自然月每账户一次），便于及时处理。

### API 密钥权限

确保 API 密钥具有以下权限：

- **·** Account Analytics: Read
- **·** Pages: Read（如需统计 Pages 项目/构建数；缺失时该项目显示为不可用/0，不阻塞其他监控）
- **·** Account Settings: Read（可选，推荐）：用于读取订阅账单周期，使 R2 的月度统计按**账单周期**而非自然月（Pages 构建固定按自然月，不依赖账单周期）。缺失/不可用时 R2 自动降级为自然月统计，并推送一条"账单周期检测失败"告警，不影响其他监控

### 所需配置文件（监控 Worker）

| 文件 / 位置 | 给谁用 | 填什么 |
|--|--|--|
| `monitor/wrangler.toml`（需编辑并提交，非敏感） | 生产 + 本地 | ① 把 `kv_namespaces` 的 `id` 替换为你新建 KV 命名空间的 ID；② 需调整监控产品/阈值时，在 `[vars]` 取消注释或新增 `MONITOR_PRODUCTS`、`THRESHOLD_*`（也可放控制台 Variables，优先级更高且不受 push 覆盖）；③ 其余一般不用改 |
| `monitor/.dev.vars`（由 `monitor/.dev.vars.example` 复制） | 监控 Worker 本地（`pnpm dev:monitor`） | `EDGE` + 可选 `SERVERCHAN_KEY` / `TG_BOT_TOKEN` / `TG_CHAT_ID` |
| Worker → Settings → Variables and Secrets（Secrets 区） | 生产环境 | `EDGE`（必需）、`SERVERCHAN_KEY`、`TG_BOT_TOKEN`、`TG_CHAT_ID`（可选） |
| Worker → Settings → Variables and Secrets（Variables 区） | 生产环境 | 可选覆盖：`MONITOR_PRODUCTS`、`THRESHOLD_*` 等非敏感项 |
| Worker → Settings → Triggers → Cron Triggers | 生产环境 | `0 * * * *`（每小时整点；**务必添加**，否则 Worker 不会自动运行） |
| 控制台 → Workers & Pages → KV | 生产环境 | 新建命名空间（如 `cf-monitor-state`），把其 ID 填回 `monitor/wrangler.toml` 的 `kv_namespaces.id` |

> `EDGE` 内容示例（与仪表盘同款，多账户以此类推）：
> ```json
> [ { "name": "账户1", "token": "Cloudflare账户API密钥", "accountId": "Cloudflare账户ID" } ]
> ```

### 环境变量一览

| 变量名 | 类型 | 必须 | 说明 |
|--|--|--|--|
| `EDGE` | 密钥 | 是 | 账户数组 JSON（与仪表盘同款） |
| `MONITOR_PRODUCTS` | 文本 | 否 | 启用监控的产品，逗号分隔，默认 `workers,kv,r2,d1,pages` |
| `THRESHOLDS` | 文本 | 否 | 兼容旧版：仅对 workers/requests 生效，阈值列表（逗号分隔），默认 `100000,50000,20000,10000` |
| `THRESHOLD_<PRODUCT>_<METRIC>` | 文本 | 否 | 自定义某产品某指标阈值（逗号分隔升序绝对数值），如 `THRESHOLD_KV_WRITES="800,900,1000"`；设 `0` 表示不监控该指标 |
| `SERVERCHAN_KEY` | 密钥 | 否 | Server酱(微信) SendKey，配置后启用微信推送 |
| `TG_BOT_TOKEN` | 密钥 | 否 | Telegram 机器人 Token，配置后启用 TG 推送 |
| `TG_CHAT_ID` | 文本 | 否 | Telegram 接收人 chat id（与 TG_BOT_TOKEN 一起配置） |

### 安全与运维说明

- **鉴权范围**：监控 Worker 的 `/run` 手动触发入口**不设验证**（任何请求都会真跑一次监控、消耗 GraphQL 取数额度，仅建议偶尔手动使用；日常监控依赖 Cron）。`/` 根状态页与 Pages 仪表盘 `/api` 均**公开**——仪表盘是静态页，前端在浏览器内请求 `/api`，若在前端放密钥则形同虚设，故不在 `/api` 上增加伪鉴权；如确有对外暴露隐私数据的顾虑，建议用 Cloudflare Access 在网关层做真正鉴权。
- **KV 水位标志带 TTL**：告警去重键（`alert:...`）按产品周期写入并自动过期（日周期 2 天、月周期 32 天），账单周期降级键（`billingcycle:degraded:...`）32 天过期，避免 KV 条目无限累积。
- **Pages 构建数口径**：按 `/deployments` 的 `created_on` **全部计入**本月（自然月当月1日 UTC 00:00 起）的构建，包含失败/取消的部署——CF Free 套餐为 500 次/月，每次触发构建即消耗 1 次（官方未豁免失败构建），全量计入且按自然月是偏保守、防计费风险的正确口径（**不使用订阅账单周期窗口**）。

## 🚧 部署教程（监控 Worker）

**1.** 创建 KV 命名空间
1. 进入 Cloudflare 控制台 → Workers & Pages → KV。
2. 新建命名空间，例如命名为 `cf-monitor-state`，复制它的 **namespace id**。

**2.** 修改 `monitor/wrangler.toml`
打开 `monitor/wrangler.toml`，把 `kv_namespaces` 中的 `id` 换成你自己创建的命名空间 ID（仓库内已有作者示例值；KV id 非敏感可入库，他人使用请替换）。如需调整监控范围或阈值，可参考注释取消 `MONITOR_PRODUCTS` / `THRESHOLDS` / `THRESHOLD_<产品>_<指标>`（或直接在控制台 Variables 设置，见第 4 步）。

**3.** 创建 Worker（推荐 Git 集成，push 自动部署）
1. Cloudflare 控制台 → Workers & Pages → Create → 选择 GitHub 仓库。
2. 部署命令填：`pnpm deploy:monitor`（等价 `wrangler deploy -c monitor/wrangler.toml`，使用项目锁定的 wrangler 版本），点保存并部署。
3. 之后每次 push 到 main 自动重新部署。
4. 添加 Cron：进入该 Worker → Settings → Triggers → Cron Triggers，添加 `0 * * * *`（每小时整点）。Cron 未在 toml 声明，故控制台配置不会被 push 覆盖。

**4.** 配置敏感变量（控制台 Secrets）
进入 Worker → Settings → Variables and Secrets，添加：

| 变量 | 必填 | 说明 |
|--|--|--|
| EDGE | 是 | 账户数组 JSON（格式见上） |
| SERVERCHAN_KEY | 否 | Server酱 SendKey |
| TG_BOT_TOKEN | 否 | Telegram Bot Token |
| TG_CHAT_ID | 否 | Telegram 接收 chat id |

阈值、监控产品等非敏感项也可在此添加变量覆盖默认值（如 `THRESHOLD_R2_CLASSBOPERATIONS="8000000,9500000"`、`MONITOR_PRODUCTS="workers,kv,r2,d1,pages"`），控制台变量优先级高于代码默认值，且不会被 push 覆盖。

**5.** 验证
1. 打开 Worker 访问地址，返回 `{"ok": true, ...}` 即运行正常。
2. 临时调低阈值（如控制台设 `THRESHOLDS="1,50"`）并手动触发一次 Cron，观察是否收到 Server酱/Telegram 消息；同一阈值一个周期内不会重复推送。

> 提示：仪表盘（Pages）与监控（Worker）都需要各自配置 `EDGE`；`KV_STATE` 绑定已在 `monitor/wrangler.toml` 中声明，Cron 在控制台 Triggers 管理。
> 本地部署备选：配置好 `monitor/.dev.vars` 后，在项目根目录执行 `pnpm deploy:monitor`。

## 🧪 本地开发（监控 Worker）

把 `monitor/.dev.vars.example` 复制为 `monitor/.dev.vars` 并填入 `EDGE` 与通知令牌，然后：

```bash
pnpm dev:monitor
```

| 命令 | 作用 | 访问地址 |
|--|--|--|
| `pnpm dev:monitor` | 本地运行监控 Worker（KV 用本地模拟） | http://localhost:8787 |

`.dev.vars` 格式（KEY=VALUE，注释用 `#`）：
```
EDGE=[{"name":"账户1","token":"你的API Token","accountId":"你的账户ID"}]
SERVERCHAN_KEY=你的SendKey
TG_BOT_TOKEN=你的BotToken
TG_CHAT_ID=你的ChatId
```

非敏感参数（`MONITOR_PRODUCTS`、`THRESHOLDS`、`THRESHOLD_*`）配在 `monitor/wrangler.toml` 的 `[vars]` 或注释示例中，无需放入 `.dev.vars`。

监控 Worker 的 Cron 不会自动触发，需手动触发一次监控流程：

```
http://localhost:8787/__scheduled?cron=0+*+*+*+*
```

本地验证时建议把阈值临时调小（如 `THRESHOLD_D1_ROWSREAD="1,50"`），即可观察推送与 KV 去重行为。

---

[返回总览 README.md](./README.md)