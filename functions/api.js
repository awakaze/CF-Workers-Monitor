const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

const cache = {
    data: null,
    lastUpdated: 0,
    ttl: 1 * 60 * 1000,
};

// Pages Functions 的请求入口
export async function onRequest(context) {
    const { request, env } = context;
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }
    return handleAPIRequest(request, env);
}

async function handleAPIRequest(request, env) {
    try {
        const url = new URL(request.url);
        const isOptimized = url.searchParams.get('optimized') === 'true';
        const now = Date.now();
        
        if (isOptimized && cache.data && now - cache.lastUpdated < cache.ttl) {
            return jsonResponse(cache.data);
        }
        
        let EDGE;
        try {
            EDGE = JSON.parse(env.EDGE || '[]');
        } catch (e) {
            return jsonResponse({ error: '环境变量 EDGE 格式错误' }, 500);
        }
        
        if (EDGE.length === 0) {
            return jsonResponse({ error: '没有配置账户信息' }, 400);
        }
        
        const accountIndex = parseInt(url.searchParams.get('accountIndex')) || 0;
        const getAllAccounts = url.searchParams.get('all') === 'true';

        let result;
        if (getAllAccounts) {
            result = await getAllAccountsDataOptimized(EDGE);
            // 有失败账户时不写缓存，避免 60 秒内刷新仍看到错误卡片
            if (isOptimized && !result.accounts.some((a) => a.error)) {
                cache.data = result;
                cache.lastUpdated = now;
            }
        } else {
            if (accountIndex < 0 || accountIndex >= EDGE.length) {
                return jsonResponse({ error: '账户索引超出范围' }, 400);
            }
            result = await getAccountData(EDGE[accountIndex], accountIndex);
        }
        return jsonResponse(result);
    } catch (error) {
        console.error('Error:', error);
        // 只返回通用错误，原始错误详情仅在服务端日志
        return jsonResponse({ error: '服务器内部错误' }, 500);
    }
}

async function fetchWithRetry(url, options = {}, maxRetries = 3, delay = 1000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) return response;
            if (response.status >= 500) {
                throw new Error(`Server error: ${response.status}`);
            }
            return response;
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await new Promise((resolve) => setTimeout(resolve, delay * (i + 1)));
        }
    }
}

async function getAccountData(account, accountIndex) {
    const { token, accountId, total = 100000 } = account;

    if (!token || !accountId) {
        throw new Error(`账户 ${accountIndex} 缺少 token 或 accountId`);
    }

    // 一次查询拿到 pages/workers 请求量与 workers 附加指标（合并后避免重复 GraphQL 调用）
    const workersStats = await getWorkersStats(token, accountId);
    const { pagesSum = 0, workersSum = 0 } = workersStats;

    // 月度产品（R2/Pages）免费额度按订阅账单周期重置，非自然月；取一次账户级账单元日
    const cycle = await getBillingCycle(token, accountId);

    let products = null;
    try {
        products = await getAccountProducts(token, accountId, cycle, workersStats);
    } catch (e) {
        console.error(`账户 ${accountIndex} 多产品数据获取失败:`, e);
    }

    const remaining = total - pagesSum - workersSum;
    const percent = (remaining / total) * 100;
    
    return {
        accountIndex,
        accountName: account.name || `Account ${accountIndex}`,
        pagesSum,
        workersSum,
        products,
        billingCycleDegraded: !cycle, // 未能读到账单周期时为 true（当前按自然月近似展示）
        total,
        remaining,
        percent: Math.round(percent),
        date: new Date().toISOString().split('T')[0],
        formatted: {
            pagesSum: formatNumber(pagesSum),
            workersSum: formatNumber(workersSum),
            remaining: remaining.toLocaleString(),
            total: formatNumber(total),
        },
    };
}

async function getAllAccountsDataOptimized(accounts) {
    const CONCURRENT_LIMIT = 6;
    const results = [];
    const accountPromises = accounts.map((account, index) =>
        getAccountDataWithRetry(account, index)
    );
    for (let i = 0; i < accountPromises.length; i += CONCURRENT_LIMIT) {
        const batch = accountPromises.slice(i, i + CONCURRENT_LIMIT);
        const batchResults = await Promise.allSettled(batch);
        batchResults.forEach((result, batchIndex) => {
            const accountIndex = i + batchIndex;
            if (result.status === 'fulfilled') {
                results.push(result.value);
            } else {
                results.push({
                    accountIndex,
                    accountName: accounts[accountIndex]?.name || `Account ${accountIndex}`,
                    error: result.reason.message,
                    products: null,
                    pagesSum: 0,
                    workersSum: 0,
                    total: accounts[accountIndex]?.total || 100000,
                    remaining: 0,
                    percent: 0,
                });
            }
        });
        if (i + CONCURRENT_LIMIT < accountPromises.length) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    const totals = results.reduce(
        (acc, curr) => {
            if (!curr.error) {
                acc.pagesSum += curr.pagesSum;
                acc.workersSum += curr.workersSum;
                acc.total += curr.total;
                acc.remaining += curr.remaining;
            }
            return acc;
        },
        { pagesSum: 0, workersSum: 0, total: 0, remaining: 0 }
    );

    const overallPercent = totals.total > 0 ? (totals.remaining / totals.total) * 100 : 0;
    return {
        accounts: results,
        totals: {
            ...totals,
            percent: Math.round(overallPercent),
            formatted: {
                pagesSum: formatNumber(totals.pagesSum),
                workersSum: formatNumber(totals.workersSum),
                remaining: totals.remaining.toLocaleString(),
                total: formatNumber(totals.total),
            },
        },
        timestamp: new Date().toISOString(),
    };
}

async function getAccountDataWithRetry(account, accountIndex, maxRetries = 2) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await getAccountData(account, accountIndex);
        } catch (error) {
            if (attempt === maxRetries) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
    }
}

// ---------- 多产品用量（kv/r2/d1 及 workers 附加指标） ----------

// 各产品指标：默认免费用量幅度（可按官方最新额度调整）
const PRODUCT_DEFS = {
    workers: {
        metrics: {
            errors:      { quota: 0,   unit: '个', reportOnly: true },
            subrequests: { quota: 0,   unit: '次', reportOnly: true },
            cpuTimeMs:   { quota: 0,   unit: 'ms', reportOnly: true },
        },
    },
    kv: {
        metrics: {
            reads:        { quota: 100000,      unit: '次' },
            writes:       { quota: 1000,        unit: '次' },
            storageBytes: { quota: 1024 ** 3,   unit: 'B'  },
        },
    },
    r2: {
        metrics: {
            classAOperations: { quota: 1000000,       unit: '次' },
            classBOperations: { quota: 10000000,      unit: '次' },
            storageBytes:     { quota: 10 * 1024 ** 3, unit: 'B' },
        },
    },
    d1: {
        metrics: {
            rowsRead:          { quota: 5000000,       unit: '行' },
            rowsWritten:       { quota: 100000,        unit: '行' },
            databaseSizeBytes: { quota: 5 * 1024 ** 3, unit: 'B'  },
        },
    },
    pages: {
        metrics: {
            builds: { quota: 500, unit: '次' },
        },
    },
};

async function getAccountProducts(token, accountId, cycle, workersStats = {}) {
    const [workers, kv, r2, d1, pages] = await Promise.allSettled([
        Promise.resolve(workersStats), // workers 附加指标已由 getAccountData 取过，直接复用
        getKvStats(token, accountId),
        getR2Stats(token, accountId, cycle),
        getD1Stats(token, accountId),
        getPagesBuildsStats(token, accountId, cycle),
    ]);
    const pick = (r) => (r.status === 'fulfilled' ? r.value : {});
    const normalize = (raw, def) => {
        const out = {};
        for (const [key, meta] of Object.entries(def.metrics)) {
            const value = Number(raw[key] || 0);
            const percent = meta.quota ? Math.min(100, Math.round((value / meta.quota) * 100)) : 0;
            out[key] = {
                value,
                quota: meta.quota,
                unit: meta.unit,
                percent,
                reportOnly: !!meta.reportOnly,
                formatted: formatUnitValue(value, meta.unit),
            };
        }
        return out;
    };

    return {
        workers: normalize(pick(workers), PRODUCT_DEFS.workers),
        kv: normalize(pick(kv), PRODUCT_DEFS.kv),
        r2: normalize(pick(r2), PRODUCT_DEFS.r2),
        d1: normalize(pick(d1), PRODUCT_DEFS.d1),
        pages: normalize(pick(pages), PRODUCT_DEFS.pages),
    };
}

/** Workers：页面请求数、附加指标（错误/子请求/CPU耗时），一次 GraphQL 查询 */
async function getWorkersStats(token, accountId) {
    const start = dayStart();
    const end = new Date().toISOString();
    const account = await runGraphQL(token, `query getBillingMetrics($accountId: string!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
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
    const rows = account.workersInvocationsAdaptive || [];
    const sum = (f) => rows.reduce((a, r) => a + f(r?.sum), 0);
    return {
        pagesSum: pagesGroups.reduce((a, g) => a + (g?.sum?.requests || 0), 0),
        workersSum: sum((s) => s?.requests || 0),
        errors: sum((s) => s?.errors || 0),
        subrequests: sum((s) => s?.subrequests || 0),
        // GraphQL 返回微秒，转成毫秒展示
        cpuTimeMs: sum((s) => s?.cpuTimeUs || 0) / 1000,
    };
}

/** KV：读/写次数 + 存储 */
async function getKvStats(token, accountId) {
    const d = dateStr(new Date());
    const account = await runGraphQL(token, `query kvMetrics($accountTag: string!, $start: Date, $end: Date) {
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
        const t = (op.dimensions?.actionType || '').toLowerCase();
        const n = op.sum?.requests || 0;
        if (t === 'read') reads += n;
        else if (t === 'write') writes += n;
    }
    return { reads, writes, storageBytes: latestDateSum(account.kvStorageAdaptiveGroups, (r) => r.max?.byteCount || 0) };
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
    return 'B';
}

/** R2：A类/B类操作次数 + 存储（账单周期，默认自然月降级） */
async function getR2Stats(token, accountId, cycle) {
    const start = (cycle && cycle.startISO) || monthStart();
    const end = new Date().toISOString();
    const account = await runGraphQL(token, `query r2Metrics($accountTag: string!, $start: Time, $end: Time) {
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
    }
    const storageBytes = latestDateSum(account.r2StorageAdaptiveGroups, (r) =>
        (r.max?.payloadSize || 0) + (r.max?.metadataSize || 0));
    return { classAOperations: classA, classBOperations: classB, storageBytes };
}

const REST_BASE = 'https://api.cloudflare.com/client/v4/accounts';

/**
 * 读取账户的市值计费周期：调用 subscriptions 接口取"当前账单周期"起点。
 * 月度免费额度（R2/Pages 等）按订阅账单元日重置，而非自然月；
 * 以订阅提供的时间源推导当前周期起点（30 天滚动对齐）。失败返回 null（调用方降级为自然月）。
 */
async function getBillingCycle(token, accountId) {
    try {
        const resp = await fetchWithRetry(`${REST_BASE}/${accountId}/subscriptions`, {
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        }, 2, 1000);
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data.success || !Array.isArray(data.result)) return null;

        const subs = data.result.filter((s) =>
            s && (s.billing_cycle_anchor_timestamp || s.current_period_end || s.end_timestamp)
        );
        if (!subs.length) return null;

        const isPlatform = (s) => /worker|platform|pages/i
            .test(String(s.rate_plan?.id || s.rate_plan?.name || s.id || ''));
        const chosen = subs.find(isPlatform) || subs[0];

        const DAY = 24 * 3600 * 1000;
        const now = Date.now();
        let startMs = null;
        const pEnd = chosen.current_period_end || chosen.end_timestamp;
        if (pEnd) {
            // current_period_end 为 "MM/DD/YYYY HH:MM:SS" 无常时区的字符串，new Date 会按运行时本地时区解析
            // （dev=UTC+8 / 生产=UTC 会差 8 小时）；统一按 UTC 中的该日期 00:00 解析，保证跨环境一致
            const mm = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(pEnd));
            const endUtc = mm ? Date.UTC(+mm[3], +mm[1] - 1, +mm[2]) : new Date(pEnd).getTime();
            startMs = endUtc - 30 * DAY;
        } else if (chosen.billing_cycle_anchor_timestamp) {
            let s = new Date(chosen.billing_cycle_anchor_timestamp).getTime();
            while (s + 30 * DAY <= now) s += 30 * DAY;
            while (s > now) s -= 30 * DAY;
            startMs = s;
        }
        if (!startMs || isNaN(startMs)) return null;

        const start = new Date(startMs);
        return { startISO: start.toISOString(), anchorDay: dateStr(start) };
    } catch (e) {
        return null;
    }
}

/** 通用 REST GET：分页拉全，回调每页 result（不传 per_page，用 Cloudflare 默认页大小并只翻 page） */
async function restPaginate(token, accountId, path, onPage, fields = {}) {
    let page = 1;
    for (;;) {
        const qs = new URLSearchParams({ page: String(page), ...fields }).toString();
        const resp = await fetchWithRetry(`${REST_BASE}/${accountId}/${path}?${qs}`, {
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        }, 2, 1000);
        if (!resp.ok) throw new Error(`REST 请求失败 (${path}): ${resp.status}`);
        const data = await resp.json();
        if (!data.success) throw new Error(`REST 错误 (${path}): ${JSON.stringify(data.errors || data)}`);
        const arr = data.result || [];
        if (onPage && onPage(arr, data.result_info)) return; // 回调返回 true 表示提前终止
        const info = data.result_info;
        if (!info || page >= info.total_pages) break;
        page++;
    }
}

/** Pages：取全部项目名 */
async function listPagesProjects(token, accountId) {
    const projects = [];
    await restPaginate(token, accountId, 'pages/projects', (arr) => {
        projects.push(...arr.map((p) => p.name));
        return false;
    });
    return projects;
}

/** Pages：本月构建次数（按 /deployments 的 created_on 统计，配额 500 次/月，自然月重置） */
async function getPagesBuildsStats(token, accountId, cycle) {
    // Pages 构建数按 CF 免费套餐口径：自然月（当月1日 UTC 00:00）重置，而非订阅账单周期
    const monthStartIso = monthStart();
    const projects = await listPagesProjects(token, accountId);
    let builds = 0;
    for (const proj of projects) {
        await restPaginate(token, accountId, `pages/projects/${encodeURIComponent(proj)}/deployments`, (arr) => {
            for (const d of arr) if ((d.created_on || '') >= monthStartIso) builds += 1;
            // 部署按时间倒序；已早于月初则终止分页
            return arr.length > 0 && (arr[arr.length - 1].created_on || '') < monthStartIso;
        });
    }
    return { builds };
}

/** D1：读/写行数 + 存储 */
async function getD1Stats(token, accountId) {
    const d = dateStr(new Date());
    const account = await runGraphQL(token, `query d1Metrics($accountTag: string!, $start: Date, $end: Date) {
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
        .reduce((a, r) => a + (r.sum?.[key] || 0), 0);
    return {
        rowsRead: sum('rowsRead'),
        rowsWritten: sum('rowsWritten'),
        databaseSizeBytes: latestDateSum(account.d1StorageAdaptiveGroups, (r) => r.max?.databaseSizeBytes || 0),
    };
}

async function runGraphQL(token, query, variables) {
    const response = await fetchWithRetry(
        'https://api.cloudflare.com/client/v4/graphql',
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

function dayStart() {
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    return now.toISOString();
}

function monthStart() {
    const now = new Date();
    now.setUTCDate(1);
    now.setUTCHours(0, 0, 0, 0);
    return now.toISOString();
}

function dateStr(d) {
    return d.toISOString().split('T')[0];
}

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

function formatUnitValue(value, unit) {
    if (unit === 'B') return formatBytes(value);
    return value.toLocaleString('zh-CN') + ' ' + unit;
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let v = bytes;
    let i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return v.toFixed(2) + ' ' + units[i];
}

function formatNumber(num) {
    if (num < 1000) {
        return num.toString();
    }
    const suffixes = ['', 'k', 'm', 'b', 't'];
    let suffixIndex = 0;
    let formattedNum = num;
    while (formattedNum >= 1000 && suffixIndex < suffixes.length - 1) {
        formattedNum /= 1000;
        suffixIndex++;
    }
    return formattedNum.toFixed(1) + suffixes[suffixIndex];
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
        },
    });
}
