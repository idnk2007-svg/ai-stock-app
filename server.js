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

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function safeParse(content) {
  if (!content) return null;
  if (typeof content === 'object') return content;
  if (typeof content === 'string') {
    try { return JSON.parse(content); } 
    catch (e) {
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
      messages: [
        { role: 'system', content: 'You are a professional financial AI. Output strictly valid JSON ONLY.' },
        { role: 'user', content: prompt }
      ],
      model,
      temperature: 0.7, 
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
  
  const tickerMatch = String(query).match(/[0-9][0-9A-Z]{3}/i);
  let ticker = tickerMatch ? tickerMatch[0].toUpperCase() : '';

  if (!ticker && query) {
    const prompt = `「${query}」の日本の上場証券コード(4桁の英数字)をJSONで返してください。出力例: {"code":"7203"}`;
    const resAI = await chatJSON(prompt);
    const found = resAI?.code || resAI?.ticker;
    if (found) ticker = String(found).replace(/[^0-9A-Z]/gi, '').toUpperCase();
  }

  if (!ticker) {
    return res.status(400).json({ error: '証券コードを特定できませんでした。' });
  }

  let exactCompanyName = query; 
  let backupPrice = null;

  // 【1】株探からのスクレイピング（不安定な指標取得を完全削除し、名前と株価のみ取得）
  try {
    const kabutanRes = await fetch(`https://kabutan.jp/stock/?code=${ticker}`, { 
        headers: { 'User-Agent': USER_AGENT } 
    });
    if (kabutanRes.ok) {
      const html = await kabutanRes.text();
      const titleMatch = html.match(/<title>(.*?)【/);
      if (titleMatch && titleMatch[1] && !titleMatch[1].includes('エラー')) {
        exactCompanyName = titleMatch[1].trim();
      }
      
      const pMatch = html.match(/class="stock_price"[^>]*>([0-9,.]+)</) || html.match(/>([0-9,.]+)円</);
      if (pMatch) backupPrice = parseFloat(pMatch[1].replace(/,/g, ''));
    }
  } catch (e) {
    console.warn("Kabutan fetch error");
  }

  let realPriceData = null;
  const fetchSymbol = /^[0-9][0-9A-Z]{3}$/.test(ticker) ? `${ticker}.T` : ticker;

  // 【2】Yahoo v8 で本物の株価を取得
  try {
    const priceRes = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${fetchSymbol}?interval=1d`, { 
        headers: { 'User-Agent': USER_AGENT } 
    });
    if (priceRes.ok) {
        const priceJson = await priceRes.json();
        const meta = priceJson?.chart?.result?.[0]?.meta;
        if (meta && meta.regularMarketPrice) {
            realPriceData = {
                price: meta.regularMarketPrice,
                prev: meta.chartPreviousClose || meta.regularMarketPreviousClose || meta.regularMarketPrice
            };
        }
    }
  } catch(e) {
    console.warn('Yahoo v8 chart fetch error');
  }

  if (!realPriceData && backupPrice) {
      realPriceData = { price: backupPrice, prev: backupPrice };
  }

  // 【3】AIに分析させる（シンプル化）
  try {
    const promptText = `
    あなたはプロの証券アナリストAIです。日本の証券コード「${ticker}」の企業（${exactCompanyName}）について分析してください。
    
    【現在の市場データ】
    ・現在の株価: ${realPriceData ? realPriceData.price : '不明'} 円
    ・前日終値: ${realPriceData ? realPriceData.prev : '不明'} 円
    
    【厳守するルール】
    各指数は、渡されたデータとあなたの知識に基づいて論理的に計算した【0〜100の整数】を必ず入れてください。
    ※出力例の数字（77）は単なるダミーです。絶対にそのまま出力せず、必ず自分で計算した数字に置き換えること！
    
    【出力JSON形式】
    {
      "tradingSignal": 77,
      "tradingSignalLabel": "買い",
      "fundamentalScore": 77,
      "fundamentalLabel": "割安",
      "technicalScore": 77,
      "technicalLabel": "上昇",
      "volatilityIndex": 77,
      "volatilityLabel": "高リスク",
      "industryGrowthIndex": 77,
      "industryGrowthLabel": "成長期待",
      "analysis": "具体的な分析コメント",
      "riskFactor": "懸念事項"
    }
    `;

    const parsedData = await chatJSON(promptText);

    if (!parsedData || Object.keys(parsedData).length === 0) {
        throw new Error('AIからの応答が空でした。もう一度お試しください。');
    }

    // AIが数値を出し忘れた場合や、サボってダミー値(77)を返した場合は厳しくエラーにしてやり直しさせる
    const toNum = (val) => {
        if (val === undefined || val === null) return null;
        let n = parseInt(val, 10);
        return isNaN(n) ? null : Math.max(0, Math.min(100, n));
    };

    const ts = toNum(parsedData.tradingSignal);
    const fs = toNum(parsedData.fundamentalScore);
    const tes = toNum(parsedData.technicalScore);
    const vi = toNum(parsedData.volatilityIndex);
    const igi = toNum(parsedData.industryGrowthIndex);

    // 絶対に42や50でごまかさない。サボりはエラーにする！
    if (ts === null || fs === null || ts === 77 || fs === 77) {
        throw new Error('AIが指数の計算をサボりました。お手数ですが、もう一度「分析」ボタンを押してください。');
    }

    parsedData.tradingSignal = ts;
    parsedData.fundamentalScore = fs;
    parsedData.technicalScore = tes;
    parsedData.volatilityIndex = vi;
    parsedData.industryGrowthIndex = igi;

    parsedData.tickerCode = ticker;
    if (exactCompanyName) parsedData.companyName = exactCompanyName; 
    
    parsedData.currentPrice = realPriceData ? realPriceData.price : 0;
    if (realPriceData && realPriceData.price) {
        const prev = realPriceData.prev || realPriceData.price;
        const diff = realPriceData.price - prev;
        const percent = prev ? (diff / prev) * 100 : 0;
        parsedData.changeText = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} (${percent.toFixed(2)}%)`;
        parsedData.isPositive = diff >= 0;
    } else {
        parsedData.changeText = "--- (---%)";
        parsedData.isPositive = true;
    }

    // Googleニュース取得
    try {
      const newsQuery = encodeURIComponent(`${exactCompanyName} 株式 OR 決算`);
      const newsRes = await fetch(`https://news.google.com/rss/search?q=${newsQuery}&hl=ja&gl=JP&ceid=JP:ja`, {
          headers: { 'User-Agent': USER_AGENT }
      });
      if (newsRes.ok) {
        const rssText = await newsRes.text();
        const items = rssText.match(/<item>[\s\S]*?<\/item>/g) || [];
        const realNews = [];
        for (let i = 0; i < Math.min(4, items.length); i++) {
          const item = items[i];
          const titleMatch = item.match(/<title>(.*?)<\/title>/);
          const linkMatch = item.match(/<link>(.*?)<\/link>/);
          const sourceMatch = item.match(/<source.*?>(.*?)<\/source>/);
          
          if (titleMatch && linkMatch) {
            let title = titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1'); 
            title = title.replace(/ - [^-]+$/, '');
            realNews.push({
              title: title,
              url: linkMatch[1],
              source: sourceMatch ? sourceMatch[1] : 'ニュースメディア'
            });
          }
        }
        if (realNews.length > 0) parsedData.news = realNews; 
      }
    } catch (e) {
      console.warn('News fetch error', e);
    }

    return res.json({ success: true, data: parsedData });
  } catch (err) {
    console.error('analyze error', err?.message || err);
    return res.status(500).json({ error: err.message || 'AIが分析データの生成に失敗しました。' });
  }
});

app.post('/api/search-code', async (req, res) => {
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query is required' });

  const cacheKey = `search-v4:${query}`;
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.t) < CACHE_DURATION) {
    return res.json({ success: true, results: cached.v });
  }

  try {
    const prompt = `「${query}」に関連する日本の上場企業の証券コード(4桁の英数字)を最大5つ、JSONで教えてください。出力例: {"codes": ["7203", "6758"]}`;
    const aiResp = await chatJSON(prompt);
    
    let candidates = [];
    if (aiResp && Array.isArray(aiResp.codes)) {
        candidates = aiResp.codes.map(c => String(c).replace(/[^0-9A-Z]/gi, '').toUpperCase());
    }

    let verifiedResults = [];
    const uniqueCodes = new Set();

    for (const code of candidates) {
        if (!code || uniqueCodes.has(code) || code.length < 4) continue;
        uniqueCodes.add(code);
        
        try {
            const kabutanRes = await fetch(`https://kabutan.jp/stock/?code=${code}`, {
                headers: { 'User-Agent': USER_AGENT }
            });
            if (kabutanRes.ok) {
                const html = await kabutanRes.text();
                const titleMatch = html.match(/<title>(.*?)【/);
                if (titleMatch && titleMatch[1]) {
                    const name = titleMatch[1].trim();
                    if (!name.includes('エラー') && !name.includes('見つかりません')) {
                        verifiedResults.push({ name: name, code: code });
                    }
                }
            }
        } catch (e) {
            console.warn("株探 verification error:", code);
        }
        
        if (verifiedResults.length >= 5) break;
    }

    cache.set(cacheKey, { v: verifiedResults, t: Date.now() });
    return res.json({ success: true, results: verifiedResults });
  } catch (e) {
    console.error('search-code error', e?.message || e);
    return res.status(500).json({ error: '検索エラーが発生しました' });
  }
});

app.listen(port, () => console.log(`Server started on port ${port}`));
