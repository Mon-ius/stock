'use strict';

/* =====================================================================
   utility.js — Universal CRRA utility over wealth.

   Every agent shares the same constant-relative-risk-aversion (CRRA)
   family, differing only in the per-agent coefficient ρ:

       U(w; ρ) = w^(1 − ρ) / (1 − ρ)

   The decision engine compares utilities across candidate trades for a
   single agent, so we can drop the ρ-dependent 1/(1−ρ) scalar and an
   additive constant without changing the argmax. We render in the
   normalized form

       U(w; ρ) = (w / w₀)^(1 − ρ)

   which (a) gives U(w₀) = 1 at the agent's initial wealth — so welfare
   is directly comparable across heterogeneous endowments — and
   (b) collapses cleanly to the three legacy shapes at canonical ρ:

       ρ = −1   U_L(w) = (w / w₀)²          strictly convex  (risk loving)
       ρ =  0   U_N(w) = w / w₀             linear           (risk neutral)
       ρ = +½   U_A(w) = √(w / w₀)          strictly concave (risk averse)

   The Risk preferences slider still thinks in three categories, but
   inside each category the sampler draws ρ uniformly from the
   category's sub-range — so 100 risk-averse agents each have their own
   curvature rather than sharing the exact √ curve. This yields the
   intra-category heterogeneity the paper's welfare plots reveal as
   noise around the category centroid.

   ρ ranges (sampled per agent in agents.js via the engine RNG):

       loving  ρ ∈ (−1,  0)      strictly convex     (open at both ends)
       neutral ρ  = 0            linear              (single-point)
       averse  ρ ∈ ( 0,  1)      strictly concave    (open at both ends)

   Wealth is mark-to-market (w = cash + inventory × lastPrice, with FV
   as the pre-first-trade fallback) and clamped at 0 so a briefly
   negative settlement cannot produce NaN through the concave branch.
   ===================================================================== */

const CRRA_RHO_RANGES = {
  loving:  { lo: -0.999, hi: -0.001, mid: -0.5 },
  neutral: { lo:  0.0,   hi:  0.0,   mid:  0.0 },
  averse:  { lo:  0.001, hi:  0.999, mid:  0.5 },
};

const Utility = {
  loving:  { label: 'Risk-loving',  symbol: '²', color: '#ff5e78', name: 'U_L' },
  neutral: { label: 'Risk-neutral', symbol: '=', color: '#b0b8c9', name: 'U_N' },
  averse:  { label: 'Risk-averse',  symbol: '√', color: '#4fa3ff', name: 'U_A' },
};

/**
 * sampleRho — draw a ρ for a given risk category from its sub-range
 * using the provided seeded RNG. Pass any RNG function returning values
 * in [0, 1); falls back to Math.random if none is supplied.
 */
function sampleRho(riskPref, rng) {
  const r = CRRA_RHO_RANGES[riskPref] || CRRA_RHO_RANGES.neutral;
  if (r.hi <= r.lo) return r.lo;
  const u = typeof rng === 'function' ? rng() : Math.random();
  return r.lo + u * (r.hi - r.lo);
}

/**
 * categoryOfRho — map a ρ back to its category bucket. Used by UI code
 * paths that only receive ρ (colour selection, label lookup) and by
 * the legacy fall-through in computeUtility when ρ is missing.
 */
function categoryOfRho(rho) {
  if (!Number.isFinite(rho)) return 'neutral';
  if (rho < 0)      return 'loving';
  if (rho > 0.0005) return 'averse';
  return 'neutral';
}

/**
 * computeCRRA — the single functional form used by every agent.
 * Clamps wealth at 0 and w₀ at 1 to avoid NaNs from pathological
 * states, and falls back to log utility at ρ = 1 where the power
 * form would degenerate to a constant.
 */
function computeCRRA(w, w0, rho) {
  const r = Math.max(0, w) / Math.max(1, w0);
  if (Math.abs(1 - rho) < 1e-9) return Math.log(Math.max(1e-12, r));
  return Math.pow(Math.max(0, r), 1 - rho);
}

/**
 * computeUtility — thin dispatcher kept for backwards compatibility
 * with callers that still pass a riskPref label. New call sites should
 * pass ρ directly. When both are supplied ρ wins; when only the label
 * is supplied we fall back to the category midpoint so legacy specs
 * without a sampled ρ still produce a sensible utility.
 */
function computeUtility(riskPref, wealth, initialWealth, rho) {
  let effectiveRho = rho;
  if (effectiveRho == null || !Number.isFinite(effectiveRho)) {
    const range = CRRA_RHO_RANGES[riskPref] || CRRA_RHO_RANGES.neutral;
    effectiveRho = range.mid;
  }
  return computeCRRA(wealth, initialWealth, effectiveRho);
}

function wealthOf(agent, price) {
  return agent.cash + agent.inventory * price;
}

function markPrice(market) {
  if (market && market.lastPrice != null) return market.lastPrice;
  return market ? market.fundamentalValue() : 0;
}
