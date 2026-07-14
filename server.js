const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.post('/api/analyze', async (req, res) => {
    const { query } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        return res.status(500).json({ error: "サーバーにAPIキーが設定されていません。" });
    }

    try {
        // ★変更点：403エラーを回避するため、APIキーをURLの最後に直接組み込みます
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        
        const promptText = `
            ユーザーが日本の株式「${query}」について検索しました。以下を推測・分析してください。
            1. 「最新の株価」「関連ニュース」「主要指標(PER, PBR, 配当利回り)」。指標は「割安」「適正」「割高」（配当は「高い」「適正」「低い」）で評価。
            2. 「最低購入金額」（現在株価 × 100株）。
            3. 「株主優待の有無」と内容。魅力度を0〜5で評価。
            4. アナリストの平均的な「目標株価」。
            5. 次回の「決算発表時期」（例: "2026年8月"）。
            6. 総合分析し、「買い時・売り時(0-100)」とラベル、「価格変動リスク(0-100)」とラベル、「業界将来性(0-100)」とラベルを算出。
            必ず以下のJSONスキーマに従ってください。
        `;

        const payload = {
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        "companyName": { type: "STRING" },
                        "tickerCode": { type: "STRING" },
                        "currentPrice": { type: "NUMBER" },
                        "changeText": { type: "STRING" },
                        "isPositive": { type: "BOOLEAN" },
                        "tradingSignal": { type: "NUMBER" },
                        "tradingSignalLabel": { type: "STRING" },
                        "volatilityIndex": { type: "NUMBER" },
                        "volatilityLabel": { type: "STRING" },
                        "industryGrowthIndex": { type: "NUMBER" },
                        "industryGrowthLabel": { type: "STRING" },
                        "advancedMetrics": {
                            type: "OBJECT",
                            properties: {
                                "minimumInvestment": { type: "NUMBER" },
                                "shareholderPerks": { type: "STRING" },
                                "perkRating": { type: "NUMBER" },
                                "targetPrice": { type: "NUMBER" },
                                "earningsDate": { type: "STRING" }
                            }
                        },
                        "news": {
                            type: "ARRAY",
                            items: {
                                type: "OBJECT",
                                properties: {
                                    "title": { type: "STRING" },
                                    "url": { type: "STRING" },
                                    "source": { type: "STRING" }
                                }
                            }
                        },
                        "fundamentals": {
                            type: "OBJECT",
                            properties: {
                                "per": { type: "STRING" },
                                "perEvaluation": { type: "STRING" },
                                "pbr": { type: "STRING" },
                                "pbrEvaluation": { type: "STRING" },
                                "dividendYield": { type: "STRING" },
                                "yieldEvaluation": { type: "STRING" }
                            }
                        },
                        "analysis": { type: "STRING" },
                        "riskFactor": { type: "STRING" }
                    },
                    required: ["companyName", "tickerCode", "currentPrice", "changeText", "isPositive", "tradingSignal", "tradingSignalLabel", "volatilityIndex", "volatilityLabel", "industryGrowthIndex", "industryGrowthLabel", "advancedMetrics", "news", "fundamentals", "analysis", "riskFactor"]
                }
            }
        };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json'
                // ★変更点：ここにあったキー認証はURLに移動したため削除しました
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("Google API Error:", errorText);
            throw new Error(`Google API エラー (${response.status}): 権限がないか、キーが間違っています。`);
        }

        const result = await response.json();
        const parsedData = JSON.parse(result.candidates[0].content.parts[0].text);
        res.json({ success: true, data: parsedData });

    } catch (err) {
        console.error("Server Error:", err);
        res.status(500).json({ error: err.message || "サーバー内部でエラーが発生しました。" });
    }
});

app.listen(port, () => console.log(`Server started on port ${port}`));
