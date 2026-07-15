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
    
    // 1. キャッシュの確認
    if (cache.has(normalizedQuery)) {
        const cachedItem = cache.get(normalizedQuery);
        if (Date.now() - cachedItem.timestamp < CACHE_DURATION) {
            return res.json({ success: true, data: cachedItem.data, fromCache: true });
        }
    }

    try {
        // 2. 入力が「証券コード」か「企業名」かを判定する
        // 日本語は消去して英数字だけ残す
        const cleanQuery = query.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
        // 4桁のコード（例: 7203, 215A）だけで検索されたか判定
        const isCodeQuery = /^[0-9][0-9A-Z]{3}$/.test(cleanQuery);
        
        let actualCompanyName = query;
        let finalTicker = "";

        // コード検索(例: 215A)の場合のみ、AIが勘違いしないようYahooから英語名を取得しておく
        if (isCodeQuery) {
            finalTicker = cleanQuery;
            try {
                const searchRes = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${finalTicker}.T`);
                if (searchRes.ok) {
                    const searchData = await searchRes.json();
                    if (searchData.quotes && searchData.quotes.length > 0) {
                        const quote = searchData.quotes[0];
                        actualCompanyName = quote.longname || quote.shortname || query;
                    }
                }
            } catch (e) {
                console.error("Name fetch error:", e);
            }
        }

        // 3. 確定した情報を使ってGroqに分析させる
        const promptText = `
            ユーザーが日本の株式「${actualCompanyName} (元の検索キーワード: ${query})」について検索しました。
            この企業に関する最新の動向、関連ニュース、主要指標を分析してください。

            【重要ルール】
            ・「companyName」は必ず日本の正式名称（例：株式会社タイミー、ユニチカ株式会社、ソニーグループなど）で出力してください。
            ・「tickerCode」は半角英数字を出力してください。${isCodeQuery ? `ユーザーが指定した証券コード「${finalTicker}」を必ずそのまま出力し、絶対に変更しないでください。` : `この企業の証券コードを推測して出力してください（例: 3103, 7203など）。`}

            以下のJSON形式のみで回答してください。JSON以外は一切出力しないでください。
            {
                "companyName": "企業名の日本語表記",
                "tickerCode": "${isCodeQuery ? finalTicker : "ここに証券コードを推測して出力"}",
                "currentPrice": 0,
                "changeText": "0 (0%)",
                "isPositive": true,
                "tradingSignal": 50,
                "tradingSignalLabel": "中立",
                "volatilityIndex": 50,
                "volatilityLabel": "普通",
                "industryGrowthIndex": 50,
                "industryGrowthLabel": "安定",
                "advancedMetrics": {
                    "minimumInvestment": 0,
                    "shareholderPerks": "なし",
                    "perkRating": 0,
                    "targetPrice": 0,
                    "earningsDate": "未定"
                },
                "news": [{"title": "関連ニュースタイトル", "url": "#", "source": "ニュース元"}],
                "fundamentals": {"per": "-", "perEvaluation": "適正", "pbr": "-", "pbrEvaluation": "適正", "dividendYield": "-", "yieldEvaluation": "適正"},
                "analysis": "企業の現状と今後の動向についての詳細な分析コメントを記載してください。",
                "riskFactor": "投資に関するリスクや懸念事項を記載してください。"
            }
        `;

        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: "user", content: promptText }],
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
        });

        let text = chatCompletion.choices[0].message.content;
        
        // 確実なJSONパース (余計な文字を削る)
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}') + 1;
        text = text.substring(start, end);
        let parsedData = JSON.parse(text);

        // ★絶対防衛ライン: コード検索だった場合は絶対にそのコードを維持、名前検索の場合はAIの推測を採用
        if (isCodeQuery) {
            parsedData.tickerCode = finalTicker;
        } else {
            parsedData.tickerCode = String(parsedData.tickerCode || "").replace(/[^0-9A-Za-z]/g, '').toUpperCase();
        }

        // 4. Yahooファイナンスからリアルタイムの株価を取得して上書き
        try {
            const cleanCode = parsedData.tickerCode;
            // 日本株のコード(数字始まりの4桁)なら .T をつける
            const fetchSymbol = /^[0-9][0-9A-Z]{3}$/.test(cleanCode) ? `${cleanCode}.T` : cleanCode;

            if (fetchSymbol) {
                const priceRes = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${fetchSymbol}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                
                if (priceRes.ok) {
                    const priceData = await priceRes.json();
                    const meta = priceData?.chart?.result?.[0]?.meta;
                    if (meta && meta.regularMarketPrice) {
                        const currentPrice = meta.regularMarketPrice;
                        const previousClose = meta.chartPreviousClose;
                        
                        // 正確な金額に上書き
                        parsedData.currentPrice = currentPrice;
                        
                        if (previousClose) {
                            const diff = currentPrice - previousClose;
                            const diffPercent = (diff / previousClose) * 100;
                            parsedData.isPositive = diff >= 0;
                            const sign = diff >= 0 ? '+' : '';
                            parsedData.changeText = `${sign}${diff.toFixed(1)} (${sign}${diffPercent.toFixed(2)}%)`;
                        }
                    }
                }
            }
        } catch (priceErr) {
            console.error("Price overwrite error:", priceErr);
        }

        // 5. 結果を保存してブラウザに返す
        cache.set(normalizedQuery, { timestamp: Date.now(), data: parsedData });
        res.json({ success: true, data: parsedData });

    } catch (err) {
        console.error("Analysis Error:", err);
        res.status(500).json({ error: "分析に失敗しました。詳細: " + err.message });
    }
});

app.listen(port, () => console.log(`Server started on port ${port}`));
