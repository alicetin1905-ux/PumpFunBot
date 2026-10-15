'use strict';
/* Analyseert de vastgelegde tokens (data/tokens-*.jsonl) en laat zien wat echt voorspelt en wat toeval is.
   Gebruik:  npm run analyze  [-- --age=20 --tp=12 --sl=8 --hold=90 --minn=30]
   Kosten (standaard = de bot): --fee=1.25 --slip=1 --impact=0.8 (% per kant) --prio=0.0008 --size=0.25 (SOL) --lat=1 (s)
   Trailing stop (zoals de bot): --trailstart=8 --trail=5   (--trail=0 = uit)

   Per token wordt gesimuleerd: instap op het snapshot-moment (+ vertraging), uitstap bij take profit / stop loss /
   trailing stop / dev-verkoop / max houdtijd, inclusief alle kosten. Het prijspad is de marketcap (evenredig met de prijs).

   Onderdelen:
   1. Kosten en break-even winstpercentage
   2. TP/SL-raster (met en zonder trailing), met beste-op-train → resultaat-op-test
   3. Vooraf bepaalde hypothesen over wallet-/bundelsignalen (geen datamining, dus eerlijk te lezen)
   4. Beste filter per kenmerk en combinaties (train 70% / test 30% in tijd)
   Een resultaat telt pas als het ook op onbekende (latere) tokens standhoudt; het ± is het 95%-betrouwbaarheidsinterval. */
const fs = require('fs'), path = require('path');
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const num = (k, d) => (args[k] !== undefined && args[k] !== '' && !isNaN(+args[k])) ? +args[k] : d;
const AGE = num('age', 20), TP = num('tp', 12), SL = num('sl', 8), HOLD = num('hold', 90), MINN = num('minn', 30);
const SIZE = num('size', 0.25), PRIO = num('prio', 0.0008), LAT = num('lat', 1);
const TRAIL0 = { start: num('trailstart', 8), pct: num('trail', 5) };
const C = { fee: num('fee', 1.25) / 100, slip: num('slip', 1) / 100, impact: num('impact', 0.8) / 100 };
const PRIO_RT = 2 * PRIO / SIZE;                                   // priority fee, beide kanten, als deel van de positie
const COST_RT = 2 * (C.fee + C.slip + C.impact) + PRIO_RT;         // ongeveer, voor de break-even-berekening

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => /^tokens-.*\.jsonl$/.test(f)).sort() : [];
const recs = [];
for (const f of files) for (const l of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
  if (!l.trim()) continue; try { recs.push(JSON.parse(l)); } catch { /* beschadigde regel */ }
}

/* Netto rendement van één token bij gegeven uitstapregels (zelfde volgorde van checks als de bot). */
function sim(r, s, o) {
  const step = r.step || 2, p = r.path || [];
  const i0 = Math.ceil((s.age + LAT) / step);
  if (i0 >= p.length - 1 || !(p[i0] > 0)) return null;
  const entry = p[i0] * (1 + C.impact + C.slip);
  const iMax = Math.min(p.length - 1, i0 + Math.floor((o.hold || HOLD) / step));
  const iDev = r.devSoldAt != null ? Math.ceil((r.devSoldAt + LAT) / step) : Infinity;
  let exit = p[iMax], peak = p[i0];
  for (let i = i0 + 1; i <= iMax; i++) {
    if (p[i] > peak) peak = p[i];
    const g = (p[i] / entry - 1) * 100, pk = (peak / entry - 1) * 100;
    if (i >= iDev || g >= o.tp || g <= -o.sl || (o.trail > 0 && pk >= o.trailStart && p[i] <= peak * (1 - o.trail / 100))) { exit = p[i]; break; }
  }
  return ((1 - C.fee) / entry) * exit * (1 - C.impact - C.slip) * (1 - C.fee) - 1 - PRIO_RT;
}
const BASE = { tp: TP, sl: SL, hold: HOLD, trail: TRAIL0.pct, trailStart: TRAIL0.start };

// Tokens met een eigen startcurve (CreateV2, vSol0 ≠ 30 SOL) hebben andere mcap-/prijsschalen: apart houden, niet meetellen.
const custom = recs.filter(r => r.vSol0 > 0 && Math.abs(r.vSol0 - 30) > 0.5).length;
const rows = [];
for (const r of recs) {
  if (r.vSol0 > 0 && Math.abs(r.vSol0 - 30) > 0.5) continue;
  const s = (r.snaps || []).reduce((b, x) => (!b || Math.abs(x.age - AGE) < Math.abs(b.age - AGE)) ? x : b, null);
  if (!s || Math.abs(s.age - AGE) > 4) continue;
  const ret = sim(r, s, BASE);
  if (ret != null) rows.push({ t0: r.t0, f: s, r, ret });
}
rows.sort((a, b) => a.t0 - b.t0);

const pct = n => (n * 100).toFixed(1) + '%';
const spct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%';
function stat(rs, key = 'ret') {
  const n = rs.length; if (!n) return { n: 0, win: 0, avg: 0, ci: 0 };
  const avg = rs.reduce((a, x) => a + x[key], 0) / n;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, x) => a + (x[key] - avg) ** 2, 0) / (n - 1)) : 0;
  return { n, win: rs.filter(x => x[key] > 0).length / n, avg, ci: 1.96 * sd / Math.sqrt(n) };
}
const line = (label, s) => `${label.padEnd(34)} n=${String(s.n).padStart(5)}  winst ${pct(s.win).padStart(6)}  gem. netto/trade ${spct(s.avg).padStart(7)} ±${(s.ci * 100).toFixed(1)}`;
const breakEven = rs => {
  const w = rs.filter(x => x.ret > 0), l = rs.filter(x => x.ret <= 0);
  if (!w.length || !l.length) return null;
  const aw = w.reduce((a, x) => a + x.ret, 0) / w.length, al = -l.reduce((a, x) => a + x.ret, 0) / l.length;
  return { aw, al, be: al / (aw + al) };
};

console.log(`\nFLINT analyse — ${recs.length} tokens vastgelegd${custom ? ` (${custom} met eigen curve uitgesloten)` : ''}, ${rows.length} bruikbaar op ~${AGE}s`);
console.log(`Uitstap: TP ${TP}% / SL ${SL}% / trailing ${TRAIL0.pct > 0 ? TRAIL0.start + '→' + TRAIL0.pct + '%' : 'uit'} / max ${HOLD}s`);
if (rows.length < MINN * 3) {
  console.log(`Nog te weinig data (${rows.length} rijen, minimaal ~${MINN * 3}). Laat de bot langer draaien en probeer opnieuw.\n`);
  process.exit(0);
}

/* ---- 1. kosten en break-even ---- */
const base = stat(rows);
console.log(`\n== 1. Kosten ==`);
console.log(`Kosten per rondreis ≈ ${(COST_RT * 100).toFixed(1)}% (fee ${(C.fee * 200).toFixed(2)}% + slippage ${(C.slip * 200).toFixed(1)}% + prijsimpact ${(C.impact * 200).toFixed(1)}% + priority fee ${(PRIO_RT * 100).toFixed(2)}%)`);
console.log(`Bij TP ${TP}% / SL ${SL}% (zonder trailing) is break-even pas bij ${pct((SL + COST_RT * 100) / (TP + SL))} winnende trades.`);
console.log('\n' + line('Alle tokens (baseline)', base));
const be = breakEven(rows);
if (be) console.log(`Gem. winst ${pct(be.aw)} vs gem. verlies ${pct(be.al)} → break-even bij ${pct(be.be)} winnende trades (gemeten: ${pct(base.win)})`);

/* ---- huidige bot-filters (standaardinstellingen) ---- */
const curPass = x => x.f.buyers >= 6 && x.f.buyVol >= 1.5 && x.f.ratio >= 2.5 && x.f.mcap >= 25 && x.f.mcap <= 60 && x.f.run <= 60 && !x.f.devSold;
const cur = rows.filter(curPass);
console.log(line('Huidige bot-filters (standaard)', stat(cur)));

/* ---- 2. TP/SL-raster ---- */
const TPS = [6, 8, 10, 12, 15, 20, 30, 50], SLS = [4, 6, 8, 10, 15, 20];
const useCur = cur.length >= MINN;
const subset = useCur ? cur : rows;
console.log(`\n== 2. TP/SL-raster op ${useCur ? 'tokens die de huidige bot-filters halen' : 'alle tokens (te weinig tokens door de bot-filters)'} (n=${subset.length}) ==`);
const cut0 = Math.floor(subset.length * 0.7), sTrain = subset.slice(0, cut0), sTest = subset.slice(cut0);
const grid = [];
for (const [tname, tr] of [['zonder trailing', { trail: 0, trailStart: 0 }], [`met trailing ${TRAIL0.start}→${TRAIL0.pct}%`, { trail: TRAIL0.pct, trailStart: TRAIL0.start }]]) {
  if (tname.startsWith('met') && !(TRAIL0.pct > 0)) continue;
  console.log(`\nGem. netto per trade, ${tname} (rij = SL, kolom = TP):`);
  console.log('SL\\TP ' + TPS.map(t => String(t).padStart(7)).join(''));
  for (const sl of SLS) {
    let out = String(sl).padStart(5) + ' ';
    for (const tp of TPS) {
      const o = { tp, sl, hold: HOLD, ...tr };
      const ev = rs => rs.map(x => ({ ret: sim(x.r, x.f, o) })).filter(x => x.ret != null);
      const all = stat(ev(subset)), tn = stat(ev(sTrain)), ts = stat(ev(sTest));
      grid.push({ tname, tp, sl, all, tn, ts });
      out += spct(all.avg).padStart(7);
    }
    console.log(out);
  }
}
const ok = grid.filter(g => g.tn.n >= MINN && g.ts.n >= Math.max(10, MINN / 2));
if (ok.length) {
  const bestTrain = ok.reduce((a, b) => b.tn.avg > a.tn.avg ? b : a);
  console.log(`\nBeste instelling op de trainperiode (uit ${ok.length} geprobeerd): TP ${bestTrain.tp}% / SL ${bestTrain.sl}% ${bestTrain.tname}`);
  console.log('   ' + line('train', bestTrain.tn));
  console.log('   ' + line('test ', bestTrain.ts));
  console.log(bestTrain.ts.avg - bestTrain.ts.ci > 0 ? '   ✔ ook op onbekende tokens positief, met zekerheid boven 0'
    : bestTrain.ts.avg > 0 ? '   ~ test positief, maar het interval omvat 0: nog niet te onderscheiden van toeval'
    : '   ✘ niet bevestigd op de test: dit is toeval of te weinig data');
  const pos = ok.filter(g => g.all.avg > 0).length;
  console.log(`   ${pos} van ${ok.length} instellingen zijn positief over de hele periode. Is dat er nul, dan helpt TP/SL-tuning niet: de filters moeten beter.`);
} else console.log('\nTe weinig tokens in train/test voor een betrouwbare TP/SL-keuze.');

/* ---- 3. vooraf bepaalde hypothesen (geen datamining) ---- */
const HYP = [
  ['sniperShare ≥ 0.5  (meeste volume is sniper/bundel)', x => x.f.sniperShare >= 0.5, 'sniperShare'],
  ['organic ≥ 4        (kopers buiten de eerste slots)', x => x.f.organic >= 4, 'organic'],
  ['devRugs ≥ 1        (maker dumpte eerder)', x => x.f.devRugs >= 1, 'devRugs'],
  ['smart ≥ 1          (slimme wallet onder de kopers)', x => x.f.smart >= 1, 'smart']
];
console.log('\n== 3. Wallet- en bundelsignalen (vooraf gekozen drempels, alle tokens; significant = gecorrigeerd voor 4 toetsen) ==');
const ZH = 2.24;   // 95% gecorrigeerd voor 4 hypothesen tegelijk (Bonferroni), anders vind je bij 4 kenmerken te vaak toeval
let anyHyp = false;
for (const [lab, fn, key] of HYP) {
  const have = rows.filter(x => x.f[key] != null);
  const a = have.filter(fn), b = have.filter(x => !fn(x));
  if (a.length < 10 || b.length < 10) { console.log(`${lab}\n   te weinig tokens (ja ${a.length} / nee ${b.length})`); continue; }
  anyHyp = true;
  const sa = stat(a), sb = stat(b), d = sa.avg - sb.avg, se = Math.sqrt((sa.ci / 1.96) ** 2 + (sb.ci / 1.96) ** 2);
  console.log(lab);
  console.log('   ' + line('ja ', sa)); console.log('   ' + line('nee', sb));
  console.log(`   verschil ${spct(d)} ±${(1.96 * se * 100).toFixed(1)} → ${Math.abs(d) > ZH * se ? 'significant' : 'niet te onderscheiden van toeval'}`);
}
if (!anyHyp) console.log('(Nog te weinig data met deze kenmerken; ze worden pas sinds de laatste versie vastgelegd.)');

/* ---- 4. beste filter per kenmerk + combinaties ---- */
const FEATS = [['buyers', 1], ['buyVol', 1], ['ratio', 1], ['mom', 1], ['buys10', 1], ['nBuys', 1], ['topShare', -1], ['mcap', -1], ['run', -1], ['devBuy', -1], ['sellers', -1],
  ['organic', 1], ['sniperShare', -1], ['snipers', -1], ['smart', 1], ['devRugs', -1], ['devN', -1]];
const quant = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];
const cands = {};
for (const [k, dir] of FEATS) {
  const v = rows.map(x => x.f[k]).filter(x => x != null).sort((a, b) => a - b);
  cands[k] = v.length ? [...new Set([.1, .25, .4, .5, .6, .75, .9].map(q => quant(v, q)))].map(th => ({ k, dir, th })) : [];
}
const pass = (x, c) => c.dir > 0 ? x.f[c.k] >= c.th : x.f[c.k] <= c.th;
const lab = c => `${c.k} ${c.dir > 0 ? '≥' : '≤'} ${c.th}`;

console.log('\n== 4. Beste enkele filter per kenmerk (n ≥ ' + MINN + ') — let op: dit is zoeken, dus toeval ligt op de loer ==');
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
console.log(`\nBeste combinaties (getraind op ${train.length}, getest op ${test.length} onbekende tokens; test n ≥ ${minTest}; ${combos.length} geprobeerd):`);
if (!ranked.length) console.log('Geen combinatie met genoeg tokens in zowel train als test. Meer data nodig.');
for (const x of ranked) {
  console.log(`${x.cs.map(lab).join(' & ')}   ${x.te.avg - x.te.ci > 0 ? '✔ houdt stand op test' : x.te.avg > 0 ? '~ test positief, interval omvat 0' : '✘ niet bevestigd op test'}`);
  console.log('   ' + line('train', x.tr)); console.log('   ' + line('test ', x.te));
}

console.log('\nLet op: een combinatie telt pas als de TEST-regel positief is mét een interval boven 0. Hoe meer je zoekt, hoe vaker');
console.log('je toeval vindt; verifieer met nieuwe data voordat je filters of TP/SL aanpast.\n');
