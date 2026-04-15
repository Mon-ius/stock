'use strict';

/* =====================================================================
   replay.js — View builders.

   Converts live Market + Logger + agent state into a flat view object
   that ui.js consumes. Live and replay paths produce identical view
   shapes so the renderer has one code path.

   View shape:
   {
     tick, period, round,
     bestBid, bestAsk, lastPrice, fvRef,
     hmmRegime,                              // current (live) regime
     regulator: { active, ratio, threshold, history[], lastWarning },
     agents: [{ id, name, role, riskPref, cognitiveType, regulatorReaction,
                traced, isLLM, cash, inventory, V, lastAction, wealth }],
     tracedIds: [...],
     traceByAgent: { id: [...] },            // only traced agents
     aggregates: [...],                      // ring buffer contents
     volumeByPeriod: [...],
     trustSnapshot: Float32Array,            // NxN
     messages: [...],                        // most-recent first
     events: [...],
     N, periods, roundsPerSession,
     tunables,
     isTraced(id)
   }
   ===================================================================== */

const Replay = {

  buildLiveView(ctx) {
    const { market, agents, logger, bus, trust, regulator, config, tunables } = ctx;
    const agentList = Object.values(agents);
    const agentsOut = agentList.map(a => {
      const v = a.subjectiveV != null ? a.subjectiveV : (market.priceHistory.length ? (market.priceHistory[market.priceHistory.length - 1].fvRef || 0) : 0);
      return {
        id: a.id, name: a.name, role: a.role,
        riskPref: a.riskPref, cognitiveType: a.cognitiveType,
        regulatorReaction: a.regulatorReaction,
        biasMode: a.biasMode, isLLM: !!a.isLLM, traced: !!a.traced,
        cash: a.cash, inventory: a.inventory, V: v,
        lastAction: a.lastAction,
        wealth: a.cash + a.inventory * v,
        receivedAlert: a.receivedAlert ? { tick: a.receivedAlert.tick, ratio: a.receivedAlert.payload.ratio, level: a.receivedAlert.payload.level } : null,
      };
    });
    const tracedIds = agentList.filter(a => a.traced).map(a => a.id);
    const traceByAgent = {};
    for (const id of tracedIds) traceByAgent[id] = logger.getTrace(id);
    const regHistory = regulator.history.slice(-1000);
    const lastWarning = [...logger.events].reverse().find(e => e.type === 'regulator_warning') || null;
    return {
      tick: market.tick, period: market.period, round: market.round,
      bestBid: market.book.bestBid(), bestAsk: market.book.bestAsk(),
      lastPrice: market.lastPrice,
      fvRef: market.priceHistory.length ? market.priceHistory[market.priceHistory.length - 1].fvRef : null,
      hmmRegime: market.hmm.regime,
      regulator: {
        active:    regulator.isActive(market.tick),
        ratio:     regulator.currentRatio(),
        threshold: regulator.threshold,
        mode:      regulator.mode,
        history:   regHistory,
        lastWarning,
      },
      agents: agentsOut,
      tracedIds,
      traceByAgent,
      aggregates:     logger.aggregates(),
      priceHistory:   market.priceHistory.slice(-2000),
      dividendHistory: market.dividendHistory.slice(-200),
      volumeByPeriod: market.volumeByPeriod.slice(),
      trustSnapshot:  trust.snapshot(),
      messages:       bus.tail(120),
      events:         logger.events.slice(-200),
      N:              agentList.length,
      periods:        config.periods,
      roundsPerSession: config.roundsPerSession,
      tunables,
      isTraced(id)  { return tracedIds.includes(id); },
    };
  },

  /** Rebuild view at a past tick from aggregate store + event log. */
  buildViewAt(ctx, tick) {
    const live = Replay.buildLiveView(ctx);
    const agg  = ctx.logger.aggregateAt(tick);
    if (!agg) return live;
    return {
      ...live,
      tick, period: agg.period, round: agg.round,
      lastPrice: agg.price, fvRef: agg.fvRef,
      regulator: { ...live.regulator, active: agg.regActive, ratio: agg.regRatio },
    };
  },

};
