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

// ★最強の突破口：「普通のChromeブラウザ」のフリをしてアクセスブロックを回避する
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
  
  try {
    // ブロック回避のため、ヘッダーにUSER_AGENTを設定
    const kabutanRes = await fetch(`https://kabutan.jp/stock/?code=${ticker}`, { 
        headers: { 'User-Agent': USER_AGENT } 
    });
    if (kabutanRes.ok) {
      const html = await kabutanRes.text();
      // 株探のタイトルタグから正式名称だけを抜き取る
      const titleMatch = html.match(/<title>(.*?)【/);
      if (titleMatch && titleMatch[1] && !titleMatch[1].includes('エラー')) {
        exactCompanyName = titleMatch[1].trim();
      }
    }
  } catch (e) {
    console.warn("Kabutan fetch error", e);
  }

  // ★Yahooファイナンスから実際の財務指標と株価を取得
  let realFundamentalsText = "データなし";
  let realPriceData = null;
  let rawFundamentals = { per: "-", pbr: "-", yield: "-" };

  try {
    const fetchSymbol = /^[0-9][0-9A-Z]{3}$/.test(ticker) ? `${ticker}.T` : ticker;
    // v7/finance/quote APIを使って、株価だけでなくPERやPBRも一緒に取得
    const quoteRes = await fetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${fetchSymbol}`, { 
        headers: { 'User-Agent': USER_AGENT } 
    });
    const quoteJson = await quoteRes.json();
    const qResult = quoteJson?.quoteResponse?.result?.[0];
    
    if (qResult) {
      const pe = qResult.trailingPE ? qResult.trailingPE.toFixed(2) : '-';
      const pbr = qResult.priceToBook ? qResult.priceToBook.toFixed(2) : '-';
      const divRaw = qResult.dividendYield || qResult.trailingAnnualDividendYield;
      const divYield = divRaw ? (divRaw * 100).toFixed(2) + '%' : '-';
      
      rawFundamentals = { per: pe, pbr: pbr, yield: divYield };
      realFundamentalsText = `PER: ${pe}倍, PBR: ${pbr}倍, 配当利回り: ${divYield}`;
      
      realPriceData = {
        price: qResult.regularMarketPrice,
        prev: qResult.regularMarketPreviousClose
      };
    }
  } catch(e) {
    console.warn('Yahoo quote fetch error', e);
  }

  try {
    // ★AIの「サボり」を許さない、超強力なプロンプトに変更
    const promptText = `
    日本の証券コード「${ticker}」の企業（${exactCompanyName}）について分析してください。
    
    【現在の実際の財務データ（非常に重要）】
    ${realFundamentalsText}
    ※AI自身の過去の記憶やイメージに頼らず、必ず上記の実際の財務データ（PER、PBRなど）を基準にして、現在の株価が割高か割安かを論理的かつ客観的に評価してください。
    
    【極めて重要なルール：必ず守ること】
    1. 「companyName」には、必ず「${exactCompanyName}」を入れてください。
    2. 「tickerCode」は必ず "${ticker}" としてください。
    3. ★★★スコアの計算について（最重要）★★★
       以下のJSONのお手本にある「50」という数字は、単なる仮の数字（ダミー）です。絶対にそのまま丸写ししないでください。
       「tradingSignal」「fundamentalScore」「technicalScore」「volatilityIndex」「industryGrowthIndex」の5つの数値は、必ずあなたの分析結果に基づく【0〜100の整数】にそれぞれ書き換えて出力してください。（例：PERが60倍で極めて割高なら、fundamentalScoreは10など）
    4. 「fundamentals」の項目には、提供した実際の数値をそのまま出力し、評価（割安・適正・割高など）を付与してください。
    
    ・分析結果は必ず以下のJSON形式で出力してください。
    {
      "companyName": "${exactCompanyName}",
      "tickerCode": "${ticker}",
      "currentPrice": 0,
      "changeText": "0 (0%)",
      "isPositive": true,
      "tradingSignal": 50,
      "tradingSignalLabel": "中立",
      "fundamentalScore": 50,
      "fundamentalLabel": "適正水準",
      "technicalScore": 50,
      "technicalLabel": "中立",
      "volatilityIndex": 50,
      "volatilityLabel": "普通",
      "industryGrowthIndex": 50,
      "industryGrowthLabel": "安定",
      "news": [],
      "fundamentals": {"per": "${rawFundamentals.per}", "perEvaluation": "適正", "pbr": "${rawFundamentals.pbr}", "pbrEvaluation": "適正", "dividendYield": "${rawFundamentals.yield}", "yieldEvaluation": "適正"},
      "analysis": "企業の現状と上記の財務データを踏まえた今後の動向を詳しく分析してください。",
      "riskFactor": "投資リスクや懸念事項を記載してください。"
    }`;

    const parsedData = await chatJSON(promptText) || {};

    // 取得しておいた実際の株価データで上書き
    if (realPriceData && realPriceData.price) {
        parsedData.currentPrice = realPriceData.price;
        const prev = realPriceData.prev || realPriceData.price;
        const diff = realPriceData.price - prev;
        const percent = prev ? (diff / prev) * 100 : 0;
        parsedData.changeText = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} (${percent.toFixed(2)}%)`;
        parsedData.isPositive = diff >= 0;
    }

    // ★Googleニュースから本物の最新ニュースを取得して上書き
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

    // AIの勘違いを防ぐための絶対防衛ライン
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
