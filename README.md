# FLINT — pump.fun paper bot

Paper trading bot voor pump.fun (PumpPortal websocket-feed). Start met een virtuele 5 SOL en rekent met
realistische kosten per kant: 1% fee, 2% slippage en een priority fee. Geen wallet, geen keys.

Twee versies:

| Versie | Bestand | Draait |
|---|---|---|
| Browser | `index.html` | alleen terwijl de pagina open staat |
| **Mac 24/7** | `bot.js` + `dashboard.html` | altijd op de achtergrond, herstart zichzelf |

## 24/7 op je Mac

Vereist Node.js 18+ (`brew install node`).

```bash
git clone https://github.com/alicetin1905-ux/PumpFunBot.git
cd PumpFunBot
./install-mac.sh
```

Dashboard: http://127.0.0.1:3000 (alleen bereikbaar vanaf je eigen Mac).

- Start bij inloggen en herstart na een crash (launchd `KeepAlive`).
- `caffeinate -i` voorkomt dat de Mac in slaap valt door inactiviteit zolang de bot draait.
- Toestand (balans, posities, trades, instellingen) staat in `data/state.json` en overleeft herstarts.
- Logs: `tail -f data/out.log`
- Stoppen: `./uninstall-mac.sh` (data blijft staan)
- Updaten: `git pull && ./install-mac.sh`

Let op: een MacBook met gesloten deksel gaat toch slapen. Laat hem open op de lader, of gebruik een Mac mini/iMac.
Zonder internet of tijdens slaap ziet de bot geen prijzen; open posities worden dan na de stale-timeout gesloten.

Test de logica zonder netwerk: `npm test`.

## Strategie

- **Instap:** genoeg unieke kopers, koopvolume en koop/verkoop-ratio, mcap binnen een bereik, token niet al te ver gestegen, dev heeft niet verkocht.
- **Uitstap:** take profit, stop loss, trailing stop, dev-verkoop, max houdtijd of stale feed.
- **Risico:** daglimiet voor verlies, maximaal aantal open posities, reserve.
- Alle waardes zijn aanpasbaar in het dashboard.

## LIVE-poort

De LIVE-knop opent pas na 100+ trades, 3 dagen data, netto positief, profit factor ≥ 1.3 en max drawdown ≤ 20%.
De LIVE-executor is **nog niet gekoppeld**. Een echte wallet hoort nooit in de HTML; dat wordt een aparte executor met een
dedicated wallet met een klein bedrag.

Paper-resultaten zijn optimistischer dan echt handelen (snellere bots, mislukte transacties, hogere slippage).
Geen financieel advies; je kunt je hele inleg verliezen.
