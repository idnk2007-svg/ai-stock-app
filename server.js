const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
});

const cache = new Map();
const CACHE_DURATION = 1000 * 60 * 60 * 12;

const FALLBACK_TICKERS = {
  'トヨタ自動車': '7203',
  'トヨタ自動車株式会社': '7203',
  'トヨタ': '7203',
  'ソニーグループ': '6758',
  'ソニー': '6758',
  '任天堂': '7974',
  '日立製作所': '6501',
  '東京エレクトロン': '8035',
  '三菱商事': '8058',
  '三井物産': '8031',
  'ソフトバンクグループ': '9984',
  '楽天グループ': '4755',
  '楽天': '4755',
  'paypay': '3988',
  'paypay株式会社': '3988',
};

function normalizeText(value) {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u3041-\u3096\u30a1-\u30f6\u4e00-\u9fff]/g, '');
}

function safeParse(content) {
  if (!content) return null;
  if (typeof content === 'object') return content;
  if (typeof content !== 'string') return null;

  const s = content.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const target = fenced ? fenced[1] : s;

  try {
    return JSON.parse(target);
  } catch (e) {}

  try {
    const objMatch = target.match(/\{[\s\S]*\}/);
    if (objMatch) return JSON.parse(objMatch[0]);
  } catch (e) {}

  try {
    const arrMatch = target.match(/\[[\s\S]*\]/);
    if (arrMatch) return JSON.parse(arrMatch[0]);
  } catch (e) {}

  return null;
}

async function chatJSON(prompt, model = 'llama-3.3-70b-versatile') {
  try {
    const resp = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model,
      response_format: { type: 'json_object' },
    });

    const raw =
      resp?.choices?.[0]?.message?.content ||
      resp?.output_text ||
      '';

    const parsed = safeParse(raw);
    return parsed ?? raw;
  } catch (e) {
    try {
      const resp = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model,
      });

      const raw =
        resp?.choices?.[0]?.message?.content ||
        resp?.output_text ||
        '';

      const parsed = safeParse(raw);
      return parsed ?? raw;
    } catch (e2) {
      console.error('chatJSON error', e2?.message || e2);
      return null;
    }
  }
}

function extractTickerFromQuery(q) {
  if (!q) return '';
  const onlyNum = String(q).replace(/[^0-9]/g, '');
  return onlyNum || '';
}

function getFallbackResults(query) {
  const normalizedQuery = normalizeText(query);
  const results = [];

  for (const [name, ticker] of Object.entries(FALLBACK_TICKERS)) {
    const normalizedName = normalizeText(name);
    if (
      normalizedName === normalizedQuery ||
      normalizedName.includes(normalizedQuery) ||
      normalizedQuery.includes(normalizedName)
    ) {
      results.push({ companyName: name, ticker });
    }
  }

  return results;
}

async function lookupTickerWithAI(nameOrQuery) {
  if (!nameOrQuery) return '';

  const fallbackResults = getFallbackResults(nameOrQuery);
  if (fallbackResults.length > 0) {
    return fallbackResults[0].ticker;
  }

  const prompt = `次の会社名に対応する日本の上場証券コード（数字のみ）をJSONで返してください。会社名: "${nameOrQuery}"。出力例: {"ticker":"7203"}`;
  const res = await chatJSON(prompt);

  if (Array.isArray(res) && res.length > 0) {
    const first = res[0];
    const found = first?.ticker || first?.code || first?.証券コード || first?.tickerCode;
    if (found) return String(found).replace(/[^0-9]/g, '');
  }

  if (res && typeof res === 'object') {
    const found =
      res?.ticker ||
      res?.code ||
      res?.証券コード ||
      res?.tickerCode ||
      (res.results && res.results[0] && (res.results[0].ticker || res.results[0].code));

    if (found) return String(found).replace(/[^0-9]/g, '');
  }

  if (typeof res === 'string') {
    const m = res.match(/(\d{3,6})/);
    if (m) return m[1];
  }

  return '';
}

app.post('/api/analyze', async (req, res) => {
  const { query, companyName } = req.body || {};
  let ticker = extractTickerFromQuery(query);

  if (!ticker) {
    ticker = await lookupTickerWithAI(companyName || query);
  }

  try {
    const promptText = `証券コード「${ticker || '不明'}」の企業について分析してください。
【重要ルール】
・企業名は必ず「${companyName || '対象の日本企業'}」という正式名称を使用してください。
・分析結果は必ず指定のJSON形式で出力してください。
{
  "companyName": "${companyName || '対象の日本企業'}",
  "tickerCode": "${ticker || ''}",
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

    if (Array.isArray(parsedData)) parsedData = parsedData[0];

    if (!parsedData || typeof parsedData !== 'object') {
      console.error('analyze: unexpected AI response', chatResp);
      return res.status(500).json({ error: 'AIからの解析結果が取得できませんでした' });
    }

    const code = String(parsedData.tickerCode || ticker || '').replace(/[^0-9]/g, '');
    if (code) {
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

  const cacheKey = `search:${query}`;
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.t) < CACHE_DURATION) {
    return res.json({ success: true, results: cached.v });
  }

  try {
    let results = getFallbackResults(query);

    if (results.length === 0) {
      const prompt = `「${query}」に関連する日本の上場企業を最大5社挙げてください。必ず「正式な会社名」と「正しい証券コード(数字のみ)」をJSON配列で返してください。出力例: [{"companyName":"トヨタ自動車株式会社","ticker":"7203"}]。JSON以外は何も出力しないでください。`;

      const aiResp = await chatJSON(prompt);

      if (Array.isArray(aiResp)) {
        results = aiResp
          .map(item => ({
            companyName: item.companyName || item.name || item.会社名,
            ticker: String(item.ticker || item.code || item.証券コード || '').replace(/[^0-9]/g, ''),
          }))
          .filter(r => r.ticker);
      } else if (aiResp && typeof aiResp === 'object') {
        const arr =
          aiResp.results && Array.isArray(aiResp.results)
            ? aiResp.results
            : Object.values(aiResp).filter(v => typeof v === 'object');

        if (Array.isArray(arr)) {
          results = arr
            .map(item => ({
              companyName: item.companyName || item.name || item.会社名,
              ticker: String(item.ticker || item.code || item.証券コード || '').replace(/[^0-9]/g, ''),
            }))
            .filter(r => r.ticker);
        }
      } else if (typeof aiResp === 'string') {
        const parsed = safeParse(aiResp);
        if (Array.isArray(parsed)) {
          results = parsed
            .map(item => ({
              companyName: item.companyName || item.name || item.会社名,
              ticker: String(item.ticker || item.code || item.証券コード || '').replace(/[^0-9]/g, ''),
            }))
            .filter(r => r.ticker);
        }
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
