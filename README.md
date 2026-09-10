[![status](https://img.shields.io/badge/status-active-success)]()
[![license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/licenses/MIT)

# Cloudflare Workers/Pages 用量监控

一个基于 Cloudflare Workers/Pages 开发的用量监控工具：既有一个**仪表盘**实时展示多个账户的 Workers / Pages / KV / R2 / D1 / Pages构建 用量，也有一套**阈值监控 Worker** 按定时任务检查免费用量、在接近额度时自动推送告警，防止计费风险。

项目分两个独立部署单元：

- **① Pages 仪表盘**（`public/` + `functions/api.js`）：浏览器访问的可视化面板，实时展示各产品或账户用量。
- **② 监控 Worker**（`monitor/`）：Cron 定时触发，查各产品免费用量、超过阈值时通过 Server酱/Telegram 推送通知（Pages 不支持定时任务，故监控放独立 Worker）。

![img](./img.png)

## ✨ 通用功能特点

**·** 🎯 多账户支持 - 同时监控多个 Cloudflare 账户

**·** 🎨 美观界面 - 现代化、响应式的仪表板界面（Pages 仪表盘）

**·** 🌙 主题切换 - 支持亮色/暗色主题（Pages 仪表盘）

**·** ⚡ 快速响应 - 使用并发查询优化性能

**·** 🔄 自动刷新 - 每 60 秒自动更新数据（服务端另有 60 秒缓存，降低 API 调用）

**·** 📱 移动友好 - 完美适配各种屏幕尺寸

**·** 💰 省额度设计 - 低于最低阈值时不读取 KV、仅在跨越新阈值时才写入，尽量压低免费 KV 读写次数

---

# 📖 详细文档

每个部署单元的**详细分析、配置项、参数解释与部署流程**均拆分为独立文档：

| 文档 | 内容 |
|--|--|
| [**Pages 仪表盘**](./PAGES-DASHBOARD.md) | 仪表盘功能、`EDGE` 账户配置、部署与本地开发、数据说明与状态指示 |
| [**监控阈值通知 Worker**](./MONITOR-WORKER.md) | 监控功能、`wrangler.toml` 与部署步骤、全部监控参数详解、各产品指标阈值、KV 去重与账单周期说明、环境变量一览 |

---

# 🚀 快速开始

## 前提

**·** Cloudflare 账户 + API 密钥（`Account Analytics: Read`，可加 `Pages: Read`）与账户 ID，组成 `EDGE` 账户数组。

**·** `pnpm` 包管理器（项目内所有命令统一用 `pnpm`）。

## ① Pages 仪表盘

浏览器访问的可视化面板，实时展示各产品用量。部署到 Cloudflare Pages。

```bash
pnpm install          # 首次安装依赖
pnpm dev:pages        # 本地预览（http://localhost:8788）
pnpm deploy:pages     # 部署到 Cloudflare Pages
```

需要配置一根环境变量 `EDGE`（账户数组）。详细配置与部署见 [PAGES-DASHBOARD.md](./PAGES-DASHBOARD.md)。

## ② 监控阈值通知 Worker

Cron 定时触发，空闲额度达到阈值时通过 Server酱 / Telegram 自动推送告警。

```bash
pnpm dev:monitor      # 本地运行（http://localhost:8787）
pnpm deploy:monitor   # 部署到 Cloudflare Worker
pnpm secret:put EDGE  # 设置敏感变量（其余令牌同理）
```

需配置 KV 命名空间、Cron 触发、`EDGE` + 通知令牌。完整部署步骤见 [MONITOR-WORKER.md](./MONITOR-WORKER.md)。

---

# 使用

## 🎯 使用方法

**1.** 查看总览：首页显示所有账户的总览统计

**2.** 切换账户：点击"查看账号"下拉菜单选择特定账户

**3.** 刷新数据：点击"刷新数据"按钮手动更新

**4.** 主题切换：点击主题切换按钮切换亮色/暗色模式

## 🔧 技术细节

**架构设计**

```
用户请求 → Cloudflare Worker/Pages Function → Cloudflare GraphQL API → 数据处理 → 响应返回
```

**性能优化**

**·** 并发查询：同时查询多个账户，大幅减少等待时间

**·** 智能缓存：60 秒缓存机制，减少 API 调用

**·** 重试机制：自动重试失败的请求

**·** 错误隔离：单个账户失败不影响其他账户

## 技术栈

**·** 运行时：Cloudflare Pages（仪表盘）+ Cloudflare Worker（监控）

**·** 前端：原生 HTML/CSS/JavaScript

**·** API：Cloudflare GraphQL API

**·** 部署：Cloudflare 边缘网络

自定义配置：修改代码中的常量来调整行为（如 `CONCURRENT_LIMIT`、缓存时间 `ttl`、重试策略 `maxRetries` / `retryDelay` 等）。

## ⚠️ 注意事项

**1.** API 限制：Cloudflare API 有速率限制，请合理配置刷新频率

**2.** 权限安全：妥善保管 API 密钥，使用最小权限

**3.** 数据延迟：监控数据可能有几分钟的延迟（勿误判为 bug）

**4.** 配额计算：确保配置的总配额与实际账户配额一致；通知渠道（Server酱/Telegram）为第三方服务，失败仅记日志不阻塞

## 📄 许可证

本项目基于 MIT 许可证开源 - 查看 LICENSE 文件了解详情。

## 🙏 致谢

**·** Cloudflare Workers
**·** Cloudflare GraphQL API
**·** 所有贡献者和用户

## 🔗 项目来源

本项目源自开源社区中一个同名的 Cloudflare Workers/Pages 用量监控项目。在原作者版本的基础上进行了大量扩展与重构——新增了多产品（KV / R2 / D1 / Pages构建）阈值监控、按 Cloudflare 账单周期统计、多账户独立告警、KV 去重与 Server酱/Telegram 推送等能力——现已发展为独立维护的项目，**不再跟随上游更新（已脱离上游分支别线）**。致敬并感谢原作者的出色工作与开源分享。

---

有问题？ 请提交 Issue 或联系维护者。

觉得有用？ 请给个 ⭐️ 支持一下！