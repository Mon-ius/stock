'use strict';

/* =====================================================================
   engine.js — Simulation loop + seeded RNG.

   Each tick the engine:
     1. Increments tick.
     2. Shuffles agent order (so fairness isn't dependent on array order).
     3. Asks every agent for a decision and logs a trace record.
     4. Submits bid/ask orders to the market, matches, settles trades.
     5. Records price history and captures a snapshot for replay.
     6. At the last tick of a period: draws the dividend, credits holders,
        logs a dividend event, advances the period and clears the book.

   The loop is driven by setTimeout with a configurable interval so the
   user can speed up or slow down the simulation in real time. A pause
   simply cancels the pending timeout; a resume starts it again.

   The RNG is a seeded mulberry32 so a given (population, seed) pair is
   fully reproducible — critical for research-grade inspection.
   ===================================================================== */

/** Seedable 32-bit PRNG — reproducible across runs. */
function makeRNG(seed) {
  let s = (seed >>> 0) || 1;
  return function rng() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Engine {
  constructor(market, agents, logger, config, rng, ctx = null) {
    this.market  = market;
    this.agents  = agents;
    this.logger  = logger;
    this.config  = config;
    this._rng    = rng || Math.random;
    // ctx carries the message bus, trust tracker, and extended-config
    // flags used by UtilityAgents. Legacy agents ignore it entirely.
    this.ctx     = ctx || {};
    this.running = false;
    this._timer  = null;
    this.onTick     = null;     // callback after each step
    this.onEnd      = null;
    this.onRoundEnd = null;     // callback(round) after each round boundary
  }

  get tickInterval() { return this.config.tickInterval; }

  start() {
    if (this.running || this.isFinished()) return;
    this.running = true;
    this._loop();
  }
  pause() {
    this.running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }
  _loop() {
    if (!this.running) return;
    const batch = this.config.ticksPerFrame || 1;
    for (let i = 0; i < batch; i++) {
      this.step();
      if (this.isFinished()) {
        this.running = false;
        if (this.onTick) this.onTick();
        if (this.onEnd) this.onEnd();
        return;
      }
    }
    if (this.onTick) this.onTick();
    this._timer = setTimeout(() => this._loop(), this.tickInterval);
  }

  /**
   * Synchronous step loop used by the multi-session batch driver.
   * Runs the engine to completion in a single tight loop with no
   * setTimeout, no rendering, and no onTick callbacks. Returns
   * after the final tick of the final round of the session.
   */
  runToEnd() {
    while (!this.isFinished()) this.step();
    if (this.onEnd) this.onEnd();
  }

  /** Run one tick of the simulation. */
  step() {
    const m = this.market;
    m.tick++;

    // Fisher-Yates shuffle of agent ids → fairness within a tick.
    const ids = Object.keys(this.agents);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(this._rng() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }

    for (const id of ids) {
      const agent    = this.agents[id];
      const decision = agent.decide(m, this._rng, this.ctx);

      // Build the trace record BEFORE submission so we capture the
      // agent's state at decision time, then fill in `filled` after
      // matching tells us what actually executed.
      const trace = {
        timestamp: m.tick,
        period:    m.period,
        agentId:   agent.id,
        agentName: agent.displayName,
        agentType: agent.type,
        state: {
          cash:           Math.round(agent.cash * 100) / 100,
          inventory:      agent.inventory,
          estimatedValue: decision.reasoning?.estimatedValue ?? null,
          observedPrice:  m.lastPrice,
        },
        decision: {
          type:     decision.type,
          price:    decision.price    ?? null,
          quantity: decision.quantity ?? null,
          passive:  !!decision.passive,
        },
        reasoning: {
          ruleUsed:         decision.reasoning?.ruleUsed         ?? 'unknown',
          expectedProfit:   decision.reasoning?.expectedProfit   ?? null,
          triggerCondition: decision.reasoning?.triggerCondition ?? '',
          utility:          decision.reasoning?.utility          ?? null,
          beliefMode:       decision.reasoning?.beliefMode       ?? null,
          receivedMsgs:     decision.reasoning?.receivedMsgs     ?? null,
        },
        filled: 0,
      };
      this.logger.logTrace(trace);

      // Extended logging for utility agents: valuation, wealth/utility,
      // and the full EU candidate table. Each stream is append-only;
      // the snapshot records its current length so replay slices cleanly.
      const u = decision.reasoning && decision.reasoning.utility;
      if (u) {
        this.logger.logValuation({
          tick:      m.tick,
          period:    m.period,
          agentId:   agent.id,
          agentName: agent.displayName,
          trueV:     u.trueValuation,
          subjV:     u.subjectiveValue,
          reportedV: agent.reportedValuation != null ? agent.reportedValuation : null,
        });
        this.logger.logUtility({
          tick:      m.tick,
          period:    m.period,
          agentId:   agent.id,
          cash:      agent.cash,
          inventory: agent.inventory,
          wealth:    u.wealth0,
          utility:   u.U0,
          riskPref:  u.riskPref,
        });
        this.logger.logEvaluation({
          tick:       m.tick,
          period:     m.period,
          agentId:    agent.id,
          candidates: u.candidates,
          chosen:     u.chosen,
        });
      }

      if (decision.type === 'bid' || decision.type === 'ask') {
        const order = new Order(
          agent.id,
          decision.type,
          decision.price,
          decision.quantity || 1,
          m.tick,
          m.period,
        );
        const fills = m.submitOrder(order, agent);
        if (fills && fills.length) {
          m.applyTrades(fills, this.agents);
          trace.filled = fills.reduce((s, t) => s + t.quantity, 0);
        }
        agent.lastAction  = decision.type;
        agent.lastPassive = !!decision.passive;
      } else {
        agent.lastAction  = 'hold';
        agent.lastPassive = false;
      }
    }

    m.recordTick();
    this.logger.snapshot(this._captureSnapshot());

    // Period boundary: dividend + comms round + period advance + book reset.
    // At the final period of a non-terminal round the engine also runs a
    // round-end transition: fresh endowments, book clear, round counter
    // incremented, period reset to 1. DLM 2005 subjects start every round
    // with the same cash/inventory schedule; we reset from App.agentSpecs
    // to honour that, while carrying agent identity (riskPref, beliefs,
    // trust matrix) across rounds so the cross-round learning channel
    // the paper hinges on is the only source of persistent state.
    if (m.tick % this.config.ticksPerPeriod === 0) {
      const d = m.payDividend(this.agents, this._rng, this.ctx);
      this.logger.logEvent({ tick: m.tick, type: 'dividend', period: m.period, round: m.round, value: d });
      // Communication + trust update (no-op unless extended mode + comms on).
      this._communicationRound();
      if (m.period < this.config.periods) {
        m.period++;
        m.book.clear();
        this.logger.logEvent({ tick: m.tick, type: 'period_start', period: m.period, round: m.round });
      } else if (m.round < (this.config.roundsPerSession || 1)) {
        // Capture each agent's final cash for this round before the
        // reset rewinds it. The session payoff is the sum across
        // rounds plus the $5 (=500¢) show-up fee, exactly as in DLM
        // 2005 ("subjects were privately paid, in cash, the amount
        // of their final cash holdings from each round").
        this._captureRoundFinalCash(m.round);
        this.logger.logEvent({ tick: m.tick, type: 'round_end', round: m.round });
        if (this.onRoundEnd) this.onRoundEnd(m.round);
        // Endogenous experience: each agent that just finished
        // playing this round has its roundsPlayed counter
        // incremented HERE, before the replacement step runs, so
        // the survivors of rounds 1–3 enter the replacement step
        // with roundsPlayed = 3 and the fresh agents spliced in by
        // _round4Replacement keep their roundsPlayed = 0 because
        // the increment has already fired for the existing agents.
        for (const id of Object.keys(this.agents)) {
          const a = this.agents[id];
          a.roundsPlayed = (a.roundsPlayed || 0) + 1;
        }
        // Replacement transition: the treatment-controlled replacement
        // step fires BEFORE the next round's reset rewinds endowments,
        // so the new fresh agents take their replacement endowments and
        // the surviving veterans start the replacement round from their
        // original spec. DLM 2005 fixes the boundary at round 3 → 4
        // (replacementRound = 4); Advanced settings exposes it as a
        // slider so replacement can happen at any r ∈ [2, R].
        const replaceR = (this.ctx && this.ctx.replacementRound) | 0 || 4;
        if (m.round === replaceR - 1) {
          this._round4Replacement();
        }
        this._resetRound();
        m.round++;
        m.period    = 1;
        m.lastPrice = null;
        m.book.clear();
        this.logger.logEvent({ tick: m.tick, type: 'round_start', round: m.round });
      } else if (m.round === (this.config.roundsPerSession || 1) && m.period === this.config.periods) {
        // Final round, final period: capture payoff one last time
        // so the session payoff sum spans every round.
        this._captureRoundFinalCash(m.round);
        if (this.onRoundEnd) this.onRoundEnd(m.round);
      }
    }
  }

  /**
   * Snapshot agent.cash for every agent into Logger.roundFinalCash[r-1].
   * Called at the end of period T of each round, *after* the last
   * dividend has been credited and *before* _resetRound rewinds the
   * cash field. The captured number is the experimental-cent payoff
   * the subject "took home" from that round under the DLM 2005 design.
   */
  _captureRoundFinalCash(round) {
    const byAgent = {};
    for (const id of Object.keys(this.agents)) {
      const a = this.agents[id];
      byAgent[a.id] = Math.round(a.cash * 100) / 100;
    }
    this.logger.logRoundFinalCash(round, byAgent);
  }

  /**
   * Round-3 → round-4 replacement step (DLM 2005 §I, p. 1733).
   *
   * At the round 3→4 boundary the engine randomly selects
   * `treatmentSize` experienced agents, removes them, and splices in
   * the same number of fresh agents (roundsPlayed = 0,
   * replacementFresh = true). Treatment sizes (N = 100 scale):
   *   T20 (R4-⅔) — 20 replaced, 80 veterans remain.
   *   T40 (R4-⅓) — 40 replaced, 60 veterans remain.
   *
   * Replacement agents are cloned from the removed agent's spec and
   * re-instantiated via buildAgentsFromSpecs so they match the
   * current population type (UtilityAgent or DLMTrader).
   */
  _round4Replacement() {
    const treatmentSize = (this.ctx && this.ctx.treatmentSize) | 0;
    if (treatmentSize <= 0) return;
    const specs = this.ctx.agentSpecs;
    if (!Array.isArray(specs)) return;

    // Pool of agent ids that have completed all three preceding
    // rounds. The Engine increments roundsPlayed inside _resetRound
    // and we are here BEFORE that call fires for the round-3 → 4
    // boundary, so the surviving original agents currently sit at
    // roundsPlayed = 2 and the ones that played rounds 1, 2, and 3
    // satisfy that condition by construction.
    const eligible = Object.keys(this.agents)
      .map(Number)
      .filter(id => !this.agents[id].replacementFresh);
    if (!eligible.length) return;

    // Fisher–Yates pick of `treatmentSize` agents without replacement.
    const pool = eligible.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this._rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const removeIds = pool.slice(0, Math.min(treatmentSize, pool.length));

    // Collect existing display names so the replacement draw never
    // reuses a name already on the table (purely cosmetic — the
    // numeric id is the real identity channel).
    const usedNames = new Set(
      Object.values(this.agents).map(a => {
        // Strip the "#N " prefix back down to the personal name so the
        // exclude set matches what dlmSampleReplacementAgent reads.
        const dn = a.displayName || '';
        const m  = dn.match(/^#\d+\s+(.*)$/);
        return m ? m[1] : dn;
      }),
    );
    const replacements = [];
    for (const oldId of removeIds) {
      const oldSpec = specs.find(s => s.id === oldId);
      // Pick a fresh unique name.
      const namePool = AGENT_NAMES.filter(n => !usedNames.has(n));
      for (let ni = namePool.length - 1; ni > 0; ni--) {
        const nj = Math.floor(this._rng() * (ni + 1));
        [namePool[ni], namePool[nj]] = [namePool[nj], namePool[ni]];
      }
      const freshName = namePool[0] || ('R' + oldId);
      usedNames.add(freshName);
      // Clone the removed agent's spec but reset to a fresh newcomer.
      const freshSpec = Object.assign({}, oldSpec, {
        name:        freshName,
        replacement: true,
      });
      const idx = specs.findIndex(s => s.id === oldId);
      if (idx >= 0) specs[idx] = freshSpec;
      const built = buildAgentsFromSpecs([freshSpec]);
      const fresh = built[oldId];
      fresh.replacementFresh = true;
      fresh.roundsPlayed     = 0;
      this.agents[oldId]     = fresh;
      const oldName = oldSpec ? oldSpec.name : null;
      replacements.push({ id: oldId, oldName, newName: freshName, type: freshSpec.type });
    }
    this.logger.logEvent({
      tick:           this.market.tick,
      type:           'round_4_replacement',
      treatmentSize,
      replaced:       replacements,
    });
  }

  /**
   * Round-end transition. Every agent's cash and inventory are rewound
   * to the spec that the sampling stage recorded for them, so round r+1
   * starts with the same endowment schedule as round 1 — DLM's "before
   * a market opened, half of the traders started with 200¢ and six
   * assets, while each of the other traders started with 600¢ and two
   * assets". Learned state (utility trust matrix, belief posteriors)
   * is intentionally not touched; that is the cross-round experience
   * channel the paper's bubble-suppression result relies on. Each agent
   * also gets an optional `onRoundStart` hook so subclasses can null
   * out transient per-round state (trend history, subjective prior).
   */
  _resetRound() {
    // Regulator warnings are sticky for the rest of the round they
    // fire in; the round boundary is where they expire so the next
    // round starts with a clean slate.
    if (this.ctx) this.ctx.regulatorWarning = null;
    const specs = this.ctx && this.ctx.agentSpecs;
    for (const id of Object.keys(this.agents)) {
      const a = this.agents[id];
      if (Array.isArray(specs)) {
        const spec = specs.find(s => s.id === a.id);
        if (spec) {
          a.cash      = spec.cash;
          a.inventory = spec.inventory;
        }
      }
      // roundsPlayed is incremented by the round-end branch in step()
      // before this method is called, so a fresh agent spliced in by
      // _round4Replacement keeps its roundsPlayed = 0 here.
      if (typeof a.onRoundStart === 'function') a.onRoundStart();
    }
  }

  /**
   * End-of-period communication + trust update. Every utility agent
   * broadcasts one message (respecting its deceptionMode). If the
   * global deception toggle is off, every message is forced honest.
   * Then the trust tracker re-scores each sender against that period's
   * volume-weighted mean trade price.
   */
  _communicationRound() {
    const bus      = this.ctx.messageBus;
    const trust    = this.ctx.trustTracker;
    const ext      = this.ctx.extended;
    const tunables = this.ctx.tunables;
    if (!bus || !ext || !ext.communication) return;
    const period = this.market.period;
    for (const id of Object.keys(this.agents)) {
      const a = this.agents[id];
      if (typeof a.communicate !== 'function') continue;
      const msg = a.communicate(this.market, this._rng, this.ctx);
      if (!msg) continue;
      if (!ext.deception) {
        // Global deception toggle off — collapse every claim to truth.
        msg.claimedValuation = msg.trueValuation;
        msg.deceptionMode    = 'honest';
        msg.deceptive        = false;
      }
      bus.post(msg);
      this.logger.logMessage(msg);
    }
    if (trust) {
      const alpha = (tunables && tunables.trustAlpha != null) ? tunables.trustAlpha : 0.3;
      trust.update(bus, this.market, period, alpha);
      trust.snapshot(this.market.tick);
      this.logger.logTrust({ tick: this.market.tick, period, trust: trust.copy() });
    }
    // Optional regulator pass — must run BEFORE _schedulePlanLLM so
    // any warning that fires in this period is visible in the prompt
    // built for the upcoming period. The detector itself does not
    // care about plan; gating on Plan II/III happens in ai.js, where
    // the warning is the only consumption channel.
    this._checkRegulator();
    // Plan II / Plan III — period-boundary LLM action request. This
    // call is fire-and-forget: the tick loop continues immediately
    // while the network request runs in the background. When the
    // promise resolves, `ctx.llmActions` is populated with action
    // choices that decide() will consume on the next tick. If the
    // LLM is slower than the next period boundary, the affected
    // agents simply fall back to EU evaluation for that period.
    // Plan I ignores this block entirely.
    this._schedulePlanLLM();
  }

  /**
   * Optional Plan II/III regulator. When ctx.tunables.applyRegulator
   * is true, monitors the bubble ratio |P_t − FV_t| / FV_t at every
   * period boundary. The first time the ratio crosses
   * `regulatorThreshold` within a round, sets ctx.regulatorWarning to
   * a sticky record { ratio, period, round, threshold, firedTick }
   * that the next prompt build picks up — ai.js prepends a clearly
   * marked REGULATOR WARNING block to every Utility agent's prompt
   * for the rest of the round. _resetRound clears the warning so each
   * round starts with a clean slate.
   *
   * No-op when the toggle is off, when there's no last price yet, or
   * when the warning has already been issued for the current round.
   */
  _checkRegulator() {
    const t = this.ctx && this.ctx.tunables;
    if (!t || !t.applyRegulator) return;
    const m = this.market;
    if (m.lastPrice == null) return;
    const fv = m.fundamentalValue();
    if (!Number.isFinite(fv) || fv <= 0) return;
    const ratio = Math.abs(m.lastPrice - fv) / fv;
    const threshold = Number.isFinite(t.regulatorThreshold) && t.regulatorThreshold > 0
      ? t.regulatorThreshold
      : 0.5;
    if (ratio < threshold) return;
    const existing = this.ctx.regulatorWarning;
    if (existing && existing.round === m.round) return;
    const warning = {
      ratio,
      threshold,
      period:    m.period,
      round:     m.round,
      firedTick: m.tick,
      lastPrice: m.lastPrice,
      fv,
    };
    this.ctx.regulatorWarning = warning;
    this.logger.logEvent({
      tick:      m.tick,
      type:      'regulator_warning',
      period:    m.period,
      round:     m.round,
      ratio,
      threshold,
      lastPrice: m.lastPrice,
      fv,
    });
  }

  /**
   * Fire-and-forget period-boundary LLM call for Plans II and III.
   *
   * Reads ctx.plan and ctx.aiConfig; no-op unless plan is II or III
   * AND an API key is present AND the global AI object is available
   * (it's not in Node smoke tests). Results are merged into
   * ctx.llmActions as soon as the promise resolves, overwriting any
   * previous per-agent entry so the next period sees the freshest
   * action. Errors surface only to the console — the engine does not
   * await or retry.
   */
  _schedulePlanLLM() {
    const plan   = this.ctx && this.ctx.plan;
    const aiCfg  = this.ctx && this.ctx.aiConfig;
    if (plan !== 'II' && plan !== 'III') return;
    if (!aiCfg || !aiCfg.apiKey) return;
    if (typeof AI === 'undefined' || !AI.getPlanBeliefs) return;
    const market = this.market;
    const cfg    = this.config;
    const agents = this.agents;
    const ctx    = this.ctx;
    // Snapshot peer messages into each agent's `receivedMsgs` field
    // now so the prompt builder reads a stable last-period view even
    // if the next tick mutates the bus before the network call runs.
    const bus = ctx.messageBus;
    if (bus && bus.byPeriod) {
      const prev = market.period;
      for (const id of Object.keys(agents)) {
        const a = agents[id];
        if (!a || a.type !== 'utility') continue;
        const msgs = bus.byPeriod(prev, market.round) || [];
        a.receivedMsgs = msgs.filter(m => m.senderId !== a.id);
      }
    }
    // Capture tick coordinates before the async call — the market may
    // advance by the time the LLM responds.
    const callTick   = market.tick;
    const callPeriod = market.period;
    const callRound  = market.round;
    const logger     = this.logger;
    Promise.resolve().then(async () => {
      try {
        const results = await AI.getPlanBeliefs(agents, market, cfg, aiCfg, plan, ctx.tunables, logger, ctx.regulatorWarning);
        if (!results) return;
        for (const k of Object.keys(results)) {
          ctx.llmActions[k] = results[k];
        }
        // Log every LLM call for the export audit trail.
        for (const id of Object.keys(agents)) {
          const a = agents[id];
          if (!a || a.type !== 'utility' || !a.lastLLMPrompt) continue;
          logger.logLLMCall({
            tick:         callTick,
            period:       callPeriod,
            round:        callRound,
            agentId:      a.id,
            agentName:    a.displayName,
            prompt:       { system: a.lastLLMPrompt.system, user: a.lastLLMPrompt.user },
            response:     a.lastLLMResponse || '',
            parsedAction: results[a.id] ? results[a.id].action : null,
            parsedReason: results[a.id] ? results[a.id].reason : null,
          });
        }
      } catch (err) {
        console.warn('[engine._schedulePlanLLM]', err && err.message || err);
      }
    });
  }

  isFinished() {
    const rounds = this.config.roundsPerSession || 1;
    return this.market.tick >= rounds * this.config.periods * this.config.ticksPerPeriod;
  }

  /**
   * Capture a snapshot sufficient to re-render the UI for this tick.
   * The live arrays on market/logger aren't copied — we record their
   * lengths so replay can slice into them, which keeps memory O(ticks).
   */
  _captureSnapshot() {
    const m = this.market;
    const agentState = {};
    for (const [id, a] of Object.entries(this.agents)) {
      agentState[id] = {
        id:               a.id,
        type:             a.type,
        typeLabel:        a.typeLabel,
        name:             a.displayName,
        cash:             Math.round(a.cash * 100) / 100,
        inventory:        a.inventory,
        initialCash:      a.initialCash,
        initialInventory: a.initialInventory,
        lastAction:       a.lastAction,
        lastPassive:      !!a.lastPassive,
        // Endogenous-experience + DLM replacement tracking. Read by
        // the UI agent card to print a "rounds played" badge and the
        // fresh-replacement flag for the round-4 newcomers.
        roundsPlayed:     a.roundsPlayed | 0,
        replacementFresh: !!a.replacementFresh,
        endowmentType:    a.endowmentType,
        // Extended fields (undefined for legacy agents — harmless).
        riskPref:            a.riskPref,
        rho:                 a.rho,
        trueValuation:       a.trueValuation,
        subjectiveValuation: a.subjectiveValuation,
        reportedValuation:   a.reportedValuation,
        deceptionMode:       a.deceptionMode,
        beliefMode:          a.beliefMode,
        initialWealth:       a.initialWealth,
      };
    }
    return {
      tick:               m.tick,
      period:             m.period,
      round:              m.round,
      session:            (this.ctx && this.ctx.currentSession) || 0,
      lastPrice:          m.lastPrice,
      fv:                 m.fundamentalValue(),
      bids: m.book.bids.map(o => ({ price: o.price, remaining: o.remaining, agentId: o.agentId })),
      asks: m.book.asks.map(o => ({ price: o.price, remaining: o.remaining, agentId: o.agentId })),
      agents:             agentState,
      tradeCount:         m.trades.length,
      priceHistoryLength: m.priceHistory.length,
      traceLength:        this.logger.traces.length,
      eventLength:        this.logger.events.length,
      volumeByPeriod:     m.volumeByPeriod.slice(),
      // Extended snapshot fields:
      messageLength:      this.logger.messages.length,
      valuationLength:    this.logger.valuationHistory.length,
      utilityLength:      this.logger.utilityHistory.length,
      evaluationLength:   this.logger.decisionEvaluations.length,
      trustLength:        this.logger.trustHistory.length,
      trust:              this.ctx.trustTracker ? this.ctx.trustTracker.copy() : null,
      tunables: {
        applyBias:              !!(this.ctx.tunables && this.ctx.tunables.applyBias),
        applyNoise:             !!(this.ctx.tunables && this.ctx.tunables.applyNoise),
        applyComplexDividends:  !!(this.ctx.tunables && this.ctx.tunables.applyComplexDividends),
        applyRegulator:         !!(this.ctx.tunables && this.ctx.tunables.applyRegulator),
        regulatorThreshold:     (this.ctx.tunables && this.ctx.tunables.regulatorThreshold) || 0.5,
      },
      regulatorWarning:   this.ctx && this.ctx.regulatorWarning
        ? Object.assign({}, this.ctx.regulatorWarning)
        : null,
    };
  }
}
