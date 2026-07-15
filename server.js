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

  let exactCompanyName = companyNameHint;
  
  // ★最強の対策：日本の「株探（かぶたん）」から100%正確な日本語の社名を取得する
  if (ticker) {
      try {
          const kabutanRes = await fetch(`https://kabutan.jp/stock/?code=${ticker}`);
          if (kabutanRes.ok) {
              const html = await kabutanRes.text();
              // <title>タイミー【215A】株の基本情報｜株探（かぶたん）</title> から社名を抽出
              const titleMatch = html.match(/<title>(.*?)【/);
              if (titleMatch && titleMatch[1]) {
                  exactCompanyName = titleMatch[1].trim(); // ここで確実に「タイミー」を取得！
              }
          }
      } catch (e) {
          console.warn("Kabutan fetch error", e);
      }
  }

  try {
    const promptText = `
    日本の証券コード「${ticker}」の企業について分析してください。
    
    【極めて重要なルール】
    ・「companyName」には、必ず「${exactCompanyName || '対象の日本企業'}」を入れてください。絶対に他の企業（例: ディー・エヌ・エー等）と混同しないでください。
    ・「tickerCode」は必ず "${ticker}" としてください。
    ・分析結果は必ず以下のJSON形式で出力してください。
    {
      "companyName": "${exactCompanyName || '対象の日本企業'}",
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

    // 絶対防衛ライン：AIが何を勘違いしても、ここで正しい「株探」の日本語名に強制上書きする！
    parsedData.tickerCode = ticker;
    if (exactCompanyName) {
        parsedData.companyName = exactCompanyName; 
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

  const cacheKey = `search:${query}`;
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.t) < CACHE_DURATION) {
    return res.json({ success: true, results: cached.v });
  }

  try {
    const prompt = `「${query}」に関連する日本の上場企業を最大5社挙げてください。必ず「会社名」と「証券コード(4桁)」をJSONの配列で返してください。
    出力例: {"results": [{"name": "ソニーグループ", "code": "6758"}]}`;

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
