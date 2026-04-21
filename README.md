# Stock Price API

股票/基金实时行情查询 API，部署在 Cloudflare Workers 上，支持 iOS 快捷指令一键获取。

## 支持的市场

| 市场 | 数据源 | 说明 |
|------|--------|------|
| 🇰🇷 韩股 | Naver Finance | 实时行情 |
| 🇭🇰 港股 | 东方财富 | ~15分钟延迟 |
| 🇨🇳 A股基金 | 天天基金 | 单位净值（非估值） |

## API 接口

### `GET /api/prices`
JSON 格式返回所有股票行情，附带市场状态。

### `GET /api/prices/text`
纯文本格式，适合 iOS 快捷指令 / Telegram Bot。

### `GET /api/stocks`
返回已配置的股票列表。

## 配置

编辑 `stocks.json` 添加/删除股票：

```json
[
  { "name": "三星电子", "code": "005930", "market": "kr", "currency": "KRW", "source": "naver", "emoji": "🇰🇷" },
  { "name": "海力士", "code": "000660", "market": "kr", "currency": "KRW", "source": "naver", "emoji": "🇰🇷" }
]
```

`source` 可选值：`naver`（韩股）、`eastmoney`（港股）、`eastmoney_fund`（A股基金）

## 本地开发

```bash
npm install
npm run dev       # 启动 wrangler dev
npm run test      # 测试各数据源 API
```

## 部署

推送至 GitHub `main` 分支后自动通过 GitHub Actions 部署到 Cloudflare Workers。

需在 GitHub 仓库 Settings → Secrets 中配置：
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
