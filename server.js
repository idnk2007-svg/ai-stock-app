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
    baseURL: "https://api.groq.com/openai/v1"
});

const cache = new Map();
const CACHE_DURATION = 1000 * 60 * 60 * 12;

// 1. 分析API: 指定された正確な証券コードと企業名のみで分析する
app.post('/api/analyze', async (req, res) => {
    const { query, companyName } = req.body; // 候補から選ばれた企業名を優先する
    const ticker = query.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    
    try {
        const promptText = `
            証券コード「${ticker}」(${companyName || '日本企業'}) について分析してください。
            【重要】社名は必ず「${companyName || '対象企業'}」としてください。他の企業と混同は厳禁です。
            以下のJSON形式のみで出力してください。
            {
                "companyName": "${companyName || ticker}",
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
        
        // 株価取得 (Yahoo API)
        try {
            const priceRes = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${ticker}.T`);
            const priceData = await priceRes.json();
            const meta = priceData?.chart?.result?.[0]?.meta;
            if (meta?.regularMarketPrice) {
                parsedData.currentPrice = meta.regularMarketPrice;
                const diff = meta.regularMarketPrice - (meta.chartPreviousClose || meta.regularMarketPrice);
                parsedData.changeText = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} (${((diff/meta.chartPreviousClose)*100).toFixed(2)}%)`;
            }
        } catch(e) {}

        res.json({ success: true, data: parsedData });
    } catch (err) {
        res.status(500).json({ error: "分析に失敗しました" });
    }
});

// 2. 検索API: AIを使って正確な証券コードと社名を取得
app.post('/api/search-code', async (req, res) => {
    const { query } = req.body;
    try {
        const prompt = `「${query}」に関連する日本の上場企業を最大5社挙げてください。
        必ず「正式な会社名」と「正しい証券コード(数字)」をJSON形式で返してください。
        例: {"results": [{"code": "6758", "name": "ソニーグループ"}]}
        JSON以外は何も出力しないでください。`;
        
        const completion = await groq.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
        });
        
        const aiData = JSON.parse(completion.choices[0].message.content);
        res.json({ success: true, results: aiData.results || [] });
    } catch (e) { 
        res.status(500).json({ error: "検索エラー" }); 
    }
});

app.listen(port, () => console.log(`Server started on port ${port}`));
