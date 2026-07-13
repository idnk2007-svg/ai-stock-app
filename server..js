const express = require('express');
const cors = require('cors');

// Expressアプリの初期化
const app = express();
const port = process.env.PORT || 3000;

// ミドルウェアの設定
app.use(cors());
app.use(express.json());

// 'public'フォルダの中にある静的ファイル(index.html等)を配信する設定
// ユーザーがURLにアクセスすると、自動的にpublic/index.htmlが表示されます
app.use(express.static('public'));

// 株価分析用のAPIエンドポイント（フロントエンドからここへリクエストが来ます）
app.post('/api/analyze', async (req, res) => {
    const { query } = req.body;
    
    // 【重要】サーバーの環境変数からAPIキーを取得（誰からも見られず安全！）
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        return res.status(500).json({ error: "サーバーにAPIキーが設定されていません。" });
    }

    try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        
        // ユーザーから送られたのは銘柄名(query)だけ。プロンプト全体はサーバー側で安全に組み立てます。
        const promptText = `
            ユーザーが日本の株式「${query}」について検索しました。
            Google検索を用いて、「最新の株価」「最新の関連ニュース」「主要指標(PER, PBR, 配当利回り)」を取得してください。
            主要指標について、PERとPBRは「割安」「適正」「割高」のいずれか、配当利回りは「高い」「適正」「低い」のいずれかで評価してください。
            総合的に分析し、今後の株価動向の予想と、「買い時・売り時」を示す0〜100の指数、そのラベル（強い買い, 買い, 中立, 売り, 強い売り）、リスク要因を挙げてください。
            さらに、直近の価格変動（ボラティリティ）や市場の不確実性を評価し、0〜100の『価格変動リスク指数』（0=非常に安定、50=普通、100=非常に変動が激しく高リスク）と、そのラベルを算出してください。
            次に、その企業が属する業界や主要ビジネスが今後伸びるのか減少していくのかを評価し、0〜100の『業界将来性指数』（0=強い衰退懸念、50=現状維持・安定、100=高い成長性）と、そのラベルを算出してください。
            最後に、企業の特性を分析し、0〜100の『投資スタイル適合度指数』（0=短期トレード向き、50=中立、100=長期保有・資産形成向き）と、そのラベルを算出してください。
            必ず以下のJSONスキーマに従って出力してください。
        `;

        const payload = {
            contents: [{ parts: [{ text: promptText }] }],
            tools: [{ google_search: {} }],
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
                        "investmentStyleIndex": { type: "NUMBER" },
                        "investmentStyleLabel": { type: "STRING" },
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
                    required: ["companyName", "tickerCode", "currentPrice", "changeText", "isPositive", "tradingSignal", "tradingSignalLabel", "volatilityIndex", "volatilityLabel", "industryGrowthIndex", "industryGrowthLabel", "investmentStyleIndex", "investmentStyleLabel", "news", "fundamentals", "analysis", "riskFactor"]
                }
            }
        };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errBody = await response.text();
            console.error("Gemini API Error:", errBody);
            return res.status(500).json({ error: `AIの分析中にエラーが発生しました。` });
        }

        const result = await response.json();
        
        let parsedData;
        try {
            parsedData = JSON.parse(result.candidates[0].content.parts[0].text);
            // フロントエンドに安全に結果だけを返す
            res.json({ success: true, data: parsedData });
        } catch(e) {
            console.error("JSON Parse Error:", e);
            res.status(500).json({ error: "AIが正しいデータを返しませんでした。" });
        }

    } catch (err) {
        console.error("Server Error:", err);
        res.status(500).json({ error: "サーバー内部でエラーが発生しました。" });
    }
});

// サーバー起動
app.listen(port, () => {
    console.log(`サーバーがポート ${port} で起動しました。`);
});