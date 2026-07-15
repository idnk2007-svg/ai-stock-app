const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Groq (Llama 3) APIクライアントの設定
const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

// キャッシュの設定 (12時間保持)
const cache = new Map();
const CACHE_DURATION = 1000 * 60 * 60 * 12;

app.post('/api/analyze', async (req, res) => {
    const { query } = req.body;
    const normalizedQuery = query.toLowerCase().trim();
    
    if (cache.has(normalizedQuery)) {
        const cachedItem = cache.get(normalizedQuery);
        if (Date.now() - cachedItem.timestamp < CACHE_DURATION) {
            return res.json({ success: true, data: cachedItem.data, fromCache: true });
        }
    }

    try {
        let actualCompanyName = query;
        let yahooSymbol = "";
        
        try {
            const searchRes = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}`);
            if (searchRes.ok) {
                const searchData = await searchRes.json();
                if (searchData.quotes && searchData.quotes.length > 0) {
                    const quote = searchData.quotes[0];
                    actualCompanyName = quote.longname || quote.shortname || query;
                    yahooSymbol = quote.symbol; 
                }
            }
        } catch (e) { console.error("Name fetch error:", e); }

        const finalTicker = yahooSymbol ? yahooSymbol.replace('.T', '') : query.replace(/[^0-9A-Za-z]/g, '').toUpperCase();

        const promptText = `
            ユーザーが株式「${actualCompanyName}」について検索しました。
            この企業に関する最新動向を分析し、JSONで出力してください。
            【重要】tickerCodeは必ず "${finalTicker || query}" を使用してください。
            {
                "companyName": "企業名の日本語正式名称",
                "tickerCode": "${finalTicker || query}",
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
                "analysis": "分析コメント",
                "riskFactor": "リスク要因"
            }
        `;

        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: "user", content: promptText }],
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
        });

        let parsedData = JSON.parse(chatCompletion.choices[0].message.content);
        parsedData.tickerCode = finalTicker || query;

        // 株価取得
        try {
            const fetchSymbol = yahooSymbol || (query.match(/^\d+$/) ? `${query}.T` : "");
            if (fetchSymbol) {
                const priceRes = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${fetchSymbol}`);
                const priceData = await priceRes.json();
                const meta = priceData?.chart?.result?.[0]?.meta;
                if (meta?.regularMarketPrice) {
                    parsedData.currentPrice = meta.regularMarketPrice;
                    const diff = meta.regularMarketPrice - meta.chartPreviousClose;
                    parsedData.changeText = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} (${((diff/meta.chartPreviousClose)*100).toFixed(2)}%)`;
                }
            }
        } catch(e) {}

        cache.set(normalizedQuery, { timestamp: Date.now(), data: parsedData });
        res.json({ success: true, data: parsedData });
    } catch (err) {
        res.status(500).json({ error: "分析失敗" });
    }
});

// ★AIハイブリッド版：コード検索API
app.post('/api/search-code', async (req, res) => {
    const { query } = req.body;
    try {
        const searchRes = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}`);
        const searchData = await searchRes.json();
        let results = searchData.quotes?.filter(q => q.symbol && q.symbol.endsWith('.T'))
            .map(q => ({ code: q.symbol.replace('.T', ''), name: q.longname || q.shortname })) || [];

        // Yahooで見つからない場合、AIに聞く
        if (results.length === 0) {
            const prompt = `「${query}」に関連する日本の企業名と4桁の証券コードを最大5件、JSON {"results": [{"code": "数字", "name": "名前"}]} で出力してください。`;
            const completion = await groq.chat.completions.create({
                messages: [{ role: "user", content: prompt }],
                model: "llama-3.3-70b-versatile",
                response_format: { type: "json_object" },
            });
            const aiData = JSON.parse(completion.choices[0].message.content);
            results = aiData.results || [];
        }
        res.json({ success: true, results: results.slice(0, 5) });
    } catch (e) { res.status(500).json({ error: "検索エラー" }); }
});

app.listen(port, () => console.log(`Server started on port ${port}`));
