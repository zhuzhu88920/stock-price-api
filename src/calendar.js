/**
 * 交易日历模块
 * 
 * 基于 trading-calendar.toml 数据生成，每年初更新
 * 提供 getMarketStatus() 函数，基于日历 + 当前时间判断各市场状态
 */

// 各市场 2026 年休市日
const HOLIDAYS = {
  cn: new Set([
    '2026-01-01','2026-01-02','2026-01-03',
    '2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-21','2026-02-22','2026-02-23',
    '2026-04-04','2026-04-05','2026-04-06',
    '2026-05-01','2026-05-02','2026-05-03','2026-05-04','2026-05-05',
    '2026-06-19','2026-06-20','2026-06-21',
    '2026-09-25','2026-09-26','2026-09-27',
    '2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07',
  ]),
  hk: new Set([
    '2026-01-01','2026-02-17','2026-02-18','2026-02-19',
    '2026-04-03','2026-04-06','2026-04-07',
    '2026-05-01','2026-05-25','2026-06-19','2026-07-01','2026-10-01','2026-10-19','2026-12-25',
  ]),
  us: new Set([
    '2026-01-01','2026-01-19','2026-02-16','2026-04-03',
    '2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  ]),
  kr: new Set([
    '2026-01-01','2026-02-16','2026-02-17','2026-02-18',
    '2026-03-02','2026-05-01','2026-05-05','2026-05-25','2026-06-03',
    '2026-08-17','2026-09-24','2026-09-25','2026-10-05','2026-10-09','2026-12-25','2026-12-31',
  ]),
};

// 半日市（收盘时间不同于常规）
// cn: 无半日市
const HALF_DAYS = {
  hk: new Set([
    '2026-02-16',  // 农历新年除夕 12:00 收盘
    '2026-12-24',  // 圣诞前夕
    '2026-12-31',  // 除夕
  ]),
  us: new Set([
    '2026-11-27',  // 黑色星期五 13:00 ET 收盘
    '2026-12-24',  // 平安夜
  ]),
  kr: new Set([
    '2026-01-02',  // 新年首个交易日 10:00 开盘
    '2026-11-19',  // 大学入学考试日 10:00 开盘
  ]),
  cn: new Set(),
};

// 韩股半日市开盘时间（特殊）
const KR_HALF_DAY_OPEN = {
  '2026-01-02': 10 * 60 + 0,   // 10:00
  '2026-11-19': 10 * 60 + 0,   // 10:00
};

// 市场常规交易时间（本地时间，分钟）
const MARKET_HOURS = {
  cn: { open: 9 * 60 + 30, close: 15 * 60 + 0, tz: 'Asia/Shanghai', lunchStart: 11 * 60 + 30, lunchEnd: 13 * 60 + 0 },
  hk: { open: 9 * 60 + 30, close: 16 * 60 + 0, tz: 'Asia/Hong_Kong', lunchStart: 12 * 60 + 0, lunchEnd: 13 * 60 + 0 },
  us: { open: 9 * 60 + 30, close: 16 * 60 + 0, tz: 'America/New_York' },
  kr: { open: 9 * 60 + 0, close: 15 * 60 + 30, tz: 'Asia/Seoul' },
};

// 半日市收盘时间（分钟）
const HALF_DAY_CLOSE = {
  hk: 12 * 60 + 0,   // 12:00
  us: 13 * 60 + 0,   // 13:00 ET
};

/**
 * 获取某个市场当前的本地时间信息
 */
function getMarketNow(market) {
  const tz = MARKET_HOURS[market].tz;
  const now = new Date();

  // 时间部分
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = {};
  timeFmt.formatToParts(now).forEach(p => { parts[p.type] = p.value; });

  const year = parseInt(parts.year);
  const month = parseInt(parts.month);
  const day = parseInt(parts.day);
  let hour = parseInt(parts.hour);
  if (hour === 24) hour = 0;
  const min = parseInt(parts.minute);
  const sec = parseInt(parts.second);

  // 星期几 — 用 weekday: 'short' 区分 Sunday/Saturday
  const wdFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const wdName = wdFmt.format(now);
  const dayOfWeekMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
  const dayOfWeek = dayOfWeekMap[wdName] ?? 0;

  return {
    year, month, day, hour, min, sec,
    totalMin: hour * 60 + min,
    dateStr: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    dayOfWeek,
  };
}

/**
 * 判断单个市场的状态
 * 返回: { status: '休市'|'未开盘'|'交易中'|'已收盘', label }
 *   休市: 周末 / 节假日
 *   未开盘: 交易日但还没到开盘时间
 *   交易中: 开盘时间 ~ 收盘时间
 *   已收盘: 已过收盘时间
 */
export function getMarketStatus(market) {
  const now = getMarketNow(market);
  const mh = MARKET_HOURS[market];

  // 周末 → 休市
  if (now.dayOfWeek === 0 || now.dayOfWeek === 6) {
    return { status: '休市', label: '休市' };
  }

  // 节假日 → 休市
  if (HOLIDAYS[market].has(now.dateStr)) {
    return { status: '休市', label: '休市' };
  }

  // 确定今日开盘/收盘时间
  let openMin = mh.open;
  let closeMin = mh.close;

  // 半日市调整
  if (HALF_DAYS[market]?.has(now.dateStr)) {
    if (market === 'kr' && KR_HALF_DAY_OPEN[now.dateStr] != null) {
      openMin = KR_HALF_DAY_OPEN[now.dateStr];
    } else if (market === 'hk' && HALF_DAY_CLOSE.hk != null) {
      closeMin = HALF_DAY_CLOSE.hk;
    } else if (market === 'us' && HALF_DAY_CLOSE.us != null) {
      closeMin = HALF_DAY_CLOSE.us;
    }
  }

  // 还没到开盘时间
  if (now.totalMin < openMin) {
    return { status: '未开盘', label: '未开盘' };
  }

  // 在交易时段内
  if (now.totalMin < closeMin) {
    return { status: '交易中', label: '交易中' };
  }

  // 已收盘
  return { status: '已收盘', label: '已收盘' };
}

/**
 * 获取所有市场的状态
 * 返回: { kr, hk, cn, us, summary, anyTrading }
 */
export function getAllMarketStatus() {
  const kr = getMarketStatus('kr');
  const hk = getMarketStatus('hk');
  const cn = getMarketStatus('cn');
  const us = getMarketStatus('us');

  const summary = `韩:${kr.label} | 港:${hk.label} | A:${cn.label} | 美:${us.label}`;
  const anyTrading = [kr, hk, cn, us].some(m => m.status === '交易中');

  return { kr, hk, cn, us, summary, anyTrading };
}

/**
 * 获取用户时区（Asia/Shanghai UTC+8）的格式化时间戳
 */
export function getUserTimestamp() {
  return new Date().toLocaleString('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).replace('T', ' ');
}
