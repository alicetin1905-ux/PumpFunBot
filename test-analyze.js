'use strict';
// Synthetische dataset met een bekend effect: tokens met veel sniper-volume dalen, de rest stijgt licht.
// analyze.js moet dat vinden (significant verschil), het TP/SL-raster tonen en niet crashen.
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert'), cp = require('child_process');
const dir = path.join(os.tmpdir(), 'flint-analyze-' + process.pid); fs.mkdirSync(dir, { recursive: true });
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / 0.7071; };
const lines = [], base = Date.UTC(2026, 0, 1);
for (let i = 0; i < 700; i++) {
  const sniper = rnd() < 0.3, drift = sniper ? -0.004 : 0.0015;
  const path_ = [30]; for (let k = 1; k < 90; k++) path_.push(Math.max(1, path_[k - 1] * (1 + drift + 0.02 * gauss())));
  const f = age => ({ age, buyers: 6 + Math.floor(rnd() * 15), sellers: 2, buyVol: 2 + rnd() * 4, sellVol: 0.5, nBuys: 10, nSells: 3, ratio: 3 + rnd() * 5, mcap: 28 + rnd() * 25,
    run: rnd() * 30, devSold: 0, devBuy: 0.5, topShare: 0.3, buys10: 1, sells10: 0.2, mom: 0.8,
    snipers: sniper ? 5 : 1, sniperShare: sniper ? 0.7 : 0.1, organic: sniper ? 2 : 8, devN: 0, devRugs: i % 10 === 0 ? 1 : 0, smart: i % 7 === 0 ? 1 : 0 });
  lines.push(JSON.stringify({ id: 'T' + i, sym: 'T' + i, t0: base + i * 60000, step: 2, snaps: [f(5), f(10), f(20), f(30)], watch: i % 12 === 0 ? [{ w: 'jaap', side: 'buy', age: 20, sol: 1, mcap: 30 }] : undefined, path: path_.map(x => +x.toFixed(2)),
    peak: Math.max(...path_), devSoldAt: null, final: f(60), trade: null }));
}
const cust = JSON.parse(lines[0]); cust.id = 'CUSTOM'; cust.vSol0 = 0.4; lines.push(JSON.stringify(cust));
fs.writeFileSync(path.join(dir, 'tokens-2026-01-01.jsonl'), lines.join('\n') + '\n');
const out = cp.spawnSync('node', [path.join(__dirname, 'analyze.js')], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
assert.strictEqual(out.status, 0, out.stderr);
const t = out.stdout;
assert(/1 met eigen curve uitgesloten/.test(t), 'token met eigen curve moet uitgesloten worden');
assert(/== 1\. Kosten ==/.test(t) && /break-even/.test(t), 'kostensectie');
assert(/== 2\. TP\/SL-raster/.test(t) && /SL\\TP/.test(t), 'raster');
assert(/Beste instelling op de trainperiode/.test(t), 'train→test keuze');
const sec = t.split('== 3.')[1].split('== 4.')[0];
const hyp = sec.split('sniperShare ≥ 0.5')[1].split('organic')[0];
assert(/verschil -\d/.test(hyp) && /significant/.test(hyp), 'sniper-effect moet significant negatief zijn:\n' + hyp);
assert(/devRugs ≥ 1/.test(sec) && /niet te onderscheiden van toeval/.test(sec.split('devRugs')[1]), 'ruis-kenmerk (devRugs) mag niet significant lijken:\n' + sec);
assert(/Gevolgde wallets/.test(t) && /jaap \(59 tokens gekocht\)/.test(t), 'watchlist-sectie:\n' + t.slice(-900));
// de kostenbewuste ± staat in de uitvoer
assert(/±\d/.test(t));

// scan.js draait op dezelfde data en rapporteert de structuur (train/test, gecorrigeerd interval, context)
const sc = cp.spawnSync('node', [path.join(__dirname, 'scan.js'), '--minn=20'], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
assert.strictEqual(sc.status, 0, sc.stderr);
assert(/strategie-scan/.test(sc.stdout) && /combinaties getest/.test(sc.stdout) && /Context: van alle/.test(sc.stdout), 'scan-uitvoer:\n' + sc.stdout);

// Nulproef: tokens zonder enig voorspellend effect (zuivere willekeurige wandeling, kosten maken ze negatief).
// De scan mag hier geen enkele combinatie "bevestigd" noemen.
{
  const d2 = path.join(os.tmpdir(), 'flint-scan-null-' + process.pid); fs.mkdirSync(d2, { recursive: true });
  const ls = [];
  for (let i = 0; i < 900; i++) {
    const pp = [30]; for (let k = 1; k < 240; k++) pp.push(Math.max(1, pp[k - 1] * (1 + 0.025 * gauss())));
    const f = age => ({ age, buyers: 4 + Math.floor(rnd() * 25), sellers: 2, buyVol: 1 + rnd() * 6, sellVol: 0.5, nBuys: 10, nSells: 3, ratio: 1 + rnd() * 8, mcap: 28 + rnd() * 40,
      run: rnd() * 30, devSold: 0, devBuy: 0.5, topShare: rnd(), buys10: rnd() * 3, sells10: 0.2, mom: rnd() - 0.4, snipers: 1, sniperShare: rnd(), organic: Math.floor(rnd() * 15), devN: 0, devRugs: 0, smart: 0 });
    ls.push(JSON.stringify({ id: 'N' + i, t0: base + i * 60000, step: 2, snaps: [f(20), f(45), f(90), f(180)], path: pp.map(x => +x.toFixed(2)), devSoldAt: null }));
  }
  fs.writeFileSync(path.join(d2, 'tokens-2026-01-01.jsonl'), ls.join('\n') + '\n');
  const nl = cp.spawnSync('node', [path.join(__dirname, 'scan.js'), '--minn=30'], { env: { ...process.env, DATA_DIR: d2 }, encoding: 'utf8' });
  assert.strictEqual(nl.status, 0, nl.stderr);
  assert(!/✔ bevestigd/.test(nl.stdout), 'nulproef: scan vond een strategie in pure ruis:\n' + nl.stdout);
  assert(/Geen enkele gekozen combinatie houdt stand/.test(nl.stdout), 'nulproef: verwacht geen-edge-conclusie:\n' + nl.stdout.slice(-600));
}
console.log('OK, analyze-test geslaagd');
