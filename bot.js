'use strict';
/* FLINT — pump.fun paper bot, headless Node-versie (24/7 op een Mac of server).
   Feed: PumpPortal websocket. Alleen paper trading; geen wallet, geen keys. */
const fs = require('fs'), path = require('path'), http = require('http');
const WebSocket = require('ws');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const DEF = {
  start: 5, size: 0.25, maxOpen: 4, reserve: 0.5,
  minAge: 8, maxAge: 60, minBuyers: 6, minVol: 1.5, ratio: 2.5, minMcap: 25, maxMcap: 60, maxRun: 60,
  tp: 12, sl: 8, trailStart: 8, trail: 5, maxHold: 90, stale: 25,
  feePct: 1, slip: 2, prio: 0.0008, dailyLoss: 0.8
};

const fresh = () => ({
  cfg: { ...DEF }, bal: DEF.start, pos: {}, hist: [], fees: 0, eqHist: [DEF.start], peakEq: DEF.start,
  dayKey: '', dayPnl: 0, running: true, startedAt: Date.now(), totalTrades: 0
});
let S = fresh();
const T = new Map();
const LOGS = [];
let dirty = false, ws = null, connected = false, backoff = 1000, lastMsg = Date.now();

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    S = { ...fresh(), ...j }; S.cfg = { ...DEF, ...S.cfg };
  } catch { /* eerste start */ }
}
const save = () => { dirty = true; };
function flush() {
  if (!dirty) return; dirty = false;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(S));
  fs.renameSync(tmp, STATE_FILE);
}
function log(m) {
  const line = `${new Date().toISOString()} ${m}`;
  LOGS.unshift(line); if (LOGS.length > 200) LOGS.pop();
  console.log(line);
}

/* ---------- executor ---------- */
const Exec = {
  buy(price, size, c) {
    const fee = size * c.feePct / 100, fill = price * (1 + c.slip / 100);
    return { tokens: (size - fee) / fill, fill, fee, prio: c.prio, cost: size + c.prio };
  },
  sell(price, tokens, c) {
    const fill = price * (1 - c.slip / 100), gross = tokens * fill, fee = gross * c.feePct / 100;
    return { fill, fee, prio: c.prio, proceeds: gross - fee - c.prio };
  }
};

/* ---------- feed ---------- */
const send = o => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
const sub = m => send({ method: 'subscribeTokenTrade', keys: [m] });
const unsub = m => send({ method: 'unsubscribeTokenTrade', keys: [m] });
const price = d => (d.vSolInBondingCurve && d.vTokensInBondingCurve) ? d.vSolInBondingCurve / d.vTokensInBondingCurve : null;

function connect() {
  ws = new WebSocket('wss://pumpportal.fun/api/data');
  ws.on('open', () => {
    connected = true; backoff = 1000; lastMsg = Date.now();
    send({ method: 'subscribeNewToken' });
    for (const m of Object.keys(S.pos)) {
      if (!T.has(m)) T.set(m, { m, sym: S.pos[m].sym, t0: S.pos[m].t0, creator: S.pos[m].creator, p0: S.pos[m].entry, p: S.pos[m].last,
        mcap: 0, buyers: new Set(), buyVol: 0, sellVol: 0, devSold: false, last: Date.now() });
      sub(m);
    }
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

function handle(d) {
  if (!d || !d.mint) return;
  if (d.txType === 'create') {
    const p = price(d); if (!p) return;
    // Tokennamen zijn door gebruikers gekozen en dus onbetrouwbaar: alleen veilige tekens, kort.
    const sym = String(d.symbol || '').replace(/[^\p{L}\p{N}$._-]/gu, '').slice(0, 14) || String(d.mint).slice(0, 5);
    T.set(d.mint, { m: d.mint, sym, t0: Date.now(), creator: d.traderPublicKey, p0: p, p,
      mcap: d.marketCapSol || 0, buyers: new Set(), buyVol: 0, sellVol: 0, devSold: false, last: Date.now() });
    sub(d.mint); return;
  }
  const t = T.get(d.mint); if (!t) return;
  const p = price(d);
  if (p) { t.p = p; t.mcap = d.marketCapSol || t.mcap; }
  t.last = Date.now();
  const sol = d.solAmount || 0;
  if (d.txType === 'buy') { t.buyVol += sol; t.buyers.add(d.traderPublicKey); }
  else if (d.txType === 'sell') { t.sellVol += sol; if (d.traderPublicKey === t.creator) t.devSold = true; }
  const pos = S.pos[d.mint];
  if (pos) {
    pos.last = t.p; pos.peak = Math.max(pos.peak, t.p);
    if (t.devSold) return close(d.mint, 'dev sold');
    checkExit(d.mint, pos);
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
  return { age, checks, dead: age > c.maxAge || t.devSold };
}
function blocker() {
  const c = S.cfg; dayReset();
  if (!S.running) return 'bot gepauzeerd';
  if (S.dayPnl <= -c.dailyLoss) return 'daglimiet verlies bereikt';
  if (Object.keys(S.pos).length >= c.maxOpen) return 'max open posities bereikt';
  if (S.bal < c.size + c.reserve) return 'onvoldoende vrije balans';
  return null;
}
function checkEntry(t) {
  if (blocker()) return;
  if (evaluate(t).checks.every(x => x.ok)) open(t);
}
function radar() {
  const rows = [];
  for (const t of T.values()) {
    if (S.pos[t.m]) continue;
    const ev = evaluate(t), passed = ev.checks.filter(x => x.ok).length;
    rows.push({ m: t.m, sym: t.sym, age: ev.age, mcap: t.mcap, checks: ev.checks, passed, total: ev.checks.length,
      ready: passed === ev.checks.length, dead: ev.dead });
  }
  const funnel = (rows[0] ? rows[0].checks : evaluate({ t0: Date.now(), p: 1, p0: 1, mcap: 0, buyers: new Set(), buyVol: 0, sellVol: 0, devSold: false }).checks)
    .map((c, i) => ({ k: c.k, label: c.label, need: c.need, ok: rows.filter(r => r.checks[i].ok).length, total: rows.length }));
  rows.sort((a, b) => (a.dead - b.dead) || (b.passed - a.passed) || (a.age - b.age));
  return { tokens: rows.slice(0, 60), funnel, trackedTotal: rows.length, readyCount: rows.filter(r => r.ready).length };
}
function open(t) {
  const c = S.cfg, r = Exec.buy(t.p, c.size, c);
  S.bal -= r.cost; S.fees += r.fee + r.prio;
  S.pos[t.m] = { m: t.m, sym: t.sym, creator: t.creator, entry: r.fill, tokens: r.tokens, cost: r.cost, t0: Date.now(), last: t.p, peak: t.p };
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
  const pos = S.pos[m]; if (!pos) return;
  const c = S.cfg, r = Exec.sell(pos.last, pos.tokens, c), pnl = r.proceeds - pos.cost;
  S.bal += r.proceeds; S.fees += r.fee + r.prio; dayReset(); S.dayPnl += pnl; S.totalTrades++;
  S.hist.unshift({ sym: pos.sym, pnl, pct: pnl / pos.cost * 100, why, dur: (Date.now() - pos.t0) / 1000, t: Date.now() });
  if (S.hist.length > 500) S.hist.pop();
  delete S.pos[m]; unsub(m); T.delete(m);
  log(`${pnl >= 0 ? 'WIN' : 'LOSS'} ${pos.sym} ${pnl.toFixed(4)} SOL (${why})`);
  const eq = equity(); S.eqHist.push(eq); if (S.eqHist.length > 1000) S.eqHist.shift(); S.peakEq = Math.max(S.peakEq, eq);
  save();
}
const equity = () => {
  let v = S.bal;
  for (const p of Object.values(S.pos)) v += p.tokens * p.last * (1 - S.cfg.slip / 100) * (1 - S.cfg.feePct / 100);
  return v;
};
function tick() {
  const now = Date.now(), c = S.cfg;
  for (const [m, p] of Object.entries(S.pos)) {
    const t = T.get(m);
    if ((now - p.t0) / 1000 > c.maxHold) close(m, 'max tijd');
    else if (t && (now - t.last) / 1000 > c.stale) close(m, 'stale');
  }
  for (const [m, t] of T) if (!S.pos[m] && now - t.t0 > (c.maxAge + 30) * 1000) { T.delete(m); unsub(m); }
  if (connected && now - lastMsg > 60000) { log('feed stil, herverbinden'); try { ws.terminate(); } catch { /* */ } }
}

/* ---------- statistieken + API ---------- */
function stats() {
  const h = S.hist, w = h.filter(x => x.pnl > 0);
  const gw = w.reduce((a, x) => a + x.pnl, 0), gl = -h.filter(x => x.pnl <= 0).reduce((a, x) => a + x.pnl, 0);
  const eq = equity();
  return { n: S.totalTrades, wr: h.length ? w.length / h.length * 100 : 0, pf: gl ? gw / gl : (gw ? 99 : 0),
    pnl: eq - S.cfg.start, eq, dd: S.peakEq ? Math.max(0, (S.peakEq - eq) / S.peakEq * 100) : 0 };
}
const state = () => ({
  connected, running: S.running, bal: S.bal, fees: S.fees, stats: stats(), cfg: S.cfg, def: DEF,
  startedAt: S.startedAt, tracked: T.size, dayPnl: S.dayPnl, blocked: blocker(), demo: !!process.env.DEMO,
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
      return res.end('token,pnl_sol,pct,reden,duur_s,tijd\n' + S.hist.map(x => [x.sym, x.pnl, x.pct, x.why, x.dur, new Date(x.t).toISOString()].join(',')).join('\n'));
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
        for (const m of Object.keys(S.pos)) unsub(m);
        T.clear(); S = fresh(); S.cfg = { ...DEF, ...body.keepCfg ? S.cfg : {} }; save(); flush(); log('reset'); return json(res, { ok: true });
      }
      return json(res, { error: 'niet gevonden' }, 404);
    });
  }
  json(res, { error: 'methode' }, 405);
});

function start() {
  load();
  server.listen(PORT, HOST, () => log(`dashboard: http://${HOST}:${PORT}`));
  if (process.env.DEMO) { connected = true; log('DEMO-modus: gesimuleerde tokens, geen echte feed'); require('./demo.js').start(handle); }
  else connect();
  setInterval(tick, 1000);
  setInterval(flush, 3000);
  setInterval(() => { S.eqHist.push(equity()); if (S.eqHist.length > 1000) S.eqHist.shift(); save(); }, 300000);
  const bye = () => { try { flush(); } catch { /* */ } process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  process.on('uncaughtException', e => log('uncaught: ' + e.message));
  process.on('unhandledRejection', e => log('unhandled: ' + e));
}

if (require.main === module) start();
module.exports = { handle, tick, close, checkEntry, getS: () => S, T, DEF };
