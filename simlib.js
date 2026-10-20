'use strict';
/* Gedeelde rekenregels voor analyze.js en scan.js: kostenmodel, uitstap-simulatie op het vastgelegde prijspad, statistiek. */
const fs = require('fs'), path = require('path');

function loadRecs(dir) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^tokens-.*\.jsonl$/.test(f)).sort() : [];
  const recs = [];
  for (const f of files) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!l.trim()) continue; try { recs.push(JSON.parse(l)); } catch { /* beschadigde regel */ }
  }
  return recs;
}
// Tokens met een eigen startcurve (CreateV2, vSol0 ≠ 30 SOL) hebben andere mcap-/prijsschalen: apart houden.
const isCustom = r => r.vSol0 > 0 && Math.abs(r.vSol0 - 30) > 0.5;

/* o: { fee, slip, impact (% per kant), prio (SOL per kant), size (SOL), lat (s) } */
function makeSim(o = {}) {
  const C = { fee: (o.fee ?? 1.25) / 100, slip: (o.slip ?? 1) / 100, impact: (o.impact ?? 0.8) / 100 };
  const SIZE = o.size ?? 0.25, PRIO = o.prio ?? 0.0008, LAT = o.lat ?? 1;
  const PRIO_RT = 2 * PRIO / SIZE, COST_RT = 2 * (C.fee + C.slip + C.impact) + PRIO_RT;
  /* Netto rendement van één token bij gegeven uitstapregels (zelfde volgorde van checks als de bot).
     ex: { tp, sl, hold, trail, trailStart } — null als het prijspad te kort is. */
  function sim(r, s, ex) {
    const step = r.step || 2, p = r.path || [];
    const i0 = Math.ceil((s.age + LAT) / step);
    if (i0 >= p.length - 1 || !(p[i0] > 0)) return null;
    const entry = p[i0] * (1 + C.impact + C.slip);
    const iMax = Math.min(p.length - 1, i0 + Math.floor(ex.hold / step));
    const iDev = r.devSoldAt != null ? Math.ceil((r.devSoldAt + LAT) / step) : Infinity;
    let exit = p[iMax], peak = p[i0];
    for (let i = i0 + 1; i <= iMax; i++) {
      if (p[i] > peak) peak = p[i];
      const g = (p[i] / entry - 1) * 100, pk = (peak / entry - 1) * 100;
      if (i >= iDev || g >= ex.tp || g <= -ex.sl || (ex.trail > 0 && pk >= ex.trailStart && p[i] <= peak * (1 - ex.trail / 100))) { exit = p[i]; break; }
    }
    return ((1 - C.fee) / entry) * exit * (1 - C.impact - C.slip) * (1 - C.fee) - 1 - PRIO_RT;
  }
  return { sim, C, SIZE, PRIO, LAT, PRIO_RT, COST_RT };
}

function stat(rs, key = 'ret') {
  const n = rs.length; if (!n) return { n: 0, win: 0, avg: 0, ci: 0, sd: 0 };
  const avg = rs.reduce((a, x) => a + x[key], 0) / n;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, x) => a + (x[key] - avg) ** 2, 0) / (n - 1)) : 0;
  return { n, win: rs.filter(x => x[key] > 0).length / n, avg, sd, ci: 1.96 * sd / Math.sqrt(n) };
}
module.exports = { loadRecs, isCustom, makeSim, stat };
