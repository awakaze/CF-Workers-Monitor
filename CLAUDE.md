# CLAUDE.md

本文件用于指导 Claude/AI 助手在本仓库中的协作规范。

> 说明：本文件为**初版**，会随后续需求持续完善。

## 项目概述

- CF-Workers-Monitor：Cloudflare Workers/Pages 用量监控工具。
- 结构：
  - `public/` — 仪表盘前端（原生 HTML/CSS/JS），经 Cloudflare Pages 托管。
  - `functions/api.js` — Pages Functions 后端，查 Cloudflare GraphQL 返回用量数据。
  - `monitor/` — **本分支新增**的多产品阈值监控 Worker：由 Cron 定时触发，查 Workers/KV/R2/D1/Pages 用量指标（R2 按 A类/B类操作分开统计）、比对免费额度阈值（按产品在注册表中配置合理默认值，可用 `THRESHOLD_<PRODUCT>_<METRIC>` 覆盖）、通过 Server酱/Telegram 推送通知，用 KV 标志位按产品周期去重。非计费指标（errors/subrequests/cpuTime）仅展示不告警。
- 部署：仪表盘走 Cloudflare Pages；监控走 Cloudflare Worker（需 Cron，Pages 不支持定时）。

## 提交规范（分单位提交）

- 每次 `git commit` 按**合理单位**拆分，保持单一关注点，各自单独提交，**不混合**。
- 提交信息使用 Conventional Commits：
  - `feat:` 新功能
  - `fix:` 修复 bug
  - `chore:` 构建、依赖、工具链等杂项
  - `docs:` 文档改动（如 README、注释）
- 示例：
  - `feat: 新增阈值监控 Worker（Cron 定时推送 Server酱/Telegram）`
  - `docs: README 补充本分支定制功能与部署教程`

## 提交与推送

- 平时只 `git commit` 提交**本地仓库**，**用户确认后**才 `git push` 推送远程。

## 改动边界（约定）

- 配置类内容由**用户本人维护**，AI 只提示/检查需要改哪些，不直接改动，除非用户明确同意：
  - Cloudflare **Pages 控制台**环境变量（`EDGE`）
  - Cloudflare **Worker** 环境变量（`EDGE`、`MONITOR_PRODUCTS`、`THRESHOLDS`、`THRESHOLD_*`、`SERVERCHAN_KEY`、`TG_BOT_TOKEN`、`TG_CHAT_ID`）
  - **KV 命名空间**创建与绑定（`KV_STATE`）
  - `monitor/wrangler.toml` 中的 KV `id`、Cron、vars 等占位符
- 框架/基础设施源码尽量不修改；确需修改须先获得用户同意并登记差异。
- 不同类型的改动单独提交：配置改动 / 代码改动 / 文档改动不混在一个 commit 里。

## 常用命令（项目根目录，统一用 pnpm）

- 本地运行监控 Worker：`pnpm dev:monitor`（配合 `--test-scheduled`，可访问 `http://localhost:8787/__scheduled?cron=0+*+*+*+*` 手动触发）
- 本地运行仪表盘：`pnpm dev:pages`
- 部署监控 Worker：`pnpm deploy:monitor`
- 部署 Pages 仪表盘：`pnpm deploy:pages`
- 设置敏感变量：`pnpm secret:put EDGE`（其余令牌同理，`wrangler secret put` 的封装）
- 本地校验语法：`node --check monitor/worker.js`（functions/api.js 同理，项目为 ESM）

## 注意事项

- 阈值去重按**产品各自周期**重置：Workers/KV/D1 按日（`YYYY-MM-DD`，对应免费额度 10万/天 等日额）、R2 按月（`YYYY-MM`，对应 10GB/月），口径与 `/api` 各产品查询一致；`getPeriodKey` 按注册表的 `period` 字段生成。
- 免费额度默认值集中在 `monitor/worker.js` 的 `FREE` 与 `functions/api.js` 的 `PRODUCT_DEFS` 两处注册表，按官方最新额度调整。
- KV 免费额度有读写次数限制：低于最低阈值时不读 KV、仅在跨越新阈值时写，尽量压低用量。

## 稳定性注意事项

- GraphQL 与应用状态：Cloudflare 统计数据可能有几分钟延迟，勿误判为代码 bug。
- 通知渠道（Server酱/Telegram）为第三方服务，可能超量或失效，失败仅记日志不阻塞。