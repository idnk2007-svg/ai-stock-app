const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Groq APIクライアントの設定
const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

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
        const promptText = `
            ユーザーが日本の株式「${query}」について検索しました。
            最新の株価、関連ニュース、主要指標を取得して分析してください。
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

        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: "user", content: promptText }],
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
        });

        let parsedData = JSON.parse(chatCompletion.choices[0].message.content);

        try {
            const cleanTickerCode = (parsedData.tickerCode || '').toString().replace(/[^0-9A-Za-z]/g, '').toUpperCase();
            if (cleanTickerCode) {
                let yahooSymbol = /^[0-9]/.test(cleanTickerCode) ? `${cleanTickerCode}.T` : cleanTickerCode;
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
        } catch (priceErr) { console.error("Price fetch error:", priceErr); }

        cache.set(normalizedQuery, { timestamp: Date.now(), data: parsedData });
        res.json({ success: true, data: parsedData });

    } catch (err) {
        console.error("Analysis Error:", err);
        res.status(500).json({ error: "分析に失敗しました。" });
    }
});

app.listen(port, () => console.log(`Server started on port ${port}`));
