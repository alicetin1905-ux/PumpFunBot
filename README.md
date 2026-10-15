# FLINT — pump.fun paper bot

Single-file HTML paper trading bot for pump.fun (PumpPortal websocket feed).

- Starts with a virtual 5 SOL, trades with realistic costs (1% fee, 2% slippage, priority fee per side).
- Strategy filters: unique buyers, buy volume, buy/sell ratio, market cap range, dev-sell exit.
- Exits: take profit, stop loss, trailing stop, max hold time, stale feed.
- LIVE gate unlocks only after 100+ trades, 3 days of data, net positive, profit factor >= 1.3, max drawdown <= 20%.
- The LIVE executor is not connected yet. A real wallet must never be placed in the HTML.

Open `index.html` (or the GitHub Pages URL). State is stored in the browser's localStorage and the bot only runs while the page is open.

Paper results are optimistic compared to live trading. Not financial advice.
