/**
 * Hooks Screener — Daily Automated Scan v2
 * 9:00 AM ET (14:00 UTC) weekdays via Vercel cron
 * 
 * Notification flow:
 * 1. Scan start → immediate push "🔍 Daily scan running..."
 * 2. Scan complete → push with full summary
 * 3. Watchlist stocks → staggered pushes (30s apart) with indicator status
 * 
 * Auto-watchlist: all 3 phases + 2/3 indicators green → silent add
 * Signal log: every full trigger stored in KV with entry price for perf tracking
 */

import webpush from 'web-push';
import { kv } from '@vercel/kv';

const KV_SUBS = 'push_subscriptions';
const KV_MONITOR = 'monitoring_list';
const KV_WATCHLIST = 'auto_watchlist';
const KV_LAST_SCAN = 'last_scan_result';
const KV_SIGNALS = 'signal_log';
const KV_SPY_HISTORY = 'spy_price_history';

const SP500 = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","BRK.B","AVGO","TSLA","LLY","JPM","V","XOM","UNH","MA","COST","HD","PG","NFLX","JNJ","ABBV","BAC","CRM","WMT","KO","MRK","CVX","AMD","PEP","ADBE","TMO","ACN","LIN","MCD","CSCO","ABT","WFC","DHR","GE","DIS","TXN","VZ","IBM","INTU","NOW","PM","CAT","AMGN","NEE","CMCSA","UBER","ISRG","SPGI","RTX","UNP","LOW","HON","QCOM","AMAT","BKNG","ETN","PFE","T","COP","SYK","BLK","PGR","SCHW","LMT","TJX","BSX","ELV","VRTX","ADP","MDT","CB","MU","GILD","PANW","MMC","ADI","SBUX","REGN","PLD","ANET","KLAC","CI","BX","SO","DE","LRCX","MO","ZTS","SHW","WM","DUK","FI","ICE","BMY","CL","EQIX","NOC","SLB","APH","MCK","TT","CME","PNC","AON","ITW","MSI","USB","GD","CMG","EOG","TGT","FCX","NKE","WELL","COF","ECL","EMR","HCA","ORLY","CSX","AJG","CDNS","PSA","MAR","MCO","ROP","CARR","SNPS"];
const ADR_LIST = ["TSM","SKHY","ASML","SAP","TM","SONY","BABA","SE","MELI","SPOT","NVO","SHOP","ARM","BIDU","JD","PDD","GRAB","RIO","BHP","BTI","DEO","UL","AZN","SHEL","BP","GSK","SAN","ING","PHG","ERIC","NOK","STM","ABB","NOVN","ROG","NESN","MFG","SMFG","NMR","KB","SHG","WF","LFC","ZNH","CEA","CHT","ASX","WDS","NAB","HTHT","IQ","TAL","EDU","VNET","CAN","FUTU","TIGR","BOSS","MBG","BMW","SIEGY","BASFY","BAYRY","RHHBY","LVMUY","CFRUY","PPRUY","EONGY","ENLAY","IBDRY"];
const RUSSELL = ["IRDM","BKE","PWP","EVER","ORN","RCAT","AAOI","IONQ","ACHR","JOBY","LILM","SPCE","ASTR","RDW","MNTS","BKSY","ASTS","SATL","KTOS","AVAV","RKLB","MNKD","SMCI","NTNX","CRDO","AEHR","FORM","NTCT","HLIT","VIAV","QLYS","VRNS","SAIL","S","SMAR","BRZE","BILL","GTLB","DDOG","ZS","CRWD","OKTA","TENB","ARLO","SWKS","MCHP","ENTG","COHU","ONTO","MKSI","ACMR","UCTT","CAMT","NVMI","ATRI","SLAB","WOLF","ERII","ARRY","HASI","NOVA","CLNE","BE","FCEL","PLUG","HYLN","BLNK","EVGO","CHPT","PTRA","WKHS","GOEV","ARVL","DKNG","PENN","RSI","GENI","SGHC","FLUT","EVEX","ACGL","KINSALE","RYAN","GSHD","JNPR","NTAP","PSTG","NXST","IPGP","NOVT","LSCC","ALGM","DIOD","LFUS","VICR"];

// ── Helpers ──────────────────────────────────────────────────
function getDailySlice(list,size,offset=0){const day=Math.floor(Date.now()/86400000)+offset;const start=(day*size)%list.length;return Array.from({length:size},(_,i)=>list[(start+i)%list.length]);}
async function fh(path,params,key){const qs=new URLSearchParams({...params,token:key}).toString();const r=await fetch(`https://finnhub.io/api/v1${path}?${qs}`);return r.json();}
async function getHistory(sym){
  try{
    const end=Math.floor(Date.now()/1000),start=end-400*86400;
    const url=`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=${start}&period2=${end}`;
    const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}});
    const d=await r.json();
    const c=d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    return Array.isArray(c)?c.filter(Boolean):null;
  }catch{return null;}
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

// ── Phase evaluators ─────────────────────────────────────────
function passesPhase1(m){
  const mt=m?.metric||{};
  const op=mt.operatingProfitTTM||mt.ebitTTM||null;
  const eq=mt.totalEquityAnnual||null,debt=mt.longTermDebtAnnual||mt.totalDebtAnnual||null;
  const ce=eq!==null&&debt!==null?eq+debt:null;
  const roce=ce&&ce>0&&op!==null?op/ce*100:mt.roeTTM||mt.roeRfy||null;
  const fcfT=mt.freeCashFlowTTM||null,mc=mt.marketCapitalization||null;
  const fcf=fcfT&&mc&&mc>0?fcfT/mc*100:mt.freeCashFlowPerShareTTM&&mt.lastClosePrice>0?mt.freeCashFlowPerShareTTM/mt.lastClosePrice*100:null;
  const de=mt['totalDebt/totalEquityAnnual']||mt['totalDebt/totalEquityQuarterly']||null;
  return(roce!==null&&roce>=15)||(fcf!==null&&fcf>=5)||(de!==null&&de<0.8);
}
function passesPhase2(closes){
  if(!closes||closes.length<220)return false;
  const n=closes.length;
  const sma=(p,e)=>{let s=0;for(let i=e-p+1;i<=e;i++)s+=closes[i];return s/p;};
  return sma(200,n-1)>sma(200,n-21);
}
function evalPhase3(closes){
  if(!closes||closes.length<50)return{passes:false,draw:null};
  const n=closes.length,cur=closes[n-1],h52=Math.max(...closes.slice(-252));
  const draw=(h52-cur)/h52*100;
  return{passes:draw>=8&&draw<=33,draw:+draw.toFixed(1)};
}
function evalTiming(closes){
  if(!closes||closes.length<60)return{rsiCross:false,macdPos:false,rsi:null,macdH:null,ttm:'No data'};
  const n=closes.length;
  // RSI
  const rp=14,hs=closes.slice(-rp*4);
  let g=0,l=0;
  for(let i=1;i<=Math.min(rp,hs.length-1);i++){const d=hs[i]-hs[i-1];d>=0?g+=d:l-=d;}
  let ag=g/rp,al=l/rp;
  for(let i=rp+1;i<hs.length;i++){const d=hs[i]-hs[i-1];ag=(ag*(rp-1)+(d>=0?d:0))/rp;al=(al*(rp-1)+(d<0?-d:0))/rp;}
  const rsi=al===0?100:100-100/(1+ag/al);
  // MACD
  const ema=(d,p)=>{const k=2/(p+1);let v=d[0],o=[v];for(let i=1;i<d.length;i++){v=d[i]*k+v*(1-k);o.push(v);}return o;};
  const e12=ema(closes,12),e26=ema(closes,26),ml=e12.map((v,i)=>v-e26[i]),sl=ema(ml,9);
  const mh=ml[n-1]-sl[n-1],mhp=n>2?ml[n-2]-sl[n-2]:0;
  // TTM Squeeze
  const bbPer=20,bbMult=2,kcMult=1.5,atrPer=14;
  const bbMid=closes.slice(-bbPer).reduce((a,b)=>a+b,0)/bbPer;
  const bbStd=Math.sqrt(closes.slice(-bbPer).reduce((a,b)=>a+(b-bbMid)**2,0)/bbPer);
  const bbUp=bbMid+bbMult*bbStd,bbLo=bbMid-bbMult*bbStd;
  let atr=0;for(let i=n-atrPer;i<n;i++){if(i>0)atr+=Math.abs(closes[i]-closes[i-1]);}atr/=atrPer;
  const kcUp=bbMid+kcMult*atr,kcLo=bbMid-kcMult*atr;
  const squeezeOn=bbUp<kcUp&&bbLo>kcLo;
  const ttm=squeezeOn?'TTM Squeeze (Coiling)':mh>0?'TTM Squeeze (Bullish)':'TTM Squeeze (Bearish)';
  const ttmBull=!squeezeOn&&mh>0;
  return{
    rsiCross:rsi>=40,macdPos:mh>0,macdCross:mhp<0&&mh>=0,
    ttmBull,ttm,rsi:+rsi.toFixed(1),macdH:+mh.toFixed(4)
  };
}

// ── KV helpers ────────────────────────────────────────────────
async function kvGet(key,fallback=[]){try{const v=await kv.get(key);return v??fallback;}catch{return fallback;}}
async function kvSet(key,val){try{await kv.set(key,val);}catch(e){console.warn(`KV set ${key} failed:`,e.message);}}

// ── Push ──────────────────────────────────────────────────────
async function sendPush(subs,payload){
  const pub=process.env.VAPID_PUBLIC_KEY,priv=process.env.VAPID_PRIVATE_KEY;
  const subj=process.env.VAPID_SUBJECT||'mailto:support@hooks-screener.app';
  if(!pub||!priv||!subs.length){console.warn('Push skipped — no VAPID keys or no subscribers');return;}
  webpush.setVapidDetails(subj,pub,priv);
  const results=await Promise.allSettled(subs.map(s=>webpush.sendNotification(s,JSON.stringify(payload))));
  const expired=[];
  results.forEach((r,i)=>{if(r.status==='rejected'&&[404,410].includes(r.reason?.statusCode))expired.push(subs[i].endpoint);});
  if(expired.length){const fresh=subs.filter(s=>!expired.includes(s.endpoint));await kvSet(KV_SUBS,fresh);}
  console.log(`Push: ${results.filter(r=>r.status==='fulfilled').length}/${subs.length} delivered`);
}

// ── Signal logging ────────────────────────────────────────────
async function logSignal(sym,price,draw,rsi,macdH,ttm,name){
  const signals=await kvGet(KV_SIGNALS,[]);
  // Don't double-log same stock within 7 days
  const recent=signals.find(s=>s.sym===sym&&(Date.now()-new Date(s.date).getTime())<7*86400000);
  if(recent)return;
  signals.push({
    sym,name:name||sym,date:new Date().toISOString(),
    entryPrice:price,currentPrice:price,returnPct:0,
    draw,rsi,macdH,ttm,status:'open'
  });
  await kvSet(KV_SIGNALS,signals);
  console.log(`Signal logged: ${sym} @ $${price}`);
}

// Update existing signal returns with current prices
async function updateSignalReturns(key,fhKey){
  const signals=await kvGet(KV_SIGNALS,[]);
  if(!signals.length)return;
  let updated=false;
  for(const sig of signals.filter(s=>s.status==='open')){
    try{
      const q=await fh(`/quote?symbol=${sig.sym}`,{},fhKey);
      if(q?.c&&q.c>0){
        sig.currentPrice=q.c;
        sig.returnPct=+((q.c-sig.entryPrice)/sig.entryPrice*100).toFixed(2);
        updated=true;
      }
    }catch{}
    await sleep(200);
  }
  if(updated)await kvSet(KV_SIGNALS,signals);
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req,res){
  const key=process.env.FINNHUB_KEY;
  if(!key)return res.status(500).json({error:'FINNHUB_KEY not configured'});

  // Subscription management
  if(req.query.action==='vapid-key')return res.status(200).json({publicKey:process.env.VAPID_PUBLIC_KEY||null});
  if(req.method==='POST'&&req.query.action==='subscribe'){
    const sub=req.body;if(!sub?.endpoint)return res.status(400).json({error:'Invalid subscription'});
    const subs=await kvGet(KV_SUBS,[]);
    if(!subs.find(s=>s.endpoint===sub.endpoint)){subs.push(sub);await kvSet(KV_SUBS,subs);}
    return res.status(201).json({success:true});
  }
  // Return last scan results for app auto-load
  if(req.method==='GET'&&req.query.action==='last-scan'){
    const result=await kvGet(KV_LAST_SCAN,null);
    return res.status(200).json(result||{});
  }
  // Return signal log for Performance tab
  if(req.method==='GET'&&req.query.action==='signals'){
    const signals=await kvGet(KV_SIGNALS,[]);
    return res.status(200).json(signals);
  }

  // ── CRON: Daily scan ──────────────────────────────────────
  const SLICE=90;
  const todaySyms=[...new Set([
    ...getDailySlice(SP500,SLICE,0),
    ...getDailySlice(ADR_LIST,Math.min(SLICE,ADR_LIST.length),1),
    ...getDailySlice(RUSSELL,SLICE,2),
  ])];

  const subs=await kvGet(KV_SUBS,[]);
  const monitoring=await kvGet(KV_MONITOR,[]);
  const autoWatchlist=await kvGet(KV_WATCHLIST,[]);

  console.log(`🔍 Daily scan: ${todaySyms.length} universe + ${monitoring.length} monitored`);

  // Notification 1: scan starting
  await sendPush(subs,{
    title:'🔍 Hooks Screener',
    body:`Daily scan starting — checking ${todaySyms.length} stocks across all universes…`,
    tag:'scan-start',requireInteraction:false,
  });

  // Update existing signal returns in background
  updateSignalReturns(KV_SIGNALS,key).catch(()=>{});

  const fullTriggers=[],setupForming=[],scanResults=[];
  const keepMonitoring=[],newAutoWL=[];

  // Phase 1 pre-filter
  const p1Pass=[];
  for(const sym of todaySyms){
    try{
      const[metric,profile]=await Promise.all([fh('/stock/metric',{symbol:sym,metric:'all'},key),fh('/stock/profile2',{symbol:sym},key)]);
      if(!profile?.ticker)continue;
      if(passesPhase1(metric))p1Pass.push({sym,profile,metric});
    }catch(e){console.warn(`P1 ${sym}:`,e.message);}
    await sleep(350);
  }

  // Full analysis on qualifiers
  for(const{sym,profile,metric}of p1Pass){
    try{
      const closes=await getHistory(sym);
      if(!closes||closes.length<60)continue;
      if(!passesPhase2(closes))continue;
      keepMonitoring.push(sym);
      const p3=evalPhase3(closes);
      if(!p3.passes)continue;
      const timing=evalTiming(closes);
      // Count green indicators
      const greenCount=[timing.rsiCross,timing.macdPos,timing.ttmBull].filter(Boolean).length;
      // Full trigger: RSI + MACD required
      const isFullTrigger=timing.rsiCross&&timing.macdPos;
      const q=await fh(`/quote?symbol=${sym}`,{},key);
      const price=q?.c||0;
      const result={
        sym,name:profile.name||sym,price,draw:p3.draw,
        rsi:timing.rsi,macdH:timing.macdH,ttm:timing.ttm,
        rsiCross:timing.rsiCross,macdPos:timing.macdPos,ttmBull:timing.ttmBull,
        greenCount,isFullTrigger,
      };
      scanResults.push(result);
      if(isFullTrigger){
        fullTriggers.push(result);
        // Log signal for performance tracking
        await logSignal(sym,price,p3.draw,timing.rsi,timing.macdH,timing.ttm,profile.name);
      } else {
        setupForming.push(result);
      }
      // Auto-watchlist: all 3 phases + 2/3 indicators green
      if(greenCount>=2&&!autoWatchlist.includes(sym))newAutoWL.push(sym);
    }catch(e){console.warn(`Analysis ${sym}:`,e.message);}
    await sleep(400);
  }

  // Also check monitoring list stocks not in today's universe
  const notInToday=monitoring.filter(s=>!todaySyms.includes(s));
  for(const sym of notInToday){
    try{
      const[metric,profile]=await Promise.all([fh('/stock/metric',{symbol:sym,metric:'all'},key),fh('/stock/profile2',{symbol:sym},key)]);
      if(!profile?.ticker||!passesPhase1(metric))continue;
      const closes=await getHistory(sym);
      if(!closes||!passesPhase2(closes))continue;
      keepMonitoring.push(sym);
      const p3=evalPhase3(closes);
      if(!p3.passes)continue;
      const timing=evalTiming(closes);
      const greenCount=[timing.rsiCross,timing.macdPos,timing.ttmBull].filter(Boolean).length;
      const isFullTrigger=timing.rsiCross&&timing.macdPos;
      const q=await fh(`/quote?symbol=${sym}`,{},key);
      const price=q?.c||0;
      const result={sym,name:profile.name||sym,price,draw:p3.draw,rsi:timing.rsi,macdH:timing.macdH,ttm:timing.ttm,rsiCross:timing.rsiCross,macdPos:timing.macdPos,ttmBull:timing.ttmBull,greenCount,isFullTrigger};
      scanResults.push(result);
      if(isFullTrigger){fullTriggers.push(result);await logSignal(sym,price,p3.draw,timing.rsi,timing.macdH,timing.ttm,profile.name);}
      else setupForming.push(result);
      if(greenCount>=2&&!autoWatchlist.includes(sym))newAutoWL.push(sym);
    }catch(e){console.warn(`Monitor ${sym}:`,e.message);}
    await sleep(400);
  }

  // Update KV
  const updatedMonitoring=[...new Set(keepMonitoring)];
  const updatedWatchlist=[...new Set([...autoWatchlist,...newAutoWL])];
  await kvSet(KV_MONITOR,updatedMonitoring);
  await kvSet(KV_WATCHLIST,updatedWatchlist);

  // Store full scan results for app auto-load
  const scanRecord={
    date:new Date().toISOString(),
    scanned:todaySyms.length,
    fullTriggers:fullTriggers.map(r=>r.sym),
    setupForming:setupForming.map(r=>r.sym),
    monitoring:updatedMonitoring.length,
    autoWatchlist:updatedWatchlist,
    results:scanResults, // full card data for app display
  };
  await kvSet(KV_LAST_SCAN,scanRecord);

  // Notification 2: scan complete summary
  let summaryBody='';
  if(fullTriggers.length>0){
    summaryBody=fullTriggers.length===1
      ?`🚨 ${fullTriggers[0].sym} — FULL TRIGGER · ${fullTriggers[0].draw}% off high`
      :`🚨 ${fullTriggers.length} full triggers found — open to review`;
  } else if(setupForming.length>0){
    summaryBody=`⚡ ${setupForming.length} setup${setupForming.length>1?'s':''} forming — ${setupForming.map(s=>s.sym).slice(0,3).join(', ')}`;
  } else {
    summaryBody=`No triggers today · ${updatedMonitoring.length} stocks monitored`;
  }
  await sendPush(subs,{
    title:'✅ Hooks Screener — Scan Complete',
    body:summaryBody,
    tag:'scan-complete',
    requireInteraction:fullTriggers.length>0,
    url:'/',
  });

  // Notification 3: staggered watchlist status updates (30s apart)
  const wlToNotify=updatedWatchlist.slice(0,10); // max 10 watchlist notifications
  for(let i=0;i<wlToNotify.length;i++){
    const sym=wlToNotify[i];
    const r=scanResults.find(s=>s.sym===sym);
    if(!r)continue;
    await sleep(30000); // 30 second delay between each
    const indicators=[];
    if(r.rsiCross)indicators.push(`RSI ${r.rsi} 🟢`);else indicators.push(`RSI ${r.rsi} 🔴`);
    if(r.macdPos)indicators.push(`MACD 🟢`);else indicators.push(`MACD 🔴`);
    indicators.push(r.ttmBull?`TTM 🟢`:r.ttm.includes('Coiling')?`TTM 🔵`:`TTM 🔴`);
    await sendPush(subs,{
      title:`👀 ${sym} — Watchlist Update`,
      body:`${indicators.join(' · ')} · ${r.draw}% off high`,
      tag:`wl-${sym}`,requireInteraction:false,url:'/',
    });
  }

  console.log(`✅ Scan complete: ${fullTriggers.length} triggers, ${setupForming.length} setups, ${updatedMonitoring.length} monitored`);
  return res.status(200).json(scanRecord);
}