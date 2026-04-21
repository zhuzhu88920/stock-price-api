/**
 * Stock Price API — Cloudflare Worker
 * 
 * 数据源：
 *   韩股    → Naver Finance API (m.stock.naver.com)
 *   港股    → 东方财富 push2 API (push2.eastmoney.com)
 *   A股基金 → 天天基金 pingzhongdata (fund.eastmoney.com)
 *
 * 市场状态：
 *   韩股  → Naver API 返回 marketStatus 字段（OPEN/CLOSE）
 *   港股  → 东方财富 API 无市场状态字段，用香港时区交易时段判断
 *   A股  → 基金净值日期与当天对比（节假日无法自动识别）
 *
 * 股票配置见 stocks.json，按 market/source 自动匹配抓取网址。
 */

import stockConfig from '../stocks.json';

// ============================================================
// 数据抓取：韩股 — Naver Finance API
// ============================================================

async function fetchNaverStock(code) {
  const url = `https://m.stock.naver.com/api/stock/${code}/basic`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      'Accept': 'application/json',
      'Referer': `https://m.stock.naver.com/item/main.naver?code=${code}`,
    },
  });
  if (!res.ok) throw new Error(`Naver API ${res.status} for ${code}`);

  const data = await res.json();

  const priceStr = data.closePrice || '0';
  const price = parseInt(priceStr.replace(/,/g, ''), 10);
  const changeStr = data.compareToPreviousClosePrice || '0';
  const change = parseInt(changeStr.replace(/,/g, ''), 10);
  const changePercent = parseFloat(data.fluctuationsRatio) || 0;
  const marketStatus = data.marketStatus || 'CLOSE';
  const stockName = data.stockName || '';
  const updateTime = data.localTradedAt || '';

  return {
    name: stockName,
    price,
    change,
    changePercent,
    marketStatus,
    updateTime,
  };
}

// ============================================================
// 数据抓取：港股 — 东方财富 push2 API
// ============================================================

async function fetchEastMoneyHK(code) {
  const secid = `116.${code}`;
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170&ut=fa5fd1943c7b386f172d6893dbbd1d0c`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      'Referer': 'https://quote.eastmoney.com/',
    },
  });
  if (!res.ok) throw new Error(`EastMoney HK API ${res.status} for ${code}`);

  const json = await res.json();
  if (!json.data) throw new Error(`EastMoney HK no data for ${code}`);

  const d = json.data;

  const price = d.f43 / 1000;
  const change = d.f169 / 100;
  const changePercent = d.f170 / 100;
  const name = d.f58 || '';
  const high = d.f44 / 1000;
  const low = d.f45 / 1000;
  const open = d.f46 / 1000;
  const volume = d.f47;
  const turnover = d.f48;
  // f60 是昨收价，不是市场状态。港股状态用本地时区判断。

  return {
    name,
    price,
    change,
    changePercent,
    high,
    low,
    open,
    volume,
    turnover,
  };
}

// ============================================================
// 数据抓取：A股基金 — 东方财富正式净值接口
// ============================================================

async function fetchEastMoneyFund(code) {
  const detailUrl = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;
  const detailRes = await fetch(detailUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      'Referer': `https://fund.eastmoney.com/${code}.html`,
    },
  });
  if (!detailRes.ok) throw new Error(`EastMoney Fund detail API ${detailRes.status} for ${code}`);

  const detailText = await detailRes.text();

  const trendMatch = detailText.match(/var Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  const nameMatch = detailText.match(/var fS_name\s*=\s*"([^"]+)"/);

  const fundName = nameMatch ? nameMatch[1] : '';

  if (!trendMatch) throw new Error(`无法解析基金 ${code} 的净值数据`);

  const trend = JSON.parse(trendMatch[1]);
  if (!trend || trend.length === 0) throw new Error(`基金 ${code} 无净值数据`);

  const latest = trend[trend.length - 1];
  const latestNav = latest.y;
  const latestChangePercent = latest.equityReturn;
  const navDate = new Date(latest.x).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

  return {
    name: fundName,
    nav: latestNav,
    price: latestNav,
    changePercent: latestChangePercent !== null ? parseFloat(latestChangePercent.toFixed(2)) : null,
    navDate: navDate,
  };
}

// ============================================================
// 统一抓取入口
// ============================================================

async function fetchStockData(stock) {
  const { source, code } = stock;

  try {
    let rawData;
    switch (source) {
      case 'naver':
        rawData = await fetchNaverStock(code);
        return {
          ...stock,
          success: true,
          price: rawData.price,
          change: rawData.change,
          changePercent: rawData.changePercent,
          extra: {
            marketStatus: rawData.marketStatus,
            updateTime: rawData.updateTime,
            rawName: rawData.name,
          },
        };

      case 'eastmoney':
        rawData = await fetchEastMoneyHK(code);
        return {
          ...stock,
          success: true,
          price: rawData.price,
          change: rawData.change,
          changePercent: rawData.changePercent,
          extra: {
            marketStatus: rawData.marketStatus,
            high: rawData.high,
            low: rawData.low,
            open: rawData.open,
            volume: rawData.volume,
            rawName: rawData.name,
          },
        };

      case 'eastmoney_fund':
        rawData = await fetchEastMoneyFund(code);
        return {
          ...stock,
          success: true,
          price: rawData.price,
          change: null,
          changePercent: rawData.changePercent,
          extra: {
            nav: rawData.nav,
            navDate: rawData.navDate,
            rawName: rawData.name,
          },
        };

      default:
        return { ...stock, success: false, error: `Unknown source: ${source}` };
    }
  } catch (err) {
    return { ...stock, success: false, error: err.message };
  }
}

// ============================================================
// 市场状态：从抓取结果中提取（数据源说的算）
// ============================================================

function extractMarketStatus(results) {
  let kse = null, hk = null, cn = null;

  for (const r of results) {
    if (!r.success) continue;

    // 韩股：Naver API 直接返回 marketStatus
    if (r.source === 'naver' && !kse) {
      const ms = r.extra?.marketStatus;
      kse = ms === 'OPEN' ? '开盘中' : '休市';
    }

    // 港股：东方财富 push2 API 没有市场状态字段，用本地时区判断
    if (r.source === 'eastmoney' && !hk) {
      hk = getHKMarketStatus();
    }

    // A股基金：净值日期=今天 → 可能在盘中，否则休市
    if (r.source === 'eastmoney_fund' && !cn) {
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      cn = r.extra?.navDate === today ? '净值更新中' : '休市';
    }
  }

  // 兜底：如果没有该市场的股票，用本地时间判断
  const now = new Date();
  if (!kse) kse = getKSTMarketStatus(now);
  if (!hk) hk = getHKMarketStatus();
  if (!cn) cn = getCNMarketStatus(now);

  const anyOpen = [kse, hk, cn].some(v => v.includes('开盘中'));

  return { open: anyOpen, kse, hk, cn };
}

/**
 * 港股市场状态（本地时区判断）
 * 港股交易时段：09:30-12:00, 13:00-16:00 HKT
 */
function getHKMarketStatus() {
  const now = new Date();
  const hkt = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Hong_Kong' }));
  const day = hkt.getDay();
  const min = hkt.getHours() * 60 + hkt.getMinutes();

  if (day === 0 || day === 6) return '周末休市';
  if (min < 570) return '盘前';              // < 09:30
  if (min < 720) return '开盘中';              // 09:30-12:00
  if (min < 780) return '盘中休市';            // 12:00-13:00
  if (min < 960) return '开盘中';              // 13:00-16:00
  return '已收盘';                            // >= 16:00
}

/**
 * 韩股市场状态（兜底，仅在没有 Naver 数据时使用）
 * 韩股交易时段：09:00-15:30 KST
 */
function getKSTMarketStatus(now) {
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = kst.getDay();
  const min = kst.getHours() * 60 + kst.getMinutes();

  if (day === 0 || day === 6) return '周末休市';
  if (min < 540) return '盘前';              // < 09:00
  if (min < 930) return '开盘中';              // 09:00-15:30
  return '已收盘';                            // >= 15:30
}

/**
 * A股市场状态（兜底，仅在没有基金数据时使用）
 * A股交易时段：09:30-11:30, 13:00-15:00 CST
 */
function getCNMarketStatus(now) {
  const cst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const day = cst.getDay();
  const min = cst.getHours() * 60 + cst.getMinutes();

  if (day === 0 || day === 6) return '周末休市';
  if (min < 570) return '盘前';              // < 09:30
  if (min < 690) return '开盘中';              // 09:30-11:30
  if (min < 780) return '午间休市';            // 11:30-13:00
  if (min < 900) return '开盘中';              // 13:00-15:00
  return '已收盘';                            // >= 15:00
}

// ============================================================
// 响应格式化
// ============================================================

function formatTicker(stock) {
  if (!stock.success) {
    return `${stock.emoji} ${stock.name} (${stock.code}) — ❌ 抓取失败: ${stock.error}`;
  }

  const dir = stock.changePercent > 0 ? '📈' : stock.changePercent < 0 ? '📉' : '➡️';
  const sign = (v) => (v >= 0 ? '+' : '') + v;

  if (stock.source === 'eastmoney_fund') {
    return [
      `${stock.emoji} ${stock.name} (${stock.code})`,
      `💰 净值: ${stock.price.toFixed(4)}  |  日期: ${stock.extra.navDate}`,
      `📊 涨跌: ${sign(stock.changePercent !== null ? stock.changePercent.toFixed(2) : 'N/A')}% ${dir}`,
    ].join('\n');
  }

  const currencySymbols = { KRW: '₩', HKD: 'HK$', CNY: '¥' };
  const sym = currencySymbols[stock.currency] || '';
  const priceStr = stock.currency === 'KRW'
    ? stock.price.toLocaleString()
    : stock.price.toFixed(stock.price < 1 ? 4 : 2);

  return [
    `${stock.emoji} ${stock.name} (${stock.code}.${stock.market.toUpperCase()})`,
    `💰 价格: ${sym}${priceStr}`,
    `📊 涨跌: ${sign(stock.changePercent.toFixed(2))}% ${dir}`,
  ].join('\n');
}

function buildTextResponse(results, marketStatus) {
  const timestamp = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;

  let msg = `📊 股价查询 - ${timestamp}\n`;
  msg += `🏦 韩国:${marketStatus.kse} | 香港:${marketStatus.hk} | A股:${marketStatus.cn}\n`;
  msg += `✅ ${successCount}成功 / ❌ ${failCount}失败\n`;
  msg += '────────────────\n\n';
  msg += results.map(formatTicker).join('\n\n');

  return msg;
}

// ============================================================
// CORS helper
// ============================================================

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// ============================================================
// Cloudflare Worker 入口
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      // GET /api/prices — JSON
      if (path === '/api/prices' || path === '/api/prices/') {
        const results = await Promise.allSettled(
          stockConfig.map(stock => fetchStockData(stock))
        );
        const data = results.map(r =>
          r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message }
        );
        const marketStatus = extractMarketStatus(data);

        return new Response(JSON.stringify({
          status: 'ok',
          timestamp: new Date().toISOString(),
          market: marketStatus,
          stocks: data,
        }, null, 2), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...corsHeaders(),
          },
        });
      }

      // GET /api/prices/text — 纯文本
      if (path === '/api/prices/text' || path === '/api/prices/text/') {
        const results = await Promise.allSettled(
          stockConfig.map(stock => fetchStockData(stock))
        );
        const data = results.map(r =>
          r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message }
        );
        const marketStatus = extractMarketStatus(data);
        const text = buildTextResponse(data, marketStatus);

        return new Response(text, {
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            ...corsHeaders(),
          },
        });
      }

      // GET /api/stocks — 配置列表
      if (path === '/api/stocks' || path === '/api/stocks/') {
        return new Response(JSON.stringify({
          count: stockConfig.length,
          stocks: stockConfig.map(s => ({
            name: s.name,
            code: s.code,
            market: s.market,
            source: s.source,
          })),
        }, null, 2), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...corsHeaders(),
          },
        });
      }

      // GET / — 说明页
      if (path === '/' || path === '/index.html') {
        const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stock Price API</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; background: #0d1117; color: #c9d1d9; }
  h1 { color: #58a6ff; border-bottom: 1px solid #30363d; padding-bottom: 10px; }
  code { background: #161b22; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  pre { background: #161b22; padding: 16px; border-radius: 8px; overflow-x: auto; border: 1px solid #30363d; }
  a { color: #58a6ff; }
  .endpoint { margin: 16px 0; padding: 12px; background: #161b22; border-radius: 8px; border-left: 3px solid #58a6ff; }
  .method { color: #7ee787; font-weight: bold; }
</style>
</head>
<body>
<h1>📊 Stock Price API</h1>
<p>股票/基金实时行情查询 API，支持韩股、港股、A股基金。</p>

<div class="endpoint">
  <span class="method">GET</span> <code>/api/prices</code><br>
  <p>JSON 格式返回所有股票行情（含市场状态）</p>
</div>

<div class="endpoint">
  <span class="method">GET</span> <code>/api/prices/text</code><br>
  <p>纯文本格式，适合 iOS 快捷指令 / Telegram</p>
</div>

<div class="endpoint">
  <span class="method">GET</span> <code>/api/stocks</code><br>
  <p>已配置的股票列表</p>
</div>

<h3>数据源</h3>
<ul>
  <li>🇰🇷 韩股 → Naver Finance</li>
  <li>🇭🇰 港股 → 东方财富</li>
  <li>🇨🇳 基金 → 天天基金</li>
</ul>

<h3>市场状态</h3>
<p>查询股价时自动附带，从数据源 API 提取（无硬编码假日列表）：</p>
<ul>
  <li>🇰🇷 韩股：Naver 返回 OPEN/CLOSE → 开盘中/休市</li>
  <li>🇭🇰 港股：本地时区判断（东方财富无状态字段，延迟~15分钟）</li>
  <li>🇨🇳 A股：基金净值日期=今天 → 净值更新中</li>
</ul>

<h3>iOS 快捷指令配置</h3>
<p>在"获取 URL 内容"中填入：</p>
<pre><code>https://your-worker.your-name.workers.dev/api/prices</code></pre>
</body>
</html>`;
        return new Response(html, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: 'Internal Server Error', message: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }
  },
};
