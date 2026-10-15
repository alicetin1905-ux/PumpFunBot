'use strict';
// Demo-modus: gesimuleerde pump.fun-berichten, zodat je het dashboard kunt bekijken zonder feed.
// Start met:  DEMO=1 DATA_DIR=/tmp/flint-demo node bot.js
const NAMES = ['NEON', 'VOID', 'PEPEX', 'ZETA', 'MOON9', 'GLITCH', 'ORBIT', 'KITSU', 'APEX', 'WAGMI', 'QUARK', 'HYPER', 'NOVA', 'DOGE2', 'CYBER', 'LUNAR', 'PIXEL', 'FLUX'];
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];

function start(handle) {
  const toks = []; let id = 0;
  const msg = (t, type, who, sol) => handle({ txType: type, mint: t.mint, traderPublicKey: who, solAmount: sol,
    vSolInBondingCurve: t.vSol, vTokensInBondingCurve: 1e9, marketCapSol: t.vSol, symbol: t.sym });

  setInterval(() => {
    const kind = Math.random();
    const t = { mint: 'DEMO' + (++id) + Math.random().toString(36).slice(2, 8), sym: pick(NAMES) + (Math.random() < .5 ? '' : Math.floor(rnd(1, 99))),
      dev: 'dev' + id, vSol: 30, born: Date.now(), heat: kind < .25 ? rnd(.75, .92) : kind < .8 ? rnd(.4, .65) : rnd(.15, .35), rug: Math.random() < .12 };
    toks.push(t);
    handle({ txType: 'create', mint: t.mint, symbol: t.sym, traderPublicKey: t.dev, solAmount: rnd(0, 2), vSolInBondingCurve: 30, vTokensInBondingCurve: 1e9, marketCapSol: 30 });
  }, 1400);

  setInterval(() => {
    for (let i = 0; i < 3 && toks.length; i++) {
      const t = pick(toks);
      if (Date.now() - t.born > 100000) continue;
      const buy = Math.random() < t.heat;
      const sol = buy ? rnd(.05, .6) : rnd(.03, .4);
      t.vSol = Math.max(18, t.vSol + (buy ? sol * .35 : -sol * .35));
      if (t.rug && Date.now() - t.born > 25000 && Math.random() < .05) { msg(t, 'sell', t.dev, rnd(1, 3)); t.rug = false; continue; }
      msg(t, buy ? 'buy' : 'sell', 'w' + Math.floor(rnd(0, 40)) + '_' + (t.mint.length % 7), sol);
    }
    while (toks.length > 80) toks.shift();
  }, 220);
}
module.exports = { start };
