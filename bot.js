'use strict';
/* FLINT — pump.fun paper bot, headless Node-versie (24/7 op een Mac of server).
   Feed: PumpPortal websocket. Alleen paper trading; geen wallet, geen keys.

   Simulatie v2 (realistischer):
   - fills lopen over de echte bonding-curve (prijsimpact van je eigen order)
   - vertraging tussen signaal en fill (standaard 0,3–0,9 s) tegen de prijs op dat moment
   - transacties kunnen mislukken (kost dan alleen de priority fee)
   - stale exits verkopen met een afslag, want een dode token verkoop je niet tegen de laatste prijs
   Dataset: elke gevolgde token wordt vastgelegd (features + prijspad + uitkomst) in data/tokens-*.jsonl,
   zodat je met `npm run analyze` kunt zien welke filters echt voorspellen. */
const fs = require('fs'), path = require('path'), http = require('http');
const WebSocket = require('ws');

// Optioneel .env (KEY=waarde per regel); echte omgevingsvariabelen gaan voor.
try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (!m || l.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* geen .env */ }
const FEED = (process.env.FEED || 'solana').toLowerCase();   // 'solana' (gratis, on-chain) of 'pumpportal' (trades vereisen betaalde key)
const RPC_WSS = process.env.RPC_WSS || 'wss://api.mainnet-beta.solana.com';

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SIM_VERSION = 2;
const SNAPS = [5, 10, 15, 20, 30, 45, 60];   // seconden na creatie waarop features worden vastgelegd
const STEP_MS = 2000;                        // resolutie van het prijspad
const MAX_TRACKED = 600;

const DEF = {
  start: 5, size: 0.25, maxOpen: 4, reserve: 0.5,
  minAge: 8, maxAge: 60, minBuyers: 6, minVol: 1.5, ratio: 2.5, minMcap: 25, maxMcap: 60, maxRun: 60,
  tp: 12, sl: 8, trailStart: 8, trail: 5, maxHold: 90, stale: 25,
  feePct: 1.25, slip: 1, prio: 0.0008, dailyLoss: 0.8,
  latMin: 300, latMax: 900, failBuy: 8, failSell: 5, staleHaircut: 15,
  logTokens: 1, logMinBuyers: 3, logHorizon: 180, keepDays: 10,
  // Optionele filters op wallet-/bundelsignalen (uit = 100 / 0 / 99 / 0); zie README
  maxSniperShare: 100, minOrganic: 0, maxDevRugs: 99, minSmart: 0
};

const fresh = () => ({
  simVersion: SIM_VERSION, cfg: { ...DEF }, bal: DEF.start, pos: {}, hist: [], fees: 0, eqHist: [DEF.start], peakEq: DEF.start,
  dayKey: '', dayPnl: 0, running: true, startedAt: Date.now(), totalTrades: 0, failed: 0, logSaved: 0, logSkipped: 0
});
let S = fresh();
const T = new Map();
const LOGS = [];
let solFeed = null, feedStart = 0, lastTradeAt = 0, nFeedTrades = 0, tradeTimes = [];
let dirty = false, ws = null, connected = false, backoff = 1000, lastMsg = Date.now(), nPending = 0, dataBytes = 0;
const tokenBuf = [], tradeBuf = [];

function log(m) {
  const line = `${new Date().toISOString()} ${m}`;
  LOGS.unshift(line); if (LOGS.length > 200) LOGS.pop();
  console.log(line);
}
function load() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j.simVersion !== SIM_VERSION) {
      fs.renameSync(STATE_FILE, path.join(DATA_DIR, 'state.v1.json'));
      log('Simulatie v2: oude paper-account gearchiveerd (state.v1.json), nieuwe account gestart met realistischere fills.');
    } else { S = { ...fresh(), ...j }; S.cfg = { ...DEF, ...S.cfg }; }
  } catch { /* eerste start */ }
  for (const p of Object.values(S.pos)) { p.vSol = p.vSol || 30; p.vTok = p.vTok || 30 / p.last; p.selling = false; }
}
const save = () => { dirty = true; };
function flush() {
  if (!dirty) return; dirty = false;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(S));
  fs.renameSync(tmp, STATE_FILE);
}

/* ---------- wallet- en makerregister ----------
   Leert uit de afgeronde tokens (alleen verleden, dus geen vooruitkijken):
   - maker: hoeveel tokens eerder gelanceerd en hoeveel daarvan de maker zelf dumpte (devRugs)
   - wallet: vroege kopers (eerste 30 s) van tokens die later minstens verdubbelden ("slimme wallets") */
const WALLET_FILE = path.join(DATA_DIR, 'wallets.json');
const SNIPE_SLOTS = 2;                                     // kopen binnen 2 slots (~1 s) na de creatie = sniper/bundel
const WIN_MULT = 2, SMART_MIN_N = 3, SMART_MIN_RATE = 0.34;  // token "wint" bij 2x mcap; slim = ≥3 vroege plekken en ≥34% winnaars
const EARLY_SECS = 30, EARLY_MAX = 20, CAP_CREATORS = 50000, CAP_WALLETS = 150000;
const REG = { creators: new Map(), wallets: new Map() };   // id → [aantal, rugs|winnaars, laatst gezien]
let regDirty = false;
const wid = k => String(k || '').slice(0, 12);
const isSmart = w => { const r = REG.wallets.get(wid(w)); return !!r && r[0] >= SMART_MIN_N && r[1] / r[0] >= SMART_MIN_RATE; };
function registryUpdate(t) {
  if (t.regDone) return; t.regDone = true;
  const now = Date.now(), win = t.m0 > 0 && t.peak >= t.m0 * WIN_MULT;
  const cr = REG.creators.get(wid(t.creator)); if (cr && t.devSold) { cr[1]++; cr[2] = now; }
  for (const w of t.early) {
    const k = wid(w), r = REG.wallets.get(k) || [0, 0, 0];
    r[0]++; if (win) r[1]++; r[2] = now; REG.wallets.set(k, r);
  }
  regDirty = true;
}
function loadRegistry() {
  try {
    const j = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
    for (const [k, ...v] of j.c || []) REG.creators.set(k, v); for (const [k, ...v] of j.w || []) REG.wallets.set(k, v);
  } catch { /* eerste start */ }
}
function saveRegistry() {
  if (!regDirty) return; regDirty = false;
  const trim = (m, cap) => { if (m.size > cap) for (const [k] of [...m].sort((a, b) => a[1][2] - b[1][2]).slice(0, m.size - Math.floor(cap * 0.8))) m.delete(k); };
  trim(REG.creators, CAP_CREATORS); trim(REG.wallets, CAP_WALLETS);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = WALLET_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ c: [...REG.creators].map(([k, v]) => [k, ...v]), w: [...REG.wallets].map(([k, v]) => [k, ...v]) }));
    fs.renameSync(tmp, WALLET_FILE);
  } catch (e) { log('register schrijven mislukt: ' + e.message); }
}

/* ---------- datalogging ---------- */
function flushData() {
  if (!tokenBuf.length && !tradeBuf.length) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const byDay = {};
    for (const { day, line } of tokenBuf.splice(0)) (byDay[day] = byDay[day] || []).push(line);
    for (const [day, lines] of Object.entries(byDay)) {
      const txt = lines.join('\n') + '\n'; dataBytes += Buffer.byteLength(txt);
      fs.appendFileSync(path.join(DATA_DIR, `tokens-${day}.jsonl`), txt);
    }
    if (tradeBuf.length) {
      const txt = tradeBuf.splice(0).join('\n') + '\n'; dataBytes += Buffer.byteLength(txt);
      fs.appendFileSync(path.join(DATA_DIR, 'trades.jsonl'), txt);
    }
  } catch (e) { log('data schrijven mislukt: ' + e.message); }
}
function pruneData() {
  try {
    const limit = Date.now() - S.cfg.keepDays * 864e5; let total = 0;
    for (const f of fs.readdirSync(DATA_DIR)) {
      const full = path.join(DATA_DIR, f), m = f.match(/^tokens-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m && Date.parse(m[1]) < limit) { fs.unlinkSync(full); continue; }
      if (/\.jsonl$/.test(f)) total += fs.statSync(full).size;
    }
    dataBytes = total;
  } catch { /* map bestaat nog niet */ }
}
const r1 = n => Math.round(n * 10) / 10, r2 = n => Math.round(n * 100) / 100;

/* Features van een token op dit moment — dezelfde set voor snapshots, trades en analyse. */
function feats(t) {
  const now = Date.now(); let b10 = 0, s10 = 0;
  for (const x of t.recent) if (now - x.ts <= 10000) { if (x.b) b10 += x.sol; else s10 += x.sol; }
  let top = 0; for (const v of t.buyBy.values()) if (v > top) top = v;
  let smart = 0; for (const b of t.buyers) if (isSmart(b)) smart++;
  return {
    age: r1((now - t.t0) / 1000), buyers: t.buyers.size, sellers: t.sellers.size, buyVol: r2(t.buyVol), sellVol: r2(t.sellVol),
    nBuys: t.nBuys, nSells: t.nSells, ratio: r2(Math.min(99, t.buyVol / (t.sellVol + 0.01))), mcap: r1(t.mcap),
    run: r1((t.p / t.p0 - 1) * 100), devSold: t.devSold ? 1 : 0, devBuy: r2(t.devBuy),
    topShare: t.buyVol ? r2(top / t.buyVol) : 0, buys10: r2(b10), sells10: r2(s10), mom: r2(b10 - s10),
    snipers: t.snipers.size, sniperShare: t.buyVol ? r2(t.sniperVol / t.buyVol) : 0, organic: t.buyers.size - t.snipers.size,
    devN: t.devN, devRugs: t.devRugs, smart
  };
}
function finalize(t) {
  registryUpdate(t);
  const c = S.cfg; if (!c.logTokens) return;
  if (t.buyers.size < c.logMinBuyers && !t.traded) { S.logSkipped++; return; }
  const rec = { id: t.m, sym: t.sym, t0: t.t0, vSol0: r2(t.v0 || 0), devBuy: r2(t.devBuy), step: STEP_MS / 1000, snaps: t.snaps, path: t.path,
    peak: r1(t.peak), peakAge: r1(t.peakAge || 0), devSoldAt: t.devSoldAt, final: feats(t), trade: t.trade || null };
  tokenBuf.push({ day: new Date(t.t0).toISOString().slice(0, 10), line: JSON.stringify(rec) });
  S.logSaved++; save();
}

/* ---------- executor: echte bonding-curve (constant product) ---------- */
const curve = {
  buy(vSol, vTok, size, c, feePct = c.feePct) {
    const fee = size * feePct / 100, net = size - fee;
    const out = (vTok - (vSol * vTok) / (vSol + net)) * (1 - c.slip / 100);
    return { tokens: out, fee, prio: c.prio, cost: size + c.prio, fill: net / out };
  },
  sell(vSol, vTok, tokens, c, haircut = 0, feePct = c.feePct) {
    const gross = (vSol - (vSol * vTok) / (vTok + tokens)) * (1 - c.slip / 100) * (1 - haircut / 100);
    const fee = gross * feePct / 100;
    return { fee, prio: c.prio, proceeds: gross - fee - c.prio };
  }
};
const lat = () => { const c = S.cfg; return c.latMax <= 0 ? 0 : c.latMin + Math.random() * (c.latMax - c.latMin); };
const schedule = (fn, ms) => {
  if (ms <= 0) return fn();
  setTimeout(() => { try { fn(); } catch (e) { log('fout in order: ' + e.message); } }, ms);
};

/* ---------- feed ---------- */
const send = o => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
const sub = m => { if (FEED === 'pumpportal') send({ method: 'subscribeTokenTrade', keys: [m] }); };
const unsub = m => { if (FEED === 'pumpportal') send({ method: 'unsubscribeTokenTrade', keys: [m] }); };
const price = d => (d.vSolInBondingCurve && d.vTokensInBondingCurve) ? d.vSolInBondingCurve / d.vTokensInBondingCurve : null;

function newTok(m, sym, creator, p, mcap, vSol, vTok, t0, devBuy) {
  return { m, sym, t0, creator, p0: p, p, vSol, vTok, v0: vSol, feePct: null, mcap, peak: mcap, peakAge: 0, buyers: new Set(), sellers: new Set(), buyBy: new Map(),
    recent: [], buyVol: 0, sellVol: 0, nTrades: 0, nBuys: 0, nSells: 0, devSold: false, devSoldAt: null, devBuy: devBuy || 0,
    last: Date.now(), path: [], snaps: [], snapIdx: 0, traded: false, pendingBuy: false, trade: null,
    m0: mcap, slot0: null, snipers: new Set(), sniperVol: 0, early: new Set(), devN: 0, devRugs: 0, regDone: false };
}

function connectSolana() {
  // Open posities moeten ook na een herstart gevolgd worden; de Solana-feed kent alleen tokens die hij zelf ziet,
  // dus die worden bij het eerstvolgende trade-event niet herkend: ze sluiten via de stale-timeout.
  for (const [m, p] of Object.entries(S.pos)) if (!T.has(m)) T.set(m, newTok(m, p.sym, p.creator, p.last, p.entryMcap || 0, p.vSol, p.vTok, p.t0, 0));
  feedStart = Date.now(); lastMsg = Date.now();
  solFeed = require('./feed-solana.js').start({
    url: RPC_WSS, log,
    onStatus: ok => { connected = ok; if (ok) lastMsg = Date.now(); },
    onMessage: m => { lastMsg = Date.now(); try { handle(m); } catch (e) { log('fout in handle: ' + e.message); } }
  });
}

function connect() {
  if (FEED !== 'pumpportal') return connectSolana();
  ws = new WebSocket('wss://pumpportal.fun/api/data' + (process.env.PUMPPORTAL_API_KEY ? '?api-key=' + encodeURIComponent(process.env.PUMPPORTAL_API_KEY) : ''));
  ws.on('open', () => {
    connected = true; backoff = 1000; lastMsg = Date.now();
    send({ method: 'subscribeNewToken' });
    for (const [m, p] of Object.entries(S.pos)) {
      if (!T.has(m)) T.set(m, newTok(m, p.sym, p.creator, p.last, p.entryMcap || 0, p.vSol, p.vTok, p.t0, 0));
    }
    if (T.size) send({ method: 'subscribeTokenTrade', keys: [...T.keys()] });
    log('feed verbonden');
  });
  ws.on('message', buf => {
    lastMsg = Date.now();
    let d; try { d = JSON.parse(buf.toString()); } catch { return; }
    try { handle(d); } catch (e) { log('fout in handle: ' + e.message); }
  });
  ws.on('close', () => {
    if (connected) log('feed verbroken, herverbinden…');
    connected = false;
    setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000);
  });
  ws.on('error', e => log('ws fout: ' + e.message));
}

function evictOldest() {
  for (const [m, t] of T) if (!S.pos[m] && !t.pendingBuy) { finalize(t); T.delete(m); unsub(m); return; }
}

function handle(d) {
  if (!d || !d.mint) return;
  if (d.txType === 'create') {
    const p = price(d); if (!p || T.has(d.mint)) return;
    if (T.size >= MAX_TRACKED) evictOldest();
    // Tokennamen zijn door gebruikers gekozen en dus onbetrouwbaar: alleen veilige tekens, kort.
    const sym = String(d.symbol || '').replace(/[^\p{L}\p{N}$._-]/gu, '').slice(0, 14) || String(d.mint).slice(0, 5);
    const t = newTok(d.mint, sym, d.traderPublicKey, p, d.marketCapSol || 0, d.vSolInBondingCurve, d.vTokensInBondingCurve, Date.now(), d.solAmount);
    const ck = wid(d.traderPublicKey), cr = REG.creators.get(ck) || [0, 0, 0];
    t.slot0 = d.slot != null ? d.slot : null; t.devN = cr[0]; t.devRugs = cr[1];
    REG.creators.set(ck, [cr[0] + 1, cr[1], Date.now()]); regDirty = true;
    T.set(d.mint, t);
    sub(d.mint); return;
  }
  const t = T.get(d.mint); if (!t) return;
  const now = Date.now(), p = price(d);
  if (p) { t.p = p; t.vSol = d.vSolInBondingCurve; t.vTok = d.vTokensInBondingCurve; }
  // Echt tarief uit het trade-event (laatste niet-nul; vrijgestelde wallets betalen 0 en zeggen niets over ons tarief).
  if (d.feeBps > 0) t.feePct = d.feeBps / 100;
  if (d.marketCapSol) t.mcap = d.marketCapSol;
  if (t.mcap > t.peak) { t.peak = t.mcap; t.peakAge = (now - t.t0) / 1000; }
  t.last = now; t.nTrades++;
  const sol = d.solAmount || 0, who = d.traderPublicKey;
  if (d.txType === 'buy' || d.txType === 'sell') { lastTradeAt = now; nFeedTrades++; tradeTimes.push(now); }
  if (d.txType === 'buy' && who === t.creator && now - t.t0 < 3000) {
    t.devBuy += sol; // eerste koop van de maker in dezelfde transactie: geen onafhankelijke koper
  } else if (d.txType === 'buy') {
    t.nBuys++; t.buyVol += sol; t.buyers.add(who); t.buyBy.set(who, (t.buyBy.get(who) || 0) + sol);
    if (t.slot0 != null && d.slot != null && d.slot - t.slot0 <= SNIPE_SLOTS) { t.snipers.add(who); t.sniperVol += sol; }
    if (t.early.size < EARLY_MAX && now - t.t0 <= EARLY_SECS * 1000) t.early.add(who);
    t.recent.push({ ts: now, sol, b: 1 });
  } else if (d.txType === 'sell') {
    t.nSells++; t.sellVol += sol; t.sellers.add(who); t.recent.push({ ts: now, sol, b: 0 });
    if (who === t.creator && !t.devSold) { t.devSold = true; t.devSoldAt = r1((now - t.t0) / 1000); }
  }
  while (t.recent.length && now - t.recent[0].ts > 15000) t.recent.shift();
  const pos = S.pos[d.mint];
  if (pos) {
    pos.last = t.p; pos.vSol = t.vSol; pos.vTok = t.vTok; pos.peak = Math.max(pos.peak, t.p); pos.low = Math.min(pos.low || t.p, t.p);
    if (!pos.selling) { if (t.devSold) return close(d.mint, 'dev sold'); checkExit(d.mint, pos); }
  } else if (S.running) checkEntry(t);
}

/* ---------- strategie ---------- */
function dayReset() { const k = new Date().toDateString(); if (S.dayKey !== k) { S.dayKey = k; S.dayPnl = 0; } }
/* Eén bron van waarheid: dezelfde filters sturen de bot én het dashboard. */
function evaluate(t) {
  const c = S.cfg, age = (Date.now() - t.t0) / 1000;
  const ratio = Math.min(99, t.buyVol / (t.sellVol + 0.01)), run = (t.p / t.p0 - 1) * 100;
  const checks = [
    { k: 'age', label: 'LEEFT', ok: age >= c.minAge && age <= c.maxAge, wait: age < c.minAge, disp: `${Math.floor(age)}s`, need: `${c.minAge}–${c.maxAge}s` },
    { k: 'buyers', label: 'KOPERS', ok: t.buyers.size >= c.minBuyers, disp: `${t.buyers.size}`, need: `≥${c.minBuyers}` },
    { k: 'vol', label: 'VOL', ok: t.buyVol >= c.minVol, disp: t.buyVol.toFixed(1), need: `≥${c.minVol}` },
    { k: 'ratio', label: 'RATIO', ok: ratio >= c.ratio, disp: ratio >= 99 ? '∞' : ratio.toFixed(1), need: `≥${c.ratio}` },
    { k: 'mcap', label: 'MCAP', ok: t.mcap >= c.minMcap && t.mcap <= c.maxMcap, disp: t.mcap.toFixed(0), need: `${c.minMcap}–${c.maxMcap}` },
    { k: 'run', label: 'RUN', ok: run <= c.maxRun, disp: `${run >= 0 ? '+' : ''}${run.toFixed(0)}%`, need: `≤${c.maxRun}%` },
    { k: 'dev', label: 'DEV', ok: !t.devSold, disp: t.devSold ? 'SOLD' : 'OK', need: 'clean' }
  ];
  // Optioneel (standaard uit): wallet-/bundelsignalen. Zonder slot-data (PumpPortal) kan de sniper-check niets zien.
  if (c.maxSniperShare < 100) { const sh = t.buyVol ? t.sniperVol / t.buyVol * 100 : 0; checks.push({ k: 'snipe', label: 'SNIPERS', ok: sh <= c.maxSniperShare, disp: `${sh.toFixed(0)}%`, need: `≤${c.maxSniperShare}%` }); }
  if (c.minOrganic > 0) { const og = t.buyers.size - t.snipers.size; checks.push({ k: 'organic', label: 'ORGANISCH', ok: og >= c.minOrganic, disp: `${og}`, need: `≥${c.minOrganic}` }); }
  if (c.maxDevRugs < 99) checks.push({ k: 'devhist', label: 'MAKER', ok: t.devRugs <= c.maxDevRugs, disp: `${t.devRugs}/${t.devN}`, need: `rugs ≤${c.maxDevRugs}` });
  if (c.minSmart > 0) { let n = 0; for (const b of t.buyers) if (isSmart(b)) n++; checks.push({ k: 'smart', label: 'SLIM', ok: n >= c.minSmart, disp: `${n}`, need: `≥${c.minSmart}` }); }
  return { age, checks, dead: age > c.maxAge || t.devSold };
}
function blocker() {
  const c = S.cfg; dayReset();
  if (!S.running) return 'bot gepauzeerd';
  if (S.dayPnl <= -c.dailyLoss) return 'daglimiet verlies bereikt';
  if (Object.keys(S.pos).length + nPending >= c.maxOpen) return 'max open posities bereikt';
  if (S.bal - nPending * c.size < c.size + c.reserve) return 'onvoldoende vrije balans';
  return null;
}
function checkEntry(t) {
  if (t.traded || t.pendingBuy || blocker()) return;
  if (evaluate(t).checks.every(x => x.ok)) open(t);
}
/* Signaal -> order -> (vertraging) -> fill tegen de prijs op dat moment. */
function open(t) {
  const feat = feats(t);
  t.pendingBuy = true; nPending++;
  schedule(() => fillBuy(t.m, feat), lat());
}
function fillBuy(m, feat) {
  nPending = Math.max(0, nPending - 1);
  const t = T.get(m); if (!t) return;
  t.pendingBuy = false;
  const c = S.cfg;
  if (Math.random() * 100 < c.failBuy) {
    S.bal -= c.prio; S.fees += c.prio; S.failed++;
    log(`KOOP MISLUKT ${t.sym} (-${c.prio} SOL fee)`); save(); return;
  }
  if (S.bal < c.size + c.prio) return;
  const feePct = t.feePct != null ? t.feePct : c.feePct;
  const r = curve.buy(t.vSol, t.vTok, c.size, c, feePct);
  S.bal -= r.cost; S.fees += r.fee + r.prio; t.traded = true;
  S.pos[m] = { m, sym: t.sym, creator: t.creator, entry: r.fill, tokens: r.tokens, cost: r.cost, t0: Date.now(), last: t.p, peak: t.p, low: t.p,
    vSol: t.vSol, vTok: t.vTok, feePct, feat, entryMcap: t.mcap, selling: false };
  log(`KOOP ${t.sym} mcap ${t.mcap.toFixed(1)} (${t.buyers.size} kopers, ${t.buyVol.toFixed(1)} SOL)`);
  save();
}
function checkExit(m, pos) {
  const c = S.cfg, g = (pos.last / pos.entry - 1) * 100, pk = (pos.peak / pos.entry - 1) * 100;
  if (g >= c.tp) return close(m, 'TP');
  if (g <= -c.sl) return close(m, 'SL');
  if (pk >= c.trailStart && pos.last <= pos.peak * (1 - c.trail / 100)) return close(m, 'trail');
}
function close(m, why) {
  const pos = S.pos[m]; if (!pos || pos.selling) return;
  pos.selling = true;
  schedule(() => fillSell(m, why, 0), lat());
}
function fillSell(m, why, attempt) {
  const pos = S.pos[m]; if (!pos) return;
  const c = S.cfg;
  if (Math.random() * 100 < c.failSell) {
    S.bal -= c.prio; S.fees += c.prio; S.failed++;
    if (attempt < 2) { log(`VERKOOP MISLUKT ${pos.sym}, opnieuw (${attempt + 1}/2)`); return schedule(() => fillSell(m, why, attempt + 1), lat()); }
    log(`VERKOOP MISLUKT ${pos.sym}, later opnieuw`); pos.selling = false; return;
  }
  const t0 = T.get(m), feePct = t0 && t0.feePct != null ? t0.feePct : pos.feePct;
  const r = curve.sell(pos.vSol, pos.vTok, pos.tokens, c, why === 'stale' ? c.staleHaircut : 0, feePct);
  const pnl = r.proceeds - pos.cost;
  S.bal += r.proceeds; S.fees += r.fee + r.prio; dayReset(); S.dayPnl += pnl; S.totalTrades++;
  const t = T.get(m);
  const rec = { sym: pos.sym, pnl, pct: pnl / pos.cost * 100, why, dur: (Date.now() - pos.t0) / 1000, t: Date.now(), feat: pos.feat,
    peakPct: (pos.peak / pos.entry - 1) * 100, lowPct: ((pos.low || pos.last) / pos.entry - 1) * 100, entryMcap: pos.entryMcap, exitMcap: t ? t.mcap : null };
  S.hist.unshift(rec); if (S.hist.length > 500) S.hist.pop();
  tradeBuf.push(JSON.stringify({ id: m, ...rec }));
  if (t) t.trade = { pnl: +pnl.toFixed(4), pct: r1(rec.pct), why, peakPct: r1(rec.peakPct), lowPct: r1(rec.lowPct), dur: r1(rec.dur) };
  delete S.pos[m];                // token blijft in T zodat het prijspad t/m de horizon wordt vastgelegd
  log(`${pnl >= 0 ? 'WIN' : 'LOSS'} ${pos.sym} ${pnl.toFixed(4)} SOL (${why})`);
  const eq = equity(); S.eqHist.push(eq); if (S.eqHist.length > 1000) S.eqHist.shift(); S.peakEq = Math.max(S.peakEq, eq);
  save();
}
const equity = () => {
  let v = S.bal;
  for (const p of Object.values(S.pos)) v += curve.sell(p.vSol, p.vTok, p.tokens, S.cfg, 0, p.feePct != null ? p.feePct : S.cfg.feePct).proceeds;
  return v;
};

function tick() {
  const now = Date.now(), c = S.cfg, hor = (c.logTokens ? c.logHorizon : c.maxAge + 30) * 1000;
  for (const [m, p] of Object.entries(S.pos)) {
    if (p.selling) continue;
    const t = T.get(m);
    if ((now - p.t0) / 1000 > c.maxHold) close(m, 'max tijd');
    else if (t && (now - t.last) / 1000 > c.stale) close(m, 'stale');
  }
  for (const [m, t] of T) {
    const age = now - t.t0;
    if (c.logTokens && age <= hor) {
      for (let idx = Math.floor(age / STEP_MS); t.path.length <= idx;) t.path.push(r1(t.mcap));
      while (t.snapIdx < SNAPS.length && age / 1000 >= SNAPS[t.snapIdx]) { t.snaps.push(feats(t)); t.snapIdx++; }
    }
    if (!S.pos[m] && !t.pendingBuy && age > hor) { finalize(t); T.delete(m); unsub(m); }
  }
  while (tradeTimes.length && now - tradeTimes[0] > 60000) tradeTimes.shift();
  if (connected && now - lastMsg > 60000) {
    log('feed stil, herverbinden');
    if (solFeed) solFeed.restart(); else try { ws.terminate(); } catch { /* */ }
  }
}

/* ---------- statistieken + API ---------- */
function stats() {
  const h = S.hist, w = h.filter(x => x.pnl > 0);
  const gw = w.reduce((a, x) => a + x.pnl, 0), gl = -h.filter(x => x.pnl <= 0).reduce((a, x) => a + x.pnl, 0);
  const eq = equity();
  return { n: S.totalTrades, wr: h.length ? w.length / h.length * 100 : 0, pf: gl ? gw / gl : (gw ? 99 : 0),
    pnl: eq - S.cfg.start, eq, dd: S.peakEq ? Math.max(0, (S.peakEq - eq) / S.peakEq * 100) : 0 };
}
function radar() {
  const rows = [], win = (S.cfg.maxAge + 30) * 1000, now = Date.now();
  for (const t of T.values()) {
    if (S.pos[t.m] || t.traded || t.pendingBuy || now - t.t0 > win) continue;
    const ev = evaluate(t), passed = ev.checks.filter(x => x.ok).length;
    rows.push({ m: t.m, sym: t.sym, age: ev.age, mcap: t.mcap, checks: ev.checks, passed, total: ev.checks.length,
      ready: passed === ev.checks.length, dead: ev.dead });
  }
  const funnel = (rows[0] ? rows[0].checks : evaluate(newTok('x', 'x', 'x', 1, 0, 30, 1e9, Date.now(), 0)).checks)
    .map((c, i) => ({ k: c.k, label: c.label, need: c.need, ok: rows.filter(r => r.checks[i].ok).length, total: rows.length }));
  rows.sort((a, b) => (a.dead - b.dead) || (b.passed - a.passed) || (a.age - b.age));
  return { tokens: rows.slice(0, 60), funnel, trackedTotal: rows.length, readyCount: rows.filter(r => r.ready).length };
}
function feedInfo() {
  const now = Date.now(), noTrades = !process.env.DEMO && connected && T.size >= 3 && now - feedStart > 25000 && now - lastTradeAt > 30000;
  const warn = noTrades ? (FEED === 'pumpportal'
      ? 'Geen trade-data ontvangen. PumpPortal levert trades alleen met een betaalde API-key (PUMPPORTAL_API_KEY in .env) — of zet FEED=solana.'
      : 'Geen trade-data ontvangen via de Solana-feed. Gebruik een betere RPC_WSS in .env (bijv. een gratis Helius/QuickNode-endpoint).')
    : '';
  return { kind: process.env.DEMO ? 'demo' : FEED, tps: r1(tradeTimes.length / 60), trades: nFeedTrades, warn,
    decodeErr: solFeed ? solFeed.stats.decodeErrors : 0 };
}
const state = () => ({
  feed: feedInfo(),
  connected, running: S.running, bal: S.bal, fees: S.fees, stats: stats(), cfg: S.cfg, def: DEF,
  startedAt: S.startedAt, tracked: T.size, dayPnl: S.dayPnl, blocked: blocker(), demo: !!process.env.DEMO,
  failed: S.failed, data: { on: !!S.cfg.logTokens, saved: S.logSaved, skipped: S.logSkipped, bytes: dataBytes },
  ...radar(),
  pos: Object.values(S.pos), hist: S.hist.slice(0, 50), eqHist: S.eqHist, logs: LOGS.slice(0, 80)
});

function readBody(req, cb) {
  let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch { cb(null); } });
}
const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (req.method === 'GET') {
    if (u === '/' || u === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:"
      });
      return res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html')));
    }
    if (u === '/api/state') return json(res, state());
    if (u === '/api/trades.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=flint-trades.csv' });
      const head = 'token,pnl_sol,pct,reden,duur_s,tijd,peak_pct,low_pct,entry_mcap,buyers,buyVol,ratio,topShare,mom';
      return res.end(head + '\n' + S.hist.map(x => { const f = x.feat || {};
        return [x.sym, x.pnl, x.pct, x.why, x.dur, new Date(x.t).toISOString(), x.peakPct, x.lowPct, x.entryMcap, f.buyers, f.buyVol, f.ratio, f.topShare, f.mom].join(','); }).join('\n'));
    }
    return json(res, { error: 'niet gevonden' }, 404);
  }
  if (req.method === 'POST') {
    // Alleen JSON: voorkomt dat een willekeurige website blind naar localhost kan posten (CORS-preflight).
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, { error: 'content-type' }, 415);
    return readBody(req, body => {
      if (!body) return json(res, { error: 'ongeldige JSON' }, 400);
      if (u === '/api/cfg') {
        for (const [k, v] of Object.entries(body)) if (k in DEF && Number.isFinite(+v)) S.cfg[k] = +v;
        save(); return json(res, { ok: true });
      }
      if (u === '/api/run') { S.running = !!body.running; log(S.running ? 'bot gestart' : 'bot gepauzeerd'); save(); return json(res, { ok: true }); }
      if (u === '/api/close') { close(String(body.mint), 'handmatig'); return json(res, { ok: true }); }
      if (u === '/api/reset' && body.confirm === true) {
        for (const m of T.keys()) unsub(m);
        T.clear(); nPending = 0; S = fresh(); save(); flush(); log('reset'); return json(res, { ok: true });
      }
      return json(res, { error: 'niet gevonden' }, 404);
    });
  }
  json(res, { error: 'methode' }, 405);
});

function start() {
  load(); loadRegistry(); pruneData();
  server.listen(PORT, HOST, () => log(`dashboard: http://${HOST}:${PORT}`));
  if (process.env.DEMO) { connected = true; log('DEMO-modus: gesimuleerde tokens, geen echte feed'); require('./demo.js').start(handle); }
  else connect();
  setInterval(tick, 1000);
  setInterval(flush, 3000);
  setInterval(flushData, 5000);
  setInterval(saveRegistry, 60000);
  setInterval(pruneData, 3600000);
  setInterval(() => { S.eqHist.push(equity()); if (S.eqHist.length > 1000) S.eqHist.shift(); save(); }, 300000);
  const bye = () => { try { flush(); flushData(); saveRegistry(); } catch { /* */ } process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  process.on('uncaughtException', e => log('uncaught: ' + e.message));
  process.on('unhandledRejection', e => log('unhandled: ' + e));
}

if (require.main === module) start();
module.exports = { handle, tick, REG, registryUpdate, saveRegistry, loadRegistry, isSmart, evaluate, close, checkEntry, finalize, flushData, getS: () => S, T, DEF, DATA_DIR };
