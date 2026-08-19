/**
 * Hooks Screener — Vercel Serverless Proxy
 * 
 * All Finnhub API calls route through here so the key
 * never touches the browser. Key lives in Vercel env vars.
 * 
 * Usage: GET /api/scan?path=/quote&symbol=GOOGL
 * The frontend calls /api/scan instead of finnhub.io directly.
 */

export default async function handler(req, res) {
  // CORS — allow your own domain only
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const key = process.env.FINNHUB_KEY;
  if (!key) {
    return res.status(500).json({ error: 'FINNHUB_KEY environment variable not set in Vercel dashboard' });
  }

  // Build Finnhub URL from query params
  const { path, ...params } = req.query;
  if (!path) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  // Build query string from remaining params
  const qs = new URLSearchParams({ ...params, token: key }).toString();
  const url = `https://finnhub.io/api/v1${path}?${qs}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    
    // Forward Finnhub's response directly
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Finnhub proxy error:', error);
    res.status(500).json({ error: 'Failed to fetch from Finnhub', details: error.message });
  }
}
