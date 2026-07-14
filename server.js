const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// AQ...形式のキーを使用する場合、環境変数から読み込むだけでOKなSDKを使います
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post('/api/analyze', async (req, res) => {
    const { query } = req.body;
    
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const promptText = `
            ユーザーが日本の株式「${query}」について検索しました。
            以下のJSONスキーマに従って、最新の株価分析データを出力してください。
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
        const text = result.response.text();
        const cleanText = text.replace(/
```json/g, '').replace(/```/g, '');
        
        res.json({ success: true, data: JSON.parse(cleanText) });

    } catch (err) {
        console.error("Analysis Error:", err);
        res.status(500).json({ error: "分析に失敗しました。キーの設定を確認してください。" });
    }
});

app.listen(port, () => console.log(`Server started on port ${port}`));
