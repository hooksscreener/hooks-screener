/**
 * Hooks Screener — Yahoo Finance Proxy
 * 
 * Proxies price history requests through your Vercel server
 * so mobile Safari can get stock data without CORS/blocking issues.
 * 
 * GET /api/history?symbol=GOOGL&days=365
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, days = 365 } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const end = Math.floor(Date.now() / 1000);
  const start = end - parseInt(days) * 24 * 60 * 60;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${start}&period2=${end}`;

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HooksScreener/1.0)',
        'Accept': 'application/json',
      }
    });

    if (!r.ok) {
      return res.status(r.status).json({ error: `Yahoo Finance returned ${r.status}` });
    }

    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: 'No data found' });

    const closes = result?.indicators?.quote?.[0]?.close;
    const volumes = result?.indicators?.quote?.[0]?.volume;
    const timestamps = result?.timestamp;

    // Cache for 1 hour — price history doesn't change during market hours
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).json({
      closes: Array.isArray(closes) ? closes.filter(Boolean) : [],
      volumes: Array.isArray(volumes) ? volumes.filter(v => v != null) : [],
      timestamps: timestamps || [],
    });
  } catch (e) {
    console.error(`History fetch error for ${symbol}:`, e.message);
    return res.status(500).json({ error: e.message });
  }
}
