onst express = require('express');
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
const CACHE_DURATION = 1000 * 60 * 60 * 12; // 12時間キャッシュ

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
      // Groqの仕様: json_objectを使う場合は必ずプロンプト内でJSONの形を指定する
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
  const onlyNum = String(q).replace(/[^0-9A-Za-z]/g, '');
  if (onlyNum.length >= 4) return onlyNum.toUpperCase();
  return '';
}

// 会社名から証券コードを推測する補助関数
async function lookupTickerWithAI(nameOrQuery) {
  if (!nameOrQuery) return '';
  const prompt = `次の会社名に対応する日本の上場証券コード（4桁の数字または英数字）を特定してください。会社名: "${nameOrQuery}"。必ず以下のJSON形式で出力してください。{"code":"7203"}`;
  const res = await chatJSON(prompt);
  const found = res?.code || res?.ticker || res?.証券コード;
  if (!found) return '';
  return String(found).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

app.post('/api/analyze', async (req, res) => {
  const { query } = req.body || {};
  let ticker = extractTickerFromQuery(query);

  // もし数字が入力されていなければ（直接「トヨタ」などと検索された場合）、AIでコードを特定する
  if (!ticker && query) {
    ticker = await lookupTickerWithAI(query);
  }

  if (!ticker) {
    return res.status(400).json({ error: '証券コードを特定できませんでした。別のキーワードでお試しください。' });
  }

  try {
    const promptText = `日本の証券コード「${ticker}」の企業について分析してください。
【重要ルール】
・「companyName」には、証券コード${ticker}に対応する「実際の正式な企業名」を必ず日本語で入れてください（例：トヨタ自動車株式会社、ソニーグループなど。"対象の日本企業"のようなプレースホルダーは絶対に使用しないでください）。
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

    const code = String(parsedData.tickerCode || ticker).replace(/[^0-9A-Za-z]/g, '');
    if (code) {
      try {
        // Yahooファイナンスからリアルタイム株価を上書き取得
        const fetchSymbol = /^[0-9][0-9A-Z]{3}$/.test(code) ? `${code}.T` : code;
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
    // 【修正点】Groqのエラーを防ぐため、必ず "results" というキーを持ったオブジェクト形式で出力させる
    const prompt = `ユーザーが「${query}」と検索しました。これに関連する日本の上場企業を最大5社挙げてください。
必ず以下のJSON形式で返してください。JSON以外は絶対に何も出力しないでください。
{"results": [{"name": "正式な会社名", "code": "証券コード(数字のみ)"}]}`;

    const aiResp = await chatJSON(prompt);
    let results = [];
    
    // AIの返答から配列を取り出して、フロントエンドが求める形（name, code）に整える
    if (aiResp && Array.isArray(aiResp.results)) {
        results = aiResp.results.map(item => ({ 
            name: item.name || item.companyName || '名称不明', 
            code: String(item.code || item.ticker || '').replace(/[^0-9A-Za-z]/g, '') 
        })).filter(r => r.code);
    }

    cache.set(cacheKey, { v: results, t: Date.now() });
    return res.json({ success: true, results });
  } catch (e) {
    console.error('search-code error', e?.message || e);
    return res.status(500).json({ error: '検索エラーが発生しました' });
  }
});

app.listen(port, () => console.log(`Server started on port ${port}`));
