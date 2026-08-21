/**
 * Hooks Screener — Daily Automated Scan with Vercel KV + Web Push
 * Runs at 9:00 AM ET (14:00 UTC) every weekday via Vercel cron.
 */

import webpush from 'web-push';
import { kv } from '@vercel/kv';

const KV_KEY = 'push_subscriptions';

const SP500 = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","BRK.B","AVGO","TSLA","LLY","JPM","V","XOM","UNH","MA","COST","HD","PG","NFLX","JNJ","ABBV","BAC","CRM","WMT","KO","MRK","CVX","AMD","PEP","ADBE","TMO","ACN","LIN","MCD","CSCO","ABT","WFC","DHR","GE","DIS","TXN","VZ","IBM","INTU","NOW","PM","CAT","AMGN","NEE","CMCSA","UBER","ISRG","SPGI","RTX","UNP","LOW","HON","QCOM","AMAT","BKNG","ETN","PFE","T","COP","SYK","BLK","PGR","SCHW","LMT","TJX","BSX","ELV","VRTX","ADP","MDT","CB","MU","GILD","PANW","MMC","ADI","SBUX","REGN","PLD","ANET","KLAC","CI","BX","SO","DE","LRCX","MO","ZTS","SHW","WM","DUK","FI","ICE","BMY","CL","EQIX","NOC","SLB","APH","MCK","TT","CME","PNC","AON","ITW","MSI","USB","GD","CMG","EOG","TGT","FCX","NKE","WELL","COF","ECL","EMR","HCA","ORLY","CSX","AJG","CDNS","PSA","MAR","MCO","ROP","CARR","SNPS"];
const ADR_LIST = ["TSM","SKHY","ASML","SAP","TM","SONY","BABA","SE","MELI","SPOT","NVO","SHOP","ARM","BIDU","JD","PDD","GRAB","RIO","BHP","BTI","DEO","UL","AZN","SHEL","BP","GSK","SAN","ING","PHG","ERIC","NOK","STM","ABB","NOVN","ROG","NESN","MFG","SMFG","NMR","KB","SHG","WF","LFC","ZNH","CEA","CHT","ASX","WDS","NAB","HTHT","IQ","TAL","EDU","VNET","CAN","FUTU","TIGR","BOSS","MBG","BMW","SIEGY","BASFY","BAYRY","RHHBY","LVMUY","CFRUY","PPRUY","EONGY","ENLAY","IBDRY"];
const RUSSELL = ["IRDM","BKE","PWP","EVER","ORN","RCAT","AAOI","IONQ","ACHR","JOBY","LILM","SPCE","ASTR","RDW","MNTS","BKSY","ASTS","SATL","KTOS","AVAV","RKLB","MNKD","SMCI","NTNX","CRDO","AEHR","FORM","NTCT","HLIT","VIAV","QLYS","VRNS","SAIL","S","SMAR","BRZE","BILL","GTLB","DDOG","ZS","CRWD","OKTA","TENB","ARLO","SWKS","MCHP","ENTG","COHU","ONTO","MKSI","ACMR","UCTT","CAMT","NVMI","ATRI","SLAB","WOLF","ERII","ARRY","HASI","NOVA","CLNE","BE","FCEL","PLUG","HYLN","BLNK","EVGO","CHPT","PTRA","WKHS","GOEV","ARVL","DKNG","PENN","RSI","GENI","SGHC","FLUT","EVEX","ACGL","KINSALE","RYAN","GSHD","JNPR","NTAP","PSTG","NXST","IPGP","NOVT","LSCC","ALGM","DIOD","LFUS","VICR"];

function getDailySlice(list, size, offset=0){
  const day=Math.floor(Date.now()/86400000)+offset;
  const start=(day*size)%list.length;
  return Array.from({length:size},(_,i)=>list[(start+i)%list.length]);
}

async function finnhub(path, params, key){
  const qs=new URLSearchParams({...params,token:key}).toString();
  const r=await fetch(`https://finnhub.io/api/v1${path}?${qs}`);
  return r.json();
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function passesPhase1(metric){
  const m=metric?.metric||{};
  const op=m.operatingProfitTTM||m.ebitTTM||null;
  const eq=m.totalEquityAnnual||null;
  const debt=m.longTermDebtAnnual||m.totalDebtAnnual||null;
  const ce=eq!==null&&debt!==null?eq+debt:null;
  const roce=ce&&ce>0&&op!==null?op/ce*100:m.roeTTM||m.roeRfy||null;
  const fcfT=m.freeCashFlowTTM||null;
  const mc=m.marketCapitalization||null;
  const fcf=fcfT&&mc&&mc>0?fcfT/mc*100:m.freeCashFlowPerShareTTM&&m.lastClosePrice>0?m.freeCashFlowPerShareTTM/m.lastClosePrice*100:null;
  const de=m['totalDebt/totalEquityAnnual']||m['totalDebt/totalEquityQuarterly']||null;
  return (roce!==null&&roce>=15)||(fcf!==null&&fcf>=5)||(de!==null&&de<0.8);
}

async function getSubscriptions(){
  try{const s=await kv.get(KV_KEY);return Array.isArray(s)?s:[];}
  catch{return [];}
}

async function sendPushToAll(subs, payload){
  const pub=process.env.VAPID_PUBLIC_KEY;
  const priv=process.env.VAPID_PRIVATE_KEY;
  const subj=process.env.VAPID_SUBJECT||'mailto:support@hooks-screener.app';
  if(!pub||!priv){console.warn('VAPID keys not configured');return;}
  webpush.setVapidDetails(subj,pub,priv);
  const results=await Promise.allSettled(
    subs.map(sub=>webpush.sendNotification(sub,JSON.stringify(payload)))
  );
  // Remove expired/invalid subscriptions
  const expired=[];
  results.forEach((r,i)=>{
    if(r.status==='rejected'&&(r.reason?.statusCode===404||r.reason?.statusCode===410)){
      expired.push(subs[i].endpoint);
    }
  });
  if(expired.length>0){
    const fresh=subs.filter(s=>!expired.includes(s.endpoint));
    await kv.set(KV_KEY,fresh).catch(()=>{});
    console.log(`Removed ${expired.length} expired subscriptions`);
  }
  const ok=results.filter(r=>r.status==='fulfilled').length;
  console.log(`Push sent to ${ok}/${subs.length} subscribers`);
}

export default async function handler(req, res){
  const key=process.env.FINNHUB_KEY;
  if(!key)return res.status(500).json({error:'FINNHUB_KEY not configured'});

  // Handle subscription requests
  if(req.query.action==='vapid-key'){
    return res.status(200).json({publicKey:process.env.VAPID_PUBLIC_KEY||null});
  }
  if(req.method==='POST'&&req.query.action==='subscribe'){
    const sub=req.body;
    if(!sub?.endpoint)return res.status(400).json({error:'Invalid subscription'});
    const subs=await getSubscriptions();
    if(!subs.find(s=>s.endpoint===sub.endpoint)){
      subs.push(sub);
      await kv.set(KV_KEY,subs).catch(()=>{});
    }
    return res.status(201).json({success:true,total:subs.length});
  }

  // ── CRON: Daily scan ──
  const startTime=new Date().toISOString();
  const SLICE=90;
  const symbols=[...new Set([
    ...getDailySlice(SP500,SLICE,0),
    ...getDailySlice(ADR_LIST,Math.min(SLICE,ADR_LIST.length),1),
    ...getDailySlice(RUSSELL,SLICE,2),
  ])];

  console.log(`🔍 Daily scan STARTING: ${symbols.length} symbols at ${startTime}`);

  const subs=await getSubscriptions();
  console.log(`Push subscribers: ${subs.length}`);

  // Notify scan is starting
  if(subs.length>0){
    await sendPushToAll(subs,{
      title:'🔍 Hooks Screener',
      body:`Daily scan starting — checking ${symbols.length} stocks…`,
      tag:'scan-start',requireInteraction:false,
    });
  }

  const qualified=[];
  for(const sym of symbols){
    try{
      const[metric,profile]=await Promise.all([
        finnhub('/stock/metric',{symbol:sym,metric:'all'},key),
        finnhub('/stock/profile2',{symbol:sym},key),
      ]);
      if(!profile?.ticker)continue;
      if(passesPhase1(metric))qualified.push(sym);
    }catch(e){console.warn(`Error ${sym}:`,e.message);}
    await sleep(400);
  }

  const count=qualified.length;
  const message=count===0
    ?'No stocks qualified today — market may be near highs'
    :count===1?`${qualified[0]} — passed Phase 1`
    :count===2?`${qualified.join(', ')} — passed Phase 1`
    :`${count} stocks passed Phase 1 — open screener to review`;

  console.log(`✅ Daily scan COMPLETE: ${message}`);

  // Send completion notification
  if(subs.length>0){
    await sendPushToAll(subs,{
      title:count>0?'✅ Hooks Screener':'📊 Hooks Screener',
      body:message,
      tag:'scan-complete',
      requireInteraction:count>0,
      url:'/',
    });
  }

  // Store latest results in KV so app can retrieve on open
  await kv.set('last_scan_result',{
    date:startTime,completed:new Date().toISOString(),
    scanned:symbols.length,qualified,message,
  }).catch(()=>{});

  return res.status(200).json({
    date:startTime,completed:new Date().toISOString(),
    scanned:symbols.length,qualified,message,
  });
}
