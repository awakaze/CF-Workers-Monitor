/**
 * CF-Workers-Monitor · 阈值监控通知 Worker
 *
 * 职责：
 *  - 由 Cron 定时触发（见 wrangler.toml 的 [triggers]）
 *  - 读取 EDGE 环境变量（与 Pages 仪表盘同款账户数组）
 *  - 对每个账户，按启用产品（默认 workers/kv/r2/d1）查询用量指标
 *  - 指标达到免费额度阈值（默认 50%/80%/95%）且本周期未推送过 → 推送 Server酱 + Telegram
 *  - 采用"高水位标志位"写法，尽量少读写 KV（免费 KV 有读写次数上限）
 *
 * 依赖的绑定 / 环境变量（由用户在 Cloudflare 控制台或 wrangler 配置）：
 *  - KV_STATE           KV 命名空间绑定，存"本周期已通知阈值"标志位
 *  - EDGE               账户数组 JSON（与 Pages 仪表盘格式一致）
 *  - MONITOR_PRODUCTS    可选，启用产品，逗号分隔，默认 "workers,kv,r2,d1"
 *  - THRESHOLD_<PRODUCT>_<METRIC>  可选，自定义某指标阈值（逗号分隔，绝对数值；设 "0" 表示不监控）
 *  - THRESHOLDS          可选，兼容旧版：仅对 workers/requests 生效
 *  - SERVERCHAN_KEY      可选，Server酱(微信) SendKey
 *  - TG_BOT_TOKEN        可选，Telegram Bot Token
 *  - TG_CHAT_ID          可选，Telegram 接收者 chat id
 */

// 产品 / 指标注册表：周期 + 各指标默认免费用量幅度(可根据官方最新额度调整)
const FREE = {
    workers: {
        period: 'day',
        metrics: {
            requests:    { quota: 100000, unit: '次', thresholds: [50000, 80000, 95000] }, // 免费 10万/天；50/80/95%
            errors:      { quota: 0,      unit: '个', alert: false }, // 非计费，仅展示
            subrequests: { quota: 0,      unit: '次', alert: false }, // 非计费，仅展示
            cpuTimeMs:   { quota: 0,      unit: 'ms', alert: false }, // 非计费，仅展示
        },
    },
    kv: {
        period: 'day',
        metrics: {
            reads:        { quota: 100000,        unit: '次', thresholds: [50000, 80000, 95000] }, // 免费 10万读/天；50/80/95%
            writes:       { quota: 1000,          unit: '次', thresholds: [800, 950] }, // 免费 1千写/天；80/95%
            storageBytes: { quota: 1024 ** 3,     unit: 'B',  thresholds: [858993459, 1020054733] }, // 免费 1GB；80/95%
        },
    },
    r2: {
        period: 'month',
        metrics: {
            classAOperations: { quota: 1000000,        unit: '次', thresholds: [800000, 950000] }, // 免费 A类 100万/月；80/95%
            classBOperations: { quota: 10000000,       unit: '次', thresholds: [8000000, 9500000] }, // 免费 B类 1000万/月；80/95%
            storageBytes:     { quota: 10 * 1024 ** 3, unit: 'B',  thresholds: [8589934592, 10200547328] }, // 免费 10GB；80/95%
        },
    },
    d1: {
        period: 'day',
        metrics: {
            rowsRead:         { quota: 5000000,       unit: '行', thresholds: [4000000, 4750000] }, // 免费 500万行/天；80/95%
            rowsWritten:      { quota: 100000,        unit: '行', thresholds: [80000, 95000] }, // 免费 10万行/天；80/95%
            databaseSizeBytes:{ quota: 5 * 1024 ** 3, unit: 'B',  thresholds: [4294967296, 5100273664] }, // 免费 5GB；80/95%
        },
    },
    pages: {
        period: 'month',
        metrics: {
            builds: { quota: 500, unit: '次', thresholds: [250, 400, 475] }, // 免费 500次构建/月；50/80/95%
        },
    },
};

const METRIC_LABELS = {
    workers: { requests: '请求数', errors: '错误数', subrequests: '子请求数', cpuTimeMs: 'CPU耗时' },
    kv: { reads: '读取', writes: '写入', storageBytes: '存储' },
    r2: { classAOperations: 'A类操作', classBOperations: 'B类操作', storageBytes: '存储' },
    d1: { rowsRead: '读行数', rowsWritten: '写行数', databaseSizeBytes: '存储' },
    pages: { builds: '构建数' },
};

// 各产品取数函数（GraphQL 或 REST）
const FETCHERS = {
    workers: getWorkersStats,
    kv: getKvStats,
    r2: getR2Stats,
    d1: getD1Stats,
    pages: getPagesBuildsStats,
};

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

export default {
    /** 定时任务入口：由 wrangler.toml 的 cron 触发 */
    async scheduled(event, env, ctx) {
        await runMonitor(env);
    },

    /** 邮件触发入口：收到绑定地址的邮件即触发一次监控（需在 CF 控制台把邮箱地址绑定到本 Worker） */
    async email(message, env, ctx) {
        console.log('收到邮件触发，开始运行监控');
        await runMonitor(env);
    },

    /** 便捷访问入口：/ 返回一行状态，可用于确认 Worker 存活 */
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname === '/') {
            const status = await readStatus(env);
            return jsonResponse({
                ok: true,
                service: 'cf-monitor',
                message: '阈值监控 Worker 正常运行',
                lastRun: status.lastRun || null,
                lastNotify: status.lastNotify || null,
            });
        }
        // 手动触发入口：可用 fetch 直接跑一次监控（生产环境没有触发 scheduled 的按钮）
        if (url.pathname === '/run') {
            try {
                await runMonitor(env);
                const status = await readStatus(env);
                return jsonResponse({
                    ok: true,
                    message: '已手动触发一次监控',
                    lastRun: status.lastRun || null,
                    lastNotify: status.lastNotify || null,
                });
            } catch (e) {
                return jsonResponse({ ok: false, error: e.message }, 500);
            }
        }
        return new Response('Not Found', { status: 404, headers: corsHeaders });
    },
};

/**
 * 主流程：遍历账户 → 遍历启用产品 → 查询指标 → 逐指标做阈值检查。
 */
async function runMonitor(env) {
    const notifyLog = [];
    try {
        let edges = [];
        try {
            edges = JSON.parse(env.EDGE || '[]');
        } catch (e) {
            throw new Error(`EDGE 环境变量格式错误: ${e.message}`);
        }
        if (!Array.isArray(edges) || edges.length === 0) {
            throw new Error('没有配置账户信息 (EDGE)');
        }

        const products = parseMonitorProducts(env);

        for (const account of edges) {
            const { token, accountId, name } = account;
            const acct = { accountName: name || accountId, accountId };
            if (!token || !accountId) {
                console.error('账户缺少 token 或 accountId:', name);
                continue;
            }
            for (const product of products) {
                const def = FREE[product];
                if (!def) continue;
                let metrics;
                try {
                    metrics = await FETCHERS[product](token, accountId);
                } catch (e) {
                    console.error(`账户「${name || accountId}」产品 ${product} 查询失败:`, e);
                    continue;
                }
                const periodKey = getPeriodKey(def.period);
                for (const [metricKey, meta] of Object.entries(def.metrics)) {
                    try {
                        await checkProductMetric(
                            env, acct, product, metricKey,
                            metrics[metricKey] || 0, meta, periodKey, notifyLog
                        );
                    } catch (e) {
                        console.error(`检查 ${product}/${metricKey} 失败:`, e);
                    }
                }
            }
        }
    } finally {
        // lastRun 每次运行都更新；lastNotify 仅在本次真正触发通知时更新，未通知则保留上次需通知时的状态
        const lastNotify = notifyLog.length ? {
            time: notifyLog[notifyLog.length - 1].time,
            count: notifyLog.length,
            attempts: notifyLog,
        } : undefined;
        await writeStatus(env, new Date().toISOString(), lastNotify);
    }
}

/**
 * 通用阈值检查：低于最低阈值不读 KV；仅在跨越新阈值时推送一次并写一次标志位。
 * alert:false 的非计费指标直接跳过。
 */
async function checkProductMetric(env, acct, product, metricKey, value, meta, periodKey, notifyLog) {
    if (meta && meta.alert === false) return; // 非计费指标：仅展示，不告警
    const quota = meta?.quota;
    const thresholds = computeThresholds(env, product, metricKey, meta);
    if (!thresholds.length) return; // 被显式禁用

    if (value < thresholds[0]) {
        // 未达到最低阈值，无需读取 KV / 判断去重
        return;
    }

    const key = `alert:${periodKey}:${acct.accountId}:${product}:${metricKey.toLowerCase()}`;
    const notified = new Set();
    try {
        const raw = await env.KV_STATE.get(key);
        if (raw) raw.split(',').forEach((t) => { const n = Number(t); if (!isNaN(n)) notified.add(n); });
    } catch (e) {
        console.error('读取 KV 失败:', e);
    }

    const crossed = thresholds.filter((t) => value >= t && !notified.has(t));
    if (crossed.length === 0) return;

    const label = (METRIC_LABELS[product] && METRIC_LABELS[product][metricKey]) || metricKey;
    const channels = await sendNotifications(
        env,
        `☁️ CF ${product.toUpperCase()} 用量提醒`,
        buildContent(acct, product, label, value, meta?.unit, crossed, periodKey)
    );
    // 累计本次运行的发送尝试，供 runMonitor 末尾统一写入状态
    notifyLog.push({
        time: new Date().toISOString(),
        title: `${product.toUpperCase()} · ${label}`,
        crossed,
        channels,
    });

    try {
        const merged = [...notified, ...crossed].sort((a, b) => a - b);
        await env.KV_STATE.put(key, merged.join(','));
    } catch (e) {
        console.error('写入 KV 失败:', e);
    }
}

/** 构造通知正文（Markdown），Server酱 与 Telegram 共用 */
function buildContent(acct, product, label, value, unit, crossed, periodKey) {
    return [
        `**账户**：${acct.accountName}`,
        `**产品**：${product.toUpperCase()} · ${label}`,
        `**当前用量**：${formatValue(value, unit)}`,
        `**已触发阈值**：${crossed.map((t) => formatValue(t, unit)).join('、')}`,
        `**统计周期**：${periodKey}`,
    ].join('\n');
}

/** 解析手动阈值：逗号分隔 → 升序去重的正数数组；空表示禁用该指标 */
function computeThresholds(env, product, metricKey, meta) {
    const envKey = `THRESHOLD_${product.toUpperCase()}_${metricKey.toUpperCase()}`;
    const raw = env[envKey];
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
        const list = parseThresholdList(raw);
        return list; // 可能为 [] → 禁用
    }
    // 兼容旧版 THRESHOLDS：仅命中 workers/requests
    if (product === 'workers' && metricKey === 'requests' && env.THRESHOLDS) {
        return parseThresholdList(env.THRESHOLDS);
    }
    // 使用注册表内的合理默认阈值
    if (meta && Array.isArray(meta.thresholds) && meta.thresholds.length) {
        return meta.thresholds.filter((n) => n > 0);
    }
    const quota = meta?.quota;
    if (!quota) return [];
    return [0.5, 0.8, 0.95]
        .map((r) => Math.round(quota * r))
        .filter((n) => n > 0 && n <= quota);
}

/** 解析通用阈值字符串：逗号分隔 → 升序去重的正数数组 */
function parseThresholdList(raw) {
    return [...new Set(
        String(raw).split(',').map((s) => Number(String(s).trim())).filter((n) => !isNaN(n) && n > 0)
    )].sort((a, b) => a - b);
}

/** 解析启用产品列表 */
function parseMonitorProducts(env) {
    const raw = env.MONITOR_PRODUCTS || 'workers,kv,r2,d1,pages';
    return String(raw).split(',').map((s) => String(s).trim().toLowerCase()).filter((p) => FREE[p]);
}

/**
 * 周期 key：day → YYYY-MM-DD（免费额度多数按日重置）；month → YYYY-MM（R2 按月）。
 */
function getPeriodKey(period) {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return period === 'month' ? `${y}-${m}` : `${y}-${m}-${day}`;
}

/** 数值展示：字节→可读容量，其它→toLocaleString */
function formatValue(n, unit) {
    if (unit === 'B') return formatBytes(n);
    return n.toLocaleString('zh-CN') + ' ' + unit;
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let v = bytes;
    let i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return v.toFixed(2) + ' ' + units[i];
}

/**
 * 持久化运行状态：lastRun（本次运行结束时间，总是更新）；
 * lastNotify（本次触发的发送尝试）。传入 undefined 表示不改变，保留上次需通知时的状态。
 */
async function writeStatus(env, lastRun, lastNotify) {
    if (!env.KV_STATE) return;
    try {
        const prev = await readStatus(env);
        const merged = {
            lastRun,
            lastNotify: lastNotify === undefined ? prev.lastNotify : lastNotify,
        };
        await env.KV_STATE.put('monitor:status', JSON.stringify(merged));
    } catch (e) {
        console.error('写入状态 KV 失败:', e);
    }
}

/** 读取持久化状态（不存在返回空对象） */
async function readStatus(env) {
    if (!env.KV_STATE) return {};
    try {
        const raw = await env.KV_STATE.get('monitor:status');
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        console.error('读取状态 KV 失败:', e);
        return {};
    }
}

/** 分别发送 Server酱 + Telegram，各自独立 try/catch；返回本次各渠道尝试结果 */
async function sendNotifications(env, title, content) {
    const channels = {};

    if (env.SERVERCHAN_KEY) {
        channels.serverchan = { configured: true, ok: false };
        try {
            const body = new URLSearchParams({ title, desp: content });
            const resp = await fetch(`https://sctapi.ftqq.com/${env.SERVERCHAN_KEY}.send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
            });
            if (resp.ok) {
                channels.serverchan.ok = true;
                console.log('Server酱 通知发送成功');
            } else {
                channels.serverchan.error = (await resp.text()).slice(0, 300);
                console.error('Server酱 发送失败:', channels.serverchan.error);
            }
        } catch (e) {
            channels.serverchan.error = e.message;
            console.error('Server酱 发送错误:', e);
        }
    }

    if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
        channels.telegram = { configured: true, ok: false };
        try {
            const resp = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: content, parse_mode: 'Markdown' }),
            });
            if (resp.ok) {
                channels.telegram.ok = true;
                console.log('Telegram 通知发送成功');
            } else {
                channels.telegram.error = (await resp.text()).slice(0, 300);
                console.error('Telegram 发送失败:', channels.telegram.error);
            }
        } catch (e) {
            channels.telegram.error = e.message;
            console.error('Telegram 发送错误:', e);
        }
    }

    return channels;
}

// ---------- 各产品 GraphQL 取数 ----------

/** 通用 GraphQL 请求：返回 accounts[0] 节点 */
async function runQuery(token, query, variables) {
    const response = await fetchWithRetry(
        GRAPHQL_URL,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ query, variables }),
        },
        2,
        1000
    );
    if (!response.ok) throw new Error(`API 请求失败: ${response.status}`);
    const data = await response.json();
    if (data.errors) throw new Error(`GraphQL 错误: ${JSON.stringify(data.errors)}`);
    const accounts = data?.data?.viewer?.accounts;
    if (!accounts || accounts.length === 0) throw new Error('未找到账户数据');
    return accounts[0];
}

/** 起始时间(UTC)：day→当日00:00；month→当月1日00:00 */
function periodStart(period) {
    const now = new Date();
    if (period === 'month') now.setUTCDate(1);
    now.setUTCHours(0, 0, 0, 0);
    return now.toISOString();
}

function dateStr(d) {
    return d.toISOString().split('T')[0];
}

/** Workers / Pages：请求、错误、子请求、CPU耗时（day） */
async function getWorkersStats(token, accountId) {
    const start = periodStart('day');
    const end = new Date().toISOString();
    const account = await runQuery(token, `query getBillingMetrics($accountId: string!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
      viewer {
        accounts(filter: {accountTag: $accountId}) {
          pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: $filter) {
            sum { requests }
          }
          workersInvocationsAdaptive(limit: 10000, filter: $filter) {
            sum { requests errors subrequests cpuTimeUs }
          }
        }
      }
    }`, { accountId, filter: { datetime_geq: start, datetime_leq: end } });

    const pagesGroups = account.pagesFunctionsInvocationsAdaptiveGroups || [];
    const workersArr = account.workersInvocationsAdaptive || [];
    const sum = (arr, f) => arr.reduce((acc, g) => acc + (g?.sum ? f(g.sum) : 0), 0);
    const wReq = sum(workersArr, (s) => s.requests || 0);
    const pReq = sum(pagesGroups, (s) => s.requests || 0);
    return {
        requests: wReq + pReq,
        errors: sum(workersArr, (s) => s.errors || 0),
        subrequests: sum(workersArr, (s) => s.subrequests || 0),
        // GraphQL 返回微秒，转成毫秒展示
        cpuTimeMs: sum(workersArr, (s) => (s.cpuTimeUs || 0)) / 1000,
    };
}

/** KV：读写次数 + 存储字节（day） */
async function getKvStats(token, accountId) {
    const d = dateStr(new Date());
    const account = await runQuery(token, `query kvMetrics($accountTag: string!, $start: Date, $end: Date) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          kvOperationsAdaptiveGroups(limit: 10000, filter: {date_geq: $start, date_leq: $end}) {
            sum { requests }
            dimensions { actionType }
          }
          kvStorageAdaptiveGroups(limit: 10000, filter: {date_geq: $start, date_leq: $end}, orderBy: [date_DESC]) {
            max { byteCount }
            dimensions { date }
          }
        }
      }
    }`, { accountTag: accountId, start: d, end: d });

    let reads = 0, writes = 0;
    for (const op of account.kvOperationsAdaptiveGroups || []) {
        const type = (op.dimensions?.actionType || '').toLowerCase();
        const n = op.sum?.requests || 0;
        if (type === 'read') reads += n;
        else if (type === 'write') writes += n;
    }
    let storageBytes = latestDateSum(account.kvStorageAdaptiveGroups, (r) => r.max?.byteCount || 0);
    return { reads, writes, storageBytes };
}

/** R2 操作分类：Class A（写/列/改）、Class B（读）、免费（Delete/Abort）。未知归 Class B（保守不误报计费） */
const R2_CLASS_A = new Set([
    'ListBuckets', 'PutBucket', 'ListObjects', 'ListObjectsV2', 'ListObjectVersions',
    'PutObject', 'CopyObject', 'CreateMultipartUpload', 'CompleteMultipartUpload',
    'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy',
    'ListParts', 'SuspendBucket', 'PutBucketEncryption', 'PutBucketCors',
    'PutBucketLifecycleConfiguration', 'PutBucketNotificationConfiguration',
    'PutBucketSippyConfiguration', 'ImportObject',
]);
const R2_FREE = new Set([
    'DeleteObject', 'DeleteObjects', 'DeleteBucket', 'AbortMultipartUpload',
]);
function classifyR2Action(actionType) {
    if (R2_CLASS_A.has(actionType)) return 'A';
    if (R2_FREE.has(actionType)) return 'F';
    return 'B'; // 其余读类（Head/Get/Usage、未知默认 B，避免误报计费）
}

/** R2：A类/B类操作次数 + 存储字节（month） */
async function getR2Stats(token, accountId) {
    const start = periodStart('month');
    const end = new Date().toISOString();
    const account = await runQuery(token, `query r2Metrics($accountTag: string!, $start: Time, $end: Time) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          r2OperationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $start, datetime_leq: $end}) {
            sum { requests }
            dimensions { actionType }
          }
          r2StorageAdaptiveGroups(limit: 10000, filter: {datetime_geq: $start, datetime_leq: $end}, orderBy: [datetime_DESC]) {
            max { payloadSize metadataSize }
            dimensions { datetime }
          }
        }
      }
    }`, { accountTag: accountId, start, end });

    let classA = 0, classB = 0;
    for (const r of account.r2OperationsAdaptiveGroups || []) {
        const cls = classifyR2Action(r.dimensions?.actionType || '');
        const n = r.sum?.requests || 0;
        if (cls === 'A') classA += n;
        else if (cls === 'B') classB += n;
        // 免费操作不计入任何一类
    }
    const storageBytes = latestDateSum(account.r2StorageAdaptiveGroups, (r) =>
        (r.max?.payloadSize || 0) + (r.max?.metadataSize || 0));
    return { classAOperations: classA, classBOperations: classB, storageBytes };
}

/** 取账户下全部 Pages 项目名 */
async function listPagesProjects(token, accountId) {
    const projects = [];
    let page = 1;
    for (;;) {
        const base = 'https://api.cloudflare.com/client/v4/accounts';
        const resp = await fetchWithRetry(`${base}/${accountId}/pages/projects?page=${page}`, {
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        }, 2, 1000);
        if (!resp.ok) throw new Error(`Pages 项目列表请求失败: ${resp.status}`);
        const data = await resp.json();
        if (!data.success) throw new Error(`Pages 项目列表错误: ${JSON.stringify(data.errors || data)}`);
        const arr = data.result || [];
        projects.push(...arr.map((p) => p.name));
        const info = data.result_info;
        if (!info || page >= info.total_pages) break;
        page++;
    }
    return projects;
}

/** Pages：本月构建次数（按 /deployments 的 created_on 统计，配额 500 次/月） */
async function getPagesBuildsStats(token, accountId) {
    const monthStartIso = periodStart('month'); // 当月1日 UTC 00:00
    const base = 'https://api.cloudflare.com/client/v4/accounts';
    const projects = await listPagesProjects(token, accountId);
    let builds = 0;
    for (const proj of projects) {
        let page = 1;
        for (;;) {
            const resp = await fetchWithRetry(`${base}/${accountId}/pages/projects/${encodeURIComponent(proj)}/deployments?page=${page}`, {
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            }, 2, 1000);
            if (!resp.ok) throw new Error(`完成构建请求失败[${proj}]: ${resp.status}`);
            const data = await resp.json();
            if (!data.success) throw new Error(`完成构建请求错误[${proj}]: ${JSON.stringify(data.errors || data)}`);
            const arr = data.result || [];
            for (const d of arr) {
                // created_on 为 ISO UTC 字符串，可直接按字典序与月初比较
                if ((d.created_on || '') < monthStartIso) { builds += 0; }
                else if ((d.created_on || '') >= monthStartIso) { builds += 1; }
            }
            // 部署按时间倒序；已早于月初则无需继续翻页
            const info = data.result_info;
            const reachedPast = arr.length > 0 && (arr[arr.length - 1].created_on || '') < monthStartIso;
            if (reachedPast) break;
            if (!info || page >= info.total_pages) break;
            page++;
        }
    }
    return { builds };
}

/** D1：读/写行数 + 存储字节（day） */
async function getD1Stats(token, accountId) {
    const d = dateStr(new Date());
    const account = await runQuery(token, `query d1Metrics($accountTag: string!, $start: Date, $end: Date) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          d1AnalyticsAdaptiveGroups(limit: 10000, filter: {date_geq: $start, date_leq: $end}) {
            sum { rowsRead rowsWritten }
          }
          d1StorageAdaptiveGroups(limit: 10000, filter: {date_geq: $start, date_leq: $end}, orderBy: [datetime_DESC]) {
            max { databaseSizeBytes }
            dimensions { datetime }
          }
        }
      }
    }`, { accountTag: accountId, start: d, end: d });

    const sum = (key) => (account.d1AnalyticsAdaptiveGroups || [])
        .reduce((acc, r) => acc + (r.sum?.[key] || 0), 0);
    const storageBytes = latestDateSum(account.d1StorageAdaptiveGroups, (r) => r.max?.databaseSizeBytes || 0);
    return { rowsRead: sum('rowsRead'), rowsWritten: sum('rowsWritten'), databaseSizeBytes: storageBytes };
}

/**
 * 取"最新时刻"快照的总和（存储为快照，按时间分组后求和最新一个时间窗）。
 * rows 已按时间倒序（orderBy datetime_DESC）。
 */
function latestDateSum(rows, valueFn) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    let latestKey = '';
    let total = 0;
    for (const row of rows) {
        const key = row.dimensions?.datetime || row.dimensions?.date || '';
        if (key > latestKey) {
            latestKey = key;
            total = valueFn(row);
        } else if (key === latestKey) {
            total += valueFn(row);
        }
    }
    return total || 0;
}

/** 带简单重试的 fetch，处理偶发的 5xx */
async function fetchWithRetry(url, options = {}, maxRetries = 3, delay = 1000) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) return response;
            if (response.status >= 500) throw new Error(`Server error: ${response.status}`);
            return response;
        } catch (error) {
            if (attempt === maxRetries - 1) throw error;
            await new Promise((resolve) => setTimeout(resolve, delay * (attempt + 1)));
        }
    }
}

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
}