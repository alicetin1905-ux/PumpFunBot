'use strict';
// Simuleert een token-levenscyclus zonder netwerk en controleert entry/exit-logica.
process.env.DATA_DIR = require('os').tmpdir() + '/flint-test-' + process.pid;
const assert = require('assert');
const B = require('./bot.js');
const S = B.getS();

function mk(mint, dev) {
  B.handle({ txType: 'create', mint, symbol: mint, traderPublicKey: dev, vSolInBondingCurve: 30, vTokensInBondingCurve: 1e9, marketCapSol: 30 });
  B.T.get(mint).t0 -= 10000; // 10s oud
}
function buy(mint, who, sol, vSol) {
  B.handle({ txType: 'buy', mint, traderPublicKey: who, solAmount: sol, vSolInBondingCurve: vSol, vTokensInBondingCurve: 1e9, marketCapSol: 30 });
}

// 1) Winnende trade: instap na 6 kopers, daarna +25% -> TP
mk('WIN', 'devA');
for (let i = 0; i < 6; i++) buy('WIN', 'w' + i, 0.4, 30 + 0.1 * (i + 1));
assert(S.pos.WIN, 'positie moet geopend zijn');
const balAfterBuy = S.bal;
assert(balAfterBuy < 5, 'balans moet gedaald zijn');
buy('WIN', 'w9', 0.4, 40);
assert(!S.pos.WIN && S.hist[0].why === 'TP', 'TP verwacht, kreeg: ' + (S.hist[0] && S.hist[0].why));
console.log('TP-trade pnl SOL:', S.hist[0].pnl.toFixed(4));

// 2) Stop loss
mk('LOSS', 'devB');
for (let i = 0; i < 6; i++) buy('LOSS', 'l' + i, 0.4, 30 + 0.1 * (i + 1));
assert(S.pos.LOSS);
buy('LOSS', 'l9', 0.1, 28);
assert(!S.pos.LOSS && S.hist[0].why === 'SL', 'SL verwacht, kreeg: ' + (S.hist[0] && S.hist[0].why));

// 3) Dev verkoopt -> geen instap, of directe exit
mk('RUG', 'devC');
B.handle({ txType: 'sell', mint: 'RUG', traderPublicKey: 'devC', solAmount: 1, vSolInBondingCurve: 29, vTokensInBondingCurve: 1e9, marketCapSol: 30 });
for (let i = 0; i < 8; i++) buy('RUG', 'r' + i, 0.4, 30);
assert(!S.pos.RUG, 'geen instap bij dev-sell');

// 4) Te weinig kopers -> geen instap
mk('THIN', 'devD');
for (let i = 0; i < 3; i++) buy('THIN', 't' + i, 1, 30.5);
assert(!S.pos.THIN, 'geen instap bij te weinig kopers');

// 5) Boekhouding klopt: balans + posities == equity, fees > 0
assert.strictEqual(S.totalTrades, 2);
assert(S.fees > 0);
assert(Math.abs(S.bal - (5 + S.hist.reduce((a, x) => a + x.pnl, 0))) < 1e-9, 'balans = start + som pnl');
console.log('OK, alle tests geslaagd. Balans:', S.bal.toFixed(4));
process.exit(0);
