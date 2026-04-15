'use strict';

/* =====================================================================
   llm.js — LLM agent scaffold (deterministic stub).

   A small subset of UtilityAgents can be flagged `isLLM = true`. Their
   decide() pipeline bypasses the EU argmax and delegates to the stub
   here. The stub is intentionally deterministic so the engine stays
   synchronous and runs reproduce from (population, seed); it exposes
   the same interface a real LLM wrapper would implement, with a TODO
   marker at the single point where an async API call would replace
   the local heuristic.

   The prompt builder emits a faithful structured prompt including
   MARKET ALERTS populated from the regulator's last warning. This is
   the hook: when a real LLM backend is wired in, swap LLM.complete()
   for an async Anthropic/OpenAI call and adapt the engine loop.
   ===================================================================== */

const LLM = {

  /**
   * Build the structured prompt a real LLM would receive. The prompt
   * surfaces private state, public state, peer messages, and regulator
   * alerts under clearly-labelled sections.
   */
  buildPrompt(agent, market, V, tick, ctx) {
    const sys = [
      'You are a trader in an experimental continuous double auction.',
      'Each round lasts T periods. At the end of every period the asset pays a stochastic dividend drawn from a two-regime hidden Markov model.',
      'Your task is to select an ACTION from {BUY_NOW, SELL_NOW, BID, ASK, HOLD}.',
      'Prefer actions that increase expected utility under your declared risk preference.',
    ].join(' ');
    const risk = agent.riskPref;
    const riskLine = risk === 'loving'  ? 'You are RISK-LOVING: U(w) = (w/w₀)² — upside dominates.'
                    : risk === 'averse' ? 'You are RISK-AVERSE: U(w) = √(w/w₀) — downside dominates.'
                    :                     'You are RISK-NEUTRAL: U(w) = w/w₀ — linear in wealth.';
    const bid = market.book.bestBid();
    const ask = market.book.bestAsk();
    const regLine = ctx.regActive && ctx.alert
      ? `\n\nMARKET ALERTS:\n- REGULATOR WARNING (${ctx.alert.payload.level}): price ${ctx.alert.payload.price} is ${(ctx.alert.payload.ratio * 100).toFixed(0)}% of reference FV ${ctx.alert.payload.fvRef}. Text: "${ctx.alert.payload.text}"`
      : '';
    const cognition = agent.cognitiveType === 'analytical'
      ? 'You can compute the true conditional expected FV.'
      : agent.cognitiveType === 'kalman'
        ? 'You can run a limited-window Bayesian filter but do not know the exact transition matrix.'
        : 'You can only average recent dividends; you do not explicitly model regimes.';
    const body = [
      `STATE:`,
      `- Tick ${tick}, Round ${market.round}, Period ${market.period}/${market.config.periods}.`,
      `- Best bid: ${bid ? bid.price.toFixed(2) : '—'}, Best ask: ${ask ? ask.price.toFixed(2) : '—'}, Last: ${market.lastPrice ?? '—'}.`,
      `YOUR PRIVATE STATE:`,
      `- ${riskLine}`,
      `- Cognitive capacity: ${cognition}`,
      `- Subjective valuation V̂ = ${V.toFixed(2)}; cash = ${agent.cash.toFixed(0)}; inventory = ${agent.inventory}.`,
      `- Regulator reaction profile: ${agent.regulatorReaction}.`,
      regLine,
      `\nRespond with a single JSON object: {"action": "BUY_NOW|SELL_NOW|BID|ASK|HOLD", "price": <number or null>, "reasoning": "<short>"}.`,
    ].join('\n');
    return { system: sys, user: body };
  },

  /**
   * Stub: deterministic heuristic that mimics the categorical action
   * set a real LLM would return. Uses the same signals (V, book edges,
   * regulator reaction) so downstream analysis code doesn't need a
   * second branch. Marked async-ready for future API wiring.
   */
  complete(prompt, agent, market, V, ctx) {
    // TODO: replace with `await client.messages.create({...})` once
    //       the engine loop is made async.
    const bid = market.book.bestBid();
    const ask = market.book.bestAsk();
    const spread = bid && ask ? ask.price - bid.price : null;
    const regPanic = ctx.regActive && agent.regulatorReaction === 'panic';

    if (regPanic && agent.inventory > 0) {
      const p = bid ? bid.price : Math.round(V * 0.95);
      return { action: 'SELL_NOW', price: p, reasoning: 'regulator warning + panic profile → dump inventory at best bid' };
    }
    if (ask && ask.price < V * 0.97 && agent.cash >= ask.price) {
      return { action: 'BUY_NOW', price: ask.price, reasoning: `ask ${ask.price} < 0.97·V=${(V * 0.97).toFixed(1)}, lift` };
    }
    if (bid && bid.price > V * 1.03 && agent.inventory > 0) {
      return { action: 'SELL_NOW', price: bid.price, reasoning: `bid ${bid.price} > 1.03·V=${(V * 1.03).toFixed(1)}, hit` };
    }
    if (spread != null && spread > V * 0.04 && agent.cash >= Math.round(V * 0.98)) {
      return { action: 'BID', price: Math.round(V * 0.98), reasoning: 'wide spread → passive bid near V' };
    }
    if (agent.inventory > 0) {
      return { action: 'ASK', price: Math.round(V * 1.02), reasoning: 'passive ask a hair above V' };
    }
    return { action: 'HOLD', price: null, reasoning: 'no edge' };
  },

  /** Bridge: returns the action object the engine expects. */
  decide(agent, market, V, tick, ctx) {
    const prompt = LLM.buildPrompt(agent, market, V, tick, ctx);
    const out    = LLM.complete(prompt, agent, market, V, ctx);
    const bid    = market.book.bestBid();
    const ask    = market.book.bestAsk();
    let action;
    switch (out.action) {
      case 'BUY_NOW':
        action = ask ? { type: 'bid', price: ask.price, quantity: 1, cross: true }
                      : { type: 'hold' };
        break;
      case 'SELL_NOW':
        action = bid && agent.inventory > 0
          ? { type: 'ask', price: bid.price, quantity: 1, cross: true }
          : { type: 'hold' };
        break;
      case 'BID':
        action = (out.price && agent.cash >= out.price)
          ? { type: 'bid', price: out.price, quantity: 1 }
          : { type: 'hold' };
        break;
      case 'ASK':
        action = (out.price && agent.inventory > 0)
          ? { type: 'ask', price: out.price, quantity: 1 }
          : { type: 'hold' };
        break;
      default:
        action = { type: 'hold' };
    }
    return {
      action,
      reasoning: {
        llmAction: out.action,
        llmPrice:  out.price,
        llmReason: out.reasoning,
        promptHash: shortHash(prompt.system + prompt.user),
      },
    };
  },

};

function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

if (typeof module !== 'undefined') module.exports = { LLM };
