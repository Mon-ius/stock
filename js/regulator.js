'use strict';

/* =====================================================================
   regulator.js — Bubble-detection warning agent.

   Observes the market tick-by-tick, computes the rolling price-to-
   fundamental ratio using a reference AnalyticalEstimator, and emits
   a WARNING message on the bus when ρ exceeds the threshold for K
   consecutive ticks. A cooldown prevents warning spam.

   Effects (per agent, resolved in UtilityAgent):
     regulatorReaction = 'ignore'   → no adjustment
     regulatorReaction = 'discount' → V̂ scaled by (1 − γ) for D ticks
     regulatorReaction = 'panic'    → agent wants to reduce inventory
                                       (sets an internal hazard flag
                                       that biases decisions toward ask)

   Modes:
     'off'   — never warns
     'warn'  — posts regulator-warning messages only
     'halt'  — additionally requests the engine to skip agent decisions
               for `haltTicks` after a warning (set via engine hook)
   ===================================================================== */

class Regulator {
  constructor(bus, hmm, config) {
    this.bus           = bus;
    this.hmm           = hmm;
    this.mode          = config.mode || 'warn';
    this.threshold     = config.threshold     ?? 1.35;
    this.persistence   = config.persistence   ?? 4;
    this.cooldown      = config.cooldown      ?? 30;
    this.haltTicks     = config.haltTicks     ?? 6;
    this.discountD     = config.discountTicks ?? 20;
    // internal state
    this._consecutive  = 0;
    this._cooldownLeft = 0;
    this._haltLeft     = 0;
    this._lastWarning  = null;    // { tick, ratio, level }
    this.activeUntil   = -1;      // tick until which warning is "in force"
    this.history       = [];      // [{tick, ratio, fvRef, warn}]
  }

  reset() {
    this._consecutive  = 0;
    this._cooldownLeft = 0;
    this._haltLeft     = 0;
    this._lastWarning  = null;
    this.activeUntil   = -1;
    this.history       = [];
  }

  /** True if the engine should skip agent order submissions this tick. */
  isHalted() { return this.mode === 'halt' && this._haltLeft > 0; }

  /** Current reference FV using analytical filter over observed dividends. */
  referenceFV(refEstimator, periodsRemaining) {
    return refEstimator.estimate(periodsRemaining).fvHat;
  }

  /**
   * Called by the engine once per tick after price recording. `context`
   * carries { tick, round, period, lastPrice, refEstimator, periodsRemaining }.
   */
  observe(context) {
    if (this.mode === 'off' || context.lastPrice == null) {
      this.history.push({ tick: context.tick, ratio: null, fvRef: null, warn: false });
      return null;
    }
    const fvRef = Math.max(1e-6, this.referenceFV(context.refEstimator, context.periodsRemaining));
    const ratio = context.lastPrice / fvRef;

    if (this._cooldownLeft > 0) this._cooldownLeft--;
    if (this._haltLeft > 0)     this._haltLeft--;

    let triggered = false;
    if (ratio >= this.threshold) this._consecutive++;
    else                         this._consecutive = 0;

    if (this._consecutive >= this.persistence && this._cooldownLeft === 0) {
      triggered = true;
      this._consecutive  = 0;
      this._cooldownLeft = this.cooldown;
      if (this.mode === 'halt') this._haltLeft = this.haltTicks;
      this.activeUntil   = context.tick + this.discountD;
      const level = ratio >= this.threshold * 1.2 ? 'severe' : 'standard';
      const msg = this.bus.post({
        tick:   context.tick,
        round:  context.round,
        period: context.period,
        fromId: 'REGULATOR',
        toId:   'all',
        kind:   'regulator-warning',
        payload: {
          ratio:     +ratio.toFixed(3),
          threshold: this.threshold,
          fvRef:     +fvRef.toFixed(2),
          price:     +context.lastPrice.toFixed(2),
          level,
          text:      `Market price ${context.lastPrice.toFixed(1)} is ${(ratio * 100).toFixed(0)}% of reference FV ${fvRef.toFixed(1)} — ${level === 'severe' ? 'severe' : 'standard'} bubble warning.`,
        },
      });
      this._lastWarning = msg;
    }
    this.history.push({ tick: context.tick, ratio, fvRef, warn: triggered });
    return triggered ? this._lastWarning : null;
  }

  /** Agents check this to decide whether to apply the discount/panic reaction. */
  isActive(tick) { return tick <= this.activeUntil; }

  currentRatio() {
    const last = this.history[this.history.length - 1];
    return last ? last.ratio : null;
  }
}

if (typeof module !== 'undefined') module.exports = { Regulator };
