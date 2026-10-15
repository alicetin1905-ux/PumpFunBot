'use strict';
/* Analyseert de vastgelegde tokens (data/tokens-*.jsonl) en laat zien welke filters echt voorspellen.
   Gebruik:  npm run analyze  [-- --age=20 --tp=12 --sl=8 --hold=90 --minn=30]

   Per token wordt gesimuleerd: instap op het snapshot-moment (+1 s vertraging), uitstap bij take profit /
   stop loss / dev-verkoop / max houdtijd, inclusief kosten (fee, slippage, prijsimpact). Het prijspad is de
   marketcap (evenredig met de prijs). Combinaties worden getraind op de eerste 70% (in tijd) en getest op de
   laatste 30%, zodat je ziet of een filter echt werkt of toeval is. */
const fs = require('fs'), path = require('path');
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const AGE = +args.age || 20, TP = +args.tp || 12, SL = +args.sl || 8, HOLD = +args.hold || 90, MINN = +args.minn || 30;
const RT = { fee: 0.01, slip: 0.01, impact: 0.008 }; // kosten per kant

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => /^tokens-.*\.jsonl$/.test(f)).sort() : [];
const recs = [];
for (const f of files) for (const l of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
  if (!l.trim()) continue; try { recs.push(JSON.parse(l)); } catch { /* beschadigde regel */ }
}

function sim(r, s, tp, sl, hold) {
  const step = r.step || 2, p = r.path || [];
  const i0 = Math.ceil((s.age + 1) / step);
  if (i0 >= p.length - 1 || !(p[i0] > 0)) return null;
  const entry = p[i0] * (1 + RT.impact + RT.slip);
  const iMax = Math.min(p.length - 1, i0 + Math.floor(hold / step));
  const iDev = r.devSoldAt != null ? Math.ceil((r.devSoldAt + 1) / step) : Infinity;
  let exit = p[iMax];
  for (let i = i0 + 1; i <= iMax; i++) {
    const g = (p[i] / entry - 1) * 100;
    if (i >= iDev || g >= tp || g <= -sl) { exit = p[i]; break; }
  }
  return ((1 - RT.fee) / entry) * exit * (1 - RT.impact - RT.slip) * (1 - RT.fee) - 1;
}

const rows = [];
for (const r of recs) {
  const s = (r.snaps || []).reduce((b, x) => (!b || Math.abs(x.age - AGE) < Math.abs(b.age - AGE)) ? x : b, null);
  if (!s || Math.abs(s.age - AGE) > 4) continue;
  const ret = sim(r, s, TP, SL, HOLD);
  if (ret != null) rows.push({ t0: r.t0, f: s, ret });
}
rows.sort((a, b) => a.t0 - b.t0);

const pct = n => (n * 100).toFixed(1) + '%';
function stat(rs) {
  const n = rs.length; if (!n) return { n: 0, win: 0, avg: 0 };
  return { n, win: rs.filter(x => x.ret > 0).length / n, avg: rs.reduce((a, x) => a + x.ret, 0) / n };
}
const line = (label, s) => `${label.padEnd(34)} n=${String(s.n).padStart(5)}  winst ${pct(s.win).padStart(6)}  gem. netto/trade ${pct(s.avg).padStart(7)}`;

console.log(`\nFLINT analyse — ${recs.length} tokens vastgelegd, ${rows.length} bruikbaar op ~${AGE}s (TP ${TP}% / SL ${SL}% / max ${HOLD}s, kosten meegerekend)`);
if (rows.length < MINN * 3) {
  console.log(`Nog te weinig data (${rows.length} rijen, minimaal ~${MINN * 3}). Laat de bot langer draaien en probeer opnieuw.\n`);
  process.exit(0);
}
const base = stat(rows);
console.log('\n' + line('Alle tokens (baseline)', base));
const w = rows.filter(x => x.ret > 0), l = rows.filter(x => x.ret <= 0);
if (w.length && l.length) {
  const aw = w.reduce((a, x) => a + x.ret, 0) / w.length, al = -l.reduce((a, x) => a + x.ret, 0) / l.length;
  console.log(`Gem. winst ${pct(aw)} vs gem. verlies ${pct(al)} → break-even bij ${pct(al / (aw + al))} winnende trades`);
}

const FEATS = [['buyers', 1], ['buyVol', 1], ['ratio', 1], ['mom', 1], ['buys10', 1], ['nBuys', 1], ['topShare', -1], ['mcap', -1], ['run', -1], ['devBuy', -1], ['sellers', -1]];
const quant = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];
const cands = {};
for (const [k, dir] of FEATS) {
  const v = rows.map(x => x.f[k]).filter(x => x != null).sort((a, b) => a - b);
  cands[k] = [...new Set([.1, .25, .4, .5, .6, .75, .9].map(q => quant(v, q)))].map(th => ({ k, dir, th }));
}
const pass = (x, c) => c.dir > 0 ? x.f[c.k] >= c.th : x.f[c.k] <= c.th;
const lab = c => `${c.k} ${c.dir > 0 ? '≥' : '≤'} ${c.th}`;

console.log('\nBeste enkele filter per kenmerk (n ≥ ' + MINN + '):');
const best = {};
for (const [k] of FEATS) {
  let b = null;
  for (const c of cands[k]) { const s = stat(rows.filter(x => pass(x, c))); if (s.n >= MINN && (!b || s.avg > b.s.avg)) b = { c, s }; }
  if (b) { best[k] = b; console.log(line(lab(b.c), b.s)); }
}

// Combinaties: train op eerste 70%, test op laatste 30%
const cut = Math.floor(rows.length * 0.7), train = rows.slice(0, cut), test = rows.slice(cut);
const top = Object.values(best).sort((a, b) => b.s.avg - a.s.avg).slice(0, 7).map(x => x.c);
const combos = [];
for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
  combos.push([top[i], top[j]]);
  for (let m = j + 1; m < top.length; m++) combos.push([top[i], top[j], top[m]]);
}
const evalCombo = (cs, rs) => stat(rs.filter(x => cs.every(c => pass(x, c))));
const minTest = Math.max(10, Math.floor(MINN / 2)), seen = new Set();
const ranked = combos.map(cs => ({ cs, tr: evalCombo(cs, train), te: evalCombo(cs, test) }))
  .filter(x => x.tr.n >= MINN && x.te.n >= minTest)
  .sort((a, b) => b.tr.avg - a.tr.avg)
  .filter(x => { const sig = `${x.tr.n}|${x.te.n}|${x.tr.avg.toFixed(4)}`; if (seen.has(sig)) return false; seen.add(sig); return true; })
  .slice(0, 6);
console.log(`\nBeste combinaties (getraind op ${train.length}, getest op ${test.length} onbekende tokens; test n ≥ ${minTest}):`);
if (!ranked.length) console.log('Geen combinatie met genoeg tokens in zowel train als test. Meer data nodig.');
for (const x of ranked) {
  console.log(`${x.cs.map(lab).join(' & ')}   ${x.te.avg > 0 ? '✔ houdt stand op test' : '✘ niet bevestigd op test'}`);
  console.log('   ' + line('train', x.tr)); console.log('   ' + line('test ', x.te));
}

const cur = rows.filter(x => x.f.buyers >= 6 && x.f.buyVol >= 1.5 && x.f.ratio >= 2.5 && x.f.mcap >= 25 && x.f.mcap <= 60 && x.f.run <= 60 && !x.f.devSold);
console.log('\n' + line('Huidige bot-filters (standaard)', stat(cur)));
console.log('\nLet op: een combinatie telt pas als de TEST-regel ook positief is. Veel combinaties zoeken = toeval vinden;');
console.log('verifieer met nieuwe data voordat je filters aanpast.\n');
