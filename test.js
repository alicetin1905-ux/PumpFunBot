'use strict';
// Simuleert token-levenscycli zonder netwerk en controleert de realistische sim + datalogging.
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert'), cp = require('child_process');
process.env.DATA_DIR = path.join(os.tmpdir(), 'flint-test-' + process.pid);
const B = require('./bot.js');
const S = B.getS(), C = S.cfg;
C.latMin = 0; C.latMax = 0; C.failBuy = 0; C.failSell = 0; // eerst deterministisch en synchroon
const sleep = ms => new Promise(r => setTimeout(r, ms));

function mk(mint, dev) {
  B.handle({ txType: 'create', mint, symbol: mint, traderPublicKey: dev, solAmount: 0.5, vSolInBondingCurve: 30, vTokensInBondingCurve: 1e9, marketCapSol: 30 });
  B.T.get(mint).t0 -= 10000; // 10s oud
}
function buy(mint, who, sol, vSol) {
  B.handle({ txType: 'buy', mint, traderPublicKey: who, solAmount: sol, vSolInBondingCurve: vSol, vTokensInBondingCurve: 1e9, marketCapSol: vSol });
}
function heat(mint, tag, n = 6) { for (let i = 0; i < n; i++) buy(mint, tag + i, 0.4, 30 + 0.1 * (i + 1)); }

(async () => {
  // 1) Winnende trade + bonding-curve fill (prijsimpact) + features op de trade
  mk('WIN', 'devA'); heat('WIN', 'w');
  const pos = S.pos.WIN; assert(pos, 'positie moet geopend zijn');
  const spot = 30.6 / 1e9, net = C.size * (1 - C.feePct / 100);
  assert(pos.tokens < net / spot, 'curve-fill moet minder tokens geven dan fill tegen spotprijs (prijsimpact)');
  assert(pos.feat && pos.feat.buyers >= 6, 'features van het instapmoment moeten bewaard zijn');
  buy('WIN', 'w9', 0.4, 40);
  assert(!S.pos.WIN && S.hist[0].why === 'TP', 'TP verwacht, kreeg: ' + (S.hist[0] && S.hist[0].why));
  assert(S.hist[0].peakPct > 0 && S.hist[0].feat, 'trade moet peakPct en feat bevatten');
  assert(B.T.get('WIN').traded && B.T.get('WIN').trade.why === 'TP', 'token blijft gevolgd met uitkomst');
  console.log('TP-trade pnl SOL:', S.hist[0].pnl.toFixed(4));

  // 2) Stop loss
  mk('LOSS', 'devB'); heat('LOSS', 'l');
  assert(S.pos.LOSS);
  buy('LOSS', 'l9', 0.1, 28);
  assert(!S.pos.LOSS && S.hist[0].why === 'SL', 'SL verwacht, kreeg: ' + (S.hist[0] && S.hist[0].why));

  // 2b) Echt fee-tarief uit het trade-event wordt bij koop en verkoop gebruikt; een vrijgestelde wallet (0 bps) overschrijft het niet
  mk('FEE', 'devH');
  const fbuy = (who, sol, vSol, feeBps) => B.handle({ txType: 'buy', mint: 'FEE', traderPublicKey: who, solAmount: sol, vSolInBondingCurve: vSol, vTokensInBondingCurve: 1e9, marketCapSol: vSol, feeBps });
  for (let i = 0; i < 6; i++) fbuy('x' + i, 0.4, 30 + 0.1 * (i + 1), i === 5 ? 0 : 50);
  assert(S.pos.FEE, 'positie verwacht');
  assert.strictEqual(S.pos.FEE.feePct, 0.5, 'tarief 0,5% uit event, kreeg ' + S.pos.FEE.feePct);
  B.close('FEE', 'handmatig');
  assert(!S.pos.FEE && S.hist[0].why === 'handmatig');

  // 2c) Wallet-/bundelsignalen: snipers (zelfde slot), maker-geschiedenis, slimme wallets, opslaan/laden
  {
    const H = (mint, tx, who, sol, vSol, slot) => B.handle({ txType: tx, mint, traderPublicKey: who, solAmount: sol, vSolInBondingCurve: vSol, vTokensInBondingCurve: 1e9, marketCapSol: vSol, slot });
    const create = (mint, dev, slot) => { B.handle({ txType: 'create', mint, symbol: mint, traderPublicKey: dev, solAmount: 0, vSolInBondingCurve: 30, vTokensInBondingCurve: 1e9, marketCapSol: 30, slot }); B.T.get(mint).t0 -= 10000; };
    // snipers: 4 kopers in slot+1, 2 later → aandeel volgt volume
    C.maxSniperShare = 50; C.minOrganic = 3; // filters aan vóór de kopen, zodat dit token geen positie opent
    create('SNP', 'devS', 1000);
    for (let i = 0; i < 4; i++) H('SNP', 'buy', 'sn' + i, 0.5, 30.1 + i / 10, 1001);
    for (let i = 0; i < 2; i++) H('SNP', 'buy', 'og' + i, 0.5, 31 + i / 10, 1010);
    const sn = B.T.get('SNP'); assert(!S.pos.SNP, 'sniper-token wordt niet gekocht');
    assert.strictEqual(sn.snipers.size, 4, 'snipers geteld op slot-verschil');
    const ev = B.evaluate(sn).checks;
    assert(ev.find(x => x.k === 'snipe') && !ev.find(x => x.k === 'snipe').ok, 'sniper-filter moet falen bij 67% sniper-volume');
    assert(!ev.find(x => x.k === 'organic').ok, 'organisch-filter moet falen bij 2 organische kopers');
    C.maxSniperShare = 100; C.minOrganic = 0;
    assert.strictEqual(B.evaluate(sn).checks.length, 7, 'optionele filters staan standaard uit');
    // zonder slot-data (andere feed) geen sniper-telling
    create('NOSLOT', 'devN'); H('NOSLOT', 'buy', 'z1', 0.5, 30.2); assert.strictEqual(B.T.get('NOSLOT').snipers.size, 0);

    // maker: eerste token dumpt de dev → tweede token van dezelfde maker draagt dat in zijn kenmerken
    create('RUG1', 'devR', 2000); H('RUG1', 'buy', 'q1', 0.5, 30.5, 2005); H('RUG1', 'sell', 'devR', 0.5, 29, 2006);
    assert(B.T.get('RUG1').devSold); B.finalize(B.T.get('RUG1'));
    create('RUG2', 'devR', 3000);
    assert.strictEqual(B.T.get('RUG2').devN, 1); assert.strictEqual(B.T.get('RUG2').devRugs, 1);
    C.maxDevRugs = 0; assert(!B.evaluate(B.T.get('RUG2')).checks.find(x => x.k === 'devhist').ok, 'maker met eerdere rug wordt geweigerd'); C.maxDevRugs = 99;

    // slimme wallet: 3x vroeg in een token dat verdubbelt → slim
    for (let i = 0; i < 3; i++) { const m = 'WINW' + i; create(m, 'devW' + i, 4000 + i); H(m, 'buy', 'smartW0', 0.5, 31, 4005 + i); H(m, 'buy', 'mid', 0.5, 70, 4020 + i); B.finalize(B.T.get(m)); }
    assert(B.isSmart('smartW0'), 'wallet met 3/3 winnaars is slim');
    for (let i = 0; i < 3; i++) { const m = 'FLAT' + i; create(m, 'devF' + i, 4100 + i); H(m, 'buy', 'loserW', 0.5, 31, 4105 + i); H(m, 'buy', 'x' + i, 0.5, 33, 4120 + i); B.finalize(B.T.get(m)); }
    assert(!B.isSmart('loserW'), 'wallet die 3x vroeg in niet-verdubbelende tokens zat is niet slim');
    create('SM4', 'devSM', 5000); H('SM4', 'buy', 'smartW0', 0.5, 30.5, 5010);
    C.minSmart = 1; assert(B.evaluate(B.T.get('SM4')).checks.find(x => x.k === 'smart').ok, 'slim-filter ziet de slimme wallet'); C.minSmart = 0;

    // register overleeft herstart
    B.saveRegistry(); const nW = B.REG.wallets.size; B.REG.wallets.clear(); B.REG.creators.clear(); B.loadRegistry();
    assert.strictEqual(B.REG.wallets.size, nW); assert(B.isSmart('smartW0'));
  }

  // 3) Dev verkoopt -> geen instap; te weinig kopers -> geen instap
  mk('RUG', 'devC');
  B.handle({ txType: 'sell', mint: 'RUG', traderPublicKey: 'devC', solAmount: 1, vSolInBondingCurve: 29, vTokensInBondingCurve: 1e9, marketCapSol: 30 });
  for (let i = 0; i < 8; i++) buy('RUG', 'r' + i, 0.4, 30);
  assert(!S.pos.RUG, 'geen instap bij dev-sell');
  mk('THIN', 'devD'); for (let i = 0; i < 3; i++) buy('THIN', 't' + i, 1, 30.5);
  assert(!S.pos.THIN, 'geen instap bij te weinig kopers');

  // 4) Mislukte koop: alleen priority fee kwijt, geen positie
  C.failBuy = 100; const bal0 = S.bal, fees0 = S.fees;
  mk('FAIL', 'devE'); heat('FAIL', 'f');
  assert(!S.pos.FAIL && S.failed >= 1, 'mislukte koop mag geen positie geven');
  assert(Math.abs((bal0 - S.bal) - C.prio * S.failed) < 1e-9 && S.fees > fees0, 'alleen priority fee verloren');
  C.failBuy = 0;

  // 5) Vertraging: fill gebeurt tegen de prijs NA de vertraging, niet tegen de prijs van het signaal
  C.latMin = C.latMax = 60;
  mk('LAT', 'devF'); heat('LAT', 'a');
  assert(!S.pos.LAT && B.T.get('LAT').pendingBuy, 'order moet nog pending zijn');
  buy('LAT', 'a9', 0.4, 31.5); // prijs beweegt tijdens de vertraging
  await sleep(150);
  assert(S.pos.LAT, 'fill moet na de vertraging zijn gebeurd');
  assert(S.pos.LAT.entry > 31e-9, 'fill moet de gestegen prijs gebruiken, entry=' + S.pos.LAT.entry);
  C.latMin = C.latMax = 0; B.close('LAT', 'handmatig');
  assert(!S.pos.LAT && S.hist[0].why === 'handmatig');

  // 6) Stale exit: verkoop met afslag (dode token is niet tegen laatste prijs te verkopen)
  mk('STALE', 'devG'); heat('STALE', 's');
  assert(S.pos.STALE);
  B.T.get('STALE').last -= 60000; B.tick();
  assert(!S.pos.STALE && S.hist[0].why === 'stale', 'stale exit verwacht');
  assert(S.hist[0].pct < -12, 'stale exit moet de afslag bevatten, pct=' + S.hist[0].pct);

  // 7) Datalogging: prijspad + snapshots + uitkomst worden vastgelegd; dode tokens niet
  const w = B.T.get('WIN'); w.t0 -= 100000; B.tick();        // binnen horizon: pad + snapshots
  w.t0 -= 100000; B.tick();                                  // voorbij horizon: finalize
  B.handle({ txType: 'create', mint: 'DEAD', symbol: 'DEAD', traderPublicKey: 'x', vSolInBondingCurve: 30, vTokensInBondingCurve: 1e9, marketCapSol: 30 });
  B.T.get('DEAD').t0 -= 400000; B.tick();
  assert(S.logSkipped >= 1, 'token zonder kopers moet worden overgeslagen');
  B.flushData();
  const f = fs.readdirSync(process.env.DATA_DIR).filter(x => /^tokens-/.test(x));
  assert(f.length === 1, 'één dagbestand verwacht');
  const lines = fs.readFileSync(path.join(process.env.DATA_DIR, f[0]), 'utf8').trim().split('\n').map(JSON.parse);
  const rec = lines.find(x => x.id === 'WIN');
  assert(rec && rec.snaps.length === 7 && rec.path.length > 10 && rec.trade && rec.trade.why === 'TP', 'dataset-record van WIN klopt niet');
  assert(fs.existsSync(path.join(process.env.DATA_DIR, 'trades.jsonl')), 'trades.jsonl verwacht');

  // 8) Boekhouding klopt: balans = start + som pnl - verloren fees van mislukte orders
  const sum = S.hist.reduce((a, x) => a + x.pnl, 0);
  assert(Object.keys(S.pos).length === 0, "open: " + Object.keys(S.pos));
  assert(Math.abs(S.bal - (5 + sum - S.failed * C.prio)) < 1e-9, `balans ${S.bal} vs verwacht ${5 + sum - S.failed * C.prio}`);

  // 9) analyze.js draait zonder crash (met weinig data: nette melding)
  const out = cp.spawnSync('node', ['analyze.js'], { env: process.env, encoding: 'utf8' });
  assert(out.status === 0 && /te weinig data/i.test(out.stdout), 'analyze.js: ' + out.stdout + out.stderr);

  console.log('OK, alle tests geslaagd. Balans:', S.bal.toFixed(4), '| mislukte orders:', S.failed);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
