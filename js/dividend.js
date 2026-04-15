'use strict';

/* =====================================================================
   dividend.js — Two-state regime-switching HMM dividend process.

   Replaces the deterministic {0, 2μ} draw used in the original DLM
   replication. The asset's per-period dividend now depends on a hidden
   regime r_t ∈ {H, L} that evolves as a Markov chain with transition
   matrix P. Conditional on the regime, the dividend is drawn from a
   non-negative Gaussian (clamped at zero) with regime-specific mean
   and shared volatility.

       P(r_{t+1} = H | r_t = H) = pHH      P(L | H) = 1 - pHH
       P(r_{t+1} = L | r_t = L) = pLL      P(H | L) = 1 - pLL

       d_t | r_t = H ~ max(0, N(muH, sigma²))
       d_t | r_t = L ~ max(0, N(muL, sigma²))

   The TRUE fundamental value at period t given hidden state r_t is the
   expected discounted-but-undiscounted sum of remaining dividends. With
   a finite horizon T and a 2-state chain that is closed-form:

       FV_t(r_t) = Σ_{k=0..T-t} (P^k · μ)[r_t]

   where μ = [muH, muL]ᵀ. We expose a precomputed lookup so analytical
   estimators don't repeatedly multiply matrices.

   Bounded-rationality angle: the hidden state r_t is NEVER given to
   agent code. Agents only observe the realised dividend stream and must
   filter for r_t themselves (see estimator.js). The analytical
   estimator uses the true HMM parameters and runs the forward filter
   exactly; the Kalman estimator uses a finite observation window with
   a wrong/diffuse prior; the naive estimator just averages recent
   dividends.
   ===================================================================== */

const HMM_DEFAULTS = {
  muH:           14,    // high-regime expected dividend
  muL:           4,     // low-regime expected dividend
  sigma:         2.5,   // shared dividend volatility (Gaussian std)
  pHH:           0.85,  // regime persistence in H
  pLL:           0.85,  // regime persistence in L
  initialRegime: 'H',   // starting regime each round
};

/** Box–Muller Gaussian draw using the supplied [0,1) RNG. */
function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

class HMMDividend {
  constructor(params = {}) {
    this.params = { ...HMM_DEFAULTS, ...params };
    this.reset();
  }

  reset(regime) {
    this.regime = regime || this.params.initialRegime;
  }

  /** Step the hidden chain one period and draw a dividend. */
  step(rng) {
    const persist = this.regime === 'H' ? this.params.pHH : this.params.pLL;
    if (rng() > persist) this.regime = this.regime === 'H' ? 'L' : 'H';
    const mu  = this.regime === 'H' ? this.params.muH : this.params.muL;
    const eps = gaussian(rng) * this.params.sigma;
    const d   = Math.max(0, mu + eps);
    return { dividend: d, regime: this.regime };
  }

  /**
   * E[ Σ_{k=0..K} d_{t+k} | r_t ] for both regimes, for k = 0..K.
   * Returns { H: [E_0, E_1, …, E_K], L: [...] }.
   * Used by the analytical estimator and the regulator.
   */
  expectedRemaining(K) {
    const { muH, muL, pHH, pLL } = this.params;
    // 1-step transition matrix as flat 2x2: rows = current state, cols = next.
    // P = [[pHH, 1-pHH], [1-pLL, pLL]]
    const mu = [muH, muL];
    // belief vector b = probability over states; iterate b ← b·P.
    const stepBelief = (b) => [
      b[0] * pHH       + b[1] * (1 - pLL),
      b[0] * (1 - pHH) + b[1] * pLL,
    ];
    const out = { H: [], L: [] };
    for (const start of ['H', 'L']) {
      let b = start === 'H' ? [1, 0] : [0, 1];
      let sum = 0;
      const series = [];
      for (let k = 0; k <= K; k++) {
        const e = b[0] * mu[0] + b[1] * mu[1];
        sum += e;
        series.push(sum);
        b = stepBelief(b);
      }
      out[start] = series;
    }
    return out;
  }

  /**
   * Bayes one-step posterior over hidden state given an observed
   * dividend. p(r | d) ∝ p(d | r) · p(r). Used by Kalman/analytical
   * estimators.
   */
  posteriorGivenDividend(prior, dividend) {
    const { muH, muL, sigma } = this.params;
    const lik = (mu) => {
      const z = (dividend - mu) / sigma;
      return Math.exp(-0.5 * z * z);
    };
    const lH = lik(muH) * prior[0];
    const lL = lik(muL) * prior[1];
    const Z  = lH + lL || 1e-12;
    return [lH / Z, lL / Z];
  }

  /** Predict belief one step ahead using P. */
  predictBelief(b) {
    const { pHH, pLL } = this.params;
    return [
      b[0] * pHH       + b[1] * (1 - pLL),
      b[0] * (1 - pHH) + b[1] * pLL,
    ];
  }
}

if (typeof module !== 'undefined') module.exports = { HMMDividend, HMM_DEFAULTS };
