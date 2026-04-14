'use strict';

/* =====================================================================
   agents.js — Trading strategies + population presets.

   The simulator carries three strategy families for the non-DLM modes
   (Lopez-Lira and AIPE) — Fundamentalist, TrendFollower, Random — plus
   the UtilityAgent that drives those two paradigms. The strict DLM
   2005 mode uses a single class, DLMTrader, whose behaviour is gated
   on the *endogenous* roundsPlayed counter: a fresh trader (rounds = 0)
   acts like a momentum/noise undergrad and produces the canonical SSW
   bubble; once the round-end reset has incremented the counter
   (rounds ≥ 1) the same agent switches to FV-anchoring with horizon
   awareness, which is the channel by which DLM's "experience kills the
   bubble" finding emerges. Crucially, no agent is ever pre-labelled
   experienced — every trader becomes experienced only by playing.
   ===================================================================== */

class Agent {
  constructor(id, type, cash, inventory, displayName) {
    this.id               = id;
    this.type             = type;
    this.displayName      = displayName;
    this.cash             = cash;
    this.inventory        = inventory;
    this.initialCash      = cash;
    this.initialInventory = inventory;
    this.lastAction       = 'hold';
    // DLM 2005 runs a session of four consecutive markets with the
    // same subject pool. The Engine increments roundsPlayed at every
    // round boundary so subclasses can condition behaviour on the
    // *endogenous* experience an agent has accumulated through play.
    // No agent is ever instantiated with roundsPlayed > 0 — the only
    // way to become experienced is to participate in a prior round.
    this.roundsPlayed     = 0;
    // True for round-4 replacement traders that were spliced into the
    // population at the round-3 → round-4 transition. Used by the UI
    // to render a "fresh" badge so the user can see the swap fired.
    this.replacementFresh = false;
  }
  decide(_market, _rng) { return { type: 'hold', reasoning: { ruleUsed: 'noop' } }; }
  /**
   * Optional round-boundary hook. The Engine calls this on every agent
   * after cash + inventory have been rewound to the spec values, so
   * subclasses should clear any per-round transient state here (local
   * price history, subjective priors, cached fills). Learned state
   * that should persist across rounds — trust matrices, belief modes,
   * risk preferences — is left alone.
   */
  onRoundStart() {}
}

/* ---------- Fundamentalist -------------------------------------------- */
/*
 * Belief ≈ FV with small noise.
 * Crosses the book when mispricing exceeds ±2%; otherwise posts passive
 * quotes inside a narrow band around FV. This is the rational anchor.
 */
class Fundamentalist extends Agent {
  constructor(id, name, cash = 1000, inventory = 3) {
    super(id, 'fundamentalist', cash, inventory, name);
  }

  decide(market, rng) {
    const fv     = market.fundamentalValue();
    const belief = fv * (1 + (rng() - 0.5) * 0.04);
    const bid    = market.book.bestBid();
    const ask    = market.book.bestAsk();

    if (ask && ask.price < belief * 0.98 && this.cash >= ask.price) {
      return order('bid', ask.price, 1, {
        ruleUsed:         'buy_undervalued_vs_fv',
        estimatedValue:   belief,
        expectedProfit:   belief - ask.price,
        triggerCondition: `ask ${ask.price.toFixed(2)} < 0.98 × belief ${belief.toFixed(2)}`,
      });
    }
    if (bid && bid.price > belief * 1.02 && this.inventory > 0) {
      return order('ask', bid.price, 1, {
        ruleUsed:         'sell_overvalued_vs_fv',
        estimatedValue:   belief,
        expectedProfit:   bid.price - belief,
        triggerCondition: `bid ${bid.price.toFixed(2)} > 1.02 × belief ${belief.toFixed(2)}`,
      });
    }

    // Passive quoting around belief. The bid and ask ranges overlap
    // slightly at belief so two fundamentalists can cross each other
    // without needing a liquidity provider.
    if (rng() < 0.45) {
      if (rng() < 0.5 && this.cash >= belief) {
        const p = round2(belief * (0.97 + rng() * 0.035));    // [0.970, 1.005]
        return order('bid', p, 1, {
          ruleUsed:         'passive_bid_near_fv',
          estimatedValue:   belief,
          expectedProfit:   belief - p,
          triggerCondition: 'probing at 97–100.5% of belief',
        });
      } else if (this.inventory > 0) {
        const p = round2(belief * (0.995 + rng() * 0.035));   // [0.995, 1.030]
        return order('ask', p, 1, {
          ruleUsed:         'passive_ask_near_fv',
          estimatedValue:   belief,
          expectedProfit:   p - belief,
          triggerCondition: 'probing at 99.5–103% of belief',
        });
      }
    }
    return hold({
      ruleUsed:         'fundamentalist_wait',
      estimatedValue:   belief,
      triggerCondition: 'market roughly at FV',
    });
  }
}

/* ---------- Trend follower -------------------------------------------- */
/*
 * Uses a short-window slope (6 last recorded prices) to detect momentum.
 *   - positive slope → chase (aggressive bid above recent)
 *   - negative slope → flee  (aggressive ask below recent)
 *   - flat slope + excess inventory → profit-take passively
 *   - out of cash + accumulated inventory → liquidate at market
 *
 * The profit-take and cash-exhausted branches are what produces the
 * classic Smith-Suchanek-Williams crash. Without them, trend followers
 * hoard inventory at the bubble peak and prices simply plateau instead
 * of collapsing.
 */
class TrendFollower extends Agent {
  constructor(id, name, cash = 1000, inventory = 3) {
    super(id, 'trend', cash, inventory, name);
  }

  decide(market, rng) {
    // Momentum must not leak across round boundaries: DLM starts every
    // round with a fresh market, so a trend follower in round 2 should
    // see price history from round 2 only. Filtering on the current
    // round guarantees the 6-tick slope starts empty at every round
    // opening and the "bootstrap" branch fires just like round 1.
    const hist = market.priceHistory
      .filter(h => h.price !== null && h.round === market.round)
      .slice(-6);
    const fv   = market.fundamentalValue();
    const bid  = market.book.bestBid();

    if (hist.length < 2) {
      if (this.cash >= fv && rng() < 0.5) {
        const p = round2(fv * (0.95 + rng() * 0.05));
        return order('bid', p, 1, {
          ruleUsed:         'trend_bootstrap_bid',
          estimatedValue:   fv,
          expectedProfit:   0,
          triggerCondition: 'no price history yet',
        });
      }
      return hold({ ruleUsed: 'trend_insufficient_history', estimatedValue: fv, triggerCondition: 'need 2+ prior ticks' });
    }

    const recent = hist[hist.length - 1].price;
    const past   = hist[0].price;
    const slope  = (recent - past) / Math.max(1, hist.length - 1);
    const target = recent + slope * 3;

    // Cash exhausted: the bubble has consumed this agent's buying power.
    // Start dumping accumulated inventory at whatever bid exists.
    if (this.cash < recent && this.inventory > this.initialInventory) {
      const sellPrice = bid ? bid.price : round2(recent * (0.96 + rng() * 0.03));
      return order('ask', sellPrice, 1, {
        ruleUsed:         'trend_cash_exhausted',
        estimatedValue:   target,
        expectedProfit:   sellPrice - recent * 0.9,
        triggerCondition: `cash ${this.cash.toFixed(0)} < recent ${recent.toFixed(0)}, excess inv ${this.inventory - this.initialInventory}`,
      });
    }

    if (slope > 0 && this.cash >= recent) {
      const p = round2(recent * (1 + 0.015 + rng() * 0.03));
      return order('bid', p, 1, {
        ruleUsed:         'chase_uptrend',
        estimatedValue:   target,
        expectedProfit:   target - p,
        triggerCondition: `slope +${slope.toFixed(2)}/tick → projected ${target.toFixed(2)}`,
      });
    }
    if (slope < 0 && this.inventory > 0) {
      const p = round2(recent * (1 - 0.015 - rng() * 0.03));
      return order('ask', p, 1, {
        ruleUsed:         'flee_downtrend',
        estimatedValue:   target,
        expectedProfit:   p - target,
        triggerCondition: `slope ${slope.toFixed(2)}/tick → projected ${target.toFixed(2)}`,
      });
    }

    // Flat slope with accumulated inventory: take profit. When a bid
    // exists, sell at it (aggressive take); otherwise post passively
    // inside recent price. Sell probability scales with excess
    // inventory — the more shares hoarded, the more eager to unload.
    if (this.inventory > this.initialInventory) {
      const excess     = this.inventory - this.initialInventory;
      const excessRate = excess / Math.max(1, this.initialInventory);
      const sellProb   = Math.min(0.85, 0.3 + excessRate * 0.25);
      if (rng() < sellProb) {
        const sellPrice = bid ? bid.price : round2(recent * (0.97 + rng() * 0.025));
        return order('ask', sellPrice, 1, {
          ruleUsed:         'trend_flat_profit_take',
          estimatedValue:   target,
          expectedProfit:   sellPrice - recent * 0.9,
          triggerCondition: `flat slope + excess inv ${excess}/${this.initialInventory}`,
        });
      }
    }

    return hold({
      ruleUsed:         'trend_flat',
      estimatedValue:   target,
      triggerCondition: `|slope| ${Math.abs(slope).toFixed(2)} ≈ 0`,
    });
  }
}

/* ---------- Random (Zero-Intelligence) -------------------------------- */
/*
 * Gode-Sunder style. Uniform draws bounded by the agent's redemption
 * value, which here is the fundamental value. Anchoring on FV rather
 * than lastPrice means random agents do NOT reinforce a runaway bubble —
 * they provide a price-discovery floor/ceiling pinned to fundamentals.
 */
class RandomAgent extends Agent {
  constructor(id, name, cash = 1000, inventory = 3) {
    super(id, 'random', cash, inventory, name);
  }

  decide(market, rng) {
    const fv   = market.fundamentalValue();
    const side = rng() < 0.5 ? 'bid' : 'ask';

    if (side === 'bid') {
      // Bid drawn uniformly in [0.7·FV, 1.1·FV]
      const price = Math.max(1, fv * (0.7 + rng() * 0.4));
      if (this.cash < price) {
        return hold({
          ruleUsed:         'zi_insufficient_cash',
          estimatedValue:   fv,
          triggerCondition: `drew ${price.toFixed(2)}, cash ${this.cash.toFixed(2)}`,
        });
      }
      return order('bid', round2(price), 1, {
        ruleUsed:         'zi_uniform_bid',
        estimatedValue:   fv,
        expectedProfit:   fv - price,
        triggerCondition: `bid ∈ [0.7·FV, 1.1·FV] → ${price.toFixed(2)}`,
      });
    }
    if (this.inventory <= 0) {
      return hold({ ruleUsed: 'zi_no_inventory', estimatedValue: fv, triggerCondition: 'zero shares' });
    }
    // Ask drawn uniformly in [0.9·FV, 1.3·FV]
    const price = Math.max(1, fv * (0.9 + rng() * 0.4));
    return order('ask', round2(price), 1, {
      ruleUsed:         'zi_uniform_ask',
      estimatedValue:   fv,
      expectedProfit:   price - fv,
      triggerCondition: `ask ∈ [0.9·FV, 1.3·FV] → ${price.toFixed(2)}`,
    });
  }
}

/* ---------- DLMTrader (strict DLM 2005 mode) -------------------------- */
/*
 * The single agent class used by strict DLM 2005 mode. Behaviour is
 * gated on the endogenous `roundsPlayed` counter, which the Engine
 * increments at every round boundary. There is no pre-assigned
 * experience type and no constructor flag that lets a caller "force
 * experience" — every trader instantiated with roundsPlayed = 0 acts
 * like a fresh undergrad, and the only way to become experienced is
 * to play a prior round of the same session. The two-state model
 * matches DLM 2005's binary "experienced / inexperienced" framing
 * (see §I, p. 1733): rounds 1–3 develop experience cumulatively, and
 * round 4 swaps in fresh inexperienced subjects under one of the two
 * treatments.
 *
 *   roundsPlayed === 0  → bubble-prone behaviour: trend-following on
 *                         the in-round price history, weak FV anchor,
 *                         no late-period liquidation. Six fresh agents
 *                         in round 1 of every session reproduce the
 *                         classic SSW bubble-and-crash.
 *
 *   roundsPlayed >= 1   → FV-anchoring veteran behaviour: discounts
 *                         belief by horizon fraction, liquidates in
 *                         the final three periods, refuses to overpay
 *                         in the last four. This is the bubble-killing
 *                         channel that drives DLM 2005's headline
 *                         result that experience, not instructions or
 *                         incentives, kills the bubble.
 */
const DLM_VETERAN = {
  discountFloor:         0.92,
  discountSlope:         0.06,
  liquidateRemaining:    3,
  avoidOverpayRemaining: 4,
  avoidOverpayMul:       0.9,
  buyDiscountMul:        0.92,
  sellPremiumMul:        1.05,
};

class DLMTrader extends Agent {
  constructor(id, name, cash, inventory) {
    super(id, 'dlm', cash, inventory, name);
  }

  decide(market, rng) {
    return this.roundsPlayed === 0
      ? this._decideInexperienced(market, rng)
      : this._decideExperienced(market, rng);
  }

  /* Round-1 fresh-undergrad behaviour: chase momentum, anchor weakly
   * on FV, post noisy quotes. Filtered on the current round so the
   * 6-tick slope window starts empty at every round boundary. */
  _decideInexperienced(market, rng) {
    const hist = market.priceHistory
      .filter(h => h.price !== null && h.round === market.round)
      .slice(-6);
    const fv  = market.fundamentalValue();
    const bid = market.book.bestBid();
    const ask = market.book.bestAsk();

    // Bootstrap: post a noisy quote on either side near FV. Real
    // undergrads bid above FV from tick 1 (producing the classic SSW
    // overshoot), but some subjects also want to cash out shares at
    // any plausible premium, so we post asks at FV × [1.00, 1.10]
    // and bids at FV × [1.02, 1.12] — overlapping ranges that let
    // the first few trades execute at asker prices and prime the
    // slope window for the trending branches below.
    if (hist.length < 2) {
      if (rng() < 0.55) {
        if (rng() < 0.5) {
          const target = fv * (1.02 + rng() * 0.10);
          if (this.cash >= target) {
            return order('bid', round2(target), 1, {
              ruleUsed:         'dlm_fresh_bootstrap_bid',
              estimatedValue:   fv,
              expectedProfit:   0,
              triggerCondition: 'no in-round price history yet',
            });
          }
        } else if (this.inventory > 0) {
          const target = fv * (1.00 + rng() * 0.10);
          return order('ask', round2(target), 1, {
            ruleUsed:         'dlm_fresh_bootstrap_ask',
            estimatedValue:   fv,
            expectedProfit:   0,
            triggerCondition: 'no in-round price history yet',
          });
        }
      }
      return hold({ ruleUsed: 'dlm_fresh_wait', estimatedValue: fv, triggerCondition: 'priming round' });
    }

    const recent = hist[hist.length - 1].price;
    const past   = hist[0].price;
    const slope  = (recent - past) / Math.max(1, hist.length - 1);
    const target = recent + slope * 3;

    // Chase a positive trend aggressively. This is the main bubble
    // inflation channel — it ignores FV in favour of pure momentum.
    if (slope > 0 && this.cash >= recent) {
      const p = round2(recent * (1 + 0.02 + rng() * 0.04));
      return order('bid', p, 1, {
        ruleUsed:         'dlm_fresh_chase',
        estimatedValue:   target,
        expectedProfit:   target - p,
        triggerCondition: `slope +${slope.toFixed(2)}/tick → projected ${target.toFixed(2)}`,
      });
    }
    // Flee a negative trend.
    if (slope < 0 && this.inventory > 0) {
      const p = round2(recent * (1 - 0.02 - rng() * 0.04));
      return order('ask', p, 1, {
        ruleUsed:         'dlm_fresh_flee',
        estimatedValue:   target,
        expectedProfit:   p - target,
        triggerCondition: `slope ${slope.toFixed(2)}/tick → projected ${target.toFixed(2)}`,
      });
    }
    // Flat slope: noisy ZI-style quote pinned to the recent price,
    // not to FV — that's the simulator's analogue of an undergrad
    // who has no horizon model.
    if (rng() < 0.55) {
      if (rng() < 0.5 && this.cash >= recent) {
        const p = round2(recent * (0.95 + rng() * 0.10));
        return order('bid', p, 1, {
          ruleUsed:         'dlm_fresh_noise_bid',
          estimatedValue:   recent,
          expectedProfit:   0,
          triggerCondition: 'flat slope noise quote',
        });
      } else if (this.inventory > 0) {
        const p = round2(recent * (0.97 + rng() * 0.12));
        return order('ask', p, 1, {
          ruleUsed:         'dlm_fresh_noise_ask',
          estimatedValue:   recent,
          expectedProfit:   0,
          triggerCondition: 'flat slope noise quote',
        });
      }
    }
    return hold({ ruleUsed: 'dlm_fresh_idle', estimatedValue: recent, triggerCondition: 'no clear edge' });
  }

  /* Veteran behaviour for roundsPlayed ≥ 1. Mirrors the bubble-
   * suppression mechanism the legacy ExperiencedAgent encoded:
   * horizon-discounted belief, liquidate late, refuse to overpay
   * late, otherwise quote passively around belief. */
  _decideExperienced(market, rng) {
    const p               = DLM_VETERAN;
    const fv              = market.fundamentalValue();
    const remaining       = market.config.periods - market.period + 1;
    const horizonFraction = remaining / market.config.periods;
    const belief          = fv * (p.discountFloor + horizonFraction * p.discountSlope);
    const bid             = market.book.bestBid();
    const ask             = market.book.bestAsk();

    if (remaining <= p.liquidateRemaining && this.inventory > 0 && bid) {
      return order('ask', round2(bid.price), 1, {
        ruleUsed:         'dlm_veteran_liquidate',
        estimatedValue:   belief,
        expectedProfit:   bid.price - belief,
        triggerCondition: `remaining=${remaining} ≤ ${p.liquidateRemaining}; dumping into bid`,
      });
    }
    if (remaining <= p.avoidOverpayRemaining && ask && ask.price > belief * p.avoidOverpayMul) {
      return hold({
        ruleUsed:         'dlm_veteran_avoid_overpay',
        estimatedValue:   belief,
        triggerCondition: `remaining=${remaining}, ask ${ask.price.toFixed(2)} > ${p.avoidOverpayMul}×belief ${belief.toFixed(2)}`,
      });
    }
    if (ask && ask.price < belief * p.buyDiscountMul && this.cash >= ask.price) {
      return order('bid', round2(ask.price), 1, {
        ruleUsed:         'dlm_veteran_buy_discount',
        estimatedValue:   belief,
        expectedProfit:   belief - ask.price,
        triggerCondition: `ask ${ask.price.toFixed(2)} < ${p.buyDiscountMul} × belief ${belief.toFixed(2)}`,
      });
    }
    if (bid && bid.price > belief * p.sellPremiumMul && this.inventory > 0) {
      return order('ask', round2(bid.price), 1, {
        ruleUsed:         'dlm_veteran_sell_premium',
        estimatedValue:   belief,
        expectedProfit:   bid.price - belief,
        triggerCondition: `bid ${bid.price.toFixed(2)} > ${p.sellPremiumMul} × belief ${belief.toFixed(2)}`,
      });
    }
    if (rng() < 0.35) {
      if (rng() < 0.5 && this.cash >= belief) {
        const px = round2(belief * (0.96 + rng() * 0.045));
        return order('bid', px, 1, {
          ruleUsed:         'dlm_veteran_passive_bid',
          estimatedValue:   belief,
          expectedProfit:   belief - px,
          triggerCondition: 'probing 96–100.5% of belief',
        });
      } else if (this.inventory > 0) {
        const px = round2(belief * (0.995 + rng() * 0.045));
        return order('ask', px, 1, {
          ruleUsed:         'dlm_veteran_passive_ask',
          estimatedValue:   belief,
          expectedProfit:   px - belief,
          triggerCondition: 'probing 99.5–104% of belief',
        });
      }
    }
    return hold({ ruleUsed: 'dlm_veteran_wait', estimatedValue: belief, triggerCondition: 'no clear edge' });
  }
}

/* ---------- Utility-maximizing AI-agent-style trader ----------------- */
/*
 * UtilityAgent replaces heuristic trading with an explicit expected-
 * utility maximization pipeline. Each decision runs through five
 * named phases:
 *
 *   1. observe    — snapshot the market (best bid, best ask, last
 *                   trade, FV, horizon).
 *   2. updateBelief — fold three inputs into `subjectiveValuation`:
 *                     (a) a persistent personal bias vs FV,
 *                     (b) per-tick Gaussian-ish noise,
 *                     (c) last period's messages weighted by
 *                         beliefMode (naive / skeptical / adaptive,
 *                         the last using TrustTracker).
 *   3. evaluate   — enumerate candidate actions — hold, cross best
 *                   ask, lift best bid, post passive bid, post passive
 *                   ask — and compute expected post-trade utility
 *                   using this agent's risk preference. Passive posts
 *                   use a fill-probability weighted EU.
 *   4. choose     — argmax EU across candidates.
 *   5. execute    — emit the chosen order (or hold). The full trace,
 *                   including every candidate's EU, is written into
 *                   decision.reasoning.utility so the replay inspector
 *                   can show the whole argmax.
 *
 * Communication (called once per period at period-end by the engine):
 *   communicate() emits a Message with trueValuation AND a
 *   claimedValuation that can diverge based on deceptionMode:
 *     - honest    tiny Gaussian noise around the truth
 *     - biased    fixed-sign tilt (from biasMode/biasAmount)
 *     - deceptive reports LOW when the agent wants to buy (inventory
 *                 below baseline) and HIGH when it wants to sell
 *                 (inventory above baseline). This aligns incentives
 *                 with the required spec: asset-poor agents understate,
 *                 asset-rich agents overstate.
 *
 * Configurable constructor options:
 *   riskPref       'averse' | 'neutral' | 'loving'
 *   biasMode       'over' | 'under' | 'none'
 *   biasAmount     magnitude (signed by biasMode), e.g. 0.15 = ±15%
 *   valuationNoise per-tick random perturbation (default 0.03)
 *   deceptionMode  'honest' | 'biased' | 'deceptive'
 *   beliefMode     'naive' | 'skeptical' | 'adaptive'
 */
/*
 * Tunable defaults — these match the constants that used to be hard-coded
 * inside UtilityAgent. Any field present in ctx.tunables at decision time
 * overrides the corresponding default, which is how the Parameters panel
 * feeds live slider values into the agent loop without rebuilding the
 * population.
 */
const UTILITY_DEFAULTS = {
  naivePriorWeight:     0.6,   // naive: subj = w·prior + (1-w)·msg_avg
  skepticalPriorWeight: 0.9,   // skeptical: same formula, heavier prior
  adaptiveWeightCap:    0.5,   // adaptive: message influence capped at this
  passiveFillProb:      0.3,   // pFill used to score passive orders
  honestNoise:          0.01,  // ±fraction on honest broadcast claim
  biasedTilt:           0.10,  // ±fraction fixed tilt for biased mode
  deceptiveOverstate:   1.18,  // factor when asset-rich wants to sell
  deceptiveUnderstate:  0.82,  // factor when asset-poor wants to buy
  signalThreshold:      0.03,  // |claim/v − 1| threshold for buy/sell label
  deceptiveThreshold:   0.05,  // |claim-true|/true > this → flagged deceptive
  valuationNoise:       0.03,  // ±fraction per-tick random belief jitter
  passiveBidLo:         0.98,  // passive bid drawn from v × [lo, hi]
  passiveBidHi:         1.01,
  passiveAskLo:         0.99,  // passive ask drawn from v × [lo, hi]
  passiveAskHi:         1.02,
};
function tunable(ctx, key) {
  const t = ctx && ctx.tunables;
  return (t && t[key] != null) ? t[key] : UTILITY_DEFAULTS[key];
}

class UtilityAgent extends Agent {
  constructor(id, name, opts = {}) {
    const cash      = opts.cash      != null ? opts.cash      : 1000;
    const inventory = opts.inventory != null ? opts.inventory : 3;
    super(id, 'utility', cash, inventory, name);
    this.riskPref       = opts.riskPref       || 'neutral';
    this.biasMode       = opts.biasMode       || 'none';
    this.biasAmount     = opts.biasAmount     || 0;
    this.valuationNoise = opts.valuationNoise != null ? opts.valuationNoise : UTILITY_DEFAULTS.valuationNoise;
    this.deceptionMode  = opts.deceptionMode  || 'honest';
    this.beliefMode     = opts.beliefMode     || 'naive';

    // Valuation state — recomputed each decide().
    this.trueValuation       = 100;
    this.subjectiveValuation = 100;
    this.reportedValuation   = null;
    this.receivedMsgs        = [];

    // Frozen baseline — used to normalize utility so U(w0) = 1. The
    // initial price reference is FV at the top of period 1 of round 1
    // (= dividendMean × periods, usually 100¢), which matches the
    // mark-to-market wealth the agent would compute on the very first
    // tick if the first trade printed at FV.
    this.initialWealth = this.cash + this.inventory * 100;
  }

  /**
   * Re-initialise transient per-round state at the start of round r+1.
   * The round-end reset has already rewound cash/inventory to the spec
   * values, so we rebase initialWealth against the *new* endowment
   * (otherwise U(w₀) ≠ 1 at the start of round 2, which would distort
   * the EU ranking across rounds). Subjective and reported valuations
   * are cleared so the first decide() of the new round reseeds them
   * from the freshly reset FV prior. Learned state — trust EMAs kept
   * in the TrustTracker, riskPref, biasMode — is left alone: that is
   * the cross-round experience channel DLM relies on.
   */
  onRoundStart() {
    this.initialWealth       = this.cash + this.inventory * 100;
    this.subjectiveValuation = 100;
    this.trueValuation       = 100;
    this.reportedValuation   = null;
    this.receivedMsgs        = [];
  }

  /* ---- Pipeline step 1: observe ---- */
  observe(market) {
    const bestBid = market.book.bestBid();
    const bestAsk = market.book.bestAsk();
    return {
      bid:       bestBid ? bestBid.price : null,
      ask:       bestAsk ? bestAsk.price : null,
      last:      market.lastPrice,
      fv:        market.fundamentalValue(),
      period:    market.period,
      remaining: Math.max(0, market.config.periods - market.period + 1),
    };
  }

  /* ---- Pipeline step 2: update belief ----
   *
   * The three research plans share one scaffold:
   *   prior = FV (both experienced and inexperienced traders know the
   *   fundamental-value pattern per DLM 2005, so neither branch does a
   *   horizon discount)
   *   posterior = blend(prior, peer messages from last period)
   *
   * They differ only in how the blend is computed:
   *
   *   Plan I   — algorithmic. posterior = w·prior + (1 − w)·avg(foreign),
   *              with w = 0.6 + 0.1·min(3, roundsPlayed). A fresh agent
   *              starts at w = 0.6 (easy to influence) and hardens
   *              toward w = 0.9 by the fourth round, matching the
   *              DLM stylized fact that experienced traders are less
   *              susceptible to peer influence.
   *
   *   Plan II  — LLM with utility form. ctx.llmBeliefs[agentId] holds
   *              the subjective valuation returned by the last
   *              period-boundary LLM call, which was prompted with
   *              the agent's risk preference AND the explicit utility
   *              form (U_L, U_N, or U_A). If absent (first period, API
   *              error, missing key), Plan II falls back to Plan I.
   *
   *   Plan III — LLM with label only. Same channel as Plan II but the
   *              prompt omits the utility formulas and only states the
   *              risk-preference label. Tests whether the label alone
   *              is sufficient to recover the utility-aware belief.
   */
  updateBelief(market, ctx, rng) {
    const fv   = market.fundamentalValue();
    const plan = (ctx && ctx.plan) || 'I';

    // Prior = FV × (1 + bias_i + ε). Each term is toggled independently
    // via the applyBias / applyNoise tunables (checkboxes in Trade
    // Settings). When both are off the prior collapses to FV exactly
    // and the sole heterogeneity channel is the peer-message blend.
    const useBias  = ctx && ctx.tunables && ctx.tunables.applyBias;
    const useNoise = ctx && ctx.tunables && ctx.tunables.applyNoise;
    const bias  = useBias
      ? (this.biasMode === 'over'  ?  this.biasAmount
       : this.biasMode === 'under' ? -this.biasAmount
       : 0)
      : 0;
    const noise = useNoise
      ? this.valuationNoise * (2 * rng() - 1)
      : 0;
    const prior = Math.max(0, fv * (1 + bias + noise));
    this.trueValuation = prior;

    // Gather last period's messages from the bus (peer channel). These
    // drive the blend in Plan I and feed the next period-boundary LLM
    // call in Plans II/III.
    const bus        = ctx && ctx.messageBus;
    const ext        = ctx && ctx.extended;
    const canListen  = !ext || ext.communication !== false;
    const prevPeriod = market.period - 1;
    const msgs       = (bus && canListen && prevPeriod >= 1) ? bus.byPeriod(prevPeriod, market.round) : [];
    this.receivedMsgs = msgs;
    const foreign = msgs.filter(m => m.senderId !== this.id);

    // Plans II and III consume a cached LLM belief first — it's already
    // blended on the model side so the algorithmic fallback is skipped
    // when a fresh cached value is available. The cache is keyed by
    // agent id and refreshed at period boundary by Engine._runPlanLLM.
    let subjective = null;
    if (plan === 'II' || plan === 'III') {
      const cache = ctx && ctx.llmBeliefs;
      if (cache && cache[this.id] != null) {
        subjective = cache[this.id];
      }
    }

    // Algorithmic fallback (and Plan I's primary path). Prior weight
    // grows with accumulated experience: w ∈ {0.6, 0.7, 0.8, 0.9} for
    // roundsPlayed ∈ {0, 1, 2, ≥3}. With an empty message set the
    // posterior collapses to the prior.
    if (subjective == null) {
      const w = 0.6 + 0.1 * Math.min(3, this.roundsPlayed | 0);
      if (foreign.length) {
        const avg = foreign.reduce((s, m) => s + m.claimedValuation, 0) / foreign.length;
        subjective = w * prior + (1 - w) * avg;
      } else {
        subjective = prior;
      }
    }

    this.subjectiveValuation = Math.max(0, subjective);
    return { trueV: this.trueValuation, subjectiveV: this.subjectiveValuation };
  }

  /* ---- Pipeline step 3: evaluate candidate actions ----
   *
   * Wealth is mark-to-belief: every inventory share is valued at the
   * agent's subjective valuation `v`. This means an agent that believes
   * a share is worth more than the ask will see EU(buy) > EU(hold) and
   * cross the book, and symmetrically for sells. The full action set
   * evaluated each tick is {hold, buy@ask, sell@bid, post bid, post ask}.
   */
  evaluate(market, rng, ctx) {
    const v    = this.subjectiveValuation;
    const bid  = market.book.bestBid();
    const ask  = market.book.bestAsk();
    const cash = this.cash;
    const inv  = this.inventory;
    const w0   = cash + inv * v;
    const U    = (w) => computeUtility(this.riskPref, w, this.initialWealth);
    const U0   = U(w0);
    const pFill       = tunable(ctx, 'passiveFillProb');
    const passiveBidLo = tunable(ctx, 'passiveBidLo');
    const passiveBidHi = tunable(ctx, 'passiveBidHi');
    const passiveAskLo = tunable(ctx, 'passiveAskLo');
    const passiveAskHi = tunable(ctx, 'passiveAskHi');
    const candidates = [];

    candidates.push({
      label:    'hold',
      type:     'hold',
      price:    null,
      quantity: null,
      wealthIf: w0,
      eu:       U0,
    });

    // Cross the book: hit best ask (buy). Deterministic fill.
    // Profitable iff v > ask.price — the agent believes the share is
    // worth more than what it pays.
    if (ask && cash >= ask.price) {
      const w1 = (cash - ask.price) + (inv + 1) * v;
      candidates.push({
        label:    `buy@ask ${ask.price.toFixed(2)}`,
        type:     'bid',
        price:    ask.price,
        quantity: 1,
        wealthIf: w1,
        eu:       U(w1),
      });
    }
    // Lift best bid (sell). Deterministic fill.
    // Profitable iff bid.price > v — the bid exceeds the agent's
    // subjective value.
    if (bid && inv > 0) {
      const w1 = (cash + bid.price) + (inv - 1) * v;
      candidates.push({
        label:    `sell@bid ${bid.price.toFixed(2)}`,
        type:     'ask',
        price:    bid.price,
        quantity: 1,
        wealthIf: w1,
        eu:       U(w1),
      });
    }
    // Passive bid at v × [passiveBidLo, passiveBidHi]. Probabilistic fill.
    {
      const price = round2(v * (passiveBidLo + rng() * Math.max(0, passiveBidHi - passiveBidLo)));
      if (price > 0 && cash >= price) {
        const w1 = (cash - price) + (inv + 1) * v;
        const eu = pFill * U(w1) + (1 - pFill) * U0;
        candidates.push({
          label:    `passive bid ${price.toFixed(2)}`,
          type:     'bid',
          price,
          quantity: 1,
          passive:  true,
          pFill,
          wealthIf: w1,
          eu,
        });
      }
    }
    // Passive ask at v × [passiveAskLo, passiveAskHi]. Probabilistic fill.
    if (inv > 0) {
      const price = round2(v * (passiveAskLo + rng() * Math.max(0, passiveAskHi - passiveAskLo)));
      const w1 = (cash + price) + (inv - 1) * v;
      const eu = pFill * U(w1) + (1 - pFill) * U0;
      candidates.push({
        label:    `passive ask ${price.toFixed(2)}`,
        type:     'ask',
        price,
        quantity: 1,
        passive:  true,
        pFill,
        wealthIf: w1,
        eu,
      });
    }
    return { candidates, w0, U0 };
  }

  /* ---- Pipeline step 4 + 5: choose + execute ---- */
  decide(market, rng, ctx = {}) {
    this.observe(market);
    this.updateBelief(market, ctx, rng);

    // Plan II / III — LLM direct action override. The cached action
    // from the period-boundary LLM call is translated into an order
    // using the *current* book state. Consumed once, then cleared.
    const plan = ctx && ctx.plan;
    const llmEntry = ctx && ctx.llmActions && ctx.llmActions[this.id];
    if ((plan === 'II' || plan === 'III') && llmEntry) {
      const result = this._translateLLMAction(llmEntry, market);
      delete ctx.llmActions[this.id];
      if (result) return result;
      // Falls through to EU evaluation if action is invalid.
    }

    const { candidates, w0, U0 } = this.evaluate(market, rng, ctx);

    let chosen = candidates[0];
    for (const c of candidates) if (c.eu > chosen.eu) chosen = c;

    const reasoning = {
      ruleUsed:         `utility_max_${this.riskPref}`,
      estimatedValue:   this.subjectiveValuation,
      expectedProfit:   (chosen.wealthIf != null ? chosen.wealthIf : w0) - w0,
      triggerCondition: `argmax EU over ${candidates.length} candidates`,
      utility: {
        riskPref:        this.riskPref,
        initialWealth:   this.initialWealth,
        wealth0:         w0,
        U0,
        trueValuation:   this.trueValuation,
        subjectiveValue: this.subjectiveValuation,
        candidates: candidates.map(c => ({
          label:    c.label,
          type:     c.type,
          price:    c.price,
          wealthIf: c.wealthIf,
          eu:       c.eu,
          passive:  !!c.passive,
        })),
        chosen: chosen.label,
      },
      biasActive:   !!(ctx && ctx.tunables && ctx.tunables.applyBias),
      noiseActive:  !!(ctx && ctx.tunables && ctx.tunables.applyNoise),
      biasMode:     this.biasMode,
      biasAmount:   this.biasAmount,
      beliefMode:   this.beliefMode,
      receivedMsgs: this.receivedMsgs.map(m => ({
        from:  m.senderName,
        claim: m.claimedValuation,
        sig:   m.signal,
      })),
    };

    if (chosen.type === 'hold') return { type: 'hold', reasoning };
    return {
      type:     chosen.type,
      price:    chosen.price,
      quantity: chosen.quantity || 1,
      reasoning,
    };
  }

  /**
   * Translate an LLM action string into an order using the current
   * book state. Returns null if the action is invalid (constraint
   * violation), in which case decide() falls back to EU evaluation.
   */
  _translateLLMAction(llmEntry, market) {
    const { action, reason } = llmEntry;
    const bid  = market.book.bestBid();
    const ask  = market.book.bestAsk();
    const cash = this.cash;
    const inv  = this.inventory;
    const reasoning = {
      ruleUsed:         `llm_action`,
      estimatedValue:   this.subjectiveValuation,
      expectedProfit:   null,
      triggerCondition: `LLM chose ${action}`,
      llmReason:        reason,
      biasActive:       false,
      noiseActive:      false,
      biasMode:         this.biasMode,
      biasAmount:       this.biasAmount,
      beliefMode:       this.beliefMode,
      receivedMsgs:     this.receivedMsgs.map(m => ({
        from: m.senderName, claim: m.claimedValuation, sig: m.signal,
      })),
    };

    if (action === 'BUY_NOW' && ask && cash >= ask.price) {
      return { type: 'bid', price: ask.price, quantity: 1, reasoning };
    }
    if (action === 'SELL_NOW' && bid && inv > 0) {
      return { type: 'ask', price: bid.price, quantity: 1, reasoning };
    }
    if (action === 'BID_1' && bid && cash >= bid.price + 1) {
      return { type: 'bid', price: round2(bid.price + 1), quantity: 1, reasoning };
    }
    if (action === 'BID_3' && bid && cash >= bid.price + 3) {
      return { type: 'bid', price: round2(bid.price + 3), quantity: 1, reasoning };
    }
    if (action === 'ASK_1' && ask && inv > 0) {
      return { type: 'ask', price: round2(ask.price - 1), quantity: 1, reasoning };
    }
    if (action === 'ASK_3' && ask && inv > 0) {
      return { type: 'ask', price: round2(ask.price - 3), quantity: 1, reasoning };
    }
    if (action === 'HOLD') {
      return { type: 'hold', reasoning };
    }
    return null;
  }

  /* ---- Communication (called once per period by engine) ---- */
  communicate(market, rng, ctx) {
    const v = this.subjectiveValuation || market.fundamentalValue();
    const honestNoise         = tunable(ctx, 'honestNoise');
    const biasedTilt          = tunable(ctx, 'biasedTilt');
    const deceptiveOverstate  = tunable(ctx, 'deceptiveOverstate');
    const deceptiveUnderstate = tunable(ctx, 'deceptiveUnderstate');
    const signalThreshold     = tunable(ctx, 'signalThreshold');
    const deceptiveThreshold  = tunable(ctx, 'deceptiveThreshold');
    let report = v;

    if (this.deceptionMode === 'honest') {
      report = v * (1 + (rng() - 0.5) * 2 * honestNoise);
    } else if (this.deceptionMode === 'biased') {
      let tilt;
      if (this.biasMode === 'over')       tilt = +biasedTilt;
      else if (this.biasMode === 'under') tilt = -biasedTilt;
      else                                tilt = (rng() - 0.5) * 2 * biasedTilt;
      report = v * (1 + tilt);
    } else if (this.deceptionMode === 'deceptive') {
      // Asset-poor agents understate (to depress price and buy cheap);
      // asset-rich agents overstate (to inflate price and sell dear).
      const wantsToSell = this.inventory > this.initialInventory;
      const wantsToBuy  = this.inventory < this.initialInventory;
      if (wantsToSell)      report = v * deceptiveOverstate;
      else if (wantsToBuy)  report = v * deceptiveUnderstate;
      else                  report = v * (1 + (rng() - 0.5) * 2 * biasedTilt);
    }
    report = Math.max(0, report);
    this.reportedValuation = report;

    // Compare the claimed valuation to the market price (or FV if no
    // trades yet) so the signal reflects the directional content visible
    // to other agents, not the degree of private-vs-public divergence.
    const ref = market.lastPrice != null ? market.lastPrice
                                         : market.fundamentalValue();
    const signal = report > ref * (1 + signalThreshold) ? 'buy'
                 : report < ref * (1 - signalThreshold) ? 'sell'
                 : 'hold';
    const deceptive = this.deceptionMode !== 'honest' &&
                      Math.abs(report - v) / Math.max(1, v) > deceptiveThreshold;

    return {
      senderId:         this.id,
      senderName:       this.displayName,
      round:            market.round,
      period:           market.period,
      tick:             market.tick,
      trueValuation:    v,
      claimedValuation: report,
      signal,
      deceptionMode:    this.deceptionMode,
      deceptive,
    };
  }
}

/* ---------- Helpers + populations ------------------------------------- */

function order(type, price, quantity, reasoning) {
  return { type, price, quantity, reasoning };
}
function hold(reasoning) {
  return { type: 'hold', reasoning };
}
function round2(x) { return Math.round(x * 100) / 100; }

const POPULATIONS = {};

/* ---------- Utility (expected-utility) population ----------
 * Six agents span the full strategy cube (risk × bias × deception ×
 * belief), so one run of this preset exercises every branch of the
 * UtilityAgent decision engine and every belief-update path.
 *
 *   U1  averse  · unbiased   · honest    · adaptive   (rational core)
 *   U2  averse  · under      · honest    · skeptical  (cautious)
 *   U3  neutral · unbiased   · biased    · naive      (gullible biaser)
 *   U4  neutral · over       · deceptive · adaptive   (strategic liar)
 *   U5  loving  · over       · deceptive · naive      (bubble pump)
 *   U6  loving  · unbiased   · honest    · skeptical  (risk taker)
 */
const UTILITY_SLOTS = [
  { name: 'U1', riskPref: 'averse',  biasMode: 'none',  biasAmount: 0,    deceptionMode: 'honest',    beliefMode: 'adaptive'  },
  { name: 'U2', riskPref: 'averse',  biasMode: 'under', biasAmount: 0.10, deceptionMode: 'honest',    beliefMode: 'skeptical' },
  { name: 'U3', riskPref: 'neutral', biasMode: 'none',  biasAmount: 0,    deceptionMode: 'biased',    beliefMode: 'naive'     },
  { name: 'U4', riskPref: 'neutral', biasMode: 'over',  biasAmount: 0.15, deceptionMode: 'deceptive', beliefMode: 'adaptive'  },
  { name: 'U5', riskPref: 'loving',  biasMode: 'over',  biasAmount: 0.20, deceptionMode: 'deceptive', beliefMode: 'naive'     },
  { name: 'U6', riskPref: 'loving',  biasMode: 'none',  biasAmount: 0,    deceptionMode: 'honest',    beliefMode: 'skeptical' },
];
POPULATIONS.utility = UTILITY_SLOTS.map(s => ({ cls: UtilityAgent, name: s.name, opts: s }));

function buildAgents(populationKey, overrides = {}) {
  const spec = POPULATIONS[populationKey] || POPULATIONS.utility;
  const out = {};
  spec.forEach((s, i) => {
    const id = i + 1;
    if (s.opts) {
      const opts = Object.assign({}, s.opts);
      if (overrides.forceHonest) opts.deceptionMode = 'honest';
      if (overrides.biasAmount != null && opts.biasMode && opts.biasMode !== 'none') {
        opts.biasAmount = overrides.biasAmount;
      }
      if (overrides.valuationNoise != null) opts.valuationNoise = overrides.valuationNoise;
      out[id] = new s.cls(id, s.name, opts);
    } else {
      out[id] = new s.cls(id, s.name);
    }
  });
  return out;
}

/*
 * distributeRiskPrefs — turn a {loving, neutral, averse} percentage spec
 * into a length-`total` sequence of per-agent risk labels using
 * largest-remainder rounding so the integer counts sum exactly to total.
 * Returned order is averse → neutral → loving, chosen so a high risk-
 * averse share settles into the earliest U slots (which happen to be the
 * unbiased/honest slots of the strategy cube and so read as "cautious").
 */
function distributeRiskPrefs(total, pct) {
  if (total <= 0) return [];
  const p = pct || { loving: 33, neutral: 34, averse: 33 };
  const sum = (p.loving || 0) + (p.neutral || 0) + (p.averse || 0);
  // Degenerate input (all-zero) — fall back to an even split so the
  // population is still valid. Anything else uses the user spec as-is.
  const norm = sum > 0 ? p : { loving: 33, neutral: 34, averse: 33 };
  const normSum = sum > 0 ? sum : 100;
  const raw = {
    loving:  total * (norm.loving  || 0) / normSum,
    neutral: total * (norm.neutral || 0) / normSum,
    averse:  total * (norm.averse  || 0) / normSum,
  };
  const base = {
    loving:  Math.floor(raw.loving),
    neutral: Math.floor(raw.neutral),
    averse:  Math.floor(raw.averse),
  };
  let assigned = base.loving + base.neutral + base.averse;
  const fracs = [
    { k: 'loving',  f: raw.loving  - base.loving  },
    { k: 'neutral', f: raw.neutral - base.neutral },
    { k: 'averse',  f: raw.averse  - base.averse  },
  ].sort((a, b) => b.f - a.f);
  let i = 0;
  while (assigned < total) { base[fracs[i % 3].k]++; assigned++; i++; }
  const seq = [];
  for (let j = 0; j < base.averse;  j++) seq.push('averse');
  for (let j = 0; j < base.neutral; j++) seq.push('neutral');
  for (let j = 0; j < base.loving;  j++) seq.push('loving');
  return seq;
}

/* =====================================================================
   Sampling stage — names + endowments

   Before the simulation starts, the population is drawn from a mix
   (counts by type) into a flat list of per-agent "specs". Each spec
   carries a display name (drawn from AGENT_NAMES without replacement),
   a starting cash + inventory pair (drawn from ENDOWMENT_DEFAULT), and
   the strategy metadata needed to instantiate the agent later. The UI
   lets the user review this list and edit individual endowments
   between runs; buildAgentsFromSpecs then turns the (possibly edited)
   spec array into live agent objects.

   Sampling uses a dedicated RNG derived from the main seed, so editing
   endowments and re-running keeps the *engine* RNG state identical
   across runs with and without a re-sample.
   ===================================================================== */

const AGENT_NAMES = [
  'Alma','Bruno','Cass','Dina','Eli','Fiona','Gus','Hana',
  'Igor','Juno','Kofi','Lena','Milo','Nora','Otis','Petra',
  'Quinn','Remy','Sage','Tam','Uma','Vera','Wren','Xena',
  'Yara','Zane','Axel','Bria','Cleo','Dov','Esme','Finn',
  'Gia','Hugo','Ivy','Joss','Knox','Luna','Mona','Neo',
  'Oki','Pax','Rhea','Sky','Tavi','Uli','Vic','Wim',
  'Xio','Yui','Zev','Ash','Bay','Cora','Dax','Eno',
];

const ENDOWMENT_DEFAULT = {
  cashMin: 800,
  cashMax: 1200,
  invMin:  2,
  invMax:  4,
};

function pickNames(n, rng) {
  const pool = AGENT_NAMES.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool[i % pool.length]);
  return out;
}

function sampleEndowment(rng, dist) {
  const d = dist || ENDOWMENT_DEFAULT;
  const cash = Math.round(d.cashMin + rng() * (d.cashMax - d.cashMin));
  const span = Math.max(0, d.invMax - d.invMin);
  const inventory = d.invMin + Math.floor(rng() * (span + 1));
  return { cash, inventory };
}

/**
 * sampleAgents — draw a list of per-agent specs for the relaxed
 * paradigms (Lopez-Lira and AIPE). DLM strict mode does NOT use this
 * function — it uses dlmSampleAgents below, which pins N=6 and the
 * two DLM endowment types and never instantiates a non-DLMTrader
 * agent. This function deliberately drops the legacy E branch: no
 * agent in any paradigm is ever instantiated with pre-assigned
 * experience.
 */
function sampleAgents(mix, rng, options = {}) {
  const dist = options.endowment || ENDOWMENT_DEFAULT;
  const uCount = mix.U || 0;
  const total =
    (mix.F || 0) + (mix.T || 0) + (mix.R || 0) + uCount;

  const names   = pickNames(total, rng);
  const riskSeq = distributeRiskPrefs(uCount, options.riskMix);
  const specs = [];
  let id = 1;
  let nameIdx = 0;

  const pushBasic = (type, typeCode, index, extra = {}) => {
    const e = sampleEndowment(rng, dist);
    specs.push({
      id, slot: id, type,
      typeLabel: `${typeCode}${index}`,
      name:      names[nameIdx++],
      cash:      e.cash,
      inventory: e.inventory,
      ...extra,
    });
    id++;
  };

  for (let i = 0; i < (mix.F || 0); i++) pushBasic('fundamentalist', 'F', i + 1);
  for (let i = 0; i < (mix.T || 0); i++) pushBasic('trend',         'T', i + 1);
  for (let i = 0; i < (mix.R || 0); i++) pushBasic('random',        'R', i + 1);

  // Under Plans I/II/III every utility agent is honest, unbiased, and
  // distinguished from its peers only by risk preference (drawn from
  // the riskMix slider). The old strategy cube's bias/deception axes
  // are out of scope for the plan-based experiments, so sampleAgents
  // pins bias='none'/deception='honest' and reads risk preference
  // directly from the distributeRiskPrefs sequence.
  for (let i = 0; i < uCount; i++) {
    const risk  = riskSeq.length ? riskSeq[i] : 'neutral';
    const cycle = Math.floor(i / 6);
    const slotTag = `U${(i % 6) + 1}`;
    const e = sampleEndowment(rng, dist);
    specs.push({
      id, slot: id, type: 'utility',
      typeLabel:     cycle > 0 ? `${slotTag}·${cycle + 1}` : slotTag,
      name:          names[nameIdx++],
      cash:          e.cash,
      inventory:     e.inventory,
      riskPref:      risk,
      biasMode:      'none',
      biasAmount:    0,
      deceptionMode: 'honest',
      beliefMode:    'plan',
    });
    id++;
  }
  return specs;
}

/**
 * buildAgentsFromSpecs — instantiate concrete Agent objects from a
 * spec array produced (and possibly edited) via sampleAgents.
 *
 * overrides:
 *   biasAmount      override per-slot biasAmount for all biased U slots
 *   valuationNoise  override per-slot valuation noise
 *   forceHonest     collapse every U slot's deceptionMode to 'honest'
 */
function buildAgentsFromSpecs(specs, overrides = {}) {
  const out = {};
  for (const s of specs) {
    const cash = s.cash != null ? s.cash : 1000;
    const inv  = s.inventory != null ? s.inventory : 3;
    // Prefix the slot number to the personal name so every surface
    // that consumes displayName (charts, feeds, tables, logs) shows
    // a consistent "#3 Milo" label for monitoring.
    const label = `#${s.id} ${s.name}`;
    let agent;
    switch (s.type) {
      case 'fundamentalist':
        agent = new Fundamentalist(s.id, label, cash, inv); break;
      case 'trend':
        agent = new TrendFollower(s.id, label, cash, inv);  break;
      case 'random':
        agent = new RandomAgent(s.id, label, cash, inv);    break;
      case 'dlm':
        agent = new DLMTrader(s.id, label, cash, inv);
        if (s.replacement) agent.replacementFresh = true;
        break;
      case 'utility': {
        const opts = {
          cash, inventory: inv,
          riskPref:       s.riskPref,
          biasMode:       s.biasMode,
          biasAmount:     s.biasAmount,
          deceptionMode:  s.deceptionMode,
          beliefMode:     s.beliefMode,
        };
        if (overrides.forceHonest) opts.deceptionMode = 'honest';
        if (overrides.biasAmount != null && opts.biasMode && opts.biasMode !== 'none') {
          opts.biasAmount = overrides.biasAmount;
        }
        if (overrides.valuationNoise != null) opts.valuationNoise = overrides.valuationNoise;
        agent = new UtilityAgent(s.id, label, opts);
        break;
      }
      default:
        continue;
    }
    agent.typeLabel = s.typeLabel;
    // Carry DLM endowment-type (A/B) from spec onto the agent so the
    // UI card can display it and the snapshotter can expose it to
    // replay views without reaching back into agentSpecs.
    if (s.endowmentType) agent.endowmentType = s.endowmentType;
    out[s.id] = agent;
  }
  return out;
}

