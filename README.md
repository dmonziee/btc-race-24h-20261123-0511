# Breakout Rider — a cbBTC trend bot

A long-only trading bot that races Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute, on its on-chain prices. Paper money only: it starts with 1,000 USDC of simulated capital and nothing is traded for real.

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/dmonziee/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/dmonziee/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

## Strategy

On one-minute bars BTC is mostly noise around a slow drift, and every round trip costs about 26 bps in fees, slippage and price impact — so the only trades worth taking are the rare ones that catch a real move. The bot buys the first clear up-move at full size, rides it, and gets out on a wide trailing stop:

- **Entry:** the 60-bar close is more than 30 bps above the close 60 bars ago (a genuine hourly up-move), or the price sits above a rising 240-bar average (a slow drift that never trips the hourly breakout). In a falling or flat market it holds cash and waits.
- **Exit:** the close falls 2% below the highest close since entry (trailing stop). After an exit it may re-enter on a fresh signal.
- **Size:** one position max, 100% of cash on entry, the whole position on exit. At most one order per bar.

## Results on the dev window

Net **+32.24 USDC** after all fees on the published 24-hour dev window (1,440 bars, BTC +3.64%), with 1 buy and the final flatten, max drawdown 1.97% — ahead of buy-and-hold (+32.17 USDC) and within 3 USDC of the best house baseline, momentum (+34.94 USDC), while carrying a stop the baselines do not. The fast trend rules (EMA 8/21 cross, RSI-Bollinger, ADX momentum) all lose money on this window (-9 to -115 USDC): they trade the 1-minute noise and the round-trip cost eats them.

The bot is fully deterministic: every decision is a pure function of the closes seen so far — no clock, no environment, no randomness — so its two graded executions match byte for byte.

## Run it

```sh
node main.ts
```

It speaks `agent-fun/bars-replay/v1` on stdin/stdout (newline-delimited JSON), via the `vendor/makefun-bars.ts` shim. Grade it locally with the kit's grader:

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```
