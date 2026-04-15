'use strict';

/* =====================================================================
   utility.js — Agent utility functions over wealth.

   Three risk preferences (U_L, U_N, U_A), each a monotonic transform of
   wealth normalized so that U(w0) = 1 at the agent's initial wealth.
   Normalization makes utility comparable across agents that use
   different transforms: every agent starts at 1.0 and a run's welfare
   can be read as a sum of dimensionless "utility units".

   Wealth is mark-to-market:
       w = cash + inventory × lastPrice
   with FV as the fallback on ticks before the first trade has printed
   (otherwise the inventory side of w would be zero at run start and
   every EU comparison would degenerate to a cash-only ranking).

   Families:
       U_A  averse   U(w) = sqrt(w / w0)      strictly concave (diminishing)
       U_N  neutral  U(w) = w / w0            linear           (indifferent)
       U_L  loving   U(w) = (w / w0)^2        strictly convex  (increasing)

   Marginal utility (the slope of U at w) drives behaviour under
   uncertainty. The expected-utility decision engine in UtilityAgent
   uses these functions to rank candidate trades under deterministic
   (hit/lift) and probabilistic (passive post) outcomes.

   Wealth is clamped at 0 to avoid NaNs from the sqrt branch on the
   unlikely path where a settlement pushes an agent briefly negative.
   ===================================================================== */

const Utility = {
  averse: {
    label:   'Risk-averse',
    symbol:  '√',
    color:   '#4fa3ff',
    name:    'U_A',
    formula: 'U_A(w) = sqrt(w / w0)',
    compute(w, w0) {
      const r = Math.max(0, w) / Math.max(1, w0);
      return Math.sqrt(r);
    },
  },
  neutral: {
    label:   'Risk-neutral',
    symbol:  '=',
    color:   '#b0b8c9',
    name:    'U_N',
    formula: 'U_N(w) = w / w0',
    compute(w, w0) {
      return Math.max(0, w) / Math.max(1, w0);
    },
  },
  loving: {
    label:   'Risk-loving',
    symbol:  '²',
    color:   '#ff5e78',
    name:    'U_L',
    formula: 'U_L(w) = (w / w0)^2',
    compute(w, w0) {
      const r = Math.max(0, w) / Math.max(1, w0);
      return r * r;
    },
  },
};

function computeUtility(riskPref, wealth, initialWealth) {
  const fn = Utility[riskPref] || Utility.neutral;
  return fn.compute(wealth, initialWealth);
}

function wealthOf(agent, price) {
  return agent.cash + agent.inventory * price;
}

function markPrice(market) {
  if (market && market.lastPrice != null) return market.lastPrice;
  return market ? market.fundamentalValue() : 0;
}
