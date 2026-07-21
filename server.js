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
      temperature: 0.6, // AIにサボらせず推論させるための調整
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
  let backupFundamentals = null;

  // 【手段1】まず株探から正確な社名と、Yahooがブロックされた時用のバックアップデータを取得
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
      
      // htmlから株価を引っこ抜く（バックアップ）
      const pMatch = html.match(/class="stock_price"[^>]*>([0-9,.]+)</) || html.match(/>([0-9,.]+)円</);
      if (pMatch) backupPrice = parseFloat(pMatch[1].replace(/,/g, ''));
      
      // htmlからPER・PBRを引っこ抜く（バックアップ）
      const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const perM = plain.match(/PER\s*([0-9,.]+)\s*倍/i);
      const pbrM = plain.match(/PBR\s*([0-9,.]+)\s*倍/i);
      const yldM = plain.match(/利回り\s*([0-9,.]+)\s*%/i);
      if (perM || pbrM || yldM) {
          backupFundamentals = {
              per: perM ? perM[1] : "-",
              pbr: pbrM ? pbrM[1] : "-",
              yield: yldM ? yldM[1] + "%" : "-"
          };
      }
    }
  } catch (e) {
    console.warn("Kabutan fetch error");
  }

  let realPriceData = null;
  const fetchSymbol = /^[0-9][0-9A-Z]{3}$/.test(ticker) ? `${ticker}.T` : ticker;

  // 【手段2】Yahoo v8 で本物の株価を取得
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

  // Yahooがダメだった場合、株探のバックアップ株価を適用
  if (!realPriceData && backupPrice) {
      realPriceData = { price: backupPrice, prev: backupPrice };
  }

  let rawFundamentals = { per: "-", pbr: "-", yield: "-" };
  let realFundamentalsText = "データなし";
  
  // 【手段3】Yahoo v7 で本物のPERを取得
  try {
    const quoteRes = await fetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${fetchSymbol}`, { 
        headers: { 'User-Agent': USER_AGENT } 
    });
    if (quoteRes.ok) {
        const quoteJson = await quoteRes.json();
        const qResult = quoteJson?.quoteResponse?.result?.[0];
        if (qResult) {
            const pe = qResult.trailingPE ? qResult.trailingPE.toFixed(2) : '-';
            const pbr = qResult.priceToBook ? qResult.priceToBook.toFixed(2) : '-';
            const divRaw = qResult.dividendYield || qResult.trailingAnnualDividendYield;
            const divYield = divRaw ? (divRaw * 100).toFixed(2) + '%' : '-';
            
            rawFundamentals = { per: pe, pbr: pbr, yield: divYield };
            realFundamentalsText = `PER: ${pe}倍, PBR: ${pbr}倍, 配当利回り: ${divYield}`;
        }
    }
  } catch(e) {
    console.warn('Yahoo v7 quote fetch error');
  }

  // Yahooがダメだった場合、株探のバックアップPERを適用
  if (realFundamentalsText === "データなし" && backupFundamentals) {
      rawFundamentals = backupFundamentals;
      realFundamentalsText = `PER: ${rawFundamentals.per}倍, PBR: ${rawFundamentals.pbr}倍, 配当利回り: ${rawFundamentals.yield}`;
  }

  try {
    const promptText = `
    日本の証券コード「${ticker}」の企業（${exactCompanyName}）について分析してください。
    
    【現在の市場データ（※極めて重要！この数値を絶対の基準として分析すること）】
    ・現在の株価: ${realPriceData ? realPriceData.price : '不明'} 円
    ・前日終値: ${realPriceData ? realPriceData.prev : '不明'} 円
    ・財務データ: ${realFundamentalsText}
    
    【極めて重要なルール】
    1. 以下のJSON構造に従って出力してください。
    2. 各種指数（Score / Index）は、必ず【0〜100の整数】であなた自身が論理的に計算してください。「0」や「50」という極端な数字や手抜きは禁止です。企業の実データに合わせて68、42、85などの具体的な数字を推論してください。
    ・tradingSignal: 売買シグナル総合（買い時なら高め）
    ・fundamentalScore: PER/PBRから見た割安度（PERが低く割安なら高め、割高なら低め）
    ・technicalScore: 現在の株価と前日終値のトレンド（上昇なら高め）
    ・volatilityIndex: 価格変動リスク（高リスクなら高め）
    ・industryGrowthIndex: 業界の将来性（成長するなら高め）
    
    【出力JSON形式（必ずこの形を守り、数値やテキストを書き換えること）】
    {
      "tradingSignal": 62,
      "tradingSignalLabel": "買い",
      "fundamentalScore": 45,
      "fundamentalLabel": "やや割高",
      "technicalScore": 55,
      "technicalLabel": "中立",
      "volatilityIndex": 60,
      "volatilityLabel": "やや高リスク",
      "industryGrowthIndex": 70,
      "industryGrowthLabel": "成長期待",
      "fundamentals": {
        "per": "${rawFundamentals.per}",
        "perEvaluation": "割高",
        "pbr": "${rawFundamentals.pbr}",
        "pbrEvaluation": "適正",
        "dividendYield": "${rawFundamentals.yield}",
        "yieldEvaluation": "低い"
      },
      "analysis": "企業の現状と今後の動向の詳しい分析。",
      "riskFactor": "投資リスクや懸念事項"
    }
    `;

    const parsedData = await chatJSON(promptText);

    if (!parsedData || Object.keys(parsedData).length === 0) {
        throw new Error('AIがデータの生成に失敗しました。もう一度「分析」ボタンを押してください。');
    }

    const toNum = (val, defaultVal) => {
        let n = parseInt(val, 10);
        return isNaN(n) ? defaultVal : Math.max(0, Math.min(100, n));
    };

    // undefined の時だけフォールバックし、AIが出した「0点」はそのまま活かす
    parsedData.tradingSignal = parsedData.tradingSignal !== undefined ? toNum(parsedData.tradingSignal, 50) : 50;
    parsedData.fundamentalScore = parsedData.fundamentalScore !== undefined ? toNum(parsedData.fundamentalScore, 50) : 50;
    parsedData.technicalScore = parsedData.technicalScore !== undefined ? toNum(parsedData.technicalScore, 50) : 50;
    parsedData.volatilityIndex = parsedData.volatilityIndex !== undefined ? toNum(parsedData.volatilityIndex, 50) : 50;
    parsedData.industryGrowthIndex = parsedData.industryGrowthIndex !== undefined ? toNum(parsedData.industryGrowthIndex, 50) : 50;

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
