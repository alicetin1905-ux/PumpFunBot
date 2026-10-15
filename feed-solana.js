'use strict';
/* Gratis pump.fun-feed rechtstreeks van de Solana-blockchain (geen PumpPortal, geen API-key).

   Hoe: via een Solana RPC-websocket (`logsSubscribe`, filter op het pump.fun-programma) ontvangen we de logs van
   elke pump.fun-transactie. Daarin staan de Anchor-events als "Program data: <base64>":
     - CreateEvent  → nieuwe token (naam, symbol, mint, dev-wallet)
     - TradeEvent   → elke koop/verkoop (mint, SOL, tokens, koper/verkoper, nieuwe curve-reserves)
   Die worden hier omgezet naar hetzelfde berichtformaat als PumpPortal (txType, mint, solAmount, …),
   zodat de rest van de bot niets hoeft te weten van de bron.

   Event-indeling (Anchor; de eerste velden zijn stabiel, nieuwere versies voegen er achteraan velden aan toe):
     TradeEvent : disc(8) mint(32) sol_amount(u64) token_amount(u64) is_buy(u8) user(32) timestamp(i64)
                  virtual_sol_reserves(u64) virtual_token_reserves(u64) real_sol_reserves(u64) real_token_reserves(u64)
                  fee_recipient(32) fee_basis_points(u64) fee(u64) creator(32) creator_fee_basis_points(u64) creator_fee(u64) …
                  (live: gewone gebruikers betalen 95 + 30 bps = 1,25%; enkele vrijgestelde wallets 0)
     CreateEvent: disc(8) name(str) symbol(str) uri(str) mint(32) bonding_curve(32) user(32)
                  creator(32) timestamp(i64) virtual_token_reserves(u64) virtual_sol_reserves(u64) real_token_reserves(u64) token_supply(u64) …
                  (CreateV2-tokens kunnen met andere startreserves beginnen dan 30 SOL; live gezien van 0,01 tot 700+ SOL)
   De discriminators zijn sha256("event:<Naam>")[0..8] (Anchor-standaard). */
const crypto = require('crypto');
const WebSocket = require('ws');

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const disc = n => crypto.createHash('sha256').update('event:' + n).digest().subarray(0, 8);
const TRADE = disc('TradeEvent'), CREATE = disc('CreateEvent');

/* ---- base58 (alleen nodig voor het mint-adres bij een nieuwe token) ---- */
const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) {
  let n = BigInt('0x' + (buf.length ? Buffer.from(buf).toString('hex') : '0')), out = '';
  while (n > 0n) { out = ALPHA[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}
function b58decode(s) {
  let n = 0n; for (const ch of s) { const i = ALPHA.indexOf(ch); if (i < 0) throw new Error('ongeldige base58'); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let zeros = 0; for (const ch of s) { if (ch === '1') zeros++; else break; }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

const u64 = (b, o) => Number(b.readBigUInt64LE(o));
function readStr(b, o) {
  if (o + 4 > b.length) throw new Error('string buiten buffer');
  const len = b.readUInt32LE(o);
  if (len > 400 || o + 4 + len > b.length) throw new Error('onredelijke stringlengte');
  return [b.subarray(o + 4, o + 4 + len).toString('utf8'), o + 4 + len];
}

/* Zet één "Program data"-buffer om naar een bericht in PumpPortal-formaat.
   ctx.hexToMint: Map(mint-hex → mint-base58) van tokens die we volgen; trades van andere tokens worden genegeerd. */
function decodeEvent(buf, ctx) {
  if (buf.length < 8) return null;
  const d = buf.subarray(0, 8);
  if (d.equals(TRADE)) {
    if (buf.length < 8 + 113) throw new Error(`TradeEvent te kort (${buf.length} bytes)`);
    const mintHex = buf.subarray(8, 40).toString('hex');
    const mint = ctx.hexToMint.get(mintHex);
    if (!mint) return null; // token die we niet volgen: negeren zonder verdere kosten
    const isBuy = buf[56];
    if (isBuy > 1) throw new Error('is_buy ongeldig');
    const sol = u64(buf, 40), tok = u64(buf, 48), vSol = u64(buf, 97), vTok = u64(buf, 105);
    // Live gezien: trades met sol_amount = 0 en virtual_sol_reserves = 0 (tokenbeweging zonder SOL, geen markttrade). Overslaan, geen formaatfout.
    if (!(vSol > 0 && vTok > 0)) return null;
    const vSolH = vSol / 1e9, vTokH = vTok / 1e6;
    // Totaal tarief (protocol + creator) in basispunten; alleen als het event lang genoeg is en de fee klopt met het bedrag.
    let feeBps;
    if (buf.length >= 217) {
      const fb = u64(buf, 161), cb = u64(buf, 209);
      if (fb <= 500 && cb <= 500) feeBps = fb + cb;
    }
    return { txType: isBuy ? 'buy' : 'sell', mint, solAmount: sol / 1e9, tokenAmount: tok / 1e6, feeBps,
      traderPublicKey: buf.subarray(57, 89).toString('hex'),
      vSolInBondingCurve: vSolH, vTokensInBondingCurve: vTokH, marketCapSol: vSolH / vTokH * 1e9 };
  }
  if (d.equals(CREATE)) {
    let o = 8, name, symbol, uri;
    [name, o] = readStr(buf, o); [symbol, o] = readStr(buf, o); [uri, o] = readStr(buf, o);
    if (o + 96 > buf.length) throw new Error('CreateEvent te kort');
    const mintBuf = buf.subarray(o, o + 32), user = buf.subarray(o + 64, o + 96).toString('hex');
    const mint = b58encode(mintBuf);
    ctx.hexToMint.set(mintBuf.toString('hex'), mint);
    // Startreserves van de curve staan in het event zelf. Standaard: 30 SOL / 1.073B tokens; valt terug daarop als het event korter is.
    let vSolH = 30, vTokH = 1073000000, custom = false;
    const t = o + 96 + 32 + 8; // na user, creator, timestamp
    if (t + 16 <= buf.length) {
      const vt = u64(buf, t), vs = u64(buf, t + 8);
      if (vt > 0 && vs > 0) { vTokH = vt / 1e6; vSolH = vs / 1e9; custom = Math.abs(vSolH - 30) > 0.5 || Math.abs(vTokH - 1073000000) > 1; }
    }
    return { txType: 'create', mint, symbol, name, traderPublicKey: user, solAmount: 0, customCurve: custom,
      vSolInBondingCurve: vSolH, vTokensInBondingCurve: vTokH, marketCapSol: vSolH / vTokH * 1e9 };
  }
  return null;
}

/* Alle events uit de logs van één transactie. Fouten in één event stoppen de rest niet. */
function decodeLogs(logs, ctx, onError) {
  const out = [];
  for (const line of logs) {
    if (typeof line !== 'string' || !line.startsWith('Program data: ')) continue;
    try { const m = decodeEvent(Buffer.from(line.slice(14), 'base64'), ctx); if (m) out.push(m); }
    catch (e) { if (onError) onError(e); }
  }
  return out;
}

function start({ url, onMessage, onStatus, log }) {
  const ctx = { hexToMint: new Map() };
  const stats = { msgs: 0, trades: 0, creates: 0, customCurves: 0, decodeErrors: 0, lastEventAt: 0 };
  let ws = null, backoff = 1000, stopped = false, lastData = Date.now(), wd = null;

  const open = () => {
    ws = new WebSocket(url);
    ws.on('open', () => {
      backoff = 1000; lastData = Date.now();
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'processed' }] }));
    });
    ws.on('message', buf => {
      lastData = Date.now();
      let j; try { j = JSON.parse(buf.toString()); } catch { return; }
      if (j.error) { log('RPC fout: ' + JSON.stringify(j.error).slice(0, 160)); return; }
      if (j.id === 1 && j.result !== undefined) { onStatus(true); log('Solana feed verbonden (logsSubscribe actief)'); return; }
      if (j.method !== 'logsNotification') return;
      stats.msgs++;
      const v = j.params && j.params.result && j.params.result.value;
      if (!v || v.err || !Array.isArray(v.logs)) return;
      for (const m of decodeLogs(v.logs, ctx, () => { stats.decodeErrors++; })) {
        if (m.txType === 'create') { stats.creates++; if (m.customCurve) stats.customCurves++; } else stats.trades++;
        stats.lastEventAt = Date.now();
        try { onMessage(m); } catch (e) { log('fout in handler: ' + e.message); }
      }
      if (ctx.hexToMint.size > 5000) { const keep = [...ctx.hexToMint].slice(-2500); ctx.hexToMint = new Map(keep); }
    });
    ws.on('close', () => { onStatus(false); if (!stopped) { setTimeout(open, backoff); backoff = Math.min(backoff * 2, 30000); } });
    ws.on('error', e => log('Solana ws fout: ' + e.message));
  };
  open();
  // Als er 45 s niets binnenkomt, is de verbinding waarschijnlijk dood: opnieuw verbinden.
  wd = setInterval(() => { if (ws && Date.now() - lastData > 45000) { log('Solana feed stil, herverbinden'); try { ws.terminate(); } catch { /* */ } lastData = Date.now(); } }, 5000);
  return { stats, restart: () => { try { ws.terminate(); } catch { /* */ } }, stop: () => { stopped = true; clearInterval(wd); try { ws.close(); } catch { /* */ } }, ctx };
}

module.exports = { start, decodeEvent, decodeLogs, b58encode, b58decode, TRADE, CREATE, PUMP_PROGRAM };
