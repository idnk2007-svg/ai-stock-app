const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const cache = new Map(); // 検索結果を一時保存する場所
const CACHE_DURATION = 1000 * 60 * 60 * 12; // 12時間のキャッシュ有効期限

app.post('/api/analyze', async (req, res) => {
    const { query } = req.body;
    const normalizedQuery = query.toLowerCase().trim();
    
    // 1. キャッシュチェック
    if (cache.has(normalizedQuery)) {
        const cachedItem = cache.get(normalizedQuery);
        if (Date.now() - cachedItem.timestamp < CACHE_DURATION) {
            console.log(`Cache hit for: ${normalizedQuery}`);
            return res.json({ success: true, data: cachedItem.data, fromCache: true });
        }
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
        
        const promptText = `
            ユーザーが日本の株式「${query}」について検索しました。
            以下のJSON形式のみで回答してください。JSON以外は一切出力しないでください。
            {
                "companyName": "string",
                "tickerCode": "string",
                "currentPrice": 0,
                "changeText": "string",
                "isPositive": true,
                "tradingSignal": 0,
                "tradingSignalLabel": "string",
                "volatilityIndex": 0,
                "volatilityLabel": "string",
                "industryGrowthIndex": 0,
                "industryGrowthLabel": "string",
                "advancedMetrics": {
                    "minimumInvestment": 0,
                    "shareholderPerks": "string",
                    "perkRating": 0,
                    "targetPrice": 0,
                    "earningsDate": "string"
                },
                "news": [{"title": "string", "url": "string", "source": "string"}],
                "fundamentals": {"per": "string", "perEvaluation": "string", "pbr": "string", "pbrEvaluation": "string", "dividendYield": "string", "yieldEvaluation": "string"},
                "analysis": "string",
                "riskFactor": "string"
            }
        `;

        const result = await model.generateContent(promptText);
        let text = result.response.text();
        
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}') + 1;
        text = text.substring(start, end);
        
        let parsedData = JSON.parse(text);

        try {
            const cleanTickerCode = (parsedData.tickerCode || '').toString().replace(/[^0-9A-Za-z]/g, '').toUpperCase();
            if (cleanTickerCode) {
                let yahooSymbol = cleanTickerCode;
                if (/^[0-9][0-9A-Z]{3}$/.test(cleanTickerCode)) {
                    yahooSymbol = `${cleanTickerCode}.T`;
                }
                
                const yahooRes = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${yahooSymbol}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                
                if (yahooRes.ok) {
                    const yahooData = await yahooRes.json();
                    const actualPrice = yahooData?.chart?.result?.[0]?.meta?.regularMarketPrice;
                    const previousClose = yahooData?.chart?.result?.[0]?.meta?.chartPreviousClose;

                    if (actualPrice) {
                        parsedData.currentPrice = actualPrice;
                        if (previousClose) {
                            const diff = actualPrice - previousClose;
                            const diffPercent = (diff / previousClose) * 100;
                            parsedData.isPositive = diff >= 0;
                            const sign = diff >= 0 ? '+' : '';
                            parsedData.changeText = `${sign}${diff.toFixed(1)} (${sign}${diffPercent.toFixed(2)}%)`;
                        }
                    }
                }
            }
        } catch (priceErr) {
            console.error("Price fetch error:", priceErr);
        }

        cache.set(normalizedQuery, { timestamp: Date.now(), data: parsedData });
        res.json({ success: true, data: parsedData });

    } catch (err) {
        console.error("Analysis Error:", err);
        res.status(500).json({ error: "分析に失敗しました。詳細: " + err.message });
    }
});

app.listen(port, () => console.log(`Server started on port ${port}`));
