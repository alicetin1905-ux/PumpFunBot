'use strict';
/* Strategie-scan: test een vaste, vooraf gekozen set strategieën op de vastgelegde tokens (data/tokens-*.jsonl).
   Gebruik:  node scan.js [--minn=40 --split=0.6]   (kosten als analyze.js: --fee --slip --impact --prio --size --lat)

   Een strategie = entry-leeftijd × entry-filter × uitstapregels. Alle combinaties zijn vooraf vastgelegd (zie onder), niet
   bijgesteld na het zien van de data. Werkwijze tegen toeval:
   - kies de beste combinaties op de EERSTE deel van de tijd (train, standaard 60%);
   - meet ze op het LATERE deel (test) dat de keuze nooit zag;
   - het interval op de test is gecorrigeerd voor het aantal gekozen combinaties (Bonferroni);
   - er wordt getoond hoeveel combinaties er in totaal geprobeerd zijn en wat de gemiddelde combinatie op de test doet.
   Alleen een combinatie die op de test positief is mét ondergrens boven 0 is een kandidaat. Geen enkele? Dan is het eerlijke
   antwoord "geen aangetoonde edge", en dat is een nuttige uitkomst. */
const path = require('path');
const { loadRecs, isCustom, makeSim, stat } = require('./simlib.js');
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const num = (k, d) => (args[k] !== undefined && args[k] !== '' && !isNaN(+args[k])) ? +args[k] : d;
const MINN = num('minn', 40), SPLIT = num('split', 0.6), TOP = 5;
const M = makeSim({ fee: num('fee', 1.25), slip: num('slip', 1), impact: num('impact', 0.8), prio: num('prio', 0.0008), size: num('size', 0.25), lat: num('lat', 1) });

const AGES = [20, 45, 90, 180];
const FILTERS = {
  'alles (baseline)': () => true,
  'bot-standaard': f => f.buyers >= 6 && f.buyVol >= 1.5 && f.ratio >= 2.5 && f.mcap >= 25 && f.mcap <= 60 && f.run <= 60 && !f.devSold,
  'momentum': f => f.mom > 0 && f.buys10 >= 1 && f.ratio >= 2 && !f.devSold && f.mcap <= 120,
  'organisch': f => f.organic >= 6 && f.sniperShare <= 0.3 && f.ratio >= 2 && !f.devSold,
  'sterk': f => f.buyers >= 15 && f.buyVol >= 5 && f.ratio >= 3 && !f.devSold && f.topShare <= 0.4,
  'momentum+organisch': f => f.mom > 0 && f.buys10 >= 1 && f.ratio >= 2 && !f.devSold && f.mcap <= 120 && f.organic >= 6 && f.sniperShare <= 0.3
};
const EXITS = [];
for (const tp of [15, 30, 50, 100]) for (const sl of [10, 15, 25]) for (const tr of [{ trail: 0, trailStart: 0 }, { trail: 10, trailStart: 20 }]) for (const hold of [90, 240])
  EXITS.push({ tp, sl, hold, ...tr, label: `TP ${tp} / SL ${sl} / ${tr.trail ? 'trail 20→10' : 'geen trail'} / ${hold}s` });

const recs = loadRecs(DIR).filter(r => !isCustom(r));
const pct = n => (n * 100).toFixed(1) + '%', spct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%';
console.log(`\nFLINT strategie-scan — ${recs.length} tokens (eigen curves uitgesloten), kosten per rondreis ≈ ${(M.COST_RT * 100).toFixed(1)}%`);
if (recs.length < MINN * 3) { console.log(`Nog te weinig data (minimaal ~${MINN * 3} tokens). Laat de bot langer draaien.\n`); process.exit(0); }

const t0s = recs.map(r => r.t0).sort((a, b) => a - b), cutT = t0s[Math.floor(t0s.length * SPLIT)];
const combos = [];
for (const age of AGES) {
  const rows = [];
  for (const r of recs) {
    const s = (r.snaps || []).reduce((b, x) => (!b || Math.abs(x.age - age) < Math.abs(b.age - age)) ? x : b, null);
    if (s && Math.abs(s.age - age) <= 4) rows.push({ t0: r.t0, r, f: s });
  }
  if (rows.length < MINN) { console.log(`entry ~${age}s: ${rows.length} tokens met data op dit moment (te weinig, overgeslagen)`); continue; }
  console.log(`entry ~${age}s: ${rows.length} tokens met data`);
  const rets = EXITS.map(ex => rows.map(x => M.sim(x.r, x.f, ex)));
  for (const [fname, fn] of Object.entries(FILTERS)) {
    const idx = []; rows.forEach((x, i) => { if (fn(x.f)) idx.push(i); });
    EXITS.forEach((ex, e) => {
      const tr = [], te = [];
      for (const i of idx) { const v = rets[e][i]; if (v == null) continue; (rows[i].t0 < cutT ? tr : te).push({ ret: v }); }
      if (tr.length >= MINN && te.length >= Math.max(10, MINN / 2)) combos.push({ age, fname, ex, tr: stat(tr), te: stat(te) });
    });
  }
}
if (!combos.length) { console.log('\nGeen combinatie met genoeg tokens in zowel train als test. Meer data nodig.\n'); process.exit(0); }

const lower = s => s.avg - s.ci;                                 // ondergrens train: voorkeur voor robuuste, niet voor toevalspieken
const ranked = combos.slice().sort((a, b) => lower(b.tr) - lower(a.tr)).slice(0, TOP);
const ZB = 2.576;                                                // 99%: 95% gecorrigeerd voor de 5 gekozen combinaties
console.log(`\n${combos.length} combinaties getest (met genoeg tokens). Top ${TOP} op de trainperiode, daarna gemeten op de testperiode (token-instaptijd ≥ ${new Date(cutT).toISOString().slice(0, 16)}Z):`);
let confirmed = 0;
for (const c of ranked) {
  const lo = c.te.avg - ZB * c.te.sd / Math.sqrt(c.te.n);
  const verdict = lo > 0 ? '✔ bevestigd (ondergrens > 0)' : c.te.avg > 0 ? '~ test positief, maar niet te onderscheiden van toeval' : '✘ niet bevestigd';
  if (lo > 0) confirmed++;
  console.log(`\nentry ~${c.age}s, filter "${c.fname}", ${c.ex.label}`);
  console.log(`   train  n=${String(c.tr.n).padStart(4)}  winst ${pct(c.tr.win).padStart(6)}  gem. netto/trade ${spct(c.tr.avg).padStart(7)} ±${(c.tr.ci * 100).toFixed(1)}`);
  console.log(`   test   n=${String(c.te.n).padStart(4)}  winst ${pct(c.te.win).padStart(6)}  gem. netto/trade ${spct(c.te.avg).padStart(7)} ±${(ZB * c.te.sd / Math.sqrt(c.te.n) * 100).toFixed(1)} (gecorrigeerd)   ${verdict}`);
}
const posTest = combos.filter(c => c.te.avg > 0).length, avgTest = combos.reduce((a, c) => a + c.te.avg, 0) / combos.length;
console.log(`\nContext: van alle ${combos.length} combinaties is ${posTest} (${pct(posTest / combos.length)}) positief op de test; gemiddelde combinatie ${spct(avgTest)} per trade.`);
console.log(`Bij ${combos.length} geprobeerde combinaties verwacht je puur door toeval een beste z-score van rond ${Math.sqrt(2 * Math.log(combos.length)).toFixed(1)}.`);
console.log(confirmed
  ? `\n${confirmed} van de ${TOP} gekozen combinaties houdt stand op onbekende tokens. Verifieer eerst op nóg latere data voordat je eraan toegeeft.\n`
  : '\nGeen enkele gekozen combinatie houdt stand op de test: er is in deze data (nog) geen aangetoonde edge. Aanpassen van TP/SL of filters op deze data zou alleen toeval opleveren.\n');
