'use strict';
process.env.DATA_DIR = require('os').tmpdir() + '/flint-feedtest-' + process.pid;
const assert = require('assert'), crypto = require('crypto');
const F = require('./feed-solana.js');
assert.strictEqual(F.TRADE.toString('base64').slice(0, 10), 'vdt/007mYe');
assert.strictEqual(F.CREATE.toString('base64').slice(0, 10), 'G3KpTd7rY3');
assert.strictEqual(F.b58encode(Buffer.alloc(32)), '1'.repeat(32));
assert.strictEqual(F.b58encode(F.b58decode(F.PUMP_PROGRAM)), F.PUMP_PROGRAM);
assert.strictEqual(F.b58decode(F.PUMP_PROGRAM).length, 32);

const w = () => crypto.randomBytes(32);
const str = s => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
const mintBuf = w(), dev = w();
const create = Buffer.concat([F.CREATE, str('Name'), str('SYM<b>'), str('https://x'), mintBuf, w(), dev, Buffer.alloc(40)]);
function trade(buy, user, sol, vSol, vTok) {
  const b = Buffer.alloc(375); F.TRADE.copy(b, 0); mintBuf.copy(b, 8);
  b.writeBigUInt64LE(BigInt(Math.round(sol * 1e9)), 40); b.writeBigUInt64LE(1000000n, 48); b[56] = buy ? 1 : 0; user.copy(b, 57);
  b.writeBigUInt64LE(BigInt(Math.round(vSol * 1e9)), 97); b.writeBigUInt64LE(BigInt(Math.round(vTok * 1e6)), 105); return b;
}
const logs = b => ['Program x invoke', 'Program data: ' + b.toString('base64')];
const ctx = { hexToMint: new Map() }, errs = [];
const msgs = [];
// trade vóór create → onbekende token → genegeerd
assert.strictEqual(F.decodeLogs(logs(trade(1, w(), 1, 31, 1e9)), ctx, e => errs.push(e)).length, 0);
msgs.push(...F.decodeLogs(logs(create), ctx, e => errs.push(e)));
assert.strictEqual(msgs[0].txType, 'create'); assert.strictEqual(msgs[0].mint, F.b58encode(mintBuf));
const m = F.decodeLogs(logs(trade(1, w(), 0.5, 31.5, 1.0e9)), ctx, e => errs.push(e))[0];
assert.strictEqual(m.txType, 'buy'); assert.ok(Math.abs(m.solAmount - 0.5) < 1e-9); assert.ok(Math.abs(m.marketCapSol - 31.5) < 1e-6);
assert.strictEqual(F.decodeLogs(logs(trade(0, w(), 0.5, 31, 1.0e9)), ctx)[0].txType, 'sell');
// kapotte data crasht niet
assert.strictEqual(F.decodeLogs(['Program data: AAAA', 'Program data: ' + F.TRADE.toString('base64')], ctx, e => errs.push(e)).length, 0);
assert.ok(errs.length >= 1);

// Regressietest voor "kopers/vol/ratio blijven 0": 6 verschillende wallets via echte decodeerlaag → bot.handle
const bot = require('./bot.js');
const hm = { hexToMint: new Map() }, out = [];
out.push(...F.decodeLogs(logs(create), hm));
const devBuy = F.decodeLogs(logs(trade(1, dev, 1, 31, 1.0e9)), hm)[0];
for (const x of [...out, devBuy]) bot.handle(x);
for (let i = 0; i < 6; i++) bot.handle(F.decodeLogs(logs(trade(1, w(), 0.4, 32 + i, 0.99e9)), hm)[0]);
const t = bot.T.get(out[0].mint);
assert.ok(t, 'token wordt gevolgd');
assert.strictEqual(t.sym, 'SYMb'); // tekens gesaneerd
assert.strictEqual(t.buyers.size, 6, 'kopers > 0');
assert.ok(t.buyVol > 2.3, 'volume > 0');
assert.ok(Math.abs(t.devBuy - 1) < 1e-9, 'dev-aankoop apart geteld');
console.log('OK, feed-tests geslaagd');
process.exit(0);
