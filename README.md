# FLINT — pump.fun paper bot

Paper trading bot voor pump.fun op een live feed (standaard gratis, rechtstreeks van Solana), met virtueel geld (start: 5 SOL).
Geen wallet, geen keys, geen echt geld.

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

### Dashboard op je iPhone

Standaard is het dashboard alleen bereikbaar op de Mac zelf. Voor je iPhone zet je in `.env` een wachtwoord en open je de poort:

```
HOST=0.0.0.0
DASH_TOKEN=kies-een-lang-willekeurig-wachtwoord
```

Daarna `./install-mac.sh` opnieuw draaien (of `launchctl kickstart -k gui/$(id -u)/com.flint.pumpbot`). **Zonder `DASH_TOKEN` negeert de bot `HOST` en blijft hij lokaal**, zodat je het nooit per ongeluk onbeveiligd openzet.

- **Thuis, zelfde wifi:** open in Safari `http://<ip-van-je-mac>:3000/?key=<DASH_TOKEN>` (het ip: `ipconfig getifaddr en0`, of de naam `jouwmac.local`). Eenmalig: daarna onthoudt Safari je via een cookie.
- **Overal (aanbevolen):** installeer [Tailscale](https://tailscale.com) op je Mac en je iPhone (gratis, zelfde account). Open dan `http://<mac-naam>:3000/?key=<DASH_TOKEN>`. Het verkeer is versleuteld en er wordt niets op het internet opengezet.
- Zet de poort **nooit** via je router open naar het internet: de verbinding is gewoon http, en het dashboard kan instellingen wijzigen en de account resetten.
- Tip: Safari → Deel → "Zet op beginscherm" geeft je een app-icoon. Het dashboard past zich aan een telefoonscherm aan.

Let op: een MacBook met gesloten deksel gaat toch slapen. Laat hem open op de lader, of gebruik een Mac mini/iMac.
Zonder internet of tijdens slaap ziet de bot geen prijzen; open posities worden dan na de stale-timeout gesloten.

Test de logica zonder netwerk: `npm test`.

## Feed

- **`FEED=solana` (standaard, gratis):** de bot leest pump.fun-transacties rechtstreeks van de blockchain via een Solana RPC-websocket (`logsSubscribe`) en decodeert de Create- en Trade-events. Geen account of key nodig.
- **`FEED=pumpportal`:** nieuwe tokens zijn gratis, maar de trade-stream (kopers, volume, ratio) vereist bij PumpPortal een betaalde API-key. Zonder key blijven kopers/vol/ratio op 0.
- Kopieer `.env.example` naar `.env` om te kiezen. De publieke RPC (`wss://api.mainnet-beta.solana.com`) kan bij veel verkeer afknijpen; een gratis Helius/QuickNode-websocket in `RPC_WSS` is stabieler.
- Het dashboard toont de feed en het aantal trades per seconde (TRADES). Komen er geen trades binnen, dan verschijnt een waarschuwing.
- Het event-formaat is gecontroleerd tegen de live mainnet-feed (okt 2026): Trade- en Create-events decoderen correct (timestamp in het event = blocktime, mints eindigen op `pump`). Trades zonder SOL en zonder reserves (tokenbewegingen, geen markttrades) worden overgeslagen.
- **Curve-varianten:** ~15% van de nieuwe tokens (CreateV2) start niet op de standaardcurve van 30 SOL maar met eigen reserves (live gezien: 0,4 / 1,7 / 726 SOL). De feed leest de startreserves uit het Create-event, dus startprijs en RUN-filter kloppen ook voor deze tokens. In de dataset staat `vSol0` per token, zodat `analyze.js` ze kan scheiden. De mcap-filter (25–60) sluit ze nu al uit. Staat `decodeErr` hoog of blijft de waarschuwing staan, dan is het formaat waarschijnlijk veranderd: meld dat.

## Radar-dashboard

Het dashboard toont live welke tokens gevolgd worden en welke filters ze halen:

- **Filter scan:** per filter hoeveel gevolgde tokens hem nu halen.
- **Token radar:** per token een ring (x/7 filters), zeven chips met de actuele waarde (groen = gehaald, rood = niet, oranje = nog te jong). Een token dat alles haalt krijgt een groene LOCK-gloed. Kaarten schuiven vloeiend naar boven als ze meer filters halen.
- Filter de radar met ALLE / ≥5/7 / KLAAR. Filter-drempels pas je aan onder "Strategie & filters".
- Dezelfde filterfunctie stuurt de bot en het dashboard, dus wat je ziet is precies wat de bot doet.

Voorbeeld zonder feed (gesimuleerde tokens): `DEMO=1 DATA_DIR=/tmp/flint-demo node bot.js`

## Realistische simulatie (v2)

Paper trading is alleen nuttig als het niet te mooi is. Daarom:

- **Bonding-curve fills:** je order loopt over de echte constant-product curve, dus je eigen koop duwt de prijs op en je verkoop drukt hem omlaag.
- **Vertraging:** tussen signaal en fill zit 0,3–0,9 s; je krijgt de prijs van dat moment, niet die van het signaal.
- **Echte fees:** het fee-tarief komt uit de trade-events zelf (nu 0,95% protocol + 0,30% creator = 1,25% per kant) en geldt per token voor koop, verkoop en equity. Vrijgestelde wallets (0%) tellen niet mee. Zonder fee-data (PumpPortal-feed) geldt de instelling "FEE/KANT %" (standaard 1,25; een eerder opgeslagen waarde in `data/state.json` blijft staan, pas die zo nodig aan in het dashboard).
- **Mislukte orders:** standaard 8% van de kopen en 5% van de verkopen mislukt (kost alleen de priority fee, verkopen worden opnieuw geprobeerd).
- **Stale exit met afslag:** een token waar niemand meer in handelt verkoop je niet tegen de laatste prijs (standaard 15% afslag).
- Alles is instelbaar onder "Strategie & filters". Oude paper-resultaten van v1 worden gearchiveerd (`data/state.v1.json`).

## Data en analyse

Elke gevolgde token (met minimaal 3 kopers) wordt vastgelegd in `data/tokens-DATUM.jsonl`: features op 5/10/15/20/30/45/60 s,
het prijspad per 2 s tot 3 minuten, en de uitkomst. Ook tokens die de bot niet kocht, zodat je filters kunt testen zonder
te wachten op live trades. Elke bot-trade komt in `data/trades.jsonl` met zijn instap-features. Oude dagbestanden worden na
10 dagen verwijderd (`keepDays`).

Na een paar dagen draaien:

```bash
npm run analyze                      # standaard: instap ~20 s, TP 12%, SL 8%
npm run analyze -- --age=30 --tp=15 --sl=10 --minn=50
```

Het script simuleert elke token met jouw kosten (fee, slippage, prijsimpact, priority fee, vertraging) en dezelfde uitstapregels als de bot
(TP, SL, trailing stop, dev-verkoop, max houdtijd). Alle kosten zijn instelbaar, bv. `--fee=1.25 --slip=1 --prio=0.0008 --lat=1`. Onderdelen:

1. **Kosten:** wat een rondreis kost (nu ≈ 6,7%) en bij welk winstpercentage je break-even draait. Bij TP 12% / SL 8% is dat ~74%.
2. **TP/SL-raster:** gemiddeld netto resultaat per TP/SL-combinatie, met en zonder trailing, plus de beste instelling op de trainperiode met zijn
   resultaat op de testperiode en een 95%-betrouwbaarheidsinterval (±). Is bijna alles negatief, dan helpt TP/SL-tuning niet en moeten de filters beter.
3. **Wallet- en bundelsignalen:** vier vooraf gekozen hypothesen (geen datamining), gecorrigeerd voor meervoudig toetsen.
4. **Beste filter per kenmerk en combinaties:** train op de eerste 70% (in tijd), test op de laatste 30%.

Alleen een resultaat dat op de test positief blijft **met een interval boven 0** is een serieus kandidaat; de rest is toeval. Tokens met een eigen
curve (zie boven) worden uitgesloten. Pas filters pas aan na bevestiging op nieuwe data.

## Wallet- en bundelsignalen

Per token worden extra kenmerken vastgelegd (in elk snapshot en bij elke trade) en kun je optioneel als filter gebruiken (standaard **uit**,
dus het gedrag van de bot verandert niet tot je ze aanzet onder "Strategie & filters"):

| Kenmerk | Betekenis | Filter (uit = ) |
|---|---|---|
| `snipers`, `sniperShare` | kopers binnen 2 slots (~1 s) na de creatie en hun aandeel van het koopvolume: bundels/snipers, nep-volume | MAX SNIPER-AANDEEL % (100) |
| `organic` | unieke kopers min snipers | MIN ORGANISCHE KOPERS (0) |
| `devN`, `devRugs` | eerdere tokens van dezelfde maker en hoeveel daarvan de maker zelf dumpte | MAX EERDERE MAKER-RUGS (99) |
| `smart` | kopers die eerder vroeg (eerste 30 s) in tokens zaten die minstens verdubbelden (≥3 keer, ≥34%) | MIN SLIMME WALLETS (0) |

Het register staat in `data/wallets.json` (max. 50k makers / 150k wallets, oudste verdwijnen) en leert alleen van afgeronde tokens uit het verleden,
dus er lekt niets vooruit. De sniper-check heeft slot-data nodig en werkt dus alleen met de Solana-feed (`FEED=solana`). Pas een filter pas aan als
sectie 3 van `npm run analyze` een significant effect laat zien op genoeg tokens.

## Strategie

- **Instap:** genoeg unieke kopers, koopvolume en koop/verkoop-ratio, mcap binnen een bereik, token niet al te ver gestegen, dev heeft niet verkocht.
- **Uitstap:** take profit, stop loss, trailing stop, dev-verkoop, max houdtijd of stale feed.
- **Risico:** daglimiet voor verlies, maximaal aantal open posities, reserve.
- Alle waardes zijn aanpasbaar in het dashboard.

## Alleen paper

Er is bewust geen echt-geld-uitvoering. De PAPER-VALIDATIE-checklist in het dashboard (100+ trades, 3 dagen data, netto positief,
profit factor ≥ 1,3, max drawdown ≤ 20%) laat zien wanneer de paper-resultaten betrouwbaar genoeg zijn om iets uit te concluderen.

Paper-resultaten blijven optimistischer dan echt handelen (snellere bots, mislukte transacties, hogere slippage). Geen financieel advies.
