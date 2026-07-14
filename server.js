const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post('/api/analyze', async (req, res) => {
    const { query } = req.body;
    
    try {
        // AIのモデル名を2026年最新版の「gemini-3.5-flash」に変更しました！
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
        
        // 記号を使わず、最初から最後の { } までを抽出する安全な方法
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}') + 1;
        text = text.substring(start, end);
        
        res.json({ success: true, data: JSON.parse(text) });

    } catch (err) {
        console.error("Analysis Error:", err);
        res.status(500).json({ error: "分析に失敗しました。詳細: " + err.message });
    }
});

app.listen(port, () => console.log(`Server started on port ${port}`));
