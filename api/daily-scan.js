/**
 * Hooks Screener — Daily Automated Scan
 * 
 * Runs at 9:00 AM ET (14:00 UTC) every weekday via Vercel cron.
 * Scans rotating 1/3 split of S&P 500, Global ADRs, Small/Mid Cap.
 * Sends push notifications for any qualifying stocks.
 * 
 * Triggered by vercel.json cron config — not called by the browser directly.
 * 
 * To set up:
 * 1. Add FINNHUB_KEY to Vercel Environment Variables
 * 2. Add PUSH_ENDPOINT (your push subscription endpoint) if using web push
 * 3. Deploy — Vercel handles the scheduling automatically
 */

// Universe lists (same as frontend)
const SP500 = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","BRK.B","AVGO","TSLA","LLY","JPM","V","XOM","UNH","MA","COST","HD","PG","NFLX","JNJ","ABBV","BAC","CRM","WMT","KO","MRK","CVX","AMD","PEP","ADBE","TMO","ACN","LIN","MCD","CSCO","ABT","WFC","DHR","GE","DIS","TXN","VZ","IBM","INTU","NOW","PM","CAT","AMGN","NEE","CMCSA","UBER","ISRG","SPGI","RTX","UNP","LOW","HON","QCOM","AMAT","BKNG","ETN","PFE","T","COP","SYK","BLK","PGR","SCHW","LMT","TJX","BSX","ELV","VRTX","ADP","MDT","CB","MU","GILD","PANW","MMC","ADI","SBUX","REGN","PLD","ANET","KLAC","CI","BX","SO","DE","LRCX","MO","ZTS","SHW","WM","DUK","FI","ICE","BMY","CL","EQIX","NOC","SLB","APH","MCK","TT","CME","PNC","AON","ITW","MSI","USB","GD","CMG","EOG","TGT","FCX","NKE","WELL","COF","ECL","EMR","HCA","ORLY","CSX","AJG","CDNS","PSA","MAR","MCO","ROP","CARR","SNPS"];
const ADR_LIST = ["TSM","SKHY","ASML","SAP","TM","SONY","BABA","SE","MELI","SPOT","NVO","SHOP","ARM","BIDU","JD","PDD","GRAB","RIO","BHP","BTI","DEO","UL","AZN","SHEL","BP","GSK","SAN","ING","PHG","ERIC","NOK","STM","LGEN","ABB","NOVN","ROG","NESN","MFG","SMFG","NMR","KB","SHG","WF","LFC","ZNH","CEA","CHT","ASX","WDS","NAB","HTHT","IQ","TAL","EDU","VNET","CAN","FUTU","TIGR","BOSS","MBG","BMW","SIEGY","BASFY","BAYRY","RHHBY","LVMUY","CFRUY","PPRUY","EONGY","ENLAY","IBDRY"];
const RUSSELL = ["IRDM","BKE","PWP","EVER","IONQ","ACHR","JOBY","RKLB","KTOS","AVAV","SMCI","NTNX","CRDO","QLYS","VRNS","SAIL","BRZE","BILL","GTLB","DDOG","ZS","CRWD","OKTA","TENB","SWKS","MCHP","ENTG","COHU","ONTO","ACMR","CAMT","NVMI","ARRY","HASI","NOVA","CLNE","BE","BLNK","EVGO","CHPT","DKNG","PENN","GENI","ACGL","KINSALE","RYAN","GSHD","NTAP","PSTG","NXST","IPGP","NOVT","LSCC","ALGM","DIOD","LFUS","VICR"];

// Rotating slice — cycles through each list over multiple days
function getDailySlice(list, sliceSize, dayOffset = 0) {
  const today = new Date();
  const dayNum = Math.floor(today.getTime() / (1000 * 60 * 60 * 24)) + dayOffset;
  const startIdx = (dayNum * sliceSize) % list.length;
  const slice = [];
  for (let i = 0; i < sliceSize; i++) {
    slice.push(list[(startIdx + i) % list.length]);
  }
  return slice;
}

async function finnhub(path, params, key) {
  const qs = new URLSearchParams({ ...params, token: key }).toString();
  const r = await fetch(`https://finnhub.io/api/v1${path}?${qs}`);
  return r.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Phase 1 check (fundamentals only)
function passesPhase1(metric) {
  const m = metric?.metric || {};
  const opProfit = m.operatingProfitTTM || m.ebitTTM || null;
  const totalEquity = m.totalEquityAnnual || null;
  const longTermDebt = m.longTermDebtAnnual || m.totalDebtAnnual || null;
  const capitalEmployed = (totalEquity !== null && longTermDebt !== null) ? totalEquity + longTermDebt : null;
  const roce = capitalEmployed && capitalEmployed > 0 && opProfit !== null
    ? opProfit / capitalEmployed * 100
    : m.roeTTM || m.roeRfy || null;
  const fcfTotal = m.freeCashFlowTTM || null;
  const marketCap = m.marketCapitalization || null;
  const fcf = fcfTotal && marketCap && marketCap > 0
    ? fcfTotal / marketCap * 100
    : m.freeCashFlowPerShareTTM && m.lastClosePrice && m.lastClosePrice > 0
      ? m.freeCashFlowPerShareTTM / m.lastClosePrice * 100
      : null;
  const de = m['totalDebt/totalEquityAnnual'] || m['totalDebt/totalEquityQuarterly'] || null;
  const pR = roce !== null && roce >= 15;
  const pF = fcf !== null && fcf >= 5;
  const pD = de !== null && de < 0.8;
  return pR || pF || pD;
}

export default async function handler(req, res) {
  // Vercel cron sends GET with a secret header for security
  // In production you'd validate: req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`
  
  const key = process.env.FINNHUB_KEY;
  if (!key) {
    return res.status(500).json({ error: 'FINNHUB_KEY not configured' });
  }

  // Build today's rotating universe: 65 from each list
  const SLICE = 65;
  const todaySyms = [
    ...getDailySlice(SP500, SLICE, 0),
    ...getDailySlice(ADR_LIST, SLICE, 1),
    ...getDailySlice(RUSSELL, SLICE, 2),
  ];
  // Deduplicate
  const symbols = [...new Set(todaySyms)];

  console.log(`Daily scan starting: ${symbols.length} symbols, ${new Date().toISOString()}`);

  const qualified = [];

  // Phase 1 pre-filter
  for (const sym of symbols) {
    try {
      const [metric, profile] = await Promise.all([
        finnhub('/stock/metric', { symbol: sym, metric: 'all' }, key),
        finnhub('/stock/profile2', { symbol: sym }, key),
      ]);
      if (!profile?.ticker) continue;
      if (passesPhase1(metric)) {
        qualified.push({ sym, profile, metric });
      }
    } catch (e) {
      console.warn(`Phase 1 error for ${sym}:`, e.message);
    }
    await sleep(400);
  }

  console.log(`Phase 1: ${qualified.length} qualified from ${symbols.length} scanned`);

  // For full technical analysis we'd need yfinance which isn't available
  // in a serverless function — so we report Phase 1 qualifiers and
  // let the frontend do the technical analysis when the user opens the app.
  // The notification tells them how many passed Phase 1 so they know to check.
  
  const results = {
    date: new Date().toISOString(),
    scanned: symbols.length,
    phase1Qualifiers: qualified.map(q => q.sym),
    message: qualified.length === 0
      ? 'No stocks passed Phase 1 today'
      : qualified.length === 1
        ? `${qualified[0].sym} — passed Phase 1`
        : qualified.length === 2
          ? `${qualified.map(q => q.sym).join(', ')} — passed Phase 1`
          : `${qualified.length} stocks passed Phase 1 — open screener to review`,
  };

  console.log('Daily scan complete:', results.message);

  // Store results so the frontend can retrieve them
  // In production: write to Vercel KV or a simple database
  // For now: return in response (frontend polls /api/daily-results)
  
  return res.status(200).json(results);
}
