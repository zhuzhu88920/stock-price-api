/**
 * Stock Price API — Cloudflare Worker
 *
 * 数据源：
 *   韩股    → Naver Finance API
 *   港股    → 东方财富 push2 API
 *   A股基金 → 天天基金 pingzhongdata
 *   市场状态 → 交易日历日历模块（calendar.js）
 *
 * 缓存策略：
 *   Cron Trigger 每 10 分钟执行 → 始终抓取 → 写 KV
 *   用户请求 → 始终读 KV 缓存 → 返回（含抓取时间）
 *   /api/cache/refresh?token=xxx → POST 手动清缓存并重新抓取
 */

import stockConfig from '../stocks.json';
import { getAllMarketStatus, getUserTimestamp } from './calendar.js';

const EM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
  'Referer': 'https://quote.eastmoney.com/',
};

const KV_CACHE_KEY = 'stock_data';
const KV_TTL = 86400; // 24 小时过期

// ============================================================
// 数据抓取（与之前相同）
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
  // 港股价格/涨跌额固定除以 1000，涨跌幅除以 100
  return {
    name: d.f58 || '',
    price: d.f43 / 1000,
    change: d.f169 / 1000,
    changePercent: d.f170 / 100,
  };
}

async function fetchEastMoneyFund(code) {
  const res = await fetch(
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=1&plat=Android&appType=ttjj&product=EFund&Version=1&Fcodes=${code}&deviceid=${Date.now()}`,
    { headers: EM_HEADERS },
  );
  if (!res.ok) throw new Error(`天天基金 API ${res.status}`);
  const json = await res.json();
  if (!json.Success || !json.Datas?.length) throw new Error('基金无净值数据');
  const d = json.Datas[0];
  return {
    name: d.SHORTNAME || '',
    nav: parseFloat(d.NAV),
    price: parseFloat(d.NAV),
    changePercent: d.NAVCHGRT !== null && d.NAVCHGRT !== undefined ? parseFloat(d.NAVCHGRT) : null,
    navDate: d.PDATE || '',
  };
}

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

// ============================================================
// 排版
// ============================================================

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

function buildTextResponse(results, market, fetchTime) {
  const ts = getUserTimestamp();
  const ok = results.filter(r => r.success).length;
  const fail = results.length - ok;
  return [
    `📊 股价查询 - ${ts}`,
    `🏦 ${market.summary}  |  ✅${ok} ❌${fail}`,
    `🕐 数据抓取时间: ${fetchTime}`,
    '────────────────',
    '',
    results.map(formatTicker).join('\n\n'),
  ].join('\n');
}

// ============================================================
// KV 缓存读写
// ============================================================

async function readCache(env) {
  try {
    const cached = await env.STOCK_CACHE.get(KV_CACHE_KEY, 'json');
    return cached || null;
  } catch {
    return null;
  }
}

async function writeCache(env, data) {
  try {
    await env.STOCK_CACHE.put(KV_CACHE_KEY, JSON.stringify(data), {
      expirationTtl: KV_TTL,
    });
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// 抓取逻辑（Cron 和 fallback 共用）
// ============================================================

async function fetchAndCache(env) {
  const market = getAllMarketStatus();

  const results = await Promise.allSettled(stockConfig.map(s => fetchStockData(s)));
  const stocks = results.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message });

  const fetchTime = getUserTimestamp();
  const cacheData = {
    stocks,
    market,
    fetchTime,
    fetchIso: new Date().toISOString(),
  };

  // 写入 KV
  const cached = await writeCache(env, cacheData);

  return { ...cacheData, cached };
}

// ============================================================
// 路由
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

async function handlePrices(isText, env) {
  const market = getAllMarketStatus();
  let cached = await readCache(env);

  // 如果没有缓存，强制抓取一次
  if (!cached) {
    cached = await fetchAndCache(env);
  }

  if (!cached) {
    // 仍然没有数据（所有市场休市且无历史缓存）
    const ts = getUserTimestamp();
    const body = isText
      ? `📊 股价查询 - ${ts}\n🏦 ${market.summary}\n⚠️ 暂无缓存数据（所有市场休市中，等待交易日积累数据）`
      : JSON.stringify({ status: 'no_data', timestamp: ts, market, message: '暂无缓存数据' }, null, 2);

    return new Response(body, {
      headers: { 'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...CORS },
    });
  }

  if (isText) {
    return new Response(buildTextResponse(cached.stocks, market, cached.fetchTime), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS },
    });
  }

  return new Response(JSON.stringify({
    status: 'ok',
    timestamp: getUserTimestamp(),
    fetchTime: cached.fetchTime,
    fetchIso: cached.fetchIso,
    market,
    stocks: cached.stocks,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

async function handleCacheStatus(env) {
  const market = getAllMarketStatus();
  const cached = await readCache(env);

  return new Response(JSON.stringify({
    hasCache: !!cached,
    fetchTime: cached?.fetchTime || null,
    fetchIso: cached?.fetchIso || null,
    stockCount: cached?.stocks?.length || 0,
    successCount: cached?.stocks?.filter(s => s.success).length || 0,
    market,
    anyTrading: market.anyTrading,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

export default {
  /**
   * 用户请求处理
   */
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (pathname === '/api/prices' || pathname === '/api/prices/') return handlePrices(false, env);
      if (pathname === '/api/prices/text' || pathname === '/api/prices/text/') return handlePrices(true, env);

      if (pathname === '/api/cache/status' || pathname === '/api/cache/status/') {
        return handleCacheStatus(env);
      }

      // POST 清缓存并强制重新抓取（需鉴权）
      if (pathname === '/api/cache/refresh' || pathname === '/api/cache/refresh/') {
        if (request.method !== 'POST') {
          return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: { 'Content-Type': 'application/json', ...CORS } });
        }
        const token = new URL(request.url).searchParams.get('token');
        if (token !== (env.CACHE_TOKEN || 'changeme')) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', ...CORS } });
        }
        await env.STOCK_CACHE.delete(KV_CACHE_KEY);
        const result = await fetchAndCache(env);
        const ok = result.stocks.filter(s => s.success).length;
        return new Response(JSON.stringify({ status: 'ok', fetchTime: result.fetchTime, stocks: result.stocks.length, success: ok }, null, 2), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
        });
      }

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
<p>股票/基金实时行情查询，支持韩股、港股、A股基金。数据每 10 分钟自动更新（交易时段）。</p>
<div class="endpoint"><span class="method">GET</span> <code>/api/prices</code> — JSON</div>
<div class="endpoint"><span class="method">GET</span> <code>/api/prices/text</code> — 纯文本</div>
<div class="endpoint"><span class="method">GET</span> <code>/api/stocks</code> — 股票列表</div>
<div class="endpoint"><span class="method">GET</span> <code>/api/cache/status</code> — 缓存状态</div>
</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...CORS } });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Internal Server Error', message: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
    }
  },

  /**
   * Cron Trigger — 每 10 分钟执行，始终抓取并写入 KV
   */
  async scheduled(event, env) {
    const result = await fetchAndCache(env);
    const ok = result.stocks.filter(s => s.success).length;
    console.log(`[Cron] 抓取完成: ${ok}/${result.stocks.length} 成功, 缓存=${result.cached}`);
  },
};
