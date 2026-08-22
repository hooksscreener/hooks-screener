/**
 * Hooks Screener — Daily Automated Scan with Smart Watchlist
 * Runs at 9:00 AM ET (14:00 UTC) every weekday via Vercel cron.
 * 
 * Tiered notification funnel:
 * 1. Phase 1 + 2 pass → silent auto-add to monitoring list
 * 2. Approaching dip range → notify
 * 3. Phase 1+2+3 pass → notify (setup forming)
 * 4. P1+P2+P3 + RSI crossing 40 + MACD positive → FULL TRIGGER notify
 * TTM Squeeze = bonus context, not required for full trigger
 */

import webpush from 'web-push';
import { kv } from '@vercel/kv';

const KV_SUBS = 'push_subscriptions';
const KV_MONITOR = 'monitoring_list'; // stocks being tracked daily
const KV_LAST_SCAN = 'last_scan_result';

const SP500 = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","BRK.B","AVGO","TSLA","LLY","JPM","V","XOM","UNH","MA","COST","HD","PG","NFLX","JNJ","ABBV","BAC","CRM","WMT","KO","MRK","CVX","AMD","PEP","ADBE","TMO","ACN","LIN","MCD","CSCO","ABT","WFC","DHR","GE","DIS","TXN","VZ","IBM","INTU","NOW","PM","CAT","AMGN","NEE","CMCSA","UBER","ISRG","SPGI","RTX","UNP","LOW","HON","QCOM","AMAT","BKNG","ETN","PFE","T","COP","SYK","BLK","PGR","SCHW","LMT","TJX","BSX","ELV","VRTX","ADP","MDT","CB","MU","GILD","PANW","MMC","ADI","SBUX","REGN","PLD","ANET","KLAC","CI","BX","SO","DE","LRCX","MO","ZTS","SHW","WM","DUK","FI","ICE","BMY","CL","EQIX","NOC","SLB","APH","MCK","TT","CME","PNC","AON","ITW","MSI","USB","GD","CMG","EOG","TGT","FCX","NKE","WELL","COF","ECL","EMR","HCA","ORLY","CSX","AJG","CDNS","PSA","MAR","MCO","ROP","CARR","SNPS"];
const ADR_LIST = ["TSM","SKHY","ASML","SAP","TM","SONY","BABA","SE","MELI","SPOT","NVO","SHOP","ARM","BIDU","JD","PDD","GRAB","RIO","BHP","BTI","DEO","UL","AZN","SHEL","BP","GSK","SAN","ING","PHG","ERIC","NOK","STM","ABB","NOVN","ROG","NESN","MFG","SMFG","NMR","KB","SHG","WF","LFC","ZNH","CEA","CHT","ASX","WDS","NAB","HTHT","IQ","TAL","EDU","VNET","CAN","FUTU","TIGR","BOSS","MBG","BMW","SIEGY","BASFY","BAYRY","RHHBY","LVMUY","CFRUY","PPRUY","EONGY","ENLAY","IBDRY"];
const RUSSELL = ["IRDM","BKE","PWP","EVER","ORN","RCAT","AAOI","IONQ","ACHR","JOBY","LILM","SPCE","ASTR","RDW","MNTS","BKSY","ASTS","SATL","KTOS","AVAV","RKLB","MNKD","SMCI","NTNX","CRDO","AEHR","FORM","NTCT","HLIT","VIAV","QLYS","VRNS","SAIL","S","SMAR","BRZE","BILL","GTLB","DDOG","ZS","CRWD","OKTA","TENB","ARLO","SWKS","MCHP","ENTG","COHU","ONTO","MKSI","ACMR","UCTT","CAMT","NVMI","ATRI","SLAB","WOLF","ERII","ARRY","HASI","NOVA","CLNE","BE","FCEL","PLUG","HYLN","BLNK","EVGO","CHPT","PTRA","WKHS","GOEV","ARVL","DKNG","PENN","RSI","GENI","SGHC","FLUT","EVEX","ACGL","KINSALE","RYAN","GSHD","JNPR","NTAP","PSTG","NXST","IPGP","NOVT","LSCC","ALGM","DIOD","LFUS","VICR"];

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

// Phase 1: fundamentals check
function passesPhase1(m){
  const mt=m?.metric||{};
  const op=mt.operatingProfitTTM||mt.ebitTTM||null;
  const eq=mt.totalEquityAnnual||null;
  const debt=mt.longTermDebtAnnual||mt.totalDebtAnnual||null;
  const ce=eq!==null&&debt!==null?eq+debt:null;
  const roce=ce&&ce>0&&op!==null?op/ce*100:mt.roeTTM||mt.roeRfy||null;
  const fcfT=mt.freeCashFlowTTM||null,mc=mt.marketCapitalization||null;
  const fcf=fcfT&&mc&&mc>0?fcfT/mc*100:mt.freeCashFlowPerShareTTM&&mt.lastClosePrice>0?mt.freeCashFlowPerShareTTM/mt.lastClosePrice*100:null;
  const de=mt['totalDebt/totalEquityAnnual']||mt['totalDebt/totalEquityQuarterly']||null;
  return(roce!==null&&roce>=15)||(fcf!==null&&fcf>=5)||(de!==null&&de<0.8);
}

// Phase 2: trend check (200D SMA slope)
function passesPhase2(closes){
  if(!closes||closes.length<220)return false;
  const n=closes.length;
  const sma=(p,e)=>{let s=0;for(let i=e-p+1;i<=e;i++)s+=closes[i];return s/p;};
  const s200=sma(200,n-1),s200p=sma(200,n-21);
  return s200>s200p;
}

// Phase 3: dip check + proximity
function evalPhase3(closes){
  if(!closes||closes.length<50)return{passes:false,draw:null,approaching:false};
  const n=closes.length;
  const cur=closes[n-1];
  const h52=Math.max(...closes.slice(-252));
  const draw=(h52-cur)/h52*100;
  const passes=draw>=8&&draw<=33;
  const approaching=draw>=5&&draw<8; // within 3% of entering range
  return{passes,draw:+draw.toFixed(1),approaching};
}

// Entry timing: RSI + MACD
function evalTiming(closes){
  if(!closes||closes.length<60)return{rsiCross:false,macdPos:false,rsi:null,macdH:null};
  const n=closes.length;
  const rp=14,hs=closes.slice(-rp*4);
  let g=0,l=0;
  for(let i=1;i<=Math.min(rp,hs.length-1);i++){const d=hs[i]-hs[i-1];d>=0?g+=d:l-=d;}
  let ag=g/rp,al=l/rp;
  for(let i=rp+1;i<hs.length;i++){const d=hs[i]-hs[i-1];ag=(ag*(rp-1)+(d>=0?d:0))/rp;al=(al*(rp-1)+(d<0?-d:0))/rp;}
  const rsi=al===0?100:100-100/(1+ag/al);
  const ema=(d,p)=>{const k=2/(p+1);let v=d[0],o=[v];for(let i=1;i<d.length;i++){v=d[i]*k+v*(1-k);o.push(v);}return o;};
  const e12=ema(closes,12),e26=ema(closes,26),ml=e12.map((v,i)=>v-e26[i]),sl=ema(ml,9);
  const mh=ml[n-1]-sl[n-1],mhp=n>2?ml[n-2]-sl[n-2]:0;
  return{rsiCross:rsi>=40,macdPos:mh>0,macdCross:mhp<0&&mh>=0,rsi:+rsi.toFixed(1),macdH:+mh.toFixed(4)};
}

// TTM Squeeze status (bonus context)
function getTTMStatus(closes){
  if(!closes||closes.length<60)return'No data';
  const n=closes.length;
  const bbPer=20,bbMult=2,kcMult=1.5,atrPer=14;
  const bbMid=closes.slice(-bbPer).reduce((a,b)=>a+b,0)/bbPer;
  const bbStd=Math.sqrt(closes.slice(-bbPer).reduce((a,b)=>a+(b-bbMid)**2,0)/bbPer);
  const bbUp=bbMid+bbMult*bbStd,bbLo=bbMid-bbMult*bbStd;
  let atr=0;for(let i=n-atrPer;i<n;i++){if(i>0)atr+=Math.abs(closes[i]-closes[i-1]);}atr/=atrPer;
  const kcUp=bbMid+kcMult*atr,kcLo=bbMid-kcMult*atr;
  const squeezeOn=bbUp<kcUp&&bbLo>kcLo;
  const e12=closes.reduce((a,v,i,arr)=>{if(i===0)return[v];const k=2/13;return[...a,v*k+a[i-1]*(1-k)];},[]);
  const e26=closes.reduce((a,v,i,arr)=>{if(i===0)return[v];const k=2/27;return[...a,v*k+a[i-1]*(1-k)];},[]);
  const ml=e12.map((v,i)=>v-e26[i]);
  const sl=ml.reduce((a,v,i)=>{if(i===0)return[v];const k=2/10;return[...a,v*k+a[i-1]*(1-k)];},[]);
  const histPos=ml[n-1]-sl[n-1]>0;
  if(squeezeOn)return'TTM Squeeze (Coiling)';
  return histPos?'TTM Squeeze (Bullish)':'TTM Squeeze (Bearish)';
}

// KV helpers
async function getMonitoringList(){try{const m=await kv.get(KV_MONITOR);return Array.isArray(m)?m:[];}catch{return[];}}
async function saveMonitoringList(list){try{await kv.set(KV_MONITOR,list);}catch{}}
async function getSubscriptions(){try{const s=await kv.get(KV_SUBS);return Array.isArray(s)?s:[];}catch{return[];}}

async function sendPushToAll(subs,payload){
  const pub=process.env.VAPID_PUBLIC_KEY,priv=process.env.VAPID_PRIVATE_KEY;
  const subj=process.env.VAPID_SUBJECT||'mailto:support@hooks-screener.app';
  if(!pub||!priv){console.warn('VAPID keys not configured');return;}
  webpush.setVapidDetails(subj,pub,priv);
  const results=await Promise.allSettled(subs.map(sub=>webpush.sendNotification(sub,JSON.stringify(payload))));
  const expired=[];
  results.forEach((r,i)=>{if(r.status==='rejected'&&[404,410].includes(r.reason?.statusCode))expired.push(subs[i].endpoint);});
  if(expired.length>0){const fresh=subs.filter(s=>!expired.includes(s.endpoint));await kv.set(KV_SUBS,fresh).catch(()=>{});}
  console.log(`Push: ${results.filter(r=>r.status==='fulfilled').length}/${subs.length} delivered`);
}

export default async function handler(req,res){
  const key=process.env.FINNHUB_KEY;
  if(!key)return res.status(500).json({error:'FINNHUB_KEY not configured'});

  // Handle subscription requests
  if(req.query.action==='vapid-key')return res.status(200).json({publicKey:process.env.VAPID_PUBLIC_KEY||null});
  if(req.method==='POST'&&req.query.action==='subscribe'){
    const sub=req.body;if(!sub?.endpoint)return res.status(400).json({error:'Invalid subscription'});
    const subs=await getSubscriptions();
    if(!subs.find(s=>s.endpoint===sub.endpoint)){subs.push(sub);await kv.set(KV_SUBS,subs).catch(()=>{});}
    return res.status(201).json({success:true});
  }

  // ── CRON: Daily scan ──
  const SLICE=90;
  const todaySyms=[...new Set([...getDailySlice(SP500,SLICE,0),...getDailySlice(ADR_LIST,Math.min(SLICE,ADR_LIST.length),1),...getDailySlice(RUSSELL,SLICE,2)])];
  const subs=await getSubscriptions();
  const monitoring=await getMonitoringList();
  
  console.log(`🔍 Daily scan: ${todaySyms.length} universe + ${monitoring.length} monitored`);

  const fullTriggers=[],setupForming=[],approaching=[],newToMonitor=[];
  const keepMonitoring=[];

  // ── Phase 1 pre-filter on universe ──
  const phase1Pass=[];
  for(const sym of todaySyms){
    try{
      const[metric,profile]=await Promise.all([fh('/stock/metric',{symbol:sym,metric:'all'},key),fh('/stock/profile2',{symbol:sym},key)]);
      if(!profile?.ticker)continue;
      if(passesPhase1(metric))phase1Pass.push({sym,profile,metric});
    }catch(e){console.warn(`P1 error ${sym}:`,e.message);}
    await sleep(350);
  }

  // ── Full analysis on Phase 1 qualifiers ──
  for(const{sym,profile,metric}of phase1Pass){
    try{
      const closes=await getHistory(sym);
      if(!closes||closes.length<60)continue;
      const p2=passesPhase2(closes);
      if(!p2)continue; // need both P1+P2 to monitor
      // Auto-add to monitoring list
      if(!monitoring.includes(sym)&&!newToMonitor.includes(sym))newToMonitor.push(sym);
      keepMonitoring.push(sym);
      const p3=evalPhase3(closes);
      const timing=evalTiming(closes);
      const ttm=getTTMStatus(closes);
      // Determine notification tier
      if(p3.passes&&timing.rsiCross&&timing.macdPos){
        // FULL TRIGGER
        fullTriggers.push({sym,draw:p3.draw,rsi:timing.rsi,ttm});
      } else if(p3.passes){
        // Setup forming — in dip range but timing not confirmed
        setupForming.push({sym,draw:p3.draw,rsi:timing.rsi});
      } else if(p3.approaching){
        // Approaching dip range
        approaching.push({sym,draw:p3.draw});
      }
    }catch(e){console.warn(`Analysis error ${sym}:`,e.message);}
    await sleep(400);
  }

  // ── Check existing monitoring list stocks not in today's universe ──
  const notInToday=monitoring.filter(sym=>!todaySyms.includes(sym));
  for(const sym of notInToday){
    try{
      const[metric,profile]=await Promise.all([fh('/stock/metric',{symbol:sym,metric:'all'},key),fh('/stock/profile2',{symbol:sym},key)]);
      if(!profile?.ticker)continue;
      const p1=passesPhase1(metric);
      if(!p1){console.log(`${sym} removed from monitoring — failed Phase 1`);continue;}
      const closes=await getHistory(sym);
      if(!closes)continue;
      const p2=passesPhase2(closes);
      if(!p2){console.log(`${sym} removed from monitoring — failed Phase 2`);continue;}
      keepMonitoring.push(sym);
      const p3=evalPhase3(closes);
      const timing=evalTiming(closes);
      const ttm=getTTMStatus(closes);
      if(p3.passes&&timing.rsiCross&&timing.macdPos)fullTriggers.push({sym,draw:p3.draw,rsi:timing.rsi,ttm});
      else if(p3.passes)setupForming.push({sym,draw:p3.draw,rsi:timing.rsi});
      else if(p3.approaching)approaching.push({sym,draw:p3.draw});
    }catch(e){console.warn(`Monitor error ${sym}:`,e.message);}
    await sleep(400);
  }

  // Update monitoring list — keep only stocks still passing P1+P2
  const updatedMonitoring=[...new Set([...keepMonitoring])];
  await saveMonitoringList(updatedMonitoring);

  // ── Send tiered notifications ──
  if(subs.length>0){
    // Full triggers — highest priority
    for(const t of fullTriggers){
      const ttmNote=t.ttm!=='No data'?` · ${t.ttm}`:'';
      await sendPushToAll(subs,{
        title:`🚨 ${t.sym} — FULL TRIGGER`,
        body:`RSI pivot confirmed · MACD positive${ttmNote} · ${t.draw}% off high`,
        tag:`trigger-${t.sym}`,requireInteraction:true,url:'/',
      });
    }
    // Setup forming
    if(setupForming.length>0&&fullTriggers.length===0){
      const syms=setupForming.map(s=>s.sym).join(', ');
      await sendPushToAll(subs,{
        title:`⚡ Setup forming: ${setupForming.length===1?setupForming[0].sym:setupForming.length+' stocks'}`,
        body:`In dip range, watching for entry timing · Open screener to review`,
        tag:'setup-forming',requireInteraction:false,url:'/',
      });
    }
    // Approaching dip
    if(approaching.length>0&&fullTriggers.length===0&&setupForming.length===0){
      await sendPushToAll(subs,{
        title:`📊 ${approaching[0].sym} approaching dip range`,
        body:`${approaching[0].draw}% off high — enter range at 8%`,
        tag:'approaching',requireInteraction:false,url:'/',
      });
    }
  }

  const result={
    date:new Date().toISOString(),
    scanned:todaySyms.length,
    monitoring:updatedMonitoring.length,
    newToMonitor,
    fullTriggers:fullTriggers.map(t=>t.sym),
    setupForming:setupForming.map(s=>s.sym),
    approaching:approaching.map(a=>a.sym),
  };

  await kv.set(KV_LAST_SCAN,result).catch(()=>{});
  console.log('✅ Scan complete:',JSON.stringify(result));
  return res.status(200).json(result);
}