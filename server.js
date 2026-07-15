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
        // 2. Yahooファイナンス検索で、コードから正しい会社名を先に割り出す
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
        } catch (e) {
            console.error("Name fetch error:", e);
        }

        // 証券コードを確実に英数字として確定させる
        const finalTicker = yahooSymbol ? yahooSymbol.replace('.T', '') : query.replace(/[^0-9A-Za-z]/g, '').toUpperCase();

        // 3. 確定した会社名を使ってGroqに分析させる
        const promptText = `
            ユーザーが株式「${actualCompanyName} (検索クエリ: ${query})」について検索しました。
            この企業に関する最新の動向、関連ニュース、主要指標を分析してください。

            【重要ルール】
            ・「companyName」は必ず日本の正式名称（例：株式会社タイミーなど）に翻訳して出力してください。
            ・「tickerCode」は必ず "${finalTicker || query}" をそのまま使用し、書き換えないでください。

            以下のJSON形式のみで回答してください。JSON以外は一切出力しないでください。
            {
                "companyName": "企業名の日本語表記",
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

        // 絶対防衛ライン: AIが何を返してきても、ここで正しい証券コードを強制上書きする！
        parsedData.tickerCode = finalTicker || query;

        // 4. Yahooファイナンスからリアルタイムの株価を取得して上書き（TradingViewと一致させる）
        try {
            let fetchSymbol = yahooSymbol;
            if (!fetchSymbol) {
                const cleanCode = query.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
                fetchSymbol = /^[0-9][0-9A-Z]{3}$/.test(cleanCode) ? `${cleanCode}.T` : cleanCode;
            }

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

// ★新機能：会社名から証券コードを検索する専用API
app.post('/api/search-code', async (req, res) => {
    const { query } = req.body;
    if (!query) return res.json({ success: true, results: [] });

    try {
        const searchRes = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}`);
        if (!searchRes.ok) throw new Error("検索に失敗しました");
        const searchData = await searchRes.json();
        
        let results = [];
        if (searchData.quotes && searchData.quotes.length > 0) {
            // 日本の銘柄（末尾が.Tのもの）だけを抽出してリスト化
            results = searchData.quotes
                .filter(q => q.symbol && q.symbol.endsWith('.T'))
                .map(q => ({
                    code: q.symbol.replace('.T', ''),
                    name: q.longname || q.shortname || '名称不明'
                }));
        }
        // 最大5件を返す
        res.json({ success: true, results: results.slice(0, 5) });
    } catch (e) {
        console.error("Code search error:", e);
        res.status(500).json({ error: "検索エラー" });
    }
});

app.listen(port, () => console.log(`Server started on port ${port}`));
