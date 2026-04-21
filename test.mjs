/**
 * 本地测试脚本 — 验证各数据源 API 是否可用
 * 运行方式: node test.mjs
 */

const stockConfig = await import('./stocks.json', { with: { type: 'json' } }).then(m => m.default);

const RESULTS = { pass: 0, fail: 0, details: [] };

function log(icon, msg) {
  console.log(`${icon} ${msg}`);
}

async function testNaver() {
  const krStocks = stockConfig.filter(s => s.source === 'naver');
  if (krStocks.length === 0) { log('⚠️', '无韩股配置，跳过 Naver 测试'); return; }

  log('🔍', `测试 Naver Finance API (${krStocks.length} 只韩股)...`);
  
  for (const stock of krStocks) {
    try {
      const url = `https://m.stock.naver.com/api/stock/${stock.code}/basic`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
          'Accept': 'application/json',
          'Referer': `https://m.stock.naver.com/item/main.naver?code=${stock.code}`,
        },
      });
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      
      if (!data.closePrice) throw new Error('closePrice 字段为空');
      
      const price = parseInt(data.closePrice.replace(/,/g, ''), 10);
      const changePercent = parseFloat(data.fluctuationsRatio) || 0;
      
      log('✅', `[Naver] ${stock.name} (${stock.code}) — ₩${price.toLocaleString()} (${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%)`);
      RESULTS.pass++;
      RESULTS.details.push({ stock: stock.name, source: 'naver', status: 'pass', price, changePercent });
    } catch (err) {
      log('❌', `[Naver] ${stock.name} (${stock.code}) — ${err.message}`);
      RESULTS.fail++;
      RESULTS.details.push({ stock: stock.name, source: 'naver', status: 'fail', error: err.message });
    }
  }
}

async function testEastMoneyHK() {
  const hkStocks = stockConfig.filter(s => s.source === 'eastmoney');
  if (hkStocks.length === 0) { log('⚠️', '无港股配置，跳过 EastMoney HK 测试'); return; }

  log('🔍', `测试东方财富港股 API (${hkStocks.length} 只港股)...`);
  
  for (const stock of hkStocks) {
    try {
      const secid = `116.${stock.code}`;
      const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170&ut=fa5fd1943c7b386f172d6893dbbd1d0c`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
          'Referer': 'https://quote.eastmoney.com/',
        },
      });
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      
      if (!json.data) throw new Error('data 字段为空');
      if (!json.data.f43 && json.data.f43 !== 0) throw new Error('f43 (price) 字段缺失');
      
      const d = json.data;
      const price = d.f43 / 1000;
      const changePercent = d.f170 / 100;
      const name = d.f58 || stock.name;
      
      log('✅', `[EastMoney HK] ${name} (${stock.code}) — HK$${price.toFixed(2)} (${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%)`);
      RESULTS.pass++;
      RESULTS.details.push({ stock: name, source: 'eastmoney_hk', status: 'pass', price, changePercent });
    } catch (err) {
      log('❌', `[EastMoney HK] ${stock.name} (${stock.code}) — ${err.message}`);
      RESULTS.fail++;
      RESULTS.details.push({ stock: stock.name, source: 'eastmoney_hk', status: 'fail', error: err.message });
    }
  }
}

async function testEastMoneyFund() {
  const cnFunds = stockConfig.filter(s => s.source === 'eastmoney_fund');
  if (cnFunds.length === 0) { log('⚠️', '无基金配置，跳过 EastMoney Fund 测试'); return; }

  log('🔍', `测试天天基金 API (${cnFunds.length} 只基金)...`);
  
  for (const stock of cnFunds) {
    try {
      // 1) 测试估值接口
      const estUrl = `https://fundgz.1234567.com.cn/js/${stock.code}.js?rt=${Date.now()}`;
      const estRes = await fetch(estUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
          'Referer': `https://fund.eastmoney.com/${stock.code}.html`,
        },
      });
      let estData = null;
      if (estRes.ok) {
        const estText = await estRes.text();
        const estMatch = estText.match(/jsonpgz\((\{.*\})\)/);
        if (estMatch) estData = JSON.parse(estMatch[1]);
      }

      // 2) 测试 pingzhongdata 接口（正式净值+涨跌幅）
      const detailUrl = `https://fund.eastmoney.com/pingzhongdata/${stock.code}.js?v=${Date.now()}`;
      const detailRes = await fetch(detailUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
          'Referer': `https://fund.eastmoney.com/${stock.code}.html`,
        },
      });
      if (!detailRes.ok) throw new Error(`detail API HTTP ${detailRes.status}`);
      
      const detailText = await detailRes.text();
      const trendMatch = detailText.match(/var Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
      const nameMatch = detailText.match(/var fS_name\s*=\s*"([^"]+)"/);

      if (!trendMatch) throw new Error('Data_netWorthTrend 未找到');

      const trend = JSON.parse(trendMatch[1]);
      const latest = trend[trend.length - 1];
      const nav = latest.y;
      const changePercent = parseFloat(latest.equityReturn.toFixed(2));
      const navDate = new Date(latest.x).toISOString().split('T')[0];
      const name = nameMatch ? nameMatch[1] : stock.name;

      // 根据配置决定是否使用估值
      const useEstimate = stock.useEstimate !== false;  // 默认 true
      const today = new Date().toISOString().split('T')[0];
      const estimateValid = useEstimate
        && estData
        && estData.gztime
        && estData.gztime.startsWith(today)
        && estData.gsz
        && parseFloat(estData.gsz) > 0;

      if (estimateValid) {
        const estPrice = parseFloat(estData.gsz);
        const estChange = parseFloat(estData.gszzl);
        log('✅', `[天天基金] ${name} (${stock.code}) — 估值 ${estPrice.toFixed(4)} (${estChange >= 0 ? '+' : ''}${estChange.toFixed(2)}%) [估值]`);
        RESULTS.pass++;
        RESULTS.details.push({ stock: name, source: 'fund_estimate', status: 'pass', price: estPrice, changePercent: estChange });
      } else {
        log('✅', `[天天基金] ${name} (${stock.code}) — 净值 ${nav.toFixed(4)} (${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%) [正式·${navDate}]`);
        RESULTS.pass++;
        RESULTS.details.push({ stock: name, source: 'fund_official', status: 'pass', price: nav, changePercent, navDate });
      }
    } catch (err) {
      log('❌', `[天天基金] ${stock.name} (${stock.code}) — ${err.message}`);
      RESULTS.fail++;
      RESULTS.details.push({ stock: stock.name, source: 'eastmoney_fund', status: 'fail', error: err.message });
    }
  }
}

// ============================================================
// 主函数
// ============================================================

console.log('='.repeat(60));
console.log('📊 Stock Price API — 本地测试');
console.log(`⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
console.log('='.repeat(60));
console.log();

await testNaver();
console.log();
await testEastMoneyHK();
console.log();
await testEastMoneyFund();

console.log();
console.log('='.repeat(60));
console.log(`📋 测试结果: ✅ ${RESULTS.pass} 通过 / ❌ ${RESULTS.fail} 失败 / 共 ${RESULTS.pass + RESULTS.fail} 项`);
console.log('='.repeat(60));

if (RESULTS.fail > 0) {
  console.log('\n❌ 失败详情:');
  RESULTS.details.filter(d => d.status === 'fail').forEach(d => {
    console.log(`  - ${d.stock} (${d.source}): ${d.error}`);
  });
  process.exit(1);
} else {
  console.log('\n🎉 所有接口测试通过！');
  process.exit(0);
}
