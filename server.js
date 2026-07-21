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
      temperature: 0.7, // AIが手抜き（常に50を出す等）しないように少し高めに設定
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
  let backupFundamentals = { per: "-", pbr: "-", yield: "-" };

  // ① 株探（バックアップ用データ）から株価とPER/PBRを強制スクレイピング
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
      
      // ★ 最強のテキスト解析（PER/PBR混同バグを完全解消）
      // HTMLタグを全て消して、文字の羅列から順番通りに抜き取る
      const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      
      // 例: "PER PBR 利回り 信用倍率 単位 11.4 倍 0.86 倍 3.45 %"
      const comboMatch = plainText.match(/PER\s+PBR\s+利回り.*?([0-9,.-]+)\s*倍\s+([0-9,.-]+)\s*倍\s+([0-9,.-]+)\s*%/i);
      
      if (comboMatch) {
          if (comboMatch[1] && comboMatch[1] !== "-") backupFundamentals.per = comboMatch[1];
          if (comboMatch[2] && comboMatch[2] !== "-") backupFundamentals.pbr = comboMatch[2];
          if (comboMatch[3] && comboMatch[3] !== "-") backupFundamentals.yield = comboMatch[3] + "%";
      } else {
          // もしレイアウトが違った場合の従来のテーブル検索
          const tableMatch = html.match(/<table class="stock_info_tb"[^>]*>([\s\S]*?)<\/table>/i);
          if (tableMatch) {
              const tds = tableMatch[1].match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
              if (tds && tds.length >= 3) {
                  const ext = (s) => (s.replace(/<[^>]+>/g, '').match(/([0-9,.-]+)/) || [])[1] || "-";
                  const p1 = ext(tds[0]);
                  const p2 = ext(tds[1]);
                  const p3 = ext(tds[2]);
                  if (p1 !== "-") backupFundamentals.per = p1;
                  if (p2 !== "-") backupFundamentals.pbr = p2;
                  if (p3 !== "-") backupFundamentals.yield = p3 + "%";
              }
          }
      }
    }
  } catch (e) {
    console.warn("Kabutan fetch error");
  }

  // ② Yahooファイナンスからリアルタイム株価（チャート用）を取得
  let realPriceData = null;
  const fetchSymbol = /^[0-9][0-9A-Z]{3}$/.test(ticker) ? `${ticker}.T` : ticker;

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

  // ③ YahooファイナンスからリアルタイムPER/PBRを取得し、株探データと合体
  let rawFundamentals = { 
      per: backupFundamentals.per, 
      pbr: backupFundamentals.pbr, 
      yield: backupFundamentals.yield 
  };
  
  try {
    const quoteRes = await fetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${fetchSymbol}`, { 
        headers: { 'User-Agent': USER_AGENT } 
    });
    if (quoteRes.ok) {
        const quoteJson = await quoteRes.json();
        const qResult = quoteJson?.quoteResponse?.result?.[0];
        if (qResult) {
            // Yahooにデータが存在する場合だけ、株探のデータを上書きする（良いとこ取り）
            if (qResult.trailingPE) rawFundamentals.per = qResult.trailingPE.toFixed(2);
            if (qResult.priceToBook) rawFundamentals.pbr = qResult.priceToBook.toFixed(2);
            const divRaw = qResult.dividendYield || qResult.trailingAnnualDividendYield;
            if (divRaw) rawFundamentals.yield = (divRaw * 100).toFixed(2) + '%';
        }
    }
  } catch(e) {
    console.warn('Yahoo v7 quote fetch error');
  }

  const realFundamentalsText = `PER: ${rawFundamentals.per}倍, PBR: ${rawFundamentals.pbr}倍, 配当利回り: ${rawFundamentals.yield}`;

  // ④ 取得した完璧なデータをAIに渡して分析させる
  try {
    const promptText = `
    日本の証券コード「${ticker}」の企業（${exactCompanyName}）について分析してください。
    
    【現在の市場データ（※極めて重要！この数値を絶対の基準として分析すること）】
    ・現在の株価: ${realPriceData ? realPriceData.price : '不明'} 円
    ・前日終値: ${realPriceData ? realPriceData.prev : '不明'} 円
    ・財務データ: ${realFundamentalsText}
    
    【極めて重要なルール】
    1. 各種指数は、必ず【0〜100の整数】であなた自身が論理的に計算してください。「50」や「42」という手抜き数字は禁止です。
    ・tradingSignal: 売買シグナル総合
    ・fundamentalScore: 財務データ（PERやPBR）から見た割安度（PERが低く割安なら100に近い）
    ・technicalScore: 現在の株価と前日終値から見たチャートのトレンド（上昇なら100に近い）
    ・volatilityIndex: 価格変動リスク
    ・industryGrowthIndex: 業界の将来性
    
    【出力JSON形式（必ずこの形を守ること）】
    {
      "tradingSignal": 62,
      "tradingSignalLabel": "買い",
      "fundamentalScore": 80,
      "fundamentalLabel": "割安水準",
      "technicalScore": 75,
      "technicalLabel": "上昇トレンド",
      "volatilityIndex": 60,
      "volatilityLabel": "やや高リスク",
      "industryGrowthIndex": 70,
      "industryGrowthLabel": "成長期待",
      "fundamentals": {
        "perEvaluation": "割高",
        "pbrEvaluation": "適正",
        "yieldEvaluation": "低い"
      },
      "analysis": "企業の現状と今後の動向の詳しい分析。",
      "riskFactor": "投資リスクや懸念事項"
    }
    `;

    const parsedData = await chatJSON(promptText);

    if (!parsedData || Object.keys(parsedData).length === 0) {
        throw new Error('AIがデータの生成に失敗しました。');
    }

    const toNum = (val) => {
        let n = parseInt(val, 10);
        return isNaN(n) ? null : Math.max(0, Math.min(100, n));
    };

    parsedData.tradingSignal = toNum(parsedData.tradingSignal) ?? 50;
    parsedData.fundamentalScore = toNum(parsedData.fundamentalScore) ?? 50;
    parsedData.technicalScore = toNum(parsedData.technicalScore) ?? 50;
    parsedData.volatilityIndex = toNum(parsedData.volatilityIndex) ?? 50;
    parsedData.industryGrowthIndex = toNum(parsedData.industryGrowthIndex) ?? 50;

    // AIが勝手に数値を消してしまった場合に備え、サーバー側の数値を強制的に上書き
    if (!parsedData.fundamentals) parsedData.fundamentals = {};
    parsedData.fundamentals.per = rawFundamentals.per;
    parsedData.fundamentals.pbr = rawFundamentals.pbr;
    parsedData.fundamentals.dividendYield = rawFundamentals.yield;
    parsedData.fundamentals.perEvaluation = parsedData.fundamentals.perEvaluation || "不明";
    parsedData.fundamentals.pbrEvaluation = parsedData.fundamentals.pbrEvaluation || "不明";
    parsedData.fundamentals.yieldEvaluation = parsedData.fundamentals.yieldEvaluation || "不明";

    parsedData.tickerCode = ticker;
    if (exactCompanyName) {
        parsedData.companyName = exactCompanyName; 
    }
    
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
        if (realNews.length > 0) {
          parsedData.news = realNews; 
        }
      }
    } catch (e) {
      console.warn('News fetch error', e);
    }

    return res.json({ success: true, data: parsedData });
  } catch (err) {
    console.error('analyze error', err?.message || err);
    return res.status(500).json({ error: 'AIが分析データの生成に失敗しました。もう一度お試しください。' });
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
