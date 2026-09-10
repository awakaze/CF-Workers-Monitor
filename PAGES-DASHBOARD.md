# Pages 仪表盘（详细文档）

> 这是 [README.md](./README.md) 中「Pages 仪表盘」部分的详细展开文档，涵盖功能、配置、部署、参数解释与数据说明。返回总览请回 [README.md](./README.md)。

仪表盘由 `public/`（前端静态资源）与 `functions/api.js`（Pages Function 后端，查询 Cloudflare GraphQL 返回用量）组成，经 Cloudflare Pages 托管。

## ✨ 功能

- **·** 🖥️ 实时数据 - 显示各账户 Workers 和 Pages 的请求量和使用情况
- **·** 剩余额度 / 使用百分比 - 展示总配额、已用量、剩余量、进度条
- **·** 多产品用量区块 - 账户卡片内展示 KV / R2 / D1 / Pages构建 等免费用量（监控 Worker 亦按同一套指标告警）
- **·** 切换账户 / 手动刷新 / 主题切换

## ⚙️ 配置

### EDGE 环境变量（账户数组）

仪表盘与监控 Worker **共用同一份 `EDGE` 配置**，为账户数组 JSON：

```json
[
  {
    "name": "账户1",
    "token": "Cloudflare账户API密钥",
    "accountId": "Cloudflare账户ID"
  },
  {
    "name": "账户2",
    "token": "Cloudflare账户API密钥",
    "accountId": "Cloudflare账户ID"
  }
]
```

| 字段 | 说明 |
|--|--|
| `name` | 账户显示名（随意，如"账户1"） |
| `token` | Cloudflare API Token（需 `Account Analytics: Read` 权限） |
| `accountId` | Cloudflare 账户 ID |

> 💡 环境变量需是**单行、英文逗号**的合法 JSON（`EDGE=[{"name":"...","token":"...","accountId":"..."}]`），避免中文逗号导致解析失败。

### 所需配置文件（仪表盘）

| 文件 / 位置 | 给谁用 | 填什么 |
|--|--|--|
| 根目录 `.dev.vars`（由 `.dev.vars.example` 复制） | Pages 仪表盘本地（`pnpm dev:pages`） | `EDGE` |
| Pages 控制台 → Settings → Environment Variables | 生产环境 | `EDGE` |

> ⚠️ `.dev.vars` 已被 `.gitignore` 忽略、不会提交；模板 `.dev.vars.example` 会提交、仅含占位符。敏感值只放进 `.dev.vars` 或生产 secret，**切勿写入仓库其他文件**。

## 🚀 部署（Cloudflare Pages）

**前提条件**

1. Cloudflare 账户 ID：Cloudflare 控制台 → 右上角头像 → 我的个人资料 → 左侧"账户信息"，即可看到 账户 ID。

2. Cloudflare API 密钥：Cloudflare 控制台 → 我的个人资料 → API 令牌 → 创建令牌，授予以 `Account Analytics: Read`（可再加 Pages: Read / Account Settings: Read）权限。将该 `token` 与 `accountId` 填入 `EDGE`。

**部署步骤（二选一）**

- **控制台（Git 集成）**：
  1. Cloudflare 控制台 → Workers & Pages → Create → Pages → 连接 GitHub 仓库。
  2. 构建输出目录填 `public`。
  3. 在 Pages 控制台 → Settings → Environment Variables 设置 `EDGE`。
  4. 保存并部署；之后每次 push 到 main 自动重新部署。

- **命令行（wrangler）**：本地配好根目录 `.dev.vars`（含 `EDGE`）后，执行 `pnpm deploy:pages`（等价 `wrangler pages deploy public`，首次会引导创建项目）。

部署完成后，打开 Pages 的 URL 即可访问监控面板。

## 🧪 本地开发（Pages）

依赖 wrangler CLI（已配置于 `package.json`），首次运行：

```bash
pnpm install
```

把根目录 `.dev.vars.example` 复制为 `.dev.vars` 并填入 `EDGE`，然后：

```bash
pnpm dev:pages
```

| 命令 | 作用 | 访问地址 |
|--|--|--|
| `pnpm dev:pages` | 本地运行仪表盘（加载 `functions/`） | http://localhost:8788 |

## 📈 数据说明与状态

**监控指标**

- **·** Pages 请求数：Cloudflare Pages 函数的调用次数
- **·** Workers 请求数：Cloudflare Workers 的调用次数
- **·** 剩余额度：总配额减去已使用量
- **·** 使用百分比：剩余额度占总配额的百分比

**多产品用量**（每账户卡片内"其他产品用量"区块）：

| 产品 | 指标 | 免费额度（默认） | 周期 |
|--|--|--|--|
| Workers | 请求数（errors/子请求/CPU耗时 仅展示不告警） | 10万/天 | 日 |
| KV | 读取 / 写入 / 存储 | 读10万、写1千/天，存储1GB | 日 |
| R2 | A类操作 / B类操作 / 存储 | A类100万、B类1000万/账期，存储10GB | 账期 |
| D1 | 读行数 / 写行数 / 存储 | 读500万行、写10万行/天，存储5GB | 日 |
| Pages | 构建数 | 500/月 | 自然月 |

> 免费额度以 Cloudflare 官方最新为准，可在 `functions/api.js` 的 `PRODUCT_DEFS`（仪表盘）与 `monitor/worker.js` 的 `FREE`（监控）中调整。

**状态指示**

- **·** 🟢 充足：剩余额度 ≥ 70%
- **·** 🟡 警告：剩余额度 30% - 70%
- **·** 🔴 不足：剩余额度 < 30%

---

[返回总览 README.md](./README.md)