'use strict';

/* =====================================================================
   market.js — Order, Trade, OrderBook, Market.

   Continuous double auction with price-time priority. The Market owns
   the book, an append-only trade log, a bounded price history ring
   buffer, and the hook points where the Engine records per-tick data.

   Dividend generation is delegated to `HMMDividend` — Market no longer
   knows the per-period dividend distribution, only how to pay the
   latest draw to every inventory holder. The fundamental value is NOT
   a deterministic staircase in the counterfactual design; agents must
   estimate it themselves (see estimator.js). The Market still exposes
   `periodsRemaining()` as a primitive the estimators consume.
   ===================================================================== */

class Order {
  constructor(agentId, side, price, quantity, timestamp, period, round) {
    this.id        = Order.nextId++;
    this.agentId   = agentId;
    this.side      = side;
    this.price     = price;
    this.quantity  = quantity;
    this.remaining = quantity;
    this.timestamp = timestamp;
    this.period    = period;
    this.round     = round;
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

class OrderBook {
  constructor() { this.bids = []; this.asks = []; }

  insert(order) {
    if (order.side === 'bid') {
      const idx = this.bids.findIndex(o =>
        o.price < order.price ||
        (o.price === order.price && o.timestamp > order.timestamp));
      if (idx === -1) this.bids.push(order);
      else this.bids.splice(idx, 0, order);
    } else {
      const idx = this.asks.findIndex(o =>
        o.price > order.price ||
        (o.price === order.price && o.timestamp > order.timestamp));
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

class Market {
  constructor(config, hmm) {
    this.config          = config;
    this.hmm             = hmm;
    this.book            = new OrderBook();
    this.trades          = [];
    // priceHistory is kept full-resolution inside a configurable window
    // and downsampled to one-per-tick for long-run aggregates. For N=100
    // runs on a 7 200-tick batch this is still just 7 200 entries, so
    // we keep the append-only contract and let Logger do the downsample.
    this.priceHistory    = [];
    const sessionPeriods = (config.roundsPerSession || 1) * config.periods;
    this.volumeByPeriod  = new Array(sessionPeriods + 2).fill(0);
    this.dividendHistory = [];
    this.round           = 1;
    this.period          = 1;
    this.tick            = 0;
    this.lastPrice       = null;
  }

  sessionPeriod(period = this.period, round = this.round) {
    return (round - 1) * this.config.periods + period;
  }

  periodsRemaining(period = this.period) {
    return Math.max(0, this.config.periods - period + 1);
  }

  submitOrder(order, agent) {
    if (order.side === 'ask' && agent.inventory < order.remaining) return [];
    if (order.side === 'bid' && agent.cash < order.price * order.remaining) return [];
    const fills = this._match(order);
    if (order.remaining > 0) this.book.insert(order);
    return fills;
  }

  _match(order) {
    const fills = [];
    while (order.remaining > 0) {
      const side = order.side === 'bid' ? this.book.asks : this.book.bids;
      if (!side.length) break;
      const best = side[0];
      const crosses = order.side === 'bid' ? best.price <= order.price : best.price >= order.price;
      if (!crosses) break;
      if (best.agentId === order.agentId) { side.shift(); continue; }
      const qty   = Math.min(order.remaining, best.remaining);
      const price = best.price;
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

  /** Draw the HMM dividend, pay every holder, and hand the value to estimators. */
  payDividend(agents, rng) {
    const { dividend, regime } = this.hmm.step(rng);
    for (const a of Object.values(agents)) {
      a.cash += dividend * a.inventory;
      if (typeof a.observeDividend === 'function') a.observeDividend(dividend);
    }
    this.dividendHistory.push({ period: this.period, round: this.round, value: dividend, regime });
    return { dividend, regime };
  }

  /** Record the tick. `fvRef` is the analytical reference FV from the regulator's estimator. */
  recordTick(fvRef) {
    this.priceHistory.push({
      tick:   this.tick,
      period: this.period,
      round:  this.round,
      price:  this.lastPrice,
      fvRef:  fvRef,
      bid:    this.book.bestBid() ? this.book.bestBid().price : null,
      ask:    this.book.bestAsk() ? this.book.bestAsk().price : null,
    });
  }

  /** Volume-weighted average price for the (round, period) pair. */
  vwap(period = this.period, round = this.round) {
    let num = 0, den = 0;
    for (let i = this.trades.length - 1; i >= 0; i--) {
      const t = this.trades[i];
      if (t.period !== period || t.round !== round) {
        if (t.round < round || (t.round === round && t.period < period)) break;
        continue;
      }
      num += t.price * t.quantity;
      den += t.quantity;
    }
    return den ? num / den : null;
  }
}
