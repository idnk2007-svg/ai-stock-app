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
const CACHE_DURATION = 1000 * 60 * 60 * 12; // 12時間

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

app.post('/api/analyze', async (req, res) => {
  const { query } = req.body || {};
  
  // クエリから証券コード(4桁の英数字)を抽出
  const tickerMatch = String(query).match(/[0-9][0-9A-Z]{3}/i);
  let ticker = tickerMatch ? tickerMatch[0].toUpperCase() : '';

  // クエリから日本語の会社名を抽出（記号や英数字を削除）
  let companyNameHint = String(query).replace(/[0-9a-zA-Z()（）\s]/g, '').trim();

  if (!ticker && query) {
    // AIを使ってコードを推測
    const prompt = `次の会社名に対応する日本の上場証券コード（4桁の英数字）をJSONで返してください。会社名: "${query}"。出力例: {"code":"7203"}`;
    const resAI = await chatJSON(prompt);
    const found = resAI?.code || resAI?.ticker || resAI?.証券コード;
    if (found) ticker = String(found).replace(/[^0-9A-Z]/gi, '').toUpperCase();
  }

  if (!ticker) {
    return res.status(400).json({ error: '証券コードを特定できませんでした。' });
  }

  if (!companyNameHint) {
    try {
        const fetchSymbol = /^[0-9][0-9A-Z]{3}$/.test(ticker) ? `${ticker}.T` : ticker;
        const searchRes = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${fetchSymbol}`);
        const searchData = await searchRes.json();
        if (searchData.quotes && searchData.quotes.length > 0) {
            companyNameHint = searchData.quotes[0].longname || searchData.quotes[0].shortname || '';
        }
    } catch (e) {
        console.warn("Name fetch error", e);
    }
  }

  try {
    const promptText = `
    日本の証券コード「${ticker}」の企業について分析してください。
    
    【極めて重要なルール】
    ・「companyName」には、必ず「${companyNameHint || '対象企業'}」の【日本語での正式な企業名】を入れてください。（例: "TIMEE INC" や "SONY GROUP" などの英語表記の場合は、必ず "株式会社タイミー" や "ソニーグループ" のように日本語のカタカナ・漢字に翻訳・修正してください）。絶対に「東京エレクトロン」など別の企業と混同しないでください。
    ・「tickerCode」は必ず "${ticker}" としてください。
    ・分析結果は必ず以下のJSON形式で出力してください。
    {
      "companyName": "実際の正式な企業名",
      "tickerCode": "${ticker}",
      "currentPrice": 0,
      "changeText": "0 (0%)",
      "isPositive": true,
      "tradingSignal": 50,
      "tradingSignalLabel": "中立",
      "volatilityIndex": 50,
      "volatilityLabel": "普通",
      "industryGrowthIndex": 50,
      "industryGrowthLabel": "安定",
      "news": [{"title": "関連ニュース", "url": "#", "source": "メディア名"}],
      "fundamentals": {"per": "-", "perEvaluation": "適正", "pbr": "-", "pbrEvaluation": "適正", "dividendYield": "-", "yieldEvaluation": "適正"},
      "analysis": "企業の現状と今後の動向を詳しく分析してください。",
      "riskFactor": "投資リスクや懸念事項を記載してください。"
    }`;

    const chatResp = await chatJSON(promptText);
    let parsedData = chatResp;

    if (!parsedData || typeof parsedData !== 'object') {
      return res.status(500).json({ error: 'AIからの解析結果が取得できませんでした' });
    }

    try {
      const fetchSymbol = /^[0-9][0-9A-Z]{3}$/.test(ticker) ? `${ticker}.T` : ticker;
      const priceRes = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${fetchSymbol}`);
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

    // 確実な上書き（保険）
    parsedData.tickerCode = ticker;

    return res.json({ success: true, data: parsedData });
  } catch (err) {
    console.error('analyze error', err?.message || err);
    return res.status(500).json({ error: '分析に失敗しました' });
  }
});

app.post('/api/search-code', async (req, res) => {
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query is required' });

  const cacheKey = `search:${query}`;
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.t) < CACHE_DURATION) {
    return res.json({ success: true, results: cached.v });
  }

  try {
    const prompt = `「${query}」に関連する日本の上場企業を最大5社挙げてください。必ず「会社名」と「証券コード(4桁)」をJSONの配列で返してください。
    出力例: {"results": [{"name": "ソニーグループ株式会社", "code": "6758"}]}`;

    const aiResp = await chatJSON(prompt);
    let results = [];
    if (aiResp && Array.isArray(aiResp.results)) {
        results = aiResp.results.map(item => ({ 
            name: item.name || item.companyName || '名称不明', 
            code: String(item.code || item.ticker || '').replace(/[^0-9A-Z]/gi, '').toUpperCase() 
        })).filter(r => r.code.length >= 4);
    }

    cache.set(cacheKey, { v: results, t: Date.now() });
    return res.json({ success: true, results });
  } catch (e) {
    console.error('search-code error', e?.message || e);
    return res.status(500).json({ error: '検索エラーが発生しました' });
  }
});

app.listen(port, () => console.log(`Server started on port ${port}`));
