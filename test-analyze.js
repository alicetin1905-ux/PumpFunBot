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
  lines.push(JSON.stringify({ id: 'T' + i, sym: 'T' + i, t0: base + i * 60000, step: 2, snaps: [f(5), f(10), f(20), f(30)], path: path_.map(x => +x.toFixed(2)),
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
// de kostenbewuste ± staat in de uitvoer
assert(/±\d/.test(t));
console.log('OK, analyze-test geslaagd');
