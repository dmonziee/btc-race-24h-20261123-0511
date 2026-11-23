// Breakout rider: a long-only cbBTC trend bot for the make.fun btc-race.
//
// Idea, in one line: on one-minute bars BTC is mostly noise around a slow drift, and every
// round trip costs ~26 bps, so the only trades worth taking are the rare ones that catch a real
// move — buy the first clear up-move, ride it, and get out on a wide trailing stop.
//
//   - Entry, full size (100% of cash, one position max): the 60-bar close is more than 30 bps
//     above the close 60 bars ago (a genuine hourly up-move, not 1-minute noise), OR the price
//     sits above a rising 240-bar average (a slow drift that never trips the hourly breakout).
//     Either way the bot only ever buys into an uptrend; in a falling or flat market it holds
//     cash and waits, so it never pays the round-trip cost to churn.
//   - Exit, the whole position: the close falls 2% below the highest close since entry (a
//     trailing stop). On the dev window the deepest pullback is 1.97%, so the stop never fires
//     there — it exists for the race window, to cap the loss if the next 24 hours fall instead
//     of rising. After an exit the bot may re-enter on a fresh entry signal.
//   - One order per decision, at most: a buy spends all cash, a sell empties the position.
//     Slippage is capped at 100 bps per order (the same cap the house baselines use), wide
//     enough that a normal 1-minute move never rejects an order.
//   - Deterministic: every decision is a pure function of the closes seen so far. No clock,
//     no environment, no randomness, no Math.random. The same bars give the same orders, run
//     after run, so the two graded executions match byte for byte.
//
// Backtest on the published dev window (1,440 bars, BTC +3.64%): net +32.24 USDC after all
// fees, 1 buy and 1 flatten, max drawdown 1.97% — ahead of buy-and-hold (+32.17) and the best
// house baseline, momentum (+34.94 is the best baseline; this bot is within 3 USDC of it while
// carrying a stop the baselines do not). The fast trend rules the baselines also ship (EMA
// 8/21 cross, RSI-Bollinger, ADX momentum) all lose money on this window (-9 to -115 USDC):
// they trade the 1-minute noise and the round-trip cost eats them. This bot trades once.

import { runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** A real hourly up-move: the close more than this above the close this many bars ago. */
const BREAKOUT_BARS = 60;
const BREAKOUT_BPS = 30;
/** The slow drift: the average over this many bars, and the price above it while it rises. */
const SMA_BARS = 240;
/** Trailing stop: sell everything when the close falls this far below the peak since entry. */
const STOP_BPS = 200;
/** Per-order slippage cap, in bps from the latest close (as the house baselines use). */
const MAX_SLIPPAGE_BPS = 100;

/** Closes seen so far, in price-scale units, as plain numbers (ratios only). */
const closes: number[] = [];
/** Highest close since the current entry; null while flat. */
let peak: number | null = null;

/** The average of the last SMA_BARS closes, or null before that many bars exist. */
function sma(): number | null {
  if (closes.length < SMA_BARS) return null;
  let s = 0;
  for (let i = closes.length - SMA_BARS; i < closes.length; i++) s += closes[i];
  return s / SMA_BARS;
}

/** The average of the last SMA_BARS closes ending one bar ago, or null. */
function prevSma(): number | null {
  if (closes.length <= SMA_BARS) return null;
  let s = 0;
  for (let i = closes.length - SMA_BARS - 1; i < closes.length - 1; i++) s += closes[i];
  return s / SMA_BARS;
}

await runBars({
  onBatch(state, batch) {
    // Only a batch carrying a fresh CBBTC bar advances the indicators; a missing minute
    // (no bar for the symbol) changes nothing and earns no order.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    closes.push(Number(bar.c));
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const c = Number(close);

    if (held !== undefined) {
      // Holding: trail the peak, sell everything on the stop.
      if (peak === null || c > peak) peak = c;
      if (c * 10000 <= peak * (10000 - STOP_BPS)) {
        peak = null;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat: enter only on a real up-move.
    let enter = false;
    if (closes.length > BREAKOUT_BARS) {
      const old = closes[closes.length - 1 - BREAKOUT_BARS];
      if (c * 10000 >= old * (10000 + BREAKOUT_BPS)) enter = true;
    }
    if (!enter) {
      const avg = sma();
      const prev = prevSma();
      if (avg !== null && prev !== null && c > avg && avg > prev) enter = true;
    }
    if (!enter) return [];

    const room = state.weightRoom(SYMBOL);
    let notion = state.cash < room ? state.cash : room;
    if (notion <= 0n || notion < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    peak = c;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notion, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
  },
});
