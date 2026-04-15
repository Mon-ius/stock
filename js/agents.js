'use strict';

/* =====================================================================
   agents.js — UtilityAgent + population sampler.

   In the counterfactual system all traders are UtilityAgents. They
   differ along three orthogonal axes, each drawn at sampling time and
   persistent for the life of the agent:

     riskPref          ∈ {loving, neutral, averse}
     cognitiveType     ∈ {naive, kalman, analytical}
     regulatorReaction ∈ {ignore, discount, panic}
     biasMode          ∈ {-1, 0, +1}          (optional prior tilt)
     isLLM             ∈ {false, true}        (routed through js/llm.js stub)
     traced            ∈ {false, true}        (full decision trace vs. aggregate)

   The decision pipeline is:

     observed dividends → estimator → fvHat (cognitive capacity)
     fvHat → apply bias + noise → prior
     prior + trusted peer reports → subjective V
     V → regulator reaction if warning is in force
     V → EU argmax over {hold, buy@ask, sell@bid, passive bid, passive ask}
         (or LLM.decide if isLLM)

   The agent owns no global state. `deps` bundles the shared services
   the agent reads (bus, trust, regulator, tunables) so decide() is
   pure w.r.t. that input.
   ===================================================================== */

const UTILITY_DEFAULTS = {
  biasAmount:      0.15,
  valuationNoise:  0.03,
  passiveFillProb: 0.30,
  priorMix:        0.60,  // own prior vs. trust-weighted peer mean
  discountGamma:   0.12,
  panicAskBias:    0.05,
  trustLambda:     0.30,
  applyBias:       true,
  applyNoise:      true,
  peerWindow:      1,     // number of prior periods of reports to fold in
};

const RISK_UTIL = {
  loving:  (w, w0) => Math.pow(Math.max(0, w) / Math.max(1, w0), 2),
  neutral: (w, w0) => w / Math.max(1, w0),
  averse:  (w, w0) => Math.sqrt(Math.max(0, w) / Math.max(1, w0)),
};

const RISK_LABEL = {
  loving:  'Risk-loving',
  neutral: 'Risk-neutral',
  averse:  'Risk-averse',
};

const COGNITIVE_LABEL = {
  naive:      'Naive (sample mean)',
  kalman:     'Kalman (limited-window filter)',
  analytical: 'Analytical (full HMM filter)',
};

const AGENT_NAMES = [
  'Ada','Alan','Alex','Alice','Amara','Amelia','Ananya','Andrei','Anika','Anton',
  'Arun','Astrid','Aurora','Baxter','Beatrice','Ben','Bjorn','Blair','Bruno','Calla',
  'Camille','Cara','Cato','Cecil','Cedric','Celia','Cesar','Chen','Chiara','Cleo',
  'Cora','Cy','Dante','Darius','Davi','Delia','Diego','Dimitri','Dora','Eden',
  'Edgar','Elena','Elio','Elsa','Emil','Enzo','Esther','Etta','Ezra','Fabia',
  'Faris','Faye','Felix','Finn','Flora','Gael','Gemma','Gia','Gideon','Giulia',
  'Hana','Hari','Hector','Helga','Hiro','Hugo','Idris','Ilya','Imani','Indira',
  'Iris','Ivo','Jana','Jules','Juno','Kai','Kamil','Kira','Klara','Lars',
  'Lena','Leo','Lila','Liora','Luca','Magnus','Maia','Malik','Marin','Marta',
  'Mateo','Maya','Mila','Miro','Nadia','Nero','Nikos','Nila','Nora','Omar',
  'Orla','Otto','Paloma','Paul','Petra','Phoebe','Pia','Quill','Raj','Reema',
  'Rhea','Rio','Roan','Roman','Rosa','Sabine','Sade','Saga','Sami','Saoirse',
  'Sena','Shea','Sora','Sven','Tamsin','Tavi','Teo','Thalia','Thea','Tito',
  'Tobin','Ulla','Una','Uri','Vera','Vesna','Vik','Wren','Xavi','Yara',
  'Yuna','Zara','Zelda','Zev',
];

function pickName(rng, used) {
  const avail = AGENT_NAMES.filter(n => !used.has(n));
  if (avail.length) {
    const n = avail[Math.floor(rng() * avail.length)];
    used.add(n);
    return n;
  }
  // Fallback: append numeric suffix (N > pool size).
  const base = AGENT_NAMES[Math.floor(rng() * AGENT_NAMES.length)];
  let k = 2;
  while (used.has(`${base}-${k}`)) k++;
  const n = `${base}-${k}`;
  used.add(n);
  return n;
}

function drawCategorical(rng, mix) {
  // mix: { key: weight, ... } — weights need not sum to 1
  const entries = Object.entries(mix);
  const total = entries.reduce((s, [, w]) => s + Math.max(0, w), 0) || 1;
  let r = rng() * total;
  for (const [k, w] of entries) {
    r -= Math.max(0, w);
    if (r <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

/**
 * Draw a population of N specs from the supplied mixes.
 * mixes = {
 *   risk:       { loving, neutral, averse },      // sum = 100
 *   cognitive:  { naive, kalman, analytical },    // sum = 100
 *   reaction:   { ignore, discount, panic },      // sum = 100
 *   biasShare:  0..1 (fraction of agents with nonzero bias),
 *   llmShare:   0..1 (fraction of agents routed through the LLM stub),
 *   endowment:  { cashLo, cashHi, invLo, invHi },
 *   tracedCount: K (first K agents auto-traced),
 * }
 */
function sampleAgents(n, mixes, rng) {
  const used = new Set();
  const specs = [];
  const e = mixes.endowment || { cashLo: 800, cashHi: 1200, invLo: 2, invHi: 4 };
  for (let i = 0; i < n; i++) {
    const riskPref          = drawCategorical(rng, mixes.risk);
    const cognitiveType     = drawCategorical(rng, mixes.cognitive);
    const regulatorReaction = drawCategorical(rng, mixes.reaction);
    const biased            = rng() < (mixes.biasShare ?? 0.5);
    const biasMode          = biased ? (rng() < 0.5 ? -1 : 1) : 0;
    const isLLM             = rng() < (mixes.llmShare ?? 0);
    const cash              = Math.round(e.cashLo + rng() * (e.cashHi - e.cashLo));
    const inventory         = Math.floor(e.invLo + rng() * (e.invHi - e.invLo + 1));
    specs.push({
      id: i,
      name: pickName(rng, used),
      role: `${riskPref[0].toUpperCase()}${cognitiveType[0].toUpperCase()}${regulatorReaction[0].toUpperCase()}`,
      riskPref,
      cognitiveType,
      regulatorReaction,
      biasMode,
      isLLM,
      cash,
      inventory,
      traced: i < (mixes.tracedCount ?? 0),
    });
  }
  return specs;
}

/* ---------- UtilityAgent ---------------------------------------------- */

class UtilityAgent {
  constructor(spec, deps) {
    Object.assign(this, spec);
    this.initialCash      = spec.cash;
    this.initialInventory = spec.inventory;
    this.deps             = deps;
    this.estimator        = deps.makeEstimator(spec.cognitiveType);
    this.subjectiveV      = null;
    this.reportedV        = null;
    this.lastAction       = 'hold';
    this.lastTrace        = null;
    this.receivedAlert    = null;
    this.pendingAlertTick = -1;
  }

  observeDividend(d) { this.estimator.observe(d); }

  onRoundStart() {
    this.estimator.reset();
    this.receivedAlert = null;
    this.cash          = this.initialCash;
    this.inventory     = this.initialInventory;
    this.subjectiveV   = null;
    this.reportedV     = null;
  }

  _readAlerts(tick) {
    const T = this.deps.tunables;
    const sinceTick = Math.max(0, tick - (T.peerWindow + 1) * T.ticksPerPeriod);
    const msgs = this.deps.bus.recent(this.id, sinceTick);
    const alert = msgs.find(m => m.kind === 'regulator-warning');
    if (alert && alert.tick > this.pendingAlertTick) {
      this.receivedAlert    = alert;
      this.pendingAlertTick = alert.tick;
    }
    return msgs;
  }

  _peerBlend(prior, msgs) {
    const peerReports = msgs.filter(m => m.kind === 'valuation-report' && m.fromId !== this.id);
    if (!peerReports.length) return prior;
    let num = 0, den = 0;
    for (const m of peerReports) {
      const w = Math.max(0, this.deps.trust.get(this.id, m.fromId));
      num += w * m.payload.reportedV;
      den += w;
    }
    if (den <= 0) return prior;
    const mix = this.deps.tunables.priorMix;
    return mix * prior + (1 - mix) * (num / den);
  }

  decide(market, rng, tick) {
    const T  = this.deps.tunables;
    const pr = Math.max(0, market.periodsRemaining());
    const est = this.estimator.estimate(pr);
    const { fvHat, confidence, belief } = est;
    const biasTerm  = T.applyBias  ? (this.biasMode || 0) * T.biasAmount       : 0;
    const noiseTerm = T.applyNoise ? (rng() - 0.5) * 2 * T.valuationNoise      : 0;
    const prior     = fvHat * (1 + biasTerm + noiseTerm);

    const msgs      = this._readAlerts(tick);
    const afterPeers = this._peerBlend(prior, msgs);
    let V = afterPeers;

    const reg = this.deps.regulator;
    const regActive = reg && reg.isActive(tick);
    if (regActive) {
      if (this.regulatorReaction === 'discount') V *= (1 - T.discountGamma);
      else if (this.regulatorReaction === 'panic') V *= (1 - 2 * T.discountGamma);
    }
    this.subjectiveV = V;
    this.reportedV   = V;

    // LLM path
    if (this.isLLM && this.deps.llm) {
      const out = this.deps.llm.decide(this, market, V, tick, { fvHat, confidence, regActive, alert: this.receivedAlert });
      this.lastAction = out.action.type;
      this.lastTrace  = this.traced ? { source: 'llm', fvHat, V, ...out.reasoning } : null;
      return out.action;
    }

    // EU argmax over Plan I candidate set
    const bestBid = market.book.bestBid();
    const bestAsk = market.book.bestAsk();
    const util    = RISK_UTIL[this.riskPref] || RISK_UTIL.neutral;
    const w0      = Math.max(1, this.initialCash + this.initialInventory * Math.max(1, V));
    const wNow    = this.cash + this.inventory * V;
    const cands   = [];

    cands.push({ action: { type: 'hold' }, eu: util(wNow, w0), why: 'status-quo' });

    if (bestAsk && this.cash >= bestAsk.price) {
      const wA = (this.cash - bestAsk.price) + (this.inventory + 1) * V;
      cands.push({ action: { type: 'bid', price: bestAsk.price, quantity: 1, cross: true }, eu: util(wA, w0), why: `lift-ask@${bestAsk.price.toFixed(1)}` });
    }
    if (bestBid && this.inventory > 0) {
      const wA = (this.cash + bestBid.price) + (this.inventory - 1) * V;
      cands.push({ action: { type: 'ask', price: bestBid.price, quantity: 1, cross: true }, eu: util(wA, w0), why: `hit-bid@${bestBid.price.toFixed(1)}` });
    }

    const passiveBidPrice = Math.max(1, Math.round(V * 0.97));
    if (this.cash >= passiveBidPrice) {
      const pFill = T.passiveFillProb;
      const wFill = (this.cash - passiveBidPrice) + (this.inventory + 1) * V;
      const eu    = pFill * util(wFill, w0) + (1 - pFill) * util(wNow, w0);
      cands.push({ action: { type: 'bid', price: passiveBidPrice, quantity: 1 }, eu, why: 'passive-bid' });
    }
    let passiveAskRef = V * 1.03;
    if (regActive && this.regulatorReaction === 'panic') passiveAskRef = V * (1 - T.panicAskBias);
    const passiveAskPrice = Math.max(1, Math.round(passiveAskRef));
    if (this.inventory > 0) {
      const pFill = T.passiveFillProb;
      const wFill = (this.cash + passiveAskPrice) + (this.inventory - 1) * V;
      const eu    = pFill * util(wFill, w0) + (1 - pFill) * util(wNow, w0);
      cands.push({ action: { type: 'ask', price: passiveAskPrice, quantity: 1 }, eu, why: regActive && this.regulatorReaction === 'panic' ? 'panic-ask' : 'passive-ask' });
    }

    cands.sort((a, b) => b.eu - a.eu);
    const chosen = cands[0];
    this.lastAction = chosen.action.type;
    this.lastTrace = this.traced ? {
      source: 'eu',
      fvHat: round2(fvHat),
      confidence: round2(confidence),
      belief: belief ? [round2(belief[0]), round2(belief[1])] : null,
      bias: round2(biasTerm),
      noise: round2(noiseTerm),
      V: round2(V),
      regActive,
      chosen: chosen.why,
      candidates: cands.slice(0, 5).map(c => ({
        type: c.action.type,
        price: c.action.price ? round2(c.action.price) : null,
        eu: round4(c.eu),
        why: c.why,
      })),
    } : null;
    return chosen.action;
  }

  /** Post a valuation-report message at period close. */
  communicate(tick, round, period) {
    if (this.subjectiveV == null) return null;
    return this.deps.bus.post({
      tick, round, period,
      fromId: this.id,
      toId:   'all',
      kind:   'valuation-report',
      payload: { reportedV: this.subjectiveV, role: this.role },
    });
  }
}

function round2(x) { return x == null ? null : Math.round(x * 100) / 100; }
function round4(x) { return x == null ? null : Math.round(x * 10000) / 10000; }

if (typeof module !== 'undefined') {
  module.exports = {
    UTILITY_DEFAULTS, RISK_UTIL, RISK_LABEL, COGNITIVE_LABEL,
    AGENT_NAMES, sampleAgents, UtilityAgent,
  };
}
