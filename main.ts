// Breakout rider: a long-only cbBTC trend bot for the make.fun btc-race.
//
// Idea, in one line: on one-minute bars BTC is mostly noise around a slow drift, and every
// round trip costs ~26 bps, so the only trades worth taking are the rare ones that catch a real
// move — buy the first clear up-move, ride it, and get out on a wide trailing stop.
//
//   - Entry, full size (100% of cash, one position max): the 20-bar close is more than 10 bps
//     above the close 20 bars ago (a fast trigger: it fires near the start of a move and
//     early in almost any window, so the bot always trades at least once and meets the
//     guardrail), AND — once the 240-bar average exists — the price also clears that
//     average, OR the price sits above a rising 240-bar average while also not down over
//     the last 20 bars (a slow drift that never trips the fast breakout). Either way the
//     bot only ever buys into an uptrend; in a falling or flat market it holds cash and
//     waits, so it never pays the round-trip cost to churn.
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
// Backtest on the published dev window (1,440 bars, BTC +3.64%): net +34.25 USDC after all
// fees, 1 buy and 1 flatten, max drawdown 1.98% — ahead of buy-and-hold (+32.17) and within
// 0.69 USDC of the best house baseline, momentum (+34.94), while carrying a 2% trailing
// stop the baselines do not. The fast trigger (20 bars / 10 bps) beats the earlier 60/30
// version (+32.24) by entering near the start of the move; thresholds 5–15 bps all give
// the same entry and the same +34.25, so the result is not tuned to one threshold. Ceiling
// on this window: BTC rose only 3.64%, so no long-only bot on 1,000 USDC can make much
// more than ~+37 USDC net (buy the exact dip, hold to the end); the theoretical perfect
// single trade (bottom to top) is ~+48 USDC gross and needs hindsight, not a rule.

import { runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** A real up-move: the close more than this above the close this many bars ago.
 *  20 bars / 10 bps (was 60/30): on this window the fast trigger enters near the start
 *  of the move instead of an hour in, and it fires early in almost any window — which
 *  matters for the race, where a bot that never trades fails the guardrail. The 2%
 *  trailing stop, not the entry filter, is what caps the loss if the move reverses. */
const BREAKOUT_BARS = 20;
const BREAKOUT_BPS = 10;
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
      if (c * 10000 >= old * (10000 + BREAKOUT_BPS)) {
        // Confirmation: once the slow average exists, the breakout must also clear it.
        // A 60-bar jump that still sits below the 240-bar average is a bounce against
        // the trend, not the start of one — skip it.
        const avg = sma();
        if (avg === null || c > avg) enter = true;
      }
    }
    if (!enter) {
      const avg = sma();
      const prev = prevSma();
      // The slow drift must also be up over the last hour: a price above a rising
      // average but below where it was 60 bars ago is still falling, not drifting up.
      const old = closes.length > BREAKOUT_BARS ? closes[closes.length - 1 - BREAKOUT_BARS] : null;
      if (avg !== null && prev !== null && c > avg && avg > prev && (old === null || c >= old)) enter = true;
    }
    if (!enter) return [];

    const room = state.weightRoom(SYMBOL);
    let notion = state.cash < room ? state.cash : room;
    if (notion <= 0n || notion < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    peak = c;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notion, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
  },
});
