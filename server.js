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

// キャッシュの設定
const cache = new Map();
const CACHE_DURATION = 1000 * 60 * 60 * 12;

// 1. メイン分析API
app.post('/api/analyze', async (req, res) => {
    const { query } = req.body;
    const normalizedQuery = query.toLowerCase().trim();
    
    if (cache.has(normalizedQuery)) {
        return res.json({ success: true, data: cache.get(normalizedQuery).data, fromCache: true });
    }

    try {
        // AIに詳細な分析を依頼（コードが確定している前提で送る）
        const promptText = `
            証券コード「${query}」の企業について、最新の財務データや市場動向を分析してください。
            【重要】tickerCodeは必ず "${query}" を使用してください。
            JSONで出力してください。
            {
                "companyName": "日本の正式名称",
                "tickerCode": "${query}",
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
        
        // リアルタイム株価をYahooから取得
        try {
            const priceRes = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${query}.T`);
            const priceData = await priceRes.json();
            const meta = priceData?.chart?.result?.[0]?.meta;
            if (meta?.regularMarketPrice) {
                parsedData.currentPrice = meta.regularMarketPrice;
                const diff = meta.regularMarketPrice - meta.chartPreviousClose;
                parsedData.changeText = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} (${((diff/meta.chartPreviousClose)*100).toFixed(2)}%)`;
            }
        } catch(e) {}

        cache.set(normalizedQuery, { timestamp: Date.now(), data: parsedData });
        res.json({ success: true, data: parsedData });
    } catch (err) {
        res.status(500).json({ error: "分析失敗" });
    }
});

// 2. 検索コード補完API（Yahoo + AI ハイブリッド）
app.post('/api/search-code', async (req, res) => {
    const { query } = req.body;
    try {
        // まずYahooで試す
        const searchRes = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}`);
        const searchData = await searchRes.json();
        let results = searchData.quotes?.filter(q => q.symbol && q.symbol.endsWith('.T'))
            .map(q => ({ code: q.symbol.replace('.T', ''), name: q.longname || q.shortname })) || [];

        // Yahooで微妙ならAIに「日本株の証券コード」を教えてもらう
        if (results.length === 0 || results.length < 2) {
            const prompt = `「${query}」に関連する日本の上場企業を最大5社挙げ、正しい4桁の証券コードと正式名称をJSONで出力してください。 {"results": [{"code": "数字", "name": "名前"}]}`;
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
