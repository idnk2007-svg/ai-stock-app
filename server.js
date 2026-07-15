
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
});

const cache = new Map();
const CACHE_DURATION = 1000 * 60 * 60 * 12; // 12 hours

function safeParse(content) {
  if (!content) return null;
  if (typeof content === 'object') return content;
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch (e) {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) {
        try { return JSON.parse(m[0]); } catch (e2) { return null; }
      }
      return null;
    }
  }
  return null;
}

async function chatJSON(prompt, model = 'llama-3.3-70b-versatile') {
  try {
    const resp = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model,
      response_format: { type: 'json_object' },
    });
    const raw = resp?.choices?.[0]?.message?.content;
    return safeParse(raw) || raw;
  } catch (e) {
    console.error('chatJSON error', e?.message || e);
    return null;
  }
}

function extractTickerFromQuery(q) {
  if (!q) return '';
  const onlyNum = String(q).replace(/[^0-9]/g, '');
  if (onlyNum) return onlyNum;
  return '';
}

async function lookupTickerWithAI(nameOrQuery) {
  if (!nameOrQuery) return '';
  const prompt = `次の会社名に対応する日本の上場証券コード（数字のみ）をJSONで返してください。会社名: "${nameOrQuery}"。出力例: {"ticker":"7203"}`;
  const res = await chatJSON(prompt);
  const found = res?.ticker || res?.code || res?.証券コード || (typeof res === 'string' ? res : undefined);
  if (!found) return '';
  return String(found).replace(/[^0-9]/g, '');
}

app.post('/api/analyze', async (req, res) => {
  const { query, companyName } = req.body || {};
  let ticker = extractTickerFromQuery(query);

  if (!ticker) {
    ticker = await lookupTickerWithAI(companyName || query);
  }

  try {
    const promptText = `証券コード「${ticker || '不明'}」の企業について分析してください。\n【重要ルール】\n・企業名は必ず「${companyName || '対象の日本企業'}」という正式名称を使用してください。\n・分析結果は必ず指定のJSON形式で出力してください。\n{\n  "companyName": "${companyName || '対象の日本企業'}",\n  "tickerCode": "${ticker || ''}",\n  "currentPrice": 0,\n  "changeText": "0 (0%)",\n  "isPositive": true,\n  "tradingSignal": 50,\n  "tradingSignalLabel": "中立",\n  "volatilityIndex": 50,\n  "volatilityLabel": "普通",\n  "industryGrowthIndex": 50,\n  "industryGrowthLabel": "安定",\n  "news": [{"title": "関連ニュース", "url": "#", "source": "メディア名"}],\n  "fundamentals": {"per": "-", "perEvaluation": "適正", "pbr": "-", "pbrEvaluation": "適正", "dividendYield": "-", "yieldEvaluation": "適正"},\n  "analysis": "企業の現状と今後の動向を詳しく分析してください。",\n  "riskFactor": "投資リスクや懸念事項を記載してください。"\n}`;

    const chatResp = await chatJSON(promptText);
    let parsedData = chatResp;

    if (!parsedData || typeof parsedData !== 'object') {
      return res.status(500).json({ error: 'AIからの解析結果が取得できませんでした' });
    }

    // Fetch current price if ticker available
    if (parsedData.tickerCode || ticker) {
      const code = String(parsedData.tickerCode || ticker).replace(/[^0-9]/g, '');
      try {
        const priceRes = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${code}.T`);
        const priceData = await priceRes.json();
        const meta = priceData?.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice) {
          parsedData.currentPrice = meta.regularMarketPrice;
          const prev = meta.chartPreviousClose || meta.regularMarketPreviousClose || meta.regularMarketPrice;
          const diff = meta.regularMarketPrice - prev;
          const percent = prev ? (diff / prev) * 100 : 0;
          parsedData.changeText = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} (${percent.toFixed(2)}%)`;
          parsedData.isPositive = diff >= 0;
        }
      } catch (e) {
        console.warn('price fetch failed', e?.message || e);
      }
    }

    return res.json({ success: true, data: parsedData });
  } catch (err) {
    console.error('analyze error', err?.message || err);
    return res.status(500).json({ error: '分析に失敗しました' });
  }
});

app.post('/api/search-code', async (req, res) => {
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query is required' });

  // simple cache
  const cacheKey = `search:${query}`;
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.t) < CACHE_DURATION) {
    return res.json({ success: true, results: cached.v });
  }

  try {
    const prompt = `「${query}」に関連する日本の上場企業を最大5社挙げてください。必ず「正式な会社名」と「正しい証券コード(数字のみ)」をJSON配列で返してください。出力例: [{"companyName":"トヨタ自動車株式会社","ticker":"7203"}]。JSON以外は何も出力しないでください。`;

    const aiResp = await chatJSON(prompt);
    let results = [];
    if (Array.isArray(aiResp)) {
      results = aiResp.map(item => ({ companyName: item.companyName || item.name || item.会社名, ticker: String(item.ticker || item.code || item.証券コード || '').replace(/[^0-9]/g, '') })).filter(r => r.ticker);
    } else if (aiResp && typeof aiResp === 'object') {
      if (Array.isArray(aiResp.results)) {
        results = aiResp.results.map(item => ({ companyName: item.companyName || item.name, ticker: String(item.ticker || item.code || '').replace(/[^0-9]/g, '') })).filter(r => r.ticker);
      } else {
        results = Object.values(aiResp).filter(Boolean).map(item => {
          if (typeof item === 'string') return null;
          return { companyName: item.companyName || item.name || item.会社名, ticker: String(item.ticker || item.code || item.証券コード || '').replace(/[^0-9]/g, '') };
        }).filter(Boolean).filter(r => r.ticker);
      }
    }

    cache.set(cacheKey, { v: results, t: Date.now() });
    return res.json({ success: true, results });
  } catch (e) {
    console.error('search-code error', e?.message || e);
    return res.status(500).json({ error: '検索エラー' });
  }
});

app.listen(port, () => console.log(`Server started on port ${port}`));
