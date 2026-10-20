'use strict';
/* Slimme-walletkandidaten: welke wallets zitten vaker dan toeval vroeg in tokens die verdubbelen, en houdt dat stand op latere data?
   Gebruik:  node wallets.js [--minapp=3 --split=0.6 --top=10]   (kosten als analyze.js: --fee --slip --impact --prio --size --lat)

   Werkwijze (tegen toeval):
   1. Per token zijn de vroege kopers (eerste 30 s, max. 20) vastgelegd, met leeftijd en bedrag. Een token "wint" als de mcap minstens verdubbelt.
   2. TRAIN (eerste 60% in tijd): een wallet is kandidaat als hij ≥ minapp keer vroeg zat en de ondergrens (Wilson 95%) van zijn winnaar-aandeel
      boven het gemiddelde van alle tokens ligt. De beste `top` op die ondergrens gaan door.
   3. TEST (laatste 40%): wat had copy-trading opgeleverd? Instap op het moment van hún koop (+ vertraging), vaste uitstap (TP 30 / SL 15 / max 120 s),
      alle kosten mee. Het interval is gecorrigeerd voor het aantal geteste kandidaten (Bonferroni).
   Veel wallets zoeken = toeval vinden: een wallet is pas interessant als hij op de TEST positief is met een ondergrens boven 0, en dan nog moet hij
   op nóg latere data blijven werken. Zet bevestigde wallets in WATCH_WALLETS om ze live te laten loggen. */
const path = require('path');
const { loadRecs, isCustom, makeSim, stat } = require('./simlib.js');
const { b58encode } = require('./feed-solana.js');
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const num = (k, d) => (args[k] !== undefined && args[k] !== '' && !isNaN(+args[k])) ? +args[k] : d;
const MINAPP = num('minapp', 3), SPLIT = num('split', 0.6), TOP = num('top', 10), MIN_TEST = 8;
const M = makeSim({ fee: num('fee', 1.25), slip: num('slip', 1), impact: num('impact', 0.8), prio: num('prio', 0.0008), size: num('size', 0.25), lat: num('lat', 1) });
const EX = { tp: 30, sl: 15, hold: 120, trail: 0, trailStart: 0 };

const pct = n => (n * 100).toFixed(1) + '%', spct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%';
const wilsonLow = (k, n) => { if (!n) return 0; const z = 1.96, p = k / n, d = 1 + z * z / n; return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; };
const zFor = k => k <= 1 ? 1.96 : k <= 3 ? 2.39 : k <= 5 ? 2.58 : k <= 10 ? 2.81 : k <= 20 ? 3.02 : 3.3;
const addr = w => /^[0-9a-f]{64}$/.test(w) ? b58encode(Buffer.from(w, 'hex')) : w;

const all = loadRecs(DIR).filter(r => !isCustom(r) && Array.isArray(r.early));
console.log(`\nFLINT slimme wallets — ${all.length} tokens met vroege-koperslijst (eigen curves uitgesloten)`);
if (all.length < 150) { console.log('Nog te weinig data (minimaal ~150 tokens met vroege kopers; die worden pas in de nieuwste versie vastgelegd). Laat de bot langer draaien.\n'); process.exit(0); }
all.sort((a, b) => a.t0 - b.t0);
const cut = Math.floor(all.length * SPLIT), train = all.slice(0, cut), test = all.slice(cut);
const win = r => r.peak >= 2 * (r.m0 > 0 ? r.m0 : (r.path || [])[0] || Infinity);
const base = train.filter(win).length / train.length, baseTest = test.filter(win).length / test.length;
console.log(`Train: ${train.length} tokens, ${pct(base)} verdubbelt. Test: ${test.length} tokens, ${pct(baseTest)} verdubbelt.`);

const W = new Map();
for (const r of train) { const w = win(r) ? 1 : 0; for (const [id] of r.early) { const x = W.get(id) || { n: 0, wins: 0 }; x.n++; x.wins += w; W.set(id, x); } }
const seenOnce = [...W.values()].filter(x => x.n >= MINAPP).length;
const cands = [...W].filter(([, x]) => x.n >= MINAPP && wilsonLow(x.wins, x.n) > base).map(([id, x]) => ({ id, ...x, low: wilsonLow(x.wins, x.n) }))
  .sort((a, b) => b.low - a.low || b.n - a.n).slice(0, TOP);
console.log(`${W.size} wallets vroeg gezien in train, ${seenOnce} met ≥ ${MINAPP} keer; ${cands.length} kandidaten met winnaar-aandeel boven toeval (Wilson-ondergrens > ${pct(base)}).`);
if (!cands.length) { console.log('Geen kandidaten: nog geen wallet die vaak genoeg vroeg zat met een aandeel boven toeval. Meer data nodig.\n'); process.exit(0); }

const Z = zFor(cands.length);
console.log(`\nKandidaten uit train, daarna gemeten op de testperiode (copy-trade met TP ${EX.tp}% / SL ${EX.sl}% / max ${EX.hold}s, kosten ≈ ${(M.COST_RT * 100).toFixed(1)}% per rondreis; interval gecorrigeerd voor ${cands.length} kandidaten):`);
const confirmed = [];
for (const c of cands) {
  const ev = [];
  for (const r of test) { const e = r.early.find(x => x[0] === c.id); if (e) { const v = M.sim(r, { age: e[1] }, EX); if (v != null) ev.push({ ret: v, win: win(r) }); } }
  const st = stat(ev), lo = st.avg - Z * st.sd / Math.sqrt(Math.max(1, st.n));
  const wr = ev.length ? ev.filter(x => x.win).length / ev.length : 0;
  let verdict;
  if (ev.length < MIN_TEST) verdict = `te weinig keren vroeg in de test (${ev.length} < ${MIN_TEST}): geen oordeel`;
  else if (lo > 0) { verdict = '✔ bevestigd op de test (ondergrens > 0)'; confirmed.push(c.id); }
  else verdict = st.avg > 0 ? '~ test positief, maar niet te onderscheiden van toeval' : '✘ niet bevestigd';
  console.log(`\n${addr(c.id)}`);
  console.log(`   train: ${c.n}x vroeg, ${c.wins} verdubbelaars (${pct(c.wins / c.n)}, ondergrens ${pct(c.low)})`);
  console.log(`   test:  ${ev.length}x vroeg, ${pct(wr)} verdubbelt (toeval ${pct(baseTest)}), copy-trade gem. netto/trade ${ev.length ? spct(st.avg) : '–'} ±${(Z * st.sd / Math.sqrt(Math.max(1, st.n)) * 100).toFixed(1)}   ${verdict}`);
}
console.log(confirmed.length
  ? `\n${confirmed.length} van ${cands.length} kandidaten houdt stand op de test. Volg ze live (en bevestig opnieuw op nieuwe data) met:\nWATCH_WALLETS=${confirmed.map((id, i) => 'w' + (i + 1) + '=' + addr(id)).join(',')}\n`
  : '\nGeen enkele kandidaat houdt stand op de test: de wallets die in train slim leken waren (nog) toeval. Meer data of een andere aanpak nodig.\n');
