'use strict';

/* =====================================================================
   engine.js — Simulation loop + seeded mulberry32 PRNG.

   Loop structure (per tick):
     1. If regulator has halted trading, skip agent decisions.
     2. Shuffle agent order, call each agent.decide(), submit orders.
     3. Apply fills; Market updates cash/inventory/price series.
     4. Regulator.observe() — may emit warning message.
     5. Market.recordTick(fvRef).
     6. Logger.recordAggregate() + per-agent traces for traced agents.
     7. If tick crosses a period boundary: dividends paid, all agents
        communicate(), trust updated from reports, period++.
     8. If period > T: round_end → reset inventories/cash → round++.
     9. If round > R: session end, onEnd callback.
   ===================================================================== */

function makeRNG(seed) {
  let s = (seed | 0) >>> 0;
  return function mulberry32() {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Engine {
  constructor(market, agents, logger, regulator, trust, config, rng, refEstimator) {
    this.market        = market;
    this.agents        = agents;
    this.agentList     = Object.values(agents);
    this.logger        = logger;
    this.regulator     = regulator;
    this.trust         = trust;
    this.config        = config;
    this.rng           = rng;
    this.refEstimator  = refEstimator;
    this.running       = false;
    this._raf          = null;
    this._lastStep     = 0;
    this._onEnd        = null;
  }

  start(onEnd) {
    this.running  = true;
    this._onEnd   = onEnd;
    this._lastStep = 0;
    this._loop();
  }

  pause() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  stop() { this.pause(); }

  tickOnce() { this._step(); }

  _loop = () => {
    if (!this.running) return;
    const now = performance.now();
    const targetMs = 1000 / (this.config.speed || 14);
    if (now - this._lastStep >= targetMs) {
      this._step();
      this._lastStep = now;
    }
    if (this.running) this._raf = requestAnimationFrame(this._loop);
  };

  _step() {
    const m = this.market;
    const halted = this.regulator && this.regulator.isHalted();

    if (!halted) {
      const order = shuffled(this.agentList, this.rng);
      for (const a of order) {
        const decision = a.decide(m, this.rng, m.tick);
        if (decision && (decision.type === 'bid' || decision.type === 'ask')) {
          const ord   = new Order(a.id, decision.type, decision.price, decision.quantity || 1, m.tick, m.period, m.round);
          const fills = m.submitOrder(ord, a);
          m.applyTrades(fills, this.agents);
        }
        if (a.traced && a.lastTrace) {
          this.logger.recordTrace(a.id, {
            tick: m.tick, round: m.round, period: m.period,
            action: a.lastAction,
            trace: a.lastTrace,
          });
        }
      }
    }

    const pr = m.periodsRemaining();
    const warning = this.regulator.observe({
      tick: m.tick, round: m.round, period: m.period,
      lastPrice: m.lastPrice,
      refEstimator: this.refEstimator,
      periodsRemaining: pr,
    });
    if (warning) this.logger.recordEvent('regulator_warning', { tick: m.tick, ...warning.payload });

    const fvRef = this.refEstimator.estimate(pr).fvHat;
    m.recordTick(fvRef);
    this.logger.recordAggregate(m, this.agentList, this.regulator, fvRef);

    const ticksPerPeriod = this.config.ticksPerPeriod;
    const newTick       = m.tick + 1;
    const crossedPeriod = Math.floor(newTick / ticksPerPeriod) > Math.floor(m.tick / ticksPerPeriod);
    m.tick = newTick;

    if (crossedPeriod) {
      const { dividend, regime } = m.payDividend(this.agents, this.rng);
      this.refEstimator.observe(dividend);
      this.logger.recordEvent('dividend', { tick: m.tick, period: m.period, round: m.round, value: dividend, regime });

      const reports = [];
      for (const a of this.agentList) {
        const msg = a.communicate(m.tick, m.round, m.period);
        if (msg) reports.push({ fromId: a.id, reportedV: msg.payload.reportedV });
      }
      const vwap = m.vwap(m.period, m.round);
      this.trust.updateFromReports(reports, vwap, this.config.tunables.trustLambda);
      this.logger.recordEvent('period_end', { tick: m.tick, period: m.period, round: m.round, vwap });

      m.period++;
      if (m.period > this.config.periods) {
        this.logger.recordEvent('round_end', { tick: m.tick, round: m.round });
        m.round++;
        m.period = 1;
        if (m.round > (this.config.roundsPerSession || 1)) {
          this.running = false;
          if (this._onEnd) this._onEnd();
          return;
        }
        m.book.clear();
        m.lastPrice = null;
        for (const a of this.agentList) a.onRoundStart();
        this.refEstimator.reset();
        this.regulator.reset();
        m.hmm.reset();
        this.logger.recordEvent('round_start', { tick: m.tick, round: m.round });
      }
    }
  }
}

function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
