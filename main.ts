// Slow-trend swing bot for cbBTC/USDC 1-minute bars (agent-fun/bars-replay/v1).
//
// Idea: BTC's 1-minute bars are mostly noise (mean |1m move| ~4 bps on the dev
// window) while a full-size round trip costs ~26 bps in fees, slippage and pool
// impact, so the bot only trades the rare slow regime shift and then rides it
// with a wide trailing stop instead of chopping on every wiggle.
//
//   - Trend: SMA(75) vs SMA(180) of closes. A cross of the 75-bar average above
//     the 180-bar average is the entry signal. Both averages are slow on purpose:
//     on the dev window the fast EMA-cross house bot fires far more often and
//     bleeds fees; the slow cross fired twice in 24h.
//   - Re-entry / breakout entry: while the trend is up (SMA75 above SMA180) and
//     the close prints a fresh 60-bar high, enter. This catches a rally that
//     resumes after an early exit, and also a window that opens with the fast
//     average already above the slow one, where no cross event ever fires.
//     A 30-bar pause after any exit applies to every entry, so a whipsaw cannot
//     re-enter on the very next bar.
//   - Size: the whole cash balance on every entry (one asset, one position max).
//   - Exit, the whole position: +200 bps take-profit on position value vs cost,
//     -80 bps stop-loss, a 100 bps trailing stop below the highest position value
//     seen since entry, or a 240-bar (4h) time stop, whichever comes first.
//   - No new entries after 1410 bars seen: a trade opened at the very end of the
//     window would be flattened at the last close with no time to move.
//   - Every order caps slippage at 150 bps past the close it was decided on.
//
// All decisions use only the bars the harness sends (hello, batch, orders, bar):
// no network, no wall clock, no files, no randomness. SMA sums update by one
// addition and one subtraction per bar in a fixed order, and every exit test is
// exact bigint arithmetic on the harness-reported position cost and value, so two
// runs on the same bars produce byte-identical orders.

import { runBars, type Bar, type BarsState, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Slow-trend averages, in bars. */
const FAST_BARS = 75;
const SLOW_BARS = 180;
/** Re-entry breakout lookback, in bars. */
const BREAKOUT_BARS = 60;
/** Bars to wait after an exit before a re-entry may fire. */
const REENTRY_COOLDOWN_BARS = 30;
/** Take-profit / stop-loss / trailing stop, in basis points of position value. */
const TAKE_PROFIT_BPS = 200n;
const STOP_LOSS_BPS = 80n;
const TRAIL_BPS = 100n;
/** Time stop: exit a position held this many bars. */
const MAX_HOLD_BARS = 240;
/** No new entries once this many bars of the symbol have been seen. */
const NO_ENTRY_AFTER_BARS = 1410;
/** Slippage cap on every order, in bps past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 150;
const BPS = 10000n;

/** Rolling sums and cross memory for one symbol's closes. */
interface Trend {
  closes: number[];
  sumFast: number;
  sumSlow: number;
  prevFast: number | null;
  prevSlow: number | null;
  fast: number | null;
  slow: number | null;
  /** The last BREAKOUT_BARS highs, oldest first. */
  highs: number[];
}

const trend: Trend = {
  closes: [],
  sumFast: 0,
  sumSlow: 0,
  prevFast: null,
  prevSlow: null,
  fast: null,
  slow: null,
  highs: [],
};

/** Bars of the symbol seen so far (drives the entry cutoff and the cooldown). */
let barsSeen = 0;
/** Bars since the last exit, counted on bars of the symbol. */
let lastExitBar = -1000000;
/** Highest position value (quote units) seen since the current entry. */
let peakValue = 0n;
/** Bars the current position has been held. */
let holdBars = 0;
/** Whether a position was held on the previous batch. */
let wasHolding = false;

function pushBar(bar: Bar): void {
  const c = Number(bar.c);
  barsSeen += 1;
  trend.closes.push(c);
  trend.sumFast += c;
  trend.sumSlow += c;
  if (trend.closes.length > FAST_BARS) trend.sumFast -= trend.closes[trend.closes.length - 1 - FAST_BARS];
  if (trend.closes.length > SLOW_BARS) trend.sumSlow -= trend.closes[trend.closes.length - 1 - SLOW_BARS];
  trend.prevFast = trend.fast;
  trend.prevSlow = trend.slow;
  trend.fast = trend.closes.length >= FAST_BARS ? trend.sumFast / FAST_BARS : null;
  trend.slow = trend.closes.length >= SLOW_BARS ? trend.sumSlow / SLOW_BARS : null;
  trend.highs.push(Number(bar.h));
  if (trend.highs.length > BREAKOUT_BARS) trend.highs.shift();
}

/** The entry signal on this bar's close. */
function entrySignal(): boolean {
  if (trend.fast === null || trend.slow === null || trend.prevFast === null || trend.prevSlow === null) return false;
  // A short pause after any exit, whatever the signal, so a whipsaw cannot
  // re-enter on the very next bar.
  if (barsSeen - lastExitBar < REENTRY_COOLDOWN_BARS) return false;
  if (trend.fast > trend.slow && trend.prevFast <= trend.prevSlow) return true;
  if (!(trend.fast > trend.slow)) return false;
  if (trend.highs.length < BREAKOUT_BARS) return false;
  // Breakout entry while the trend is already up: this also covers a window
  // that opens with the fast average already above the slow one, where no cross
  // event ever fires. The close must beat every high of the bars before this one.
  const prevHigh = trend.highs.slice(0, -1).reduce((a, x) => (x > a ? x : a), trend.highs[0]!);
  const close = trend.closes[trend.closes.length - 1]!;
  return close > prevHigh;
}

/** Whether the held position exits on this bar's close. */
function exitSignal(state: BarsState): boolean {
  const held = state.positions.get(SYMBOL);
  if (held === undefined) return false;
  const value = state.value(SYMBOL, held.qty);
  if (value <= 0n || held.cost <= 0n) return false;
  // Take-profit: value at least 200 bps over cost. Stop-loss: 80 bps under cost.
  if (value * BPS >= held.cost * (BPS + TAKE_PROFIT_BPS)) return true;
  if (value * BPS <= held.cost * (BPS - STOP_LOSS_BPS)) return true;
  // Trailing stop: 100 bps below the highest value since entry.
  if (value * BPS <= peakValue * (BPS - TRAIL_BPS)) return true;
  // Time stop.
  if (holdBars >= MAX_HOLD_BARS) return true;
  return false;
}

await runBars({
  onBatch(state, batch) {
    let fresh = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      pushBar(bar);
      fresh = true;
    }
    if (!fresh) return [];
    const held = state.positions.get(SYMBOL);
    const holding = held !== undefined;
    if (holding && !wasHolding) {
      // A buy just filled: start the peak and the hold clock at this value.
      peakValue = state.value(SYMBOL, held.qty);
      holdBars = 0;
    } else if (holding) {
      holdBars += 1;
      const value = state.value(SYMBOL, held.qty);
      if (value > peakValue) peakValue = value;
    } else if (wasHolding) {
      lastExitBar = barsSeen;
      peakValue = 0n;
      holdBars = 0;
    }
    wasHolding = holding;
    if (state.warmingUp) return [];

    const orders: OrderInput[] = [];
    if (holding) {
      if (exitSignal(state)) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        orders.push(sell);
      }
      return orders;
    }
    if (barsSeen > NO_ENTRY_AFTER_BARS) return [];
    if (!entrySignal()) return [];
    const room = state.weightRoom(SYMBOL);
    let notional = state.cash < room ? state.cash : room;
    if (notional <= 0n) return [];
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
    orders.push(buy);
    return orders;
  },
});
