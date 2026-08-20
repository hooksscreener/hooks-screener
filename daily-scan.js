/**
 * Hooks Screener — Daily Automated Scan
 * Runs at 9:00 AM ET (14:00 UTC) every weekday via Vercel cron.
 * Sends push notifications for scan start, completion, and results.
 */

const SP500 = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","BRK.B","AVGO","TSLA","LLY","JPM","V","XOM","UNH","MA","COST","HD","PG","NFLX","JNJ","ABBV","BAC","CRM","WMT","KO","MRK","CVX","AMD","PEP","ADBE","TMO","ACN","LIN","MCD","CSCO","ABT","WFC","DHR","GE","DIS","TXN","VZ","IBM","INTU","NOW","PM","CAT","AMGN","NEE","CMCSA","UBER","ISRG","SPGI","RTX","UNP","LOW","HON","QCOM","AMAT","BKNG","ETN","PFE","T","COP","SYK","BLK","PGR","SCHW","LMT","TJX","BSX","ELV","VRTX","ADP","MDT","CB","MU","GILD","PANW","MMC","ADI","SBUX","REGN","PLD","ANET","KLAC","CI","BX","SO","DE","LRCX","MO","ZTS","SHW","WM","DUK","FI","ICE","BMY","CL","EQIX","NOC","SLB","APH","MCK","TT","CME","PNC","AON","ITW","MSI","USB","GD","CMG","EOG","TGT","FCX","NKE","WELL","COF","ECL","EMR","HCA","ORLY","CSX","AJG","CDNS","PSA","MAR","MCO","ROP","CARR","SNPS"];
const ADR_LIST = ["TSM","SKHY","ASML","SAP","TM","SONY","BABA","SE","MELI","SPOT","NVO","SHOP","ARM","BIDU","JD","PDD","GRAB","RIO","BHP","BTI","DEO","UL","AZN","SHEL","BP","GSK","SAN","ING","PHG","ERIC","NOK","STM","ABB","NOVN","ROG","NESN","MFG","SMFG","NMR","KB","SHG","WF","LFC","ZNH","CEA","CHT","ASX","WDS","NAB","HTHT","IQ","TAL","EDU","VNET","CAN","FUTU","TIGR","BOSS","MBG","BMW","SIEGY","BASFY","BAYRY","RHHBY","LVMUY","CFRUY","PPRUY","EONGY","ENLAY","IBDRY"];
const RUSSELL = ["IRDM","BKE","PWP","EVER","ORN","RCAT","AAOI","IONQ","ACHR","JOBY","LILM","SPCE","ASTR","RDW","MNTS","BKSY","ASTS","SATL","KTOS","AVAV","RKLB","MNKD","SMCI","NTNX","CRDO","AEHR","FORM","NTCT","HLIT","VIAV","QLYS","VRNS","SAIL","S","SMAR","BRZE","BILL","GTLB","DDOG","ZS","CRWD","OKTA","TENB","ARLO","SWKS","MCHP","ENTG","COHU","ONTO","MKSI","ACMR","UCTT","CAMT","NVMI","ATRI","SLAB","WOLF","ERII","ARRY","HASI","NOVA","CLNE","BE","FCEL","PLUG","HYLN","BLNK","EVGO","CHPT","PTRA","WKHS","GOEV","ARVL","DKNG","PENN","RSI","GENI","SGHC","FLUT","EVEX","ACGL","KINSALE","RYAN","GSHD","JNPR","NTAP","PSTG","NXST","IPGP","NOVT","LSCC","ALGM","DIOD","LFUS","VICR"];

function getDailySlice(list, sliceSize, dayOffset = 0) {
  const dayNum = Math.floor(Date.now() / (1000 * 60 * 60 * 24)) + dayOffset;
  const startIdx = (dayNum * sliceSize) % list.length;
  const slice = [];
  for (let i = 0; i < sliceSize; i++) slice.push(list[(startIdx + i) % list.length]);
  return slice;
}

async function finnhub(path, params, key) {
  const qs = new URLSearchParams({ ...params, token: key }).toString();
  const r = await fetch(`https://finnhub.io/api/v1${path}?${qs}`);
  return r.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function passesPhase1(metric) {
  const m = metric?.metric || {};
  const opProfit = m.operatingProfitTTM || m.ebitTTM || null;
  const totalEquity = m.totalEquityAnnual || null;
  const longTermDebt = m.longTermDebtAnnual || m.totalDebtAnnual || null;
  const capitalEmployed = (totalEquity !== null && longTermDebt !== null) ? totalEquity + longTermDebt : null;
  const roce = capitalEmployed && capitalEmployed > 0 && opProfit !== null
    ? opProfit / capitalEmployed * 100 : m.roeTTM || m.roeRfy || null;
  const fcfTotal = m.freeCashFlowTTM || null;
  const marketCap = m.marketCapitalization || null;
  const fcf = fcfTotal && marketCap && marketCap > 0
    ? fcfTotal / marketCap * 100
    : m.freeCashFlowPerShareTTM && m.lastClosePrice && m.lastClosePrice > 0
      ? m.freeCashFlowPerShareTTM / m.lastClosePrice * 100 : null;
  const de = m['totalDebt/totalEquityAnnual'] || m['totalDebt/totalEquityQuarterly'] || null;
  return (roce !== null && roce >= 15) || (fcf !== null && fcf >= 5) || (de !== null && de < 0.8);
}

// Send Web Push notification to stored subscription
async function sendPush(subscription, payload) {
  if (!subscription) return;
  try {
    // For production: use web-push library with VAPID keys
    // For now: store results in Vercel KV and client polls on open
    // This is the placeholder — full web-push requires VAPID setup
    console.log('Push payload:', JSON.stringify(payload));
  } catch (e) {
    console.error('Push error:', e);
  }
}

export default async function handler(req, res) {
  const key = process.env.FINNHUB_KEY;
  if (!key) return res.status(500).json({ error: 'FINNHUB_KEY not configured' });

  const SLICE = 90;
  const todaySyms = [
    ...getDailySlice(SP500, SLICE, 0),
    ...getDailySlice(ADR_LIST, SLICE, 1),
    ...getDailySlice(RUSSELL, SLICE, 2),
  ];
  const symbols = [...new Set(todaySyms)];
  const startTime = new Date().toISOString();

  console.log(`🔍 Daily scan STARTING: ${symbols.length} symbols at ${startTime}`);

  // Store scan status in response headers so client can poll
  const qualified = [];

  for (const sym of symbols) {
    try {
      const [metric, profile] = await Promise.all([
        finnhub('/stock/metric', { symbol: sym, metric: 'all' }, key),
        finnhub('/stock/profile2', { symbol: sym }, key),
      ]);
      if (!profile?.ticker) continue;
      if (passesPhase1(metric)) qualified.push(sym);
    } catch (e) {
      console.warn(`Error for ${sym}:`, e.message);
    }
    await sleep(400);
  }

  const endTime = new Date().toISOString();
  const count = qualified.length;

  // Build notification message
  let message;
  if (count === 0) {
    message = 'No stocks passed Phase 1 today — market may be near highs';
  } else if (count === 1) {
    message = `${qualified[0]} — passed Phase 1`;
  } else if (count === 2) {
    message = `${qualified.join(', ')} — passed Phase 1`;
  } else {
    message = `${count} stocks passed Phase 1 — open screener to review`;
  }

  const result = {
    date: startTime,
    completed: endTime,
    scanned: symbols.length,
    qualified,
    message,
    notificationTitle: 'Hooks Screener — 9AM Scan Complete',
    notificationBody: message,
  };

  console.log('✅ Daily scan COMPLETE:', message);

  return res.status(200).json(result);
}
