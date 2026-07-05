/**
 * DeepSeek Usage Tracker — VSCode Extension
 *
 * 数据源：
 *   余额  → api.deepseek.com/user/balance           (API Key sk-...)
 *   用量  → platform.deepseek.com/api/v0/usage/*     (Session Token + Cookie)
 */

const vscode = require('vscode');
const https = require('https');
const http = require('http');
const tls = require('tls');

// ============================================================
//  Constants & i18n
// ============================================================

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const L10N = {
  en: {
    title: 'DeepSeek Usage', balance: 'Balance', monthCost: 'This Month',
    monthlyUsage: 'Monthly Usage (Tokens)',
    modelDetail: 'Detail', requests: 'Requests', tokens: 'Tokens',
    loading: 'Loading...', refresh: 'Refresh', noSessionToken: 'Configure Session Token & Cookie',
    errNoApiKey: 'Set API Key', cacheHit: 'Cache Hit', cacheMiss: 'Cache Miss',
    output: 'Output', month: 'Month', toppedUp: 'Topped Up', granted: 'Granted',
  },
  'zh-cn': {
    title: 'DeepSeek Usage', balance: '余额', monthCost: '本月消费',
    monthlyUsage: '月度用量 (Tokens)',
    modelDetail: '明细', requests: '请求数', tokens: 'Tokens',
    loading: '加载中...', refresh: '刷新', noSessionToken: '请在设置中配置 Session Token 和 Cookie',
    errNoApiKey: '请设置 API Key', cacheHit: '缓存命中', cacheMiss: '缓存未命中',
    output: '输出', month: '月份', toppedUp: '充值', granted: '赠送',
  },
};

function t() {
  const lang = vscode.workspace.getConfiguration('deepseek-usage').get('language', 'zh-cn');
  return L10N[lang] || L10N['zh-cn'];
}

function fmtNum(n) { const v = parseInt(n) || 0; if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'; if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'; return '' + v; }
function fmtCost(n) { const v = parseFloat(n) || 0; if (v >= 100) return v.toFixed(1); return v.toFixed(2); }
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ============================================================
//  HTTP Client — supports optional HTTP CONNECT proxy
// ============================================================

function httpsRequest({ hostname, path, method, headers, proxy }) {
  return new Promise((resolve, reject) => {
    if (!proxy) {
      const req = https.request({ hostname, path, method, headers, timeout: 15000 }, (res) => {
        let body = ''; res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, data: body }));
      });
      req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); }); req.end(); return;
    }
    // HTTP CONNECT tunnel
    const pu = new URL(proxy);
    const preq = http.request({ host: pu.hostname, port: pu.port || 8080, method: 'CONNECT', path: `${hostname}:443`, timeout: 10000 });
    preq.on('connect', (_r, s) => {
      const ts = tls.connect({ socket: s, servername: hostname, rejectUnauthorized: false }, () => {
        ts.write([`${method} ${path} HTTP/1.1`, `Host: ${hostname}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), 'Connection: close', '', ''].join('\r\n'));
        let raw = '', hd = false, sc = 0;
        ts.on('data', (c) => { raw += c.toString(); if (!hd) { const i = raw.indexOf('\r\n\r\n'); if (i !== -1) { sc = parseInt((raw.substring(0, i).match(/HTTP\/\d\.\d (\d+)/) || ['', '0'])[1]); raw = raw.substring(i + 4); hd = true; } } });
        ts.on('end', () => resolve({ status: sc, data: raw }));
        ts.on('error', reject); ts.setTimeout(15000, () => { ts.destroy(); reject(new Error('TLS timeout')); });
      }); ts.on('error', reject);
    });
    preq.on('error', reject); preq.on('timeout', () => { preq.destroy(); reject(new Error('Proxy timeout')); }); preq.end();
  });
}

// ============================================================
//  API Functions
// ============================================================

async function fetchBalance(apiKey) {
  const { status, data } = await httpsRequest({ hostname: 'api.deepseek.com', path: '/user/balance', method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } });
  if (status === 401) throw new Error('API Key invalid (401)'); if (status !== 200) throw new Error(`HTTP ${status}`); return JSON.parse(data);
}

async function fetchPlatformApi(sessionToken, cookie, proxy, path) {
  const { status, data } = await httpsRequest({
    hostname: 'platform.deepseek.com', path, method: 'GET',
    headers: { Authorization: `Bearer ${sessionToken}`, Cookie: cookie || '', 'x-client-locale': 'zh_CN', 'x-client-platform': 'web', 'x-client-timezone-offset': '28800', 'x-client-version': '1.0.0', Referer: 'https://platform.deepseek.com/usage', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36' },
    proxy: proxy || undefined,
  });
  if (status === 401) throw new Error('Session expired');
  if (status === 429) throw new Error('Rate limited');
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return JSON.parse(data);
}

async function fetchMonthData(sessionToken, cookie, proxy, month, year) {
  const [amountData, costData] = await Promise.all([
    fetchPlatformApi(sessionToken, cookie, proxy, `/api/v0/usage/amount?month=${month}&year=${year}`),
    fetchPlatformApi(sessionToken, cookie, proxy, `/api/v0/usage/cost?month=${month}&year=${year}`),
  ]);
  return aggregateUsage(amountData, costData);
}

// ============================================================
//  Data Aggregation — produces chart-ready structure
// ============================================================

function aggregateUsage(amountData, costData) {
  const amountTotal = amountData?.data?.biz_data?.total || [];
  const amountDays = amountData?.data?.biz_data?.days || [];
  const costBiz = costData?.data?.biz_data;
  const costTotal = Array.isArray(costBiz) ? costBiz[0]?.total || [] : costBiz?.total || [];
  const costDays = Array.isArray(costBiz) ? costBiz[0]?.days || [] : costBiz?.days || [];

  // Merge by model
  const modelMap = {};
  for (const item of amountTotal) {
    const m = modelMap[item.model] = modelMap[item.model] || { model: item.model, cacheHit: 0, cacheMiss: 0, output: 0, cost: 0, requests: 0 };
    for (const u of item.usage) {
      if (u.type === 'REQUEST') m.requests = parseInt(u.amount) || 0;
      else if (u.type === 'PROMPT_CACHE_HIT_TOKEN') m.cacheHit += parseInt(u.amount) || 0;
      else if (u.type === 'PROMPT_CACHE_MISS_TOKEN') m.cacheMiss += parseInt(u.amount) || 0;
      else if (u.type === 'RESPONSE_TOKEN') m.output += parseInt(u.amount) || 0;
    }
  }
  for (const item of costTotal) {
    const m = modelMap[item.model]; if (!m) continue;
    let sum = 0; for (const u of item.usage) sum += parseFloat(u.amount) || 0; m.cost = sum;
  }
  const models = Object.values(modelMap).filter(m => m.cacheHit + m.cacheMiss + m.output + m.requests > 0);

  // Merge daily: by model per day
  const dayModelMap = {};
  for (const day of amountDays) {
    const dm = dayModelMap[day.date] = dayModelMap[day.date] || {};
    for (const item of day.data || []) {
      dm[item.model] = dm[item.model] || { cacheHit: 0, cacheMiss: 0, output: 0, requests: 0, cost: 0 };
      for (const u of item.usage) {
        if (u.type === 'REQUEST') dm[item.model].requests = parseInt(u.amount) || 0;
        else if (u.type === 'PROMPT_CACHE_HIT_TOKEN') dm[item.model].cacheHit += parseInt(u.amount) || 0;
        else if (u.type === 'PROMPT_CACHE_MISS_TOKEN') dm[item.model].cacheMiss += parseInt(u.amount) || 0;
        else if (u.type === 'RESPONSE_TOKEN') dm[item.model].output += parseInt(u.amount) || 0;
      }
    }
  }
  for (const day of costDays) {
    const dm = dayModelMap[day.date]; if (!dm) continue;
    for (const item of day.data || []) {
      if (!dm[item.model]) dm[item.model] = { cacheHit: 0, cacheMiss: 0, output: 0, requests: 0, cost: 0 };
      let sum = 0; for (const u of item.usage) sum += parseFloat(u.amount) || 0; dm[item.model].cost = sum;
    }
  }

  // Per-model daily arrays
  const modelDays = {};
  for (const [date, dm] of Object.entries(dayModelMap)) {
    for (const [model, vals] of Object.entries(dm)) {
      if (!modelDays[model]) modelDays[model] = [];
      modelDays[model].push({ date: date.slice(5), ...vals, total: vals.cacheHit + vals.cacheMiss + vals.output });
    }
  }
  for (const k of Object.keys(modelDays)) modelDays[k].sort((a, b) => a.date.localeCompare(b.date));

  // All days (for monthly chart)
  const days = Object.entries(dayModelMap).map(([date, dm]) => {
    let ch = 0, cm = 0, out = 0;
    for (const v of Object.values(dm)) { ch += v.cacheHit; cm += v.cacheMiss; out += v.output; }
    return { date: date.slice(5), cacheHit: ch, cacheMiss: cm, output: out, total: ch + cm + out };
  }).sort((a, b) => a.date.localeCompare(b.date));

  const totalTokens = models.reduce((s, m) => s + m.cacheHit + m.cacheMiss + m.output, 0);
  const totalCost = models.reduce((s, m) => s + m.cost, 0);
  const totalReqs = models.reduce((s, m) => s + m.requests, 0);

  return { models, days, modelDays, totalTokens, totalCost, totalReqs, modelCount: models.length };
}

// ============================================================
//  Webview HTML Generator — Canvas Charts Dashboard
// ============================================================

function buildPanelHtml(balance, usage, i18n, month, year) {
  const hasBalance = balance && balance.is_available;
  const bal = hasBalance ? balance.balance_infos[0] : null;
  const totalBalance = bal ? parseFloat(bal.total_balance) : 0;
  const monthCost = usage ? usage.totalCost : 0;
  const hasUsage = usage && usage.models.length > 0;

  // Inject data as JSON for JS
  const injectData = JSON.stringify({
    balance: balance, usage: usage, i18n: i18n,
    month: month, year: year, hasBalance: hasBalance, hasUsage: hasUsage,
    totalBalance: totalBalance, monthCost: monthCost,
    bal: bal,
  }).replace(/</g, '\\u003c').replace(/-->/g, '--\\>');

  // Month options
  const now = new Date();
  let monthOpts = '';
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = d.getMonth() + 1, y = d.getFullYear();
    const sel = m === month && y === year ? ' selected' : '';
    monthOpts += `<option value="${y}-${String(m).padStart(2, '0')}"${sel}>${y}-${String(m).padStart(2, '0')}</option>`;
  }

  const balHtml = hasBalance ? `
    <div class="cards">
      <div class="card"><div class="label">${i18n.balance}</div><div class="value">¥${fmtCost(totalBalance)}</div><div class="sub">${i18n.toppedUp}: ¥${fmtCost(parseFloat(bal.topped_up_balance))} | ${i18n.granted}: ¥${fmtCost(parseFloat(bal.granted_balance))}</div></div>
      <div class="card cost"><div class="label">${i18n.monthCost}</div><div class="value">¥${fmtCost(monthCost)}</div><div class="sub">${hasUsage ? fmtNum(usage.totalTokens) + ' tokens' : ''}</div></div>
    </div>` : `<div class="empty"><p>${i18n.errNoApiKey}</p></div>`;

  return `<!DOCTYPE html><html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>DeepSeek Usage</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);padding:20px 24px;font-size:13px}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.header h1{font-size:18px;font-weight:600}
.header-r{display:flex;align-items:center;gap:10px}
.month-select{padding:5px 10px;background:var(--vscode-input-background);color:var(--vscode-editor-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;font-size:13px;cursor:pointer}
.btn{padding:5px 14px;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:500}
.btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:16px}
.card{background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:6px;padding:14px 16px}
.card .label{font-size:11px;text-transform:uppercase;color:var(--vscode-descriptionForeground);margin-bottom:4px;letter-spacing:.5px}
.card .value{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.card .sub{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px}
.card.cost .value{color:#f59e0b}
.section-title{font-size:13px;font-weight:600;margin:16px 0 8px;display:flex;align-items:center;gap:8px}
.chart-wrap{background:var(--vscode-input-background);border-radius:6px;padding:12px;margin-bottom:12px;position:relative}
.chart-wrap canvas{display:block;width:100%}
.legend{display:flex;gap:16px;margin-bottom:8px;font-size:11px}
.legend-item{display:flex;align-items:center;gap:4px}
.legend-dot{width:8px;height:8px;border-radius:2px}
.model-header{font-size:13px;font-weight:600;margin:16px 0 6px;color:var(--vscode-textLink-foreground)}
.model-stats{display:flex;gap:16px;font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:4px}
.model-stats span{font-weight:600;color:var(--vscode-editor-foreground)}
.empty{text-align:center;padding:30px;color:var(--vscode-descriptionForeground)}
#toast{position:fixed;top:10px;right:20px;z-index:999;padding:8px 16px;border-radius:4px;font-size:12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);box-shadow:0 2px 8px rgba(0,0,0,.3);transform:translateY(-100px);transition:transform .2s;pointer-events:none}
#toast.show{transform:translateY(0)}
#chart-tip{position:fixed;pointer-events:none;z-index:998;background:var(--vscode-input-background);color:var(--vscode-editor-foreground);border:1px solid var(--vscode-input-border);border-radius:6px;padding:10px 14px;font-size:11px;line-height:1.6;box-shadow:0 4px 12px rgba(0,0,0,.3);opacity:0;transition:opacity .15s;max-width:220px}
#chart-tip.show{opacity:1}
#chart-tip .tip-row{display:flex;justify-content:space-between;gap:16px}
#chart-tip .tip-total{margin-top:4px;padding-top:4px;border-top:1px solid var(--vscode-input-border);font-weight:600}
</style></head>
<body><div id="toast"></div><div id="chart-tip"></div>
<div class="header">
  <h1>${i18n.title}</h1>
  <div class="header-r">
    <select class="month-select" id="monthSelect">${monthOpts}</select>
    <button class="btn btn-primary" id="refreshBtn">${i18n.refresh}</button>
  </div>
</div>
<div id="balanceArea">${balHtml}</div>
<div id="usageArea"></div>

<script>
(function() {
const vsc = acquireVsCodeApi();
var D = ${injectData};
var chartColors = { cacheHit: '#22c55e', cacheMiss: '#f59e0b', output: '#3b82f6', grid: '#333' };
var modelColors = ['#6366f1', '#ec4899', '#14b8a6', '#f97316'];

function fmtNum(n) { var v = parseInt(n)||0; if(v>=1e6)return (v/1e6).toFixed(1)+'M'; if(v>=1e3)return (v/1e3).toFixed(1)+'K'; return ''+v; }
function fmtCost(n) { return (parseFloat(n)||0).toFixed(2); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Toast
var toastTimer=null;
function toast(msg){ var e=document.getElementById('toast'); e.textContent=msg; e.className='show'; clearTimeout(toastTimer); toastTimer=setTimeout(function(){e.className=''},2000); }

// Theme-aware grid color
function gridColor() {
  var bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
  return bg && parseInt(bg.replace('#',''),16) < 0x888888 ? '#444' : '#ddd';
}

// ===== CANVAS HELPERS =====
function getCtx(id) {
  var c = document.getElementById(id); if(!c) return null;
  var dpr = window.devicePixelRatio||1;
  var rect = c.getBoundingClientRect();
  c.width = rect.width * dpr; c.height = rect.height * dpr;
  var ctx = c.getContext('2d'); ctx.scale(dpr,dpr);
  c.ctx = ctx; c.cw = rect.width; c.ch = rect.height;
  return ctx;
}

function drawHLine(ctx, w, y, color, x1, x2) {
  ctx.strokeStyle = color||gridColor(); ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(x1||0, y); ctx.lineTo(x2||w, y); ctx.stroke();
}

// ===== TOOLTIP HELPERS =====
var monthlyBarData = [];

function showChartTip(evt, html) {
  var e = document.getElementById('chart-tip');
  e.innerHTML = html; e.className = 'show';
  e.style.left = Math.min(evt.clientX + 14, window.innerWidth - 230) + 'px';
  e.style.top = (evt.clientY - 10) + 'px';
}
function hideChartTip() { document.getElementById('chart-tip').className = ''; }

// ===== MONTHLY STACKED BAR CHART =====
function drawMonthlyChart(canvas, models) {
  var ctx = getCtx(canvas.id); if(!ctx||!models.length) return;
  var w = canvas.cw, h = canvas.ch;
  var pad = { top: 20, right: 20, bottom: 30, left: 80 };
  var pw = w - pad.left - pad.right, ph = h - pad.top - pad.bottom;
  var barW = Math.min(120, pw / models.length - 20);
  var gap = (pw - barW * models.length) / (models.length + 1);

  var maxVal = 0;
  models.forEach(function(m){ maxVal = Math.max(maxVal, m.cacheHit + m.cacheMiss + m.output); });
  if (maxVal === 0) { ctx.fillStyle = '#888'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('No data', w/2, h/2); monthlyBarData=[]; return; }

  // Grid
  ctx.fillStyle = gridColor(); ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  var steps = 4;
  for (var i = 0; i <= steps; i++) {
    var y = pad.top + ph * (1 - i / steps);
    drawHLine(ctx, w, y, undefined, pad.left, w - pad.right);
    ctx.fillText(fmtNum(maxVal * i / steps), pad.left - 6, y + 4);
  }

  // Bars + store for hover
  monthlyBarData = [];
  models.forEach(function(m, i) {
    var x = pad.left + gap + i * (barW + gap);
    var total = m.cacheHit + m.cacheMiss + m.output;
    if (total === 0) return;
    var bh = ph * (total / maxVal);
    var segs = [
      { val: m.cacheHit, color: chartColors.cacheHit, label: 'Cache Hit' },
      { val: m.cacheMiss, color: chartColors.cacheMiss, label: 'Cache Miss' },
      { val: m.output, color: chartColors.output, label: 'Output' }
    ];
    var sy = pad.top + ph;
    var segRects = [];
    segs.forEach(function(s) {
      if (s.val === 0) return;
      var sh = ph * (s.val / maxVal);
      sy -= sh;
      ctx.fillStyle = s.color; ctx.fillRect(x, sy, barW, sh);
      if (sh > 14) {
        ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText((s.val/total*100).toFixed(0)+'%', x+barW/2, sy+sh/2+4);
      }
      segRects.push({ color: s.color, label: s.label, val: s.val, pct: (s.val/total*100).toFixed(1)+'%' });
    });
    monthlyBarData.push({ x:x, w:barW, model:m.model, total:total, segs:segRects, requests:m.requests, cost:m.cost });
    ctx.fillStyle = '#888'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(m.model.replace('deepseek-',''), x+barW/2, pad.top+ph+16);
    ctx.fillStyle = '#ccc'; ctx.font = 'bold 11px sans-serif';
    ctx.fillText(fmtNum(total), x+barW/2, pad.top+ph-bh-4);
  });

  // Hover
  canvas.onmousemove = function(e) {
    var rect = canvas.getBoundingClientRect();
    var scale = canvas.cw / rect.width;
    var mx = (e.clientX - rect.left) * scale;
    var found = monthlyBarData.find(function(b) { return mx >= b.x && mx <= b.x + b.w; });
    if (found) {
      var rows = found.segs.map(function(s) { return '<div class="tip-row"><span style="color:'+s.color+'">&#9679;</span> '+s.label+'<span>'+fmtNum(s.val)+' ('+s.pct+')</span></div>'; }).join('');
      rows += '<div class="tip-row tip-total"><span>'+esc(found.model)+'</span><span>'+fmtNum(found.total)+'</span></div>';
      rows += '<div class="tip-row"><span>&nbsp; Requests</span><span>'+found.requests.toLocaleString()+'</span></div>';
      rows += '<div class="tip-row"><span>&nbsp; Cost</span><span>¥'+fmtCost(found.cost)+'</span></div>';
      showChartTip(e, rows);
    } else { hideChartTip(); }
  };
  canvas.onmouseleave = hideChartTip;
}

// ===== DAILY REQUEST LINE CHART (with tooltip) =====
var lineTooltipData = {};

function drawRequestLine(canvas, days) {
  try {
  var ctx = getCtx(canvas.id); if(!ctx||!days.length) return;
  var w = canvas.cw, h = canvas.ch;
  var pad = { top: 10, right: 20, bottom: 24, left: 50 };
  var pw = w - pad.left - pad.right, ph = h - pad.top - pad.bottom;
  var points = [];

  var maxR = 0;
  days.forEach(function(d){ maxR = Math.max(maxR, d.requests); });
  if (maxR === 0) maxR = 10;

  ctx.fillStyle = gridColor(); ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
  for (var i = 0; i <= 3; i++) {
    var y = pad.top + ph * (1 - i/3);
    drawHLine(ctx, w, y, undefined, pad.left, w - pad.right);
    ctx.fillText(Math.round(maxR * i / 3), pad.left - 6, y + 3);
  }

  ctx.textAlign = 'center'; var step = Math.max(1, Math.floor(days.length / 8));
  days.forEach(function(d, i) {
    var x = pad.left + pw * i / (days.length - 1 || 1);
    if (i % step === 0 || i === days.length - 1) {
      ctx.fillStyle = gridColor(); ctx.fillText(d.date, x, pad.top + ph + 14);
    }
  });

  ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 2; ctx.beginPath();
  days.forEach(function(d, i) {
    var x = pad.left + pw * i / (days.length - 1 || 1);
    var y = pad.top + ph * (1 - d.requests / maxR);
    points.push({ x:x, y:y, date:d.date, val:d.requests });
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }); ctx.stroke();

  days.forEach(function(d, i) {
    var x = pad.left + pw * i / (days.length - 1 || 1);
    var y = pad.top + ph * (1 - d.requests / maxR);
    ctx.fillStyle = '#6366f1'; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI*2); ctx.fill();
  });

  lineTooltipData[canvas.id] = points;

  canvas.onmousemove = function(e) {
    var rect = canvas.getBoundingClientRect();
    var sx = canvas.cw / rect.width, sy = canvas.ch / rect.height;
    var mx = (e.clientX - rect.left) * sx, my = (e.clientY - rect.top) * sy;
    var pts = lineTooltipData[canvas.id] || [];
    var found = null, minDist = 24;
    pts.forEach(function(p) {
      var d = Math.sqrt((mx-p.x)*(mx-p.x)+(my-p.y)*(my-p.y));
      if (d < minDist) { minDist = d; found = p; }
    });
    if (found) { showChartTip(e, '<div class="tip-row"><span>'+found.date+'</span><span>'+found.val.toLocaleString()+' reqs</span></div>'); }
    else { hideChartTip(); }
  };
  canvas.onmouseleave = hideChartTip;
  } catch(e2) { console.error('drawRequestLine:', e2); }
}

// ===== DAILY TOKEN STACKED BAR (with tooltip) =====
var tokenBarData = {};

function drawDailyTokenBar(canvas, days) {
  try {
  var ctx = getCtx(canvas.id); if(!ctx||!days.length) return;
  var w = canvas.cw, h = canvas.ch;
  var pad = { top: 10, right: 20, bottom: 24, left: 50 };
  var pw = w - pad.left - pad.right, ph = h - pad.top - pad.bottom;
  var barW = Math.max(4, Math.min(30, pw / days.length - 2));
  var gap = (pw - barW * days.length) / (days.length + 1);
  var bars = [];

  var maxT = 0;
  days.forEach(function(d){ maxT = Math.max(maxT, d.total); });
  if (maxT === 0) { ctx.fillStyle = '#888'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('No data', w/2, h/2); return; }

  ctx.fillStyle = gridColor(); ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
  for (var i = 0; i <= 3; i++) {
    var y = pad.top + ph * (1 - i/3);
    drawHLine(ctx, w, y, undefined, pad.left, w - pad.right);
    ctx.fillText(fmtNum(maxT * i / 3), pad.left - 6, y + 3);
  }

  ctx.textAlign = 'center'; var step = Math.max(1, Math.floor(days.length / 10));
  days.forEach(function(d, i) {
    var x = pad.left + gap + i*(barW+gap);
    if (i % step === 0 || i === days.length - 1) {
      ctx.fillStyle = gridColor(); ctx.fillText(d.date, x + barW/2, pad.top + ph + 14);
    }
  });

  days.forEach(function(d, i) {
    var x = pad.left + gap + i*(barW+gap);
    var segs = [
      { val: d.cacheHit, color: chartColors.cacheHit, label: 'Cache Hit' },
      { val: d.cacheMiss, color: chartColors.cacheMiss, label: 'Cache Miss' },
      { val: d.output, color: chartColors.output, label: 'Output' }
    ];
    var sy = pad.top + ph;
    var segRects = [];
    segs.forEach(function(s) {
      if (s.val === 0) return;
      var sh = Math.max(1, ph * (s.val / maxT));
      sy -= sh;
      ctx.fillStyle = s.color; ctx.fillRect(x, sy, barW, sh);
      segRects.push({ val: s.val, color: s.color, label: s.label, pct: d.total>0?(s.val/d.total*100).toFixed(1)+'%':'0%' });
    });
    bars.push({ x:x, w:barW, date:d.date, total:d.total, segs:segRects, requests:d.requests||0, cost:d.cost||0 });
  });

  tokenBarData[canvas.id] = bars;

  canvas.onmousemove = function(e) {
    var rect = canvas.getBoundingClientRect();
    var sx = canvas.cw / rect.width;
    var mx = (e.clientX - rect.left) * sx;
    var bdata = tokenBarData[canvas.id] || [];
    var found = bdata.find(function(b) { return mx >= b.x && mx <= b.x + b.w; });
    if (found) {
      var rows = found.segs.map(function(s) { return '<div class="tip-row"><span style="color:'+s.color+'">&#9679;</span> '+s.label+'<span>'+fmtNum(s.val)+' ('+s.pct+')</span></div>'; }).join('');
      rows += '<div class="tip-row tip-total"><span>'+found.date+'</span><span>'+fmtNum(found.total)+'</span></div>';
      rows += '<div class="tip-row"><span>&nbsp; Reqs</span><span>'+found.requests.toLocaleString()+'</span></div>';
      if (found.cost) rows += '<div class="tip-row"><span>&nbsp; Cost</span><span>¥'+fmtCost(found.cost)+'</span></div>';
      showChartTip(e, rows);
    } else { hideChartTip(); }
  };
  canvas.onmouseleave = hideChartTip;
  } catch(e2) { console.error('drawDailyTokenBar:', e2); }
}

// ===== RENDER ALL =====
function render(data) {
  data = data || D;
  if (!data) return;

  var d = data.data || data;
  var bal = d.balance; var usage = d.usage; var i18n = d.i18n || {};

  // Balance cards (can come from data or from render call)
  if (data.type === 'updateData' || data.type === 'init') {
    var hb = d.hasBalance;
    var tb = d.totalBalance||0, mc = d.monthCost||0;
    if (hb && d.bal) {
      document.getElementById('balanceArea').innerHTML =
        '<div class="cards">' +
        '<div class="card"><div class="label">'+(i18n.balance||'Balance')+'</div><div class="value">¥'+fmtCost(tb)+'</div><div class="sub">'+(i18n.toppedUp||'Topped Up')+': ¥'+fmtCost(parseFloat(d.bal.topped_up_balance))+' | '+(i18n.granted||'Granted')+': ¥'+fmtCost(parseFloat(d.bal.granted_balance))+'</div></div>' +
        '<div class="card cost"><div class="label">'+(i18n.monthCost||'This Month')+'</div><div class="value">¥'+fmtCost(mc)+'</div></div>' +
        '</div>';
    }
  }

  var html = '';
  if (d.hasUsage && usage && usage.models && usage.models.length) {
    // Monthly chart
    html += '<div class="section-title">'+(i18n.monthlyUsage||'Monthly Usage')+'</div>';
    html += '<div class="legend">' +
      '<div class="legend-item"><div class="legend-dot" style="background:'+chartColors.cacheHit+'"></div>'+(i18n.cacheHit||'Cache Hit')+'</div>' +
      '<div class="legend-item"><div class="legend-dot" style="background:'+chartColors.cacheMiss+'"></div>'+(i18n.cacheMiss||'Cache Miss')+'</div>' +
      '<div class="legend-item"><div class="legend-dot" style="background:'+chartColors.output+'"></div>'+(i18n.output||'Output')+'</div>' +
      '</div>';
    html += '<div class="chart-wrap"><canvas id="monthlyChart" style="width:100%;height:220px"></canvas></div>';

    // Per-model charts
    if (usage.modelDays) {
      var modelNames = Object.keys(usage.modelDays);
      for (var mi = 0; mi < modelNames.length; mi++) {
        var mname = modelNames[mi];
        var md = usage.modelDays[mname];
        var mm = usage.models.find(function(x){return x.model===mname;});
        if (!mm || !md || !md.length) continue;
        var mid = mname.replace(/[^a-z0-9]/gi,'_');
        html += '<div class="model-header">'+esc(mname)+' <span style="font-weight:400;font-size:11px;color:#888">| ¥'+fmtCost(mm.cost)+'</span></div>';
        // Requests line chart with label
        html += '<div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:2px">'+(i18n.requests||'API Requests')+': <b style="color:var(--vscode-editor-foreground)">'+mm.requests.toLocaleString()+'</b></div>';
        html += '<div class="chart-wrap"><canvas id="req_'+mid+'" style="width:100%;height:120px"></canvas></div>';
        // Token stacked bar with label
        html += '<div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:2px">'+(i18n.tokens||'Tokens')+': <b style="color:var(--vscode-editor-foreground)">'+fmtNum(mm.cacheHit+mm.cacheMiss+mm.output)+'</b> ('+(i18n.cacheHit||'Hit')+': '+fmtNum(mm.cacheHit)+', '+(i18n.cacheMiss||'Miss')+': '+fmtNum(mm.cacheMiss)+', '+(i18n.output||'Out')+': '+fmtNum(mm.output)+')</div>';
        html += '<div class="chart-wrap"><canvas id="tok_'+mid+'" style="width:100%;height:180px"></canvas></div>';
      }
    }
    // Fallback: show model summaries even without daily data
    if (!usage.modelDays || Object.keys(usage.modelDays).length === 0) {
      for (var fi = 0; fi < usage.models.length; fi++) {
        var fm = usage.models[fi];
        html += '<div class="model-header">'+esc(fm.model)+' <span style="font-weight:400;font-size:11px;color:#888">| ¥'+fmtCost(fm.cost)+'</span></div>';
        html += '<div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:2px">'+(i18n.requests||'API Requests')+': <b style="color:var(--vscode-editor-foreground)">'+fm.requests.toLocaleString()+'</b></div>';
        html += '<div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:2px">'+(i18n.tokens||'Tokens')+': <b style="color:var(--vscode-editor-foreground)">'+fmtNum(fm.cacheHit+fm.cacheMiss+fm.output)+'</b></div>';
        html += '<div class="chart-wrap"><p style="padding:12px;color:#888;font-size:12px">Per-model daily data not available (session token may limit detail).</p></div>';
      }
    }
  } else {
    html += '<div class="empty"><p>'+(i18n.noSessionToken||'No usage data')+'</p></div>';
  }

  document.getElementById('usageArea').innerHTML = html;

  // Re-bind ResizeObserver to new chart containers
  if (typeof ro !== 'undefined') {
    document.querySelectorAll('.chart-wrap').forEach(function(el) { ro.observe(el); });
  }

  // Draw charts after DOM update
  setTimeout(function() {
    if (usage && usage.models && usage.models.length) {
      drawMonthlyChart(document.getElementById('monthlyChart'), usage.models);
    }
    if (usage && usage.modelDays) {
      Object.keys(usage.modelDays).forEach(function(mn) {
        var mid = mn.replace(/[^a-z0-9]/gi,'_');
        var md = usage.modelDays[mn];
        drawRequestLine(document.getElementById('req_'+mid), md);
        drawDailyTokenBar(document.getElementById('tok_'+mid), md);
      });
    }
  }, 50);
}

// ===== ACTIONS =====
function doRefresh() {
  var btn = document.getElementById('refreshBtn');
  btn.disabled = true; btn.textContent = '...';
  toast('Refreshing...');
  vsc.postMessage({ type: 'refresh' });
}

function onMonthChange() {
  var v = document.getElementById('monthSelect').value.split('-');
  var btn = document.getElementById('refreshBtn');
  btn.disabled = true; btn.textContent = '...';
  toast('Loading...');
  vsc.postMessage({ type: 'changeMonth', year: parseInt(v[0]), month: parseInt(v[1]) });
}

// Message handler
window.addEventListener('message', function(e) {
  var msg = e.data;
  if (msg.type === 'updateData') {
    var btn = document.getElementById('refreshBtn');
    btn.disabled = false; btn.textContent = D.i18n.refresh || 'Refresh';
    D = msg;
    render(msg);
    if (msg.error) { toast(msg.error); }
    else { toast('Updated'); }
  }
  if (msg.type === 'monthData') {
    var btn = document.getElementById('refreshBtn');
    btn.disabled = false; btn.textContent = D.i18n.refresh || 'Refresh';
    D.usage = msg.usage;
    D.monthCost = msg.usage ? msg.usage.totalCost : 0;
    render({ type: 'updateData', data: D, i18n: D.i18n });
  }
});

// ---- CSP-safe event binding (no inline onclick/onchange) ----
document.getElementById('refreshBtn').addEventListener('click', doRefresh);
document.getElementById('monthSelect').addEventListener('change', onMonthChange);

// ---- ResizeObserver: redraw charts when panel resizes ----
var resizeDebounce = null;
var ro = new ResizeObserver(function(entries) {
  if (resizeDebounce) clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(function() {
    entries.forEach(function(entry) {
      var c = entry.target.querySelector('canvas');
      if (!c || !c.id) return;
      if (c.id === 'monthlyChart' && D.usage && D.usage.models) {
        drawMonthlyChart(c, D.usage.models);
      } else if (c.id.indexOf('req_') === 0) {
        // Find model from id: req_{model} or tok_{model}
        var mid = c.id.replace(/^(req_|tok_)/, '');
        var mname = Object.keys(D.usage.modelDays||{}).find(function(k){ return k.replace(/[^a-z0-9]/gi,'_') === mid; });
        if (mname && D.usage.modelDays[mname] && c.id.indexOf('req_') === 0) {
          drawRequestLine(c, D.usage.modelDays[mname]);
        }
      } else if (c.id.indexOf('tok_') === 0) {
        var mid2 = c.id.replace(/^(req_|tok_)/, '');
        var mname2 = Object.keys(D.usage.modelDays||{}).find(function(k){ return k.replace(/[^a-z0-9]/gi,'_') === mid2; });
        if (mname2 && D.usage.modelDays[mname2] && c.id.indexOf('tok_') === 0) {
          drawDailyTokenBar(c, D.usage.modelDays[mname2]);
        }
      }
    });
  }, 200);
});
// Observe all chart containers
document.querySelectorAll('.chart-wrap').forEach(function(el) { ro.observe(el); });

// Initial render
render({ type: 'init', data: D, i18n: D.i18n });
})();
</script></body></html>`;
}

// ============================================================
//  Extension Activation
// ============================================================

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  const i18n = t();
  const config = () => vscode.workspace.getConfiguration('deepseek-usage');

  // ---- Status bar ----
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
  statusBarItem.command = 'deepseek-usage.showUsage';
  statusBarItem.text = '$(sync~spin) DeepSeek';
  statusBarItem.tooltip = i18n.loading;
  statusBarItem.show();

  // ---- Config ----
  async function getApiKey() {
    const sk = await context.secrets.get('deepseek.apiKey'); if (sk) return sk;
    return config().get('apiKey', '') || '';
  }
  async function getConfig() {
    const cfg = config();
    return { apiKey: await getApiKey(), sessionToken: cfg.get('sessionToken', '') || '', cookie: cfg.get('cookie', '') || '', proxy: cfg.get('proxy', '') || '' };
  }

  // ---- Data ----
  let latestData = { balance: null, usage: null, error: null };
  let currentMonth, currentYear;

  async function refreshAllData(month, year) {
    const now = new Date(); month = month || now.getMonth() + 1; year = year || now.getFullYear();
    currentMonth = month; currentYear = year;

    const cfg = await getConfig();
    latestData = { balance: null, usage: null, error: null };

    const results = await Promise.allSettled([
      cfg.apiKey ? fetchBalance(cfg.apiKey) : Promise.reject(new Error('no-api-key')),
      cfg.sessionToken && cfg.cookie ? fetchMonthData(cfg.sessionToken, cfg.cookie, cfg.proxy, month, year) : Promise.reject(new Error('no-session')),
    ]);

    const errors = [];
    if (results[0].status === 'fulfilled') latestData.balance = results[0].value;
    else if (results[0].reason.message !== 'no-api-key') errors.push('Balance: ' + results[0].reason.message);
    if (results[1].status === 'fulfilled') latestData.usage = results[1].value;
    else if (results[1].reason.message !== 'no-session') errors.push('Usage: ' + results[1].reason.message);
    latestData.error = errors.length ? errors.join(' | ') : null;

    updateStatusBar();
  }

  function updateStatusBar() {
    const { balance, usage, error } = latestData;
    if (error) { statusBarItem.text = '$(error) DeepSeek'; statusBarItem.tooltip = error; statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground'); return; }
    const bal = balance?.balance_infos?.[0]; const balTotal = bal ? parseFloat(bal.total_balance).toFixed(2) : null;
    const cost = usage ? usage.totalCost.toFixed(2) : null;
    if (balTotal && cost) { statusBarItem.text = `$(credit-card) DeepSeek ${cost}/${balTotal}`; statusBarItem.tooltip = `Month: ¥${cost} | Balance: ¥${balTotal}\nClick for details`; statusBarItem.backgroundColor = undefined; }
    else if (balTotal) { statusBarItem.text = `$(credit-card) DeepSeek ${balTotal}`; statusBarItem.tooltip = `Balance: ¥${balTotal}`; statusBarItem.backgroundColor = undefined; }
    else { statusBarItem.text = '$(key) DeepSeek'; statusBarItem.tooltip = 'Set API Key'; }
  }

  // ---- Webview Panel ----
  let currentPanel = null;

  function updatePanelHtml() {
    if (!currentPanel) return;
    currentPanel.webview.html = buildPanelHtml(latestData.balance, latestData.usage, t(), currentMonth, currentYear);
  }

  function openUsagePanel() {
    if (currentPanel) { currentPanel.reveal(); updatePanelHtml(); return; }
    currentPanel = vscode.window.createWebviewPanel('deepseekUsage', t().title, vscode.ViewColumn.Two, { enableScripts: true, retainContextWhenHidden: true });
    updatePanelHtml();

    currentPanel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === 'refresh') {
          await refreshAllData(currentMonth, currentYear);
          updatePanelHtml();
        } else if (msg.type === 'changeMonth') {
          await refreshAllData(msg.month, msg.year);
          // Only update if we got usable data (avoid replacing with empty page on error)
          if (latestData.usage || latestData.balance) {
            updatePanelHtml();
          } else {
            vscode.window.showErrorMessage(
              'DeepSeek Usage: Failed to load ' + msg.year + '-' +
              String(msg.month).padStart(2, '0') + ' — ' +
              (latestData.error || 'check session token / network')
            );
            // Restore previous month in status bar
            currentMonth = (new Date()).getMonth() + 1;
            currentYear = (new Date()).getFullYear();
          }
        }
      } catch (e) {
        vscode.window.showErrorMessage('DeepSeek Usage error: ' + (e.message || e));
      }
    });
    currentPanel.onDidDispose(() => { currentPanel = null; });
  }

  // ---- Commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek-usage.showUsage', () => openUsagePanel()),
    vscode.commands.registerCommand('deepseek-usage.refresh', () => refreshAllData()),
    vscode.commands.registerCommand('deepseek-usage.setApiKey', async () => {
      const currentKey = await getApiKey();
      const newKey = await vscode.window.showInputBox({ prompt: 'Enter DeepSeek API Key', placeHolder: 'sk-...', password: true, ignoreFocusOut: true, value: currentKey });
      if (newKey !== undefined) { await context.secrets.store('deepseek.apiKey', newKey); await config().update('apiKey', newKey, vscode.ConfigurationTarget.Global); vscode.window.showInformationMessage('API Key saved'); refreshAllData(); }
    }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('deepseek-usage')) refreshAllData().then(updatePanelHtml).catch(() => {}); }),
    statusBarItem,
    { dispose: () => clearInterval(setInterval(() => refreshAllData(), REFRESH_INTERVAL_MS)) }
  );

  // Init
  await refreshAllData();
  const iid = setInterval(() => refreshAllData(), REFRESH_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(iid) });
  console.log('[DeepSeek Usage] Activated');
}

function deactivate() { console.log('[DeepSeek Usage] Deactivated'); }
module.exports = { activate, deactivate };
