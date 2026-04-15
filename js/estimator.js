'use strict';

/* =====================================================================
   estimator.js — Bounded-rationality FV estimators.

   Each agent owns one estimator. Calling `observe(dividend)` feeds the
   latest realised dividend; `estimate(periodsRemaining)` returns a
   point estimate of remaining fundamental value plus a confidence
   score in [0,1]. Estimators encapsulate both the agent's cognitive
   capacity and their use of structural knowledge about the HMM.

     NaiveEstimator        — sample mean of the last K dividends times
                             periodsRemaining. No regime concept, no
                             filter. Confidence ∝ number of observations.
     KalmanEstimator       — Bayesian forward filter over the 2-state
                             chain, BUT with a stale/diffuse prior and
                             a finite memory window. Tracks posterior
                             belief b_t ∈ Δ². Mimics an analyst who
                             understands that regimes exist but doesn't
                             know the exact transition probabilities.
     AnalyticalEstimator   — full exact forward filter using the true
                             HMM params. The "rational benchmark"; used
                             by the regulator to compute the reference
                             FV and by any agent with enough compute.

   All three expose the same interface so UtilityAgent.decide() can
   stay cognition-agnostic.
   ===================================================================== */

class NaiveEstimator {
  constructor(hmm, opts = {}) {
    this.kind   = 'naive';
    this.hmm    = hmm;
    this.window = opts.window || 4;
    this.obs    = [];
  }

  observe(dividend) {
    this.obs.push(dividend);
    if (this.obs.length > this.window) this.obs.shift();
  }

  estimate(periodsRemaining) {
    const mean = this.obs.length
      ? this.obs.reduce((s, x) => s + x, 0) / this.obs.length
      : 0.5 * (this.hmm.params.muH + this.hmm.params.muL);
    const fvHat = mean * periodsRemaining;
    const conf  = Math.min(1, this.obs.length / this.window);
    return { fvHat, confidence: conf, belief: null };
  }

  reset() { this.obs = []; }
}

class KalmanEstimator {
  constructor(hmm, opts = {}) {
    this.kind   = 'kalman';
    this.hmm    = hmm;
    this.window = opts.window || 6;
    // Diffuse prior [0.5, 0.5] and a SUBJECTIVE transition matrix that
    // is deliberately more diffuse than the true one — models an agent
    // who knows regimes exist but over-estimates transition probability.
    this.subjPHH = opts.subjPHH ?? Math.max(0.55, hmm.params.pHH - 0.15);
    this.subjPLL = opts.subjPLL ?? Math.max(0.55, hmm.params.pLL - 0.15);
    this.belief  = [0.5, 0.5];
    this.obs     = [];
  }

  _subjPredict(b) {
    return [
      b[0] * this.subjPHH       + b[1] * (1 - this.subjPLL),
      b[0] * (1 - this.subjPHH) + b[1] * this.subjPLL,
    ];
  }

  observe(dividend) {
    this.obs.push(dividend);
    if (this.obs.length > this.window) this.obs.shift();
    // Rebuild belief from the window with a flat prior — models a
    // finite-memory agent who drops old evidence.
    let b = [0.5, 0.5];
    for (const d of this.obs) {
      b = this.hmm.posteriorGivenDividend(b, d);
      b = this._subjPredict(b);
    }
    this.belief = b;
  }

  estimate(periodsRemaining) {
    // Use the agent's subjective chain to forecast remaining dividend
    // sum conditional on current belief.
    const { muH, muL } = this.hmm.params;
    let b   = this.belief.slice();
    let sum = 0;
    for (let k = 0; k < periodsRemaining; k++) {
      sum += b[0] * muH + b[1] * muL;
      b    = this._subjPredict(b);
    }
    const conf = Math.max(Math.abs(this.belief[0] - 0.5) * 2, 0);
    return { fvHat: sum, confidence: conf, belief: this.belief.slice() };
  }

  reset() {
    this.obs = [];
    this.belief = [0.5, 0.5];
  }
}

class AnalyticalEstimator {
  constructor(hmm) {
    this.kind   = 'analytical';
    this.hmm    = hmm;
    this.belief = [0.5, 0.5];
    this.obs    = [];
  }

  observe(dividend) {
    this.obs.push(dividend);
    this.belief = this.hmm.posteriorGivenDividend(this.belief, dividend);
    this.belief = this.hmm.predictBelief(this.belief);
  }

  estimate(periodsRemaining) {
    const { muH, muL } = this.hmm.params;
    let b   = this.belief.slice();
    let sum = 0;
    for (let k = 0; k < periodsRemaining; k++) {
      sum += b[0] * muH + b[1] * muL;
      b    = this.hmm.predictBelief(b);
    }
    return { fvHat: sum, confidence: 1, belief: this.belief.slice() };
  }

  reset() {
    this.obs = [];
    this.belief = [0.5, 0.5];
  }
}

function makeEstimator(kind, hmm, opts) {
  if (kind === 'naive')      return new NaiveEstimator(hmm, opts);
  if (kind === 'kalman')     return new KalmanEstimator(hmm, opts);
  if (kind === 'analytical') return new AnalyticalEstimator(hmm);
  throw new Error(`unknown estimator kind: ${kind}`);
}

if (typeof module !== 'undefined') {
  module.exports = { NaiveEstimator, KalmanEstimator, AnalyticalEstimator, makeEstimator };
}
