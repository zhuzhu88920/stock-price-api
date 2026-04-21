/**
 * Stock Price API — Cloudflare Worker
 *
 * 数据源：
 *   韩股    → Naver Finance API
 *   港股    → 东方财富 push2 API
 *   A股基金 → 天天基金 pingzhongdata
 *   市场状态 → 东方财富指数实时数据 / Naver marketStatus
 */

import stockConfig from '../stocks.json';

const EM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
  'Referer': 'https://quote.eastmoney.com/',
};

// ============================================================
// 数据抓取
// ============================================================

async function fetchNaverStock(code) {
  const res = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, {
    headers: {
      'User-Agent': EM_HEADERS['User-Agent'],
      'Accept': 'application/json',
      'Referer': `https://m.stock.naver.com/item/main.naver?code=${code}`,
    },
  });
  if (!res.ok) throw new Error(`Naver API ${res.status}`);
  const d = await res.json();
  return {
    name: d.stockName || '',
    price: parseInt((d.closePrice || '0').replace(/,/g, ''), 10),
    change: parseInt((d.compareToPreviousClosePrice || '0').replace(/,/g, ''), 10),
    changePercent: parseFloat(d.fluctuationsRatio) || 0,
    marketStatus: d.marketStatus || 'CLOSE',
  };
}

async function fetchEastMoneyHK(code) {
  const res = await fetch(
    `https://push2.eastmoney.com/api/qt/stock/get?secid=116.${code}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f152,f169,f170&ut=fa5fd1943c7b386f172d6893dbbd1d0c`,
    { headers: EM_HEADERS },
  );
  if (!res.ok) throw new Error(`EastMoney HK API ${res.status}`);
  const json = await res.json();
  if (!json.data) throw new Error('EastMoney HK no data');
  const d = json.data;
  const unit = d.f152 || 1000;
  return {
    name: d.f58 || '',
    price: d.f43 / unit,
    change: d.f169 / unit,
    changePercent: d.f170 / 100,
  };
}

async function fetchEastMoneyFund(code) {
  const res = await fetch(`https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`, {
    headers: EM_HEADERS,
  });
  if (!res.ok) throw new Error(`天天基金 API ${res.status}`);
  const text = await res.text();
  const trendMatch = text.match(/var Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  const nameMatch = text.match(/var fS_name\s*=\s*"([^"]+)"/);
  if (!trendMatch) throw new Error('无法解析基金净值');
  const trend = JSON.parse(trendMatch[1]);
  if (!trend.length) throw new Error('基金无净值数据');
  const latest = trend[trend.length - 1];
  return {
    name: nameMatch?.[1] || '',
    nav: latest.y,
    price: latest.y,
    changePercent: latest.equityReturn !== null ? parseFloat(latest.equityReturn.toFixed(2)) : null,
    navDate: new Date(latest.x).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }),
  };
}

// ============================================================
// 市场状态（从网页抓取指数实时数据，无兜底）
// ============================================================

// 通过东方财富指数是否有实时价格判断市场是否开盘
async function fetchIndexOpen(secid) {
  try {
    const res = await fetch(
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f170,f171&ut=fa5fd1943c7b386f172d6893dbbd1d0c`,
      { headers: EM_HEADERS },
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.data) return null;
    // f170>0 表示有实时价格变动 → 开盘中
    return json.data.f170 > 0;
  } catch {
    return null;
  }
}

// 韩股：Naver API 直接返回 marketStatus
async function fetchKSEStatus() {
  try {
    const res = await fetch(`https://m.stock.naver.com/api/stock/005930/basic`, {
      headers: { 'User-Agent': EM_HEADERS['User-Agent'], 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d.marketStatus === 'OPEN' ? '开盘中' : '已收盘';
  } catch {
    return null;
  }
}

async function getMarketStatus() {
  const [kse, hk, cn] = await Promise.all([
    fetchKSEStatus(),
    fetchIndexOpen('100.HSI'),
    fetchIndexOpen('1.000001'),
  ]);

  const fmt = (label, val) => val === null ? `${label}:?` : val ? `${label}:开` : `${label}:收`;

  return {
    kse: kse ?? '未知',
    hk: hk === null ? '未知' : hk ? '开盘中' : '已收盘',
    cn: cn === null ? '未知' : cn ? '开盘中' : '已收盘',
    summary: [fmt('韩', kse === '开盘中'), fmt('港', hk), fmt('A', cn)].join(' | '),
  };
}

// ============================================================
// 统一抓取 + 排版
// ============================================================

async function fetchStockData(stock) {
  try {
    const raw = await (
      stock.source === 'naver' ? fetchNaverStock
        : stock.source === 'eastmoney' ? fetchEastMoneyHK
          : stock.source === 'eastmoney_fund' ? fetchEastMoneyFund
            : () => { throw new Error(`Unknown source: ${stock.source}`); }
    )(stock.code);

    return {
      ...stock,
      success: true,
      price: raw.price,
      change: raw.change ?? null,
      changePercent: raw.changePercent ?? null,
      navDate: raw.navDate || null,
    };
  } catch (err) {
    return { ...stock, success: false, error: err.message };
  }
}

function formatTicker(stock) {
  if (!stock.success) return `${stock.emoji} ${stock.name} — ❌ ${stock.error}`;

  const dir = stock.changePercent > 0 ? '📈' : stock.changePercent < 0 ? '📉' : '➡️';
  const sign = v => (v >= 0 ? '+' : '') + v;

  if (stock.source === 'eastmoney_fund') {
    return `${stock.emoji} ${stock.name}\n💰 净值: ${stock.price.toFixed(4)}  |  ${stock.navDate}\n📊 ${sign(stock.changePercent ?? 0)}% ${dir}`;
  }

  const sym = { KRW: '₩', HKD: 'HK$', CNY: '¥' }[stock.currency] || '';
  const priceStr = stock.currency === 'KRW'
    ? stock.price.toLocaleString()
    : stock.price.toFixed(stock.price < 1 ? 4 : 2);

  return `${stock.emoji} ${stock.name} (${stock.code}.${stock.market.toUpperCase()})\n💰 ${sym}${priceStr}\n📊 ${sign(stock.changePercent)}% ${dir}`;
}

function buildTextResponse(results, market) {
  const ts = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const ok = results.filter(r => r.success).length;
  const fail = results.length - ok;
  return [
    `📊 股价查询 - ${ts}`,
    `🏦 ${market.summary}  |  ✅${ok} ❌${fail}`,
    '────────────────',
    '',
    results.map(formatTicker).join('\n\n'),
  ].join('\n');
}

// ============================================================
// 路由
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

async function handlePrices(isText) {
  const [results, market] = await Promise.all([
    Promise.allSettled(stockConfig.map(s => fetchStockData(s))),
    getMarketStatus(),
  ]);
  const data = results.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message });

  if (isText) {
    return new Response(buildTextResponse(data, market), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS },
    });
  }
  return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString(), market, stocks: data }, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (pathname === '/api/prices' || pathname === '/api/prices/') return handlePrices(false);
      if (pathname === '/api/prices/text' || pathname === '/api/prices/text/') return handlePrices(true);

      if (pathname === '/api/stocks' || pathname === '/api/stocks/') {
        return new Response(JSON.stringify({
          count: stockConfig.length,
          stocks: stockConfig.map(({ name, code, market, source }) => ({ name, code, market, source })),
        }, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
      }

      if (pathname === '/' || pathname === '/index.html') {
        return new Response(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stock Price API</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:40px auto;padding:0 20px;background:#0d1117;color:#c9d1d9}
  h1{color:#58a6ff;border-bottom:1px solid #30363d;padding-bottom:10px}
  code{background:#161b22;padding:2px 6px;border-radius:4px;font-size:.9em}
  .endpoint{margin:16px 0;padding:12px;background:#161b22;border-radius:8px;border-left:3px solid #58a6ff}
  .method{color:#7ee787;font-weight:bold}
</style>
</head>
<body>
<h1>📊 Stock Price API</h1>
<p>股票/基金实时行情查询，支持韩股、港股、A股基金。</p>
<div class="endpoint"><span class="method">GET</span> <code>/api/prices</code> — JSON</div>
<div class="endpoint"><span class="method">GET</span> <code>/api/prices/text</code> — 纯文本</div>
<div class="endpoint"><span class="method">GET</span> <code>/api/stocks</code> — 股票列表</div>
</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...CORS } });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Internal Server Error', message: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
    }
  },
};
