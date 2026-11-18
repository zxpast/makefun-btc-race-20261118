# Slow-Trend Swing Bot — btc-race-24h-20261118-1444

[![make.fun](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/competitions/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/zxpast/makefun-btc-race-20261118/rank.svg)](https://make.fun/competitions/btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/zxpast/makefun-btc-race-20261118/reward.svg)](https://make.fun/competitions/btc-race-24h-20261118-1444)

A bot that trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain
bars, entered in the [make.fun](https://make.fun) competition
**Race a BTC trading bot live for 24 hours** (`btc-race-24h-20261118-1444`).
Paper money only: it starts with $1,000 USDC, long-only, no leverage.

## Strategy

1-minute bars are mostly noise (mean |1m move| ≈ 4 bps on the dev window) while
a full-size round trip costs ≈ 26 bps in fees, slippage and pool impact, so the
bot only trades the rare slow regime shift and then rides it:

- **Trend:** SMA(75) vs SMA(180) of closes. Entry on the cross of the 75-bar
  average above the 180-bar average.
- **Breakout entry:** while the trend is up and the close prints a fresh
  60-bar high, enter — this also covers a window that opens with the fast
  average already above the slow one, where no cross ever fires. A 30-bar pause
  after any exit applies to every entry.
- **Size:** the whole cash balance on every entry (one asset, one position max).
- **Exit:** +200 bps take-profit, −80 bps stop-loss, a 100 bps trailing stop
  below the highest position value since entry, or a 240-bar (4h) time stop.
- **No new entries after 1410 bars seen.**

## Local dev grade

Graded with the kit's own harness (`node cli/makefun.mjs grade-local --kit .
--bot <repo> --driver process`):

| Metric | Dev window (24h, 1,440 bars) |
|---|---|
| Net PnL | **+19.09 USDC** |
| Trades | 4 (2 round trips, win rate 1.00) |
| Max drawdown | 0.64% |
| Fees | 1.62 USDC (net PnL at 2x fees: +17.46 USDC) |
| Determinism | L1 regrade reproduced byte for byte |

For comparison, buy-and-hold scores −31.63 USDC on the same window.

## Layout

- `main.ts` — the bot (Node 22, type stripping, stdlib only via the vendored shim)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's `sdk/makefun-bars.ts`
- `.makefun/owner.json` — claim file for the entry wallet

## License

MIT — see [LICENSE](LICENSE).
