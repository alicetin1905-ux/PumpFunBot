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

## Radar-dashboard

Het dashboard toont live welke tokens gevolgd worden en welke filters ze halen:

- **Filter scan:** per filter hoeveel gevolgde tokens hem nu halen.
- **Token radar:** per token een ring (x/7 filters), zeven chips met de actuele waarde (groen = gehaald, rood = niet, oranje = nog te jong). Een token dat alles haalt krijgt een groene LOCK-gloed. Kaarten schuiven vloeiend naar boven als ze meer filters halen.
- Filter de radar met ALLE / ≥5/7 / KLAAR. Filter-drempels pas je aan onder "Strategie & filters".
- Dezelfde filterfunctie stuurt de bot en het dashboard, dus wat je ziet is precies wat de bot doet.

Voorbeeld zonder feed (gesimuleerde tokens): `DEMO=1 DATA_DIR=/tmp/flint-demo node bot.js`

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
