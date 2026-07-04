/**
 * DeepSeek Usage Tracker — VSCode Extension
 *
 * 数据源：
 *   余额  → api.deepseek.com/user/balance           (API Key sk-...)
 *   用量  → platform.deepseek.com/api/v0/usage/*     (Session Token + Cookie)
 *
 * 最少参数：apiKey + sessionToken + cookie，proxy 可选
 */

const vscode = require('vscode');
const https = require('https');
const http = require('http');
const tls = require('tls');

// ============================================================
//  Constants
// ============================================================

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟

const L10N = {
  en: {
    title: 'DeepSeek Usage',
    balance: 'Balance',
    monthCost: 'This Month',
    remaining: 'Remaining',
    modelBreakdown: 'Model Breakdown',
    dailyUsage: 'Daily Usage',
    model: 'Model',
    tokens: 'Tokens',
    cost: 'Cost',
    requests: 'Requests',
    loading: 'Loading...',
    noData: 'No data',
    noSessionToken: 'Set Session Token & Cookie in settings for usage data',
    refresh: 'Refresh',
    activated: '[DeepSeek Usage] Activated',
    deactivated: '[DeepSeek Usage] Deactivated',
    errSessionExpired: 'Session expired, please re-login',
    errNetwork: 'Network error',
    errNoApiKey: 'Set API Key',
    totalTokens: 'Total Tokens',
    cacheHit: 'Cache Hit',
    cacheMiss: 'Cache Miss',
    response: 'Response',
  },
  'zh-cn': {
    title: 'DeepSeek Usage',
    balance: '余额',
    monthCost: '本月消费',
    remaining: '剩余',
    modelBreakdown: '模型用量明细',
    dailyUsage: '每日用量',
    model: '模型',
    tokens: 'Tokens',
    cost: '金额',
    requests: '请求数',
    loading: '加载中...',
    noData: '暂无数据',
    noSessionToken: '请在设置中配置 Session Token 和 Cookie 以获取用量数据',
    refresh: '刷新',
    activated: '[DeepSeek Usage] 已激活',
    deactivated: '[DeepSeek Usage] 已停用',
    errSessionExpired: '会话已过期，请重新登录获取 Token',
    errNetwork: '网络错误',
    errNoApiKey: '请设置 API Key',
    totalTokens: 'Token 总量',
    cacheHit: '缓存命中',
    cacheMiss: '缓存未命中',
    response: '输出',
  },
};

function t() {
  const lang = vscode.workspace.getConfiguration('deepseek-usage').get('language', 'zh-cn');
  return L10N[lang] || L10N['zh-cn'];
}

function formatTokens(n) {
  const num = parseInt(n);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toString();
}

function formatCost(n) {
  return '¥' + parseFloat(n).toFixed(2);
}

// ============================================================
//  HTTP Client — with optional proxy support (HTTP CONNECT)
// ============================================================

/**
 * 发送 HTTPS 请求，支持可选的 HTTP CONNECT 代理
 * @param {{ hostname, path, method, headers, proxy?: string }} opts
 * @returns {Promise<{ status: number, data: string }>}
 */
function httpsRequest(opts) {
  const { hostname, path, method, headers, proxy } = opts;

  return new Promise((resolve, reject) => {
    // ---- 直连模式（无代理） ----
    if (!proxy) {
      const req = https.request(
        { hostname, path, method, headers, timeout: 15000 },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, data: body }));
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
      return;
    }

    // ---- 代理模式：HTTP CONNECT 隧道 ----
    const proxyUrl = new URL(proxy);
    const proxyReq = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port || 8080,
      method: 'CONNECT',
      path: `${hostname}:443`,
      headers: { 'User-Agent': 'vscode-deepseek-usage' },
      timeout: 10000,
    });

    proxyReq.on('connect', (_res, socket) => {
      const tlsSocket = tls.connect(
        { socket, servername: hostname, rejectUnauthorized: false },
        () => {
          // 手动构造 HTTP/1.1 请求
          const reqLines = [
            `${method} ${path} HTTP/1.1`,
            `Host: ${hostname}`,
            ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
            'Connection: close',
            '',
            '',
          ];
          tlsSocket.write(reqLines.join('\r\n'));

          let raw = '';
          let headerDone = false;
          let statusCode = 0;

          tlsSocket.on('data', (chunk) => {
            raw += chunk.toString();
            if (!headerDone) {
              const idx = raw.indexOf('\r\n\r\n');
              if (idx !== -1) {
                const m = raw.substring(0, idx).match(/HTTP\/\d\.\d (\d+)/);
                statusCode = m ? parseInt(m[1]) : 0;
                raw = raw.substring(idx + 4);
                headerDone = true;
              }
            }
          });

          tlsSocket.on('end', () => resolve({ status: statusCode, data: raw }));
          tlsSocket.on('error', reject);
          tlsSocket.setTimeout(15000, () => {
            tlsSocket.destroy();
            reject(new Error('TLS timeout'));
          });
        }
      );
      tlsSocket.on('error', reject);
    });

    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      reject(new Error('Proxy timeout'));
    });
    proxyReq.end();
  });
}

// ============================================================
//  API Functions
// ============================================================

/**
 * 查询余额（API Key 认证）
 * GET https://api.deepseek.com/user/balance
 */
async function fetchBalance(apiKey) {
  const { status, data } = await httpsRequest({
    hostname: 'api.deepseek.com',
    path: '/user/balance',
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'deepseek-usage-vscode/0.0.1',
    },
  });

  if (status === 401) throw new Error('API Key 无效 (401)');
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return JSON.parse(data);
}

/**
 * 查询用量 Token 数（Session Token + Cookie 认证）
 * GET https://platform.deepseek.com/api/v0/usage/amount?month=X&year=Y
 */
async function fetchUsageAmount(sessionToken, cookie, proxy, month, year) {
  const { status, data } = await httpsRequest({
    hostname: 'platform.deepseek.com',
    path: `/api/v0/usage/amount?month=${month}&year=${year}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      Cookie: cookie || '',
      'x-client-locale': 'zh_CN',
      'x-client-platform': 'web',
      'x-client-timezone-offset': '28800',
      'x-client-version': '1.0.0',
      Referer: 'https://platform.deepseek.com/usage',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
    },
    proxy: proxy || undefined,
  });

  if (status === 401) throw new Error('Session 过期，请重新获取 Token');
  if (status === 429) throw new Error('被限流，请稍后再试');
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return JSON.parse(data);
}

/**
 * 查询消费金额（Session Token + Cookie 认证）
 * GET https://platform.deepseek.com/api/v0/usage/cost?month=X&year=Y
 */
async function fetchUsageCost(sessionToken, cookie, proxy, month, year) {
  const { status, data } = await httpsRequest({
    hostname: 'platform.deepseek.com',
    path: `/api/v0/usage/cost?month=${month}&year=${year}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      Cookie: cookie || '',
      'x-client-locale': 'zh_CN',
      'x-client-platform': 'web',
      'x-client-timezone-offset': '28800',
      'x-client-version': '1.0.0',
      Referer: 'https://platform.deepseek.com/usage',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
    },
    proxy: proxy || undefined,
  });

  if (status !== 200) throw new Error(`HTTP ${status}`);
  return JSON.parse(data);
}

// ============================================================
//  Data Aggregation
// ============================================================

/**
 * 聚合用量数据：合并 amount + cost，计算每个模型的总 token 和总消费
 */
function aggregateUsage(amountData, costData) {
  const models = {};

  // Amount 结构: data.biz_data.total[] → { model, usage[{ type, amount }] }
  const amountTotal = amountData?.data?.biz_data?.total || [];
  const amountDays = amountData?.data?.biz_data?.days || [];

  // Cost 结构: data.biz_data[0].total[] → { model, usage[{ type, amount }] }
  const costBiz = costData?.data?.biz_data;
  const costTotal = Array.isArray(costBiz) ? costBiz[0]?.total || [] : costBiz?.total || [];
  const costDays = Array.isArray(costBiz) ? costBiz[0]?.days || [] : costBiz?.days || [];

  // 合并 total
  for (const item of amountTotal) {
    const m = (models[item.model] = models[item.model] || {
      model: item.model,
      tokens: {},
      cost: {},
      totalTokens: 0,
      totalCost: 0,
      requests: 0,
    });
    for (const u of item.usage) {
      m.tokens[u.type] = parseInt(u.amount) || 0;
      if (u.type === 'REQUEST') m.requests = parseInt(u.amount) || 0;
      else m.totalTokens += parseInt(u.amount) || 0;
    }
  }
  for (const item of costTotal) {
    const m = models[item.model];
    if (!m) continue;
    for (const u of item.usage) {
      m.cost[u.type] = parseFloat(u.amount) || 0;
      m.totalCost += parseFloat(u.amount) || 0;
    }
  }

  // 合并 daily（取最近有数据的 7 天）
  const dayMap = {};
  for (const day of amountDays) {
    const d = (dayMap[day.date] = dayMap[day.date] || { date: day.date, tokens: 0, cost: 0 });
    for (const item of day.data || []) {
      for (const u of item.usage) {
        if (u.type !== 'REQUEST') d.tokens += parseInt(u.amount) || 0;
      }
    }
  }
  for (const day of costDays) {
    const d = dayMap[day.date];
    if (!d) continue;
    for (const item of day.data || []) {
      for (const u of item.usage) {
        d.cost += parseFloat(u.amount) || 0;
      }
    }
  }

  const days = Object.values(dayMap)
    .filter((d) => d.tokens > 0 || d.cost > 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 7)
    .reverse();

  const totalTokens = Object.values(models).reduce((s, m) => s + m.totalTokens, 0);
  const totalCost = Object.values(models).reduce((s, m) => s + m.totalCost, 0);

  return {
    models: Object.values(models),
    totalTokens,
    totalCost,
    days,
    modelCount: Object.keys(models).length,
  };
}

// ============================================================
//  Webview HTML Generator
// ============================================================

function buildPanelHtml(balance, usage, i18n) {
  const hasBalance = balance && balance.is_available;
  const bal = hasBalance ? balance.balance_infos[0] : null;
  const totalBalance = bal ? parseFloat(bal.total_balance) : 0;
  const monthCost = usage ? usage.totalCost : 0;
  const remaining = totalBalance - monthCost;
  const hasUsage = usage && usage.models && usage.models.length > 0;

  // 模型表格
  const modelRows = (usage?.models || [])
    .map(
      (m) =>
        `<tr><td>${escHtml(m.model)}</td><td class="num">${formatTokens(m.totalTokens)}</td><td class="num cost">${formatCost(m.totalCost)}</td><td class="num">${m.requests.toLocaleString()}</td></tr>`
    )
    .join('');

  // 每日用量表格
  const dayRows = hasUsage
    ? (usage.days || [])
        .map(
          (d) =>
            `<tr><td>${d.date.slice(5)}</td><td class="num">${formatTokens(d.tokens)}</td><td class="num cost">${formatCost(d.cost)}</td></tr>`
        )
        .join('')
    : '';

  // Token 分类统计
  const cacheHit = hasUsage
    ? usage.models.reduce((s, m) => s + (m.tokens.PROMPT_CACHE_HIT_TOKEN || 0), 0)
    : 0;
  const cacheMiss = hasUsage
    ? usage.models.reduce((s, m) => s + (m.tokens.PROMPT_CACHE_MISS_TOKEN || 0), 0)
    : 0;
  const respTokens = hasUsage
    ? usage.models.reduce((s, m) => s + (m.tokens.RESPONSE_TOKEN || 0), 0)
    : 0;
  const totalReqs = hasUsage
    ? usage.models.reduce((s, m) => s + m.requests, 0)
    : 0;

  const balSub = hasBalance
    ? `Topped Up: ${formatCost(parseFloat(bal.topped_up_balance))} | Granted: ${formatCost(parseFloat(bal.granted_balance))}`
    : i18n.errNoApiKey;
  const costSub = hasUsage
    ? `${formatTokens(usage.totalTokens)} tokens · ${usage.modelCount} models`
    : i18n.noSessionToken;
  const timeLabel = new Date().toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  // ---- 页面上所有内容都在 Node 端生成好，webview 只是展示 + 刷新按钮 ----
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DeepSeek Usage</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:var(--vscode-editor-background);
    color:var(--vscode-editor-foreground);
    padding:24px 28px;font-size:14px
  }
  .header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
  .header h1{font-size:20px;font-weight:600}
  .header-right{display:flex;align-items:center;gap:10px}
  .btn{
    padding:6px 16px;border:none;border-radius:4px;cursor:pointer;
    font-size:13px;font-weight:500;transition:opacity .15s
  }
  .btn:hover{opacity:.85}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  .btn-spin{display:inline-block;animation:spin 1s linear infinite}
  @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}

  #toast{
    position:fixed;top:12px;right:24px;z-index:999;
    padding:10px 20px;border-radius:6px;font-size:13px;
    background:var(--vscode-button-background);color:var(--vscode-button-foreground);
    box-shadow:0 4px 12px rgba(0,0,0,.3);
    transform:translateY(-120px);transition:transform .25s ease;pointer-events:none
  }
  #toast.show{transform:translateY(0)}
  #toast.success{background:#16a34a}
  #toast.error{background:#dc2626}

  .status-bar{
    display:flex;align-items:center;gap:8px;margin-bottom:16px;
    font-size:12px;color:var(--vscode-descriptionForeground)
  }
  .status-dot{width:6px;height:6px;border-radius:50%;display:inline-block}
  .status-dot.ok{background:#22c55e}
  .status-dot.err{background:#ef4444}

  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:28px}
  .card{
    background:var(--vscode-input-background);
    border:1px solid var(--vscode-input-border,transparent);
    border-radius:8px;padding:18px 20px
  }
  .card .label{
    font-size:12px;text-transform:uppercase;
    color:var(--vscode-descriptionForeground);margin-bottom:6px;letter-spacing:.5px
  }
  .card .value{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}
  .card .sub{font-size:12px;color:var(--vscode-descriptionForeground);margin-top:4px}
  .card.remaining .value{color:#22c55e}
  .card.cost .value{color:#f59e0b}

  .section-title{font-size:15px;font-weight:600;margin:24px 0 12px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{
    text-align:left;padding:8px 12px;font-weight:500;font-size:11px;
    text-transform:uppercase;letter-spacing:.5px;
    color:var(--vscode-descriptionForeground);
    border-bottom:1px solid var(--vscode-input-border,#333)
  }
  td{padding:10px 12px;border-bottom:1px solid var(--vscode-input-border,#222)}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .cost{color:#f59e0b;font-weight:500}
  .model-name{font-weight:500}

  .token-types{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}
  .token-type{
    background:var(--vscode-input-background);
    border-radius:6px;padding:12px 14px;text-align:center
  }
  .token-type .tt-label{font-size:11px;color:var(--vscode-descriptionForeground)}
  .token-type .tt-value{font-size:18px;font-weight:600;margin-top:4px}

  .empty{text-align:center;padding:40px 20px;color:var(--vscode-descriptionForeground)}
  .empty-icon{font-size:40px;margin-bottom:12px;opacity:.5}
  .empty p{font-size:13px;line-height:1.6}
  .last-updated{font-size:11px;color:var(--vscode-descriptionForeground)}
</style>
</head>
<body>

<div id="toast"></div>

<div class="header">
  <h1>${i18n.title}</h1>
  <div class="header-right">
    <span class="last-updated">${timeLabel}</span>
    <button class="btn btn-primary" id="refresh-btn" onclick="doRefresh()">${i18n.refresh}</button>
  </div>
</div>

<!-- Status -->
<div class="status-bar">
  <span class="status-dot ${hasBalance ? 'ok' : 'err'}"></span> Balance API &nbsp;|&nbsp;
  <span class="status-dot ${hasUsage ? 'ok' : 'err'}"></span> Usage API
</div>

<!-- Cards -->
<div class="cards">
  <div class="card">
    <div class="label">${i18n.balance}</div>
    <div class="value">${hasBalance ? formatCost(totalBalance) : '—'}</div>
    <div class="sub">${balSub}</div>
  </div>
  <div class="card cost">
    <div class="label">${i18n.monthCost}</div>
    <div class="value">${hasUsage ? formatCost(monthCost) : '—'}</div>
    <div class="sub">${costSub}</div>
  </div>
  <div class="card remaining">
    <div class="label">${i18n.remaining}</div>
    <div class="value">${hasBalance ? formatCost(remaining) : '—'}</div>
    <div class="sub">${hasBalance ? (remaining >= 0 ? 'OK' : 'Over budget!') : ''}</div>
  </div>
</div>

${
  hasUsage
    ? `
<!-- Token Types -->
<div class="section-title">${i18n.totalTokens}</div>
<div class="token-types">
  <div class="token-type"><div class="tt-label">${i18n.cacheHit}</div><div class="tt-value">${formatTokens(cacheHit)}</div></div>
  <div class="token-type"><div class="tt-label">${i18n.cacheMiss}</div><div class="tt-value">${formatTokens(cacheMiss)}</div></div>
  <div class="token-type"><div class="tt-label">${i18n.response}</div><div class="tt-value">${formatTokens(respTokens)}</div></div>
  <div class="token-type"><div class="tt-label">${i18n.requests}</div><div class="tt-value">${totalReqs.toLocaleString()}</div></div>
</div>

<!-- Model Breakdown -->
<div class="section-title">${i18n.modelBreakdown}</div>
<table>
  <thead><tr><th>${i18n.model}</th><th class="num">${i18n.tokens}</th><th class="num">${i18n.cost}</th><th class="num">${i18n.requests}</th></tr></thead>
  <tbody>${modelRows}</tbody>
</table>
`
    : ''
}

${
  hasUsage && dayRows
    ? `
<!-- Daily Usage -->
<div class="section-title">${i18n.dailyUsage}</div>
<table>
  <thead><tr><th>Date</th><th class="num">${i18n.tokens}</th><th class="num">${i18n.cost}</th></tr></thead>
  <tbody>${dayRows}</tbody>
</table>
`
    : ''
}

${
  !hasBalance && !hasUsage
    ? `
<div class="empty">
  <div class="empty-icon">&#x1F4CA;</div>
  <p>${i18n.noSessionToken}</p>
  <p style="font-size:12px;margin-top:8px">Settings &rarr; Deepseek-usage &rarr; Session Token / Cookie</p>
</div>
`
    : ''
}

<script>
  const vsc = acquireVsCodeApi()
  var toastTimer = null

  function show(msg, cls) {
    var t = document.getElementById('toast')
    t.textContent = msg
    t.className = (cls||'') + ' show'
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function(){ t.className = '' }, 2500)
  }

  function doRefresh() {
    var btn = document.getElementById('refresh-btn')
    btn.disabled = true
    btn.innerHTML = '<span class="btn-spin">&#x21bb;</span> Refreshing...'
    show('Refreshing...')
    vsc.postMessage({ type: 'refresh' })
  }

  // 扩展替换整个 HTML 后，这段 JS 重新执行，按钮自动恢复
</script>
</body>
</html>`;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
//  Extension Activation
// ============================================================

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  const i18n = t();
  const config = () => vscode.workspace.getConfiguration('deepseek-usage');

  // ---- 状态栏 ----
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    1
  );
  statusBarItem.command = 'deepseek-usage.showUsage';
  statusBarItem.text = '$(sync~spin) DeepSeek';
  statusBarItem.tooltip = i18n.loading;
  statusBarItem.show();

  // ---- 读取配置（SecretStorage 优先于 settings.json） ----
  async function getApiKey() {
    // 1. SecretStorage（加密存储，最高优先级）
    const secretKey = await context.secrets.get('deepseek.apiKey');
    if (secretKey) return secretKey;
    // 2. settings.json
    const configKey = config().get('apiKey', '');
    if (configKey) return configKey;
    return '';
  }

  async function getConfig() {
    const cfg = config();
    return {
      apiKey: await getApiKey(),
      sessionToken: cfg.get('sessionToken', '') || '',
      cookie: cfg.get('cookie', '') || '',
      proxy: cfg.get('proxy', '') || '',
    };
  }

  // ---- 数据获取（全部并行） ----
  /** @type {{ balance: any, usage: any, error: string|null }} */
  let latestData = { balance: null, usage: null, error: null };

  async function refreshAllData() {
    const cfg = await getConfig();
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    latestData = { balance: null, usage: null, error: null };

    // 并行获取余额 + 用量
    const results = await Promise.allSettled([
      // 余额（必须有 API Key）
      cfg.apiKey
        ? fetchBalance(cfg.apiKey)
        : Promise.reject(new Error('no-api-key')),
      // 用量（必须有 Session Token + Cookie）
      cfg.sessionToken && cfg.cookie
        ? (async () => {
            const [amountData, costData] = await Promise.all([
              fetchUsageAmount(cfg.sessionToken, cfg.cookie, cfg.proxy, month, year),
              fetchUsageCost(cfg.sessionToken, cfg.cookie, cfg.proxy, month, year),
            ]);
            return aggregateUsage(amountData, costData);
          })()
        : Promise.reject(new Error('no-session')),
    ]);

    if (results[0].status === 'fulfilled') {
      latestData.balance = results[0].value;
    }
    if (results[1].status === 'fulfilled') {
      latestData.usage = results[1].value;
    }

    // 错误收集
    const errors = [];
    if (results[0].status === 'rejected' && results[0].reason.message !== 'no-api-key') {
      errors.push('Balance: ' + results[0].reason.message);
    }
    if (results[1].status === 'rejected' && results[1].reason.message !== 'no-session') {
      errors.push('Usage: ' + results[1].reason.message);
    }
    latestData.error = errors.length ? errors.join(' | ') : null;

    // 更新状态栏
    updateStatusBar();

    // 如果 webview 开着，推送数据
    if (currentPanel) {
      currentPanel.webview.postMessage({
        type: 'updateData',
        data: latestData,
        i18n: t(),
      });
    }
  }

  function updateStatusBar() {
    const { balance, usage, error } = latestData;
    const msg = t();

    if (error) {
      statusBarItem.text = '$(error) DeepSeek';
      statusBarItem.tooltip = error + '\nClick to retry';
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.errorBackground'
      );
      return;
    }

    const bal = balance?.balance_infos?.[0];
    const balTotal = bal ? parseFloat(bal.total_balance).toFixed(2) : null;
    const cost = usage ? usage.totalCost.toFixed(2) : null;

    if (balTotal && cost) {
      statusBarItem.text = `$(credit-card) DeepSeek ${cost}/${balTotal}`;
      statusBarItem.tooltip = [
        `${msg.monthCost}: ${formatCost(cost)}`,
        `${msg.balance}: ${formatCost(balTotal)}`,
        '',
        'Click for details',
      ].join('\n');
      statusBarItem.backgroundColor = undefined;
    } else if (balTotal) {
      statusBarItem.text = `$(credit-card) DeepSeek ${balTotal}`;
      statusBarItem.tooltip = [
        `${msg.balance}: ${formatCost(balTotal)}`,
        '',
        'Set Session Token for usage data',
      ].join('\n');
      statusBarItem.backgroundColor = undefined;
    } else {
      statusBarItem.text = '$(key) DeepSeek';
      statusBarItem.tooltip = msg.errNoApiKey;
    }
  }

  // ---- Webview Panel 管理 ----
  /** @type {vscode.WebviewPanel|null} */
  let currentPanel = null;

  function updatePanelHtml() {
    if (currentPanel) {
      currentPanel.webview.html = buildPanelHtml(
        latestData.balance,
        latestData.usage,
        t()
      );
    }
  }

  function openUsagePanel() {
    if (currentPanel) {
      currentPanel.reveal();
      updatePanelHtml(); // 刷新数据
      return;
    }

    currentPanel = vscode.window.createWebviewPanel(
      'deepseekUsage',
      t().title,
      vscode.ViewColumn.Two,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    updatePanelHtml();

    // 监听 webview 消息 — 只用做刷新触发
    currentPanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'refresh') {
        statusBarItem.text = '$(sync~spin) DeepSeek';
        await refreshAllData();
        // 直接替换整个 HTML，按钮自动恢复正常
        updatePanelHtml();
      }
    });

    currentPanel.onDidDispose(() => {
      currentPanel = null;
    });
  }

  // ---- 注册命令 ----
  const showUsageCmd = vscode.commands.registerCommand(
    'deepseek-usage.showUsage',
    () => openUsagePanel()
  );

  const refreshCmd = vscode.commands.registerCommand(
    'deepseek-usage.refresh',
    async () => {
      statusBarItem.text = '$(sync~spin) DeepSeek';
      await refreshAllData();
    }
  );

  const setApiKeyCmd = vscode.commands.registerCommand(
    'deepseek-usage.setApiKey',
    async () => {
      const currentKey = await getApiKey();
      const newKey = await vscode.window.showInputBox({
        prompt: '请输入 DeepSeek API Key',
        placeHolder: 'sk-...',
        password: true,
        ignoreFocusOut: true,
        value: currentKey,
      });
      if (newKey !== undefined) {
        // 优先存 SecretStorage（加密），settings.json 作备份
        await context.secrets.store('deepseek.apiKey', newKey);
        await config().update('apiKey', newKey, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('API Key 已保存');
        refreshAllData();
      }
    }
  );

  // ---- 监听配置变更 ----
  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('deepseek-usage')) {
      refreshAllData().then(() => updatePanelHtml());
    }
  });

  // ---- 启动 ----
  await refreshAllData();
  const intervalId = setInterval(refreshAllData, REFRESH_INTERVAL_MS);

  context.subscriptions.push(
    statusBarItem,
    showUsageCmd,
    refreshCmd,
    setApiKeyCmd,
    configListener,
    { dispose: () => clearInterval(intervalId) }
  );

  console.log(i18n.activated);
}

function deactivate() {
  console.log('[DeepSeek Usage] Deactivated');
}

module.exports = { activate, deactivate };
