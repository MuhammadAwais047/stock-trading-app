# TICKR — Paper Trading Desk

A stock-trading simulator with a living market: 12 fictional stocks, live price ticks every 2 seconds, candlestick charts with volume, and a full paper-trading loop — watchlist, order ticket, positions with cost-basis P/L, and order history. Everything runs locally; no real money, no APIs, no keys.

**Live demo:** https://muhammadawais047.github.io/stock-trading-app/

## Features

- **Simulated market engine** — 12 fictional companies across 10 sectors, each with its own volatility profile; prices jitter every 2 seconds and every panel (tape, watchlist, chart, positions, KPIs) updates live
- **Deterministic history** — a seeded PRNG generates each symbol's price series backwards from its current price, so bars are coherent across timeframes and identical on every visit
- **Candlestick charts** — hand-built SVG with up/down candles, volume histogram, right-axis price scale, dashed last-price line with a live price pill, crosshair tooltip with OHLCV, and 5 timeframes (1D intraday 5-minute bars through 1Y weekly)
- **Market session realism** — 1D bars follow a 09:30–16:00 session; day change is measured against the previous session's open
- **Watchlist** — 12 symbols with mini sparklines, star/favorite toggles, live prices and day change, instant filter by symbol, name, or sector (`/` focuses search)
- **Order ticket** — buy/sell market orders with share stepper, 25% / 50% / Max sizing, live cost preview, and validation (insufficient buying power, overselling)
- **Confirm dialog** — every order is reviewed before it fills; Escape or Cancel aborts cleanly with no side effects
- **Positions table** — shares, average cost, live price, value, day P/L, and total P/L with percentage; one-click BUY/SELL quick actions that pre-fill the ticket
- **Order history** — every fill logged with side, size, price, total, and timestamp
- **Portfolio KPIs** — total equity, day's P/L, total P/L (with return on invested cost), and buying power
- **Two-step reset** — clears the portfolio back to the $10,000 starting stake with a confirm-to-arm button
- **Persistence** — cash, positions, transactions, stars, and selected symbol survive reloads via `localStorage`
- **Responsive** — three-column desk collapses to stacked chart-first layout on tablet and phone
- **Accessible** — keyboard navigation, ARIA roles, live-region announcements, visible focus, reduced-motion support

## Tech

| Layer | Choice |
|---|---|
| Markup | Single `index.html` |
| Logic | Vanilla JS (IIFE, zero dependencies) |
| Styling | Hand-written CSS with custom properties |
| Charts | Hand-built SVG candlesticks + sparklines |
| Data | `localStorage` JSON |
| Build | None — static files, open and go |

## Run locally

```bash
cd stock-trading-app
python -m http.server 8775
# open http://127.0.0.1:8775/
```

Or serve with any static server. Opening `index.html` directly also works.

## Structure

```
index.html   # topbar, tape, KPIs, desk grid (watchlist/chart/ticket), positions, orders
styles.css   # dark trading theme, responsive breakpoints, reduced motion
app.js       # market engine, chart renderer, trading logic, persistence
```

## How prices work

1. Each symbol gets a deterministic starting price from a seeded PRNG (same on every visit)
2. History bars are generated **backwards** from the live price, so the last candle always closes at the current tape price — every timeframe stays coherent
3. Live ticks jitter prices by a fraction of each stock's volatility every 2 seconds
4. Orders fill instantly at the live price with $0 fee; cost basis and P/L recompute on every tick

## Notes

- The market is entirely fictional — symbols, companies, and prices are all invented
- Clearing site data resets the portfolio to $10,000 cash

## License

[MIT](LICENSE) © 2026 Muhammad Awais
