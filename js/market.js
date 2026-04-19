'use strict';

/* =====================================================================
   market.js — Order, Trade, OrderBook, Market

   A continuous double auction is implemented as:
     1. Two sorted arrays (bids, asks) with price-time priority.
     2. On every inbound order, match greedily against the opposite side
        at the *resting* order's price until no cross remains.
     3. Whatever quantity is left over is inserted into the book.

   The Market also owns append-only history arrays (priceHistory, trades,
   volumeByPeriod, dividendHistory). Nothing is ever mutated or removed
   from these arrays, which is what lets Replay reconstruct any past
   tick by slicing to a recorded length.
   ===================================================================== */

class Order {
  constructor(agentId, side, price, quantity, timestamp, period) {
    this.id        = Order.nextId++;
    this.agentId   = agentId;
    this.side      = side;       // 'bid' | 'ask'
    this.price     = price;
    this.quantity  = quantity;
    this.remaining = quantity;
    this.timestamp = timestamp;  // tick number when submitted
    this.period    = period;
  }
}
Order.nextId = 1;

class Trade {
  constructor(bidOrder, askOrder, price, quantity, timestamp, period, round) {
    this.id         = Trade.nextId++;
    this.buyerId    = bidOrder.agentId;
    this.sellerId   = askOrder.agentId;
    this.bidOrderId = bidOrder.id;
    this.askOrderId = askOrder.id;
    this.price      = price;
    this.quantity   = quantity;
    this.timestamp  = timestamp;
    this.period     = period;
    this.round      = round;
  }
}
Trade.nextId = 1;

/**
 * Price-time priority order book.
 *   bids: sorted descending by price, ascending by timestamp
 *   asks: sorted ascending  by price, ascending by timestamp
 * A linear insert is O(n) but n is tiny (<= a few dozen resting orders
 * at any time in this sim), which keeps the implementation dead simple.
 */
class OrderBook {
  constructor() {
    this.bids = [];
    this.asks = [];
  }

  insert(order) {
    if (order.side === 'bid') {
      const idx = this.bids.findIndex(o =>
        o.price < order.price ||
        (o.price === order.price && o.timestamp > order.timestamp)
      );
      if (idx === -1) this.bids.push(order);
      else this.bids.splice(idx, 0, order);
    } else {
      const idx = this.asks.findIndex(o =>
        o.price > order.price ||
        (o.price === order.price && o.timestamp > order.timestamp)
      );
      if (idx === -1) this.asks.push(order);
      else this.asks.splice(idx, 0, order);
    }
  }

  bestBid() { return this.bids[0] || null; }
  bestAsk() { return this.asks[0] || null; }

  removeFilled() {
    this.bids = this.bids.filter(o => o.remaining > 0);
    this.asks = this.asks.filter(o => o.remaining > 0);
  }

  clear() { this.bids = []; this.asks = []; }
}

/* Complex-dividend distribution used when the Advanced → "Complex
 * Dividends" toggle is ON. Five outcomes with non-equal probabilities;
 * the weighted mean is exactly 10¢ (= 0·0.30 + 4·0.25 + 10·0.20 + 20·0.15
 * + 40·0.10), matching `dividendMean` so FV_t = 10·(T−t+1) is unchanged.
 * The whole point is that the distribution's *shape* is non-trivial: a
 * human subject cannot read that mean off the table at a glance, which
 * motivates the matching bounded-rationality prior in UtilityAgent. */
const COMPLEX_DIVIDEND_DISTRIBUTION = [
  { value:  0, prob: 0.30 },
  { value:  4, prob: 0.25 },
  { value: 10, prob: 0.20 },
  { value: 20, prob: 0.15 },
  { value: 40, prob: 0.10 },
];

/**
 * Market — owns the book, the dividend process, and the append-only
 * time-series arrays used for charts and replay.
 *
 * The asset pays a per-period dividend d ∈ {0, 2·μ} with p = 0.5, so
 * E[d] = μ (configured as `dividendMean`, default 10). Fundamental value
 * at the *start* of period t is FV_t = μ × (T − t + 1): the remaining
 * expected dividend stream. After period T's dividend is paid the asset
 * is worthless.
 *
 * DLM 2005 nests T periods inside a *session* of `roundsPerSession`
 * consecutive markets ("rounds"). The Market therefore also tracks a
 * 1-indexed `round` counter; FV resets at the start of every round so
 * `priceHistory.fv` traces the saw-tooth in Figure 1 of the paper. The
 * per-period volume series is sized for the full session (rounds ×
 * periods + 2) and indexed by a global period
 * `g = (round − 1) · periods + period`, so a single array spans every
 * round end-to-end with no per-round slicing.
 */
class Market {
  constructor(config) {
    this.config          = config;
    this.book            = new OrderBook();
    this.trades          = [];
    this.priceHistory    = [];                                     // { tick, period, round, price, fv, bid, ask }
    const sessionPeriods = (config.roundsPerSession || 1) * config.periods;
    this.volumeByPeriod  = new Array(sessionPeriods + 2).fill(0);
    this.dividendHistory = [];                                     // { period, round, value }
    this.round           = 1;
    this.period          = 1;
    this.tick            = 0;
    this.lastPrice       = null;
  }

  /** Global 1-indexed period across the full session. */
  sessionPeriod(period = this.period, round = this.round) {
    return (round - 1) * this.config.periods + period;
  }

  fundamentalValue(period = this.period) {
    const remaining = Math.max(0, this.config.periods - period + 1);
    return this.config.dividendMean * remaining;
  }

  /**
   * Submit an order, matching it greedily against the book first and
   * resting any remainder. Validates that the submitting agent has the
   * cash / inventory to cover the worst-case fill; otherwise the order
   * is rejected entirely (returns []).
   */
  submitOrder(order, agent) {
    if (order.side === 'ask') {
      if (agent.inventory < order.remaining) return [];
    } else {
      if (agent.cash < order.price * order.remaining) return [];
    }
    const fills = this._match(order);
    if (order.remaining > 0) this.book.insert(order);
    return fills;
  }

  /**
   * Match against the opposite side. Self-match prevention: if the best
   * opposite order is from the same agent, we cancel that resting order
   * and continue to the next level (standard exchange behavior for
   * wash-trade prevention).
   */
  _match(order) {
    const fills = [];
    while (order.remaining > 0) {
      const side = order.side === 'bid' ? this.book.asks : this.book.bids;
      if (!side.length) break;
      const best = side[0];
      const crosses = order.side === 'bid'
        ? best.price <= order.price
        : best.price >= order.price;
      if (!crosses) break;
      if (best.agentId === order.agentId) {
        // Self-match: cancel the resting order, try the next level.
        side.shift();
        continue;
      }
      const qty   = Math.min(order.remaining, best.remaining);
      const price = best.price;                  // trade at the resting price
      order.remaining -= qty;
      best.remaining  -= qty;
      if (order.side === 'bid') {
        fills.push(new Trade(order, best, price, qty, this.tick, this.period, this.round));
      } else {
        fills.push(new Trade(best, order, price, qty, this.tick, this.period, this.round));
      }
    }
    this.book.removeFilled();
    return fills;
  }

  /** Apply a list of executed trades: settle cash/inventory, update series. */
  applyTrades(trades, agents) {
    for (const t of trades) {
      this.trades.push(t);
      this.lastPrice = t.price;
      this.volumeByPeriod[this.sessionPeriod()] += t.quantity;
      const buyer  = agents[t.buyerId];
      const seller = agents[t.sellerId];
      buyer.cash       -= t.price * t.quantity;
      buyer.inventory  += t.quantity;
      seller.cash      += t.price * t.quantity;
      seller.inventory -= t.quantity;
    }
  }

  /**
   * Draw the common dividend and credit every holder.
   *
   * The baseline process is DLM 2005's {0, 2μ} coin flip. When the
   * Advanced → "Complex Dividends" toggle is ON (read from ctx.tunables)
   * the draw switches to the 5-point distribution in
   * COMPLEX_DIVIDEND_DISTRIBUTION — same mean, harder-to-compute
   * weighted sum.
   */
  payDividend(agents, rng = Math.random, ctx = null) {
    const useComplex = !!(ctx && ctx.tunables && ctx.tunables.applyComplexDividends);
    let d;
    if (useComplex) {
      const r = rng();
      let acc = 0;
      d = COMPLEX_DIVIDEND_DISTRIBUTION[COMPLEX_DIVIDEND_DISTRIBUTION.length - 1].value;
      for (const bucket of COMPLEX_DIVIDEND_DISTRIBUTION) {
        acc += bucket.prob;
        if (r < acc) { d = bucket.value; break; }
      }
    } else {
      const hi = this.config.dividendMean * 2;
      d = rng() < 0.5 ? 0 : hi;
    }
    for (const a of Object.values(agents)) a.cash += d * a.inventory;
    this.dividendHistory.push({ period: this.period, round: this.round, value: d });
    return d;
  }

  /** Record a per-tick point for the price-over-time series. */
  recordTick() {
    this.priceHistory.push({
      tick:   this.tick,
      period: this.period,
      round:  this.round,
      price:  this.lastPrice,
      fv:     this.fundamentalValue(),
      bid:    this.book.bestBid() ? this.book.bestBid().price : null,
      ask:    this.book.bestAsk() ? this.book.bestAsk().price : null,
    });
  }
}
