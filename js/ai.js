'use strict';

/* ======================================================================
   ai.js — AIPE (AI-Agent Prior Elicitation) endpoint.

   Thin, dependency-free wrapper around the OpenAI /v1/chat/completions
   API, used only by the AIPE paradigm (data-paradigm="wang" retained as
   the internal code key for stability). Reuses the `{endpoint, apiKey,
   model}` shape from the lying project's agent roster and its plain-text
   response contract (no structured JSON, no function calls).

   Flow:

     1. main.js reads the three fields (#ai-key, #ai-endpoint, #ai-model)
        into App.aiConfig on every run start — nothing is persisted to
        localStorage, matching the lying project's deliberately forgetful
        design.

     2. When the paradigm is 'wang' AND the key is non-empty AND the
        current population has at least one Utility agent, App.start()
        fires AI.getPsychAnchors(agents, config, aiCfg) and awaits the
        result before launching the engine loop.

     3. Each Utility agent in the resulting map receives its psychological
        anchor — a single number in [0.25·FV₀, 1.75·FV₀] — which the
        agent writes into `psychAnchor`. On the first decision tick the
        agent seeds `subjectiveValue` from that anchor instead of the
        default `FV · (1 + bias + noise)` prior, so the model's psychology
        shows up in the very first order posted.

     4. Errors, missing keys, or invalid responses fall back to the
        deterministic Lopez-Lira belief model without disturbing the run.
        AIPE must still produce a simulation when the network is
        unavailable, because the paper's research question ("does the
        asset end up with the highest-V̂ agent") is answerable from the
        deterministic path alone — the AI agent only adds a stronger,
        more heterogeneous psychological signal.
   ====================================================================== */

const AI = {
  /**
   * Provider definitions — endpoint, agent-capable models, and default
   * for each supported LLM provider. The UI builds the provider
   * dropdown from PROVIDERS and swaps the model list on change.
   */
  PROVIDERS: {
    openai: {
      label: 'OpenAI ChatGPT',
      endpoint: 'https://openai-20250719-f7491cbb.rootdirectorylab.com/v1/chat/completions',
      keyPlaceholder: 'sk-...',
      models: [
        { id: 'gpt-4o',   label: 'GPT-4o' },
        { id: 'gpt-5.4',  label: 'GPT-5.4' },
      ],
      default: 'gpt-4o',
    },
    gemini: {
      label: 'Google Gemini',
      endpoint: 'https://gemini-20250719-bdb3d11b.rootdirectorylab.com/v1beta',
      keyPlaceholder: 'AIza...',
      models: [
        { id: 'gemini-3-flash-preview',    label: 'Gemini 3 Flash Preview' },
        { id: 'gemini-3.1-pro-preview',    label: 'Gemini 3.1 Pro Preview' },
      ],
      default: 'gemini-3-flash-preview',
    },
    claude: {
      label: 'Anthropic Claude',
      endpoint: 'https://anthropic-20250719-b6006324.rootdirectorylab.com/v1/messages',
      keyPlaceholder: 'sk-ant-...',
      models: [
        { id: 'claude-opus-4-6',   label: 'Claude Opus 4.6' },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      ],
      default: 'claude-sonnet-4-6',
    },
  },

  DEFAULT_PROVIDER: 'openai',

  /** Convenience accessors — resolve via the active provider. */
  getProvider(key) {
    return this.PROVIDERS[key] || this.PROVIDERS[this.DEFAULT_PROVIDER];
  },
  getModels(providerKey) { return this.getProvider(providerKey).models; },
  getDefaultModel(providerKey) { return this.getProvider(providerKey).default; },
  getDefaultEndpoint(providerKey) { return this.getProvider(providerKey).endpoint; },
  getKeyPlaceholder(providerKey) { return this.getProvider(providerKey).keyPlaceholder; },

  /**
   * gpt-5 / o3+ / o1+ families require `max_completion_tokens` in
   * place of the legacy `max_tokens` field.
   */
  _usesCompletionTokens(model) {
    return /^(gpt-5|o[3-9]|o[1-9]\d)/.test(model || '');
  },

  /* ---- Provider-specific call implementations ---- */

  async _callOpenAI(cfg, system, prompt) {
    const endpoint  = cfg.endpoint || this.getDefaultEndpoint('openai');
    const model     = cfg.model    || this.getDefaultModel('openai');
    const maxTokens = cfg.maxTokens || 1024;
    const body = {
      model,
      temperature: cfg.temperature ?? 0.4,
      ...(this._usesCompletionTokens(model)
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens }),
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: prompt },
      ],
    };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ai.openai: HTTP ${res.status} ${text}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('ai.openai: no content');
    return content.trim();
  },

  async _callGemini(cfg, system, prompt) {
    const model     = cfg.model || this.getDefaultModel('gemini');
    const base      = cfg.endpoint || this.getDefaultEndpoint('gemini');
    const endpoint  = `${base.replace(/\/+$/, '')}/models/${model}:generateContent?key=${cfg.apiKey}`;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: cfg.temperature ?? 0.4,
        maxOutputTokens: cfg.maxTokens || 1024,
      },
    };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ai.gemini: HTTP ${res.status} ${text}`);
    }
    const data = await res.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof content !== 'string') throw new Error('ai.gemini: no content');
    return content.trim();
  },

  async _callClaude(cfg, system, prompt) {
    const endpoint  = cfg.endpoint || this.getDefaultEndpoint('claude');
    const model     = cfg.model    || this.getDefaultModel('claude');
    const body = {
      model,
      max_tokens: cfg.maxTokens || 1024,
      system,
      messages: [{ role: 'user', content: prompt }],
    };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ai.claude: HTTP ${res.status} ${text}`);
    }
    const data = await res.json();
    const block = (data?.content || []).find(b => b.type === 'text');
    if (!block || typeof block.text !== 'string') throw new Error('ai.claude: no content');
    return block.text.trim();
  },

  /**
   * Unified call dispatcher — routes to the provider-specific handler
   * based on `cfg.provider`. Falls back to OpenAI format for backwards
   * compatibility when provider is unset.
   */
  async call(cfg, system, prompt) {
    if (!cfg || !cfg.apiKey) throw new Error('ai.call: missing apiKey');
    const provider = cfg.provider || this.DEFAULT_PROVIDER;
    if (provider === 'gemini') return this._callGemini(cfg, system, prompt);
    if (provider === 'claude') return this._callClaude(cfg, system, prompt);
    return this._callOpenAI(cfg, system, prompt);
  },

  /**
   * Parse a psychological valuation out of a free-form AI-agent response.
   * The prompt asks for a single number; in practice models sometimes
   * prefix it with "My valuation is". The regex grabs the first
   * signed decimal and clamps it into [lo, hi] so an out-of-range
   * reply can never destabilize the engine.
   */
  parseValuation(raw, lo, hi) {
    if (typeof raw !== 'string') return null;
    const m = raw.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const v = parseFloat(m[0]);
    if (!Number.isFinite(v)) return null;
    return Math.max(lo, Math.min(hi, v));
  },

  /**
   * Parse an action from the structured LLM response.
   * Expected format: "Reason: ... Action: BUY_NOW"
   */
  _VALID_ACTIONS: ['BUY_NOW', 'SELL_NOW', 'BID_1', 'BID_3', 'ASK_1', 'ASK_3', 'HOLD'],

  parseAction(raw) {
    if (typeof raw !== 'string') return null;
    const m = raw.match(/Action\s*:\s*(BUY_NOW|SELL_NOW|BID_1|BID_3|ASK_1|ASK_3|HOLD)/i);
    if (!m) return null;
    const action = m[1].toUpperCase();
    if (!this._VALID_ACTIONS.includes(action)) return null;
    const rm = raw.match(/Reason\s*:\s*(.+?)(?=\nAction|\n*$)/is);
    return { action, reason: rm ? rm[1].trim() : '' };
  },

  /**
   * Period-boundary LLM belief update for Plans II and III.
   *
   * Fires one chat completion per utility agent in parallel and
   * returns a { [agentId]: subjectiveValuation } map, which the
   * engine writes into `ctx.llmBeliefs` for the next period's
   * `updateBelief` pass to consume.
   *
   * The prompt is structured into two clearly labelled blocks:
   *
   *   PUBLIC MARKET STATE  — observable by all participants: market
   *     rules, current round/period, FV, order book, recent trades,
   *     cumulative volume, and peer messages from last period.
   *
   *   YOUR PRIVATE STATE   — known only to this agent: cash,
   *     inventory, rounds of experience, risk preference, belief
   *     mode, bias/noise configuration, and the resulting prior
   *     valuation. Plan II additionally reveals the explicit utility
   *     formula; Plan III reveals only the risk-preference label.
   *
   * Every call is independent; failures are logged and the agent
   * is simply skipped in the returned map — the engine treats a
   * missing key as "fall back to Plan I's algorithm next period"
   * so the run never stalls waiting for the network.
   *
   * @param {{[id:string]: object}} agents
   * @param {Market} market
   * @param {{periods:number, dividendMean:number}} config
   * @param {{apiKey:string, endpoint?:string, model?:string}} aiCfg
   * @param {'II'|'III'} plan
   * @param {object} [tunables]
   * @param {object} [logger] — optional; when provided the prompt includes
   *   per-round P&L from `logger.roundFinalCash`, so the LLM can reason
   *   about its own past performance instead of a rule-based experience
   *   label.
   * @param {?{ratio:number,threshold:number,period:number,round:number}} [regulator]
   *   Optional one-shot regulator warning (Advanced → "Regulator"). When
   *   provided AND ctx.tunables.applyRegulator is true, the prompt
   *   gains a top-of-message REGULATOR WARNING block describing the
   *   bubble ratio that tripped the regulator.
   * @returns {Promise<{[id:number]: number}>}
   */
  async getPlanBeliefs(agents, market, config, aiCfg, plan, tunables, logger, regulator) {
    if (!aiCfg || !aiCfg.apiKey) return {};
    if (plan !== 'II' && plan !== 'III') return {};
    const utilityAgents = Object.values(agents).filter(
      a => a && (a.type === 'utility' || a.constructor?.name === 'UtilityAgent'),
    );
    if (!utilityAgents.length) return {};

    const periods      = config.periods;
    const periodNow    = market.period;
    const kRemaining   = periods - periodNow + 1;
    const dividendAvg  = config.dividendMean;
    const fvNow        = market.fundamentalValue();
    const lastPrice    = market.lastPrice != null ? market.lastPrice : fvNow;
    const bestBid      = market.book.bestBid();
    const bestAsk      = market.book.bestAsk();
    const bidPrice     = bestBid ? bestBid.price : null;
    const askPrice     = bestAsk ? bestAsk.price : null;

    // Previous reference price — last trade from prior period.
    const round        = market.round;
    const prevTrades   = market.trades.filter(
      t => t.round === round && t.period < periodNow,
    );
    const prevPrice    = prevTrades.length
      ? prevTrades[prevTrades.length - 1].price
      : lastPrice;

    // Per-period last-trade price for the current round so far — gives
    // the LLM the within-round trajectory (bubble forming? converging?)
    // instead of a single "previous reference price" number.
    const currentRoundPath = [];
    for (let p = 1; p < periodNow; p++) {
      const tr = market.trades.filter(t => t.round === round && t.period === p);
      const last = tr.length ? tr[tr.length - 1].price : null;
      currentRoundPath.push({ period: p, price: last, fv: dividendAvg * (periods - p + 1) });
    }

    // Build a per-agent history block from prior rounds the agent has
    // actually lived through. Fresh replacements (roundsPlayed = 0) get
    // no history — they are the "inexperienced" type and their prompt
    // says so explicitly, so the LLM can reason about its own naivety.
    const buildHistoryBlock = (a) => {
      const exp = a.roundsPlayed | 0;
      if (exp <= 0) return null;
      const lines = [];
      const firstRound = Math.max(1, round - exp);
      for (let r = firstRound; r <= round - 1; r++) {
        const pricePath = [];
        const fvPath    = [];
        let peakPrice = -Infinity, peakPeriod = 0;
        let lastSeenPrice = null;
        for (let p = 1; p <= periods; p++) {
          const tr = market.trades.filter(t => t.round === r && t.period === p);
          const last = tr.length ? tr[tr.length - 1].price : null;
          const fvP  = dividendAvg * (periods - p + 1);
          pricePath.push(last != null ? last.toFixed(0) : '—');
          fvPath.push(String(fvP));
          if (last != null) {
            lastSeenPrice = last;
            if (last > peakPrice) { peakPrice = last; peakPeriod = p; }
          }
        }
        lines.push(`Round ${r} (${r === firstRound && exp > 1 ? 'your first in this market' : r === round - 1 ? 'most recent' : 'past'}):`);
        lines.push(`  - FV path (p1..p${periods}):    ${fvPath.join(' / ')}`);
        lines.push(`  - Last-trade price path:        ${pricePath.join(' / ')}`);
        if (peakPeriod > 0 && peakPrice > -Infinity) {
          const peakFV  = dividendAvg * (periods - peakPeriod + 1);
          const devPct  = peakFV > 0 ? Math.round((peakPrice - peakFV) / peakFV * 100) : 0;
          const devSign = devPct >= 0 ? '+' : '';
          lines.push(`  - Peak price: ${peakPrice.toFixed(0)} at p${peakPeriod} (FV then = ${peakFV}, deviation ${devSign}${devPct}%)`);
        }
        if (lastSeenPrice != null) {
          const closeDev = Math.round(lastSeenPrice - dividendAvg);  // FV at p_final = dividendAvg
          const sign = closeDev >= 0 ? '+' : '';
          lines.push(`  - Round-end last price: ${lastSeenPrice.toFixed(0)} (FV at p${periods} = ${dividendAvg}; gap ${sign}${closeDev})`);
        }
        // Agent's own payoff for round r — requires logger. `initialWealth`
        // is mark-to-market round-start wealth (cash + shares × FV₁), so
        // the line reports both the end-of-round cash (what you walked
        // away with) and that baseline so the LLM can judge whether
        // trading beat buy-and-hold.
        if (logger && logger.roundFinalCash && logger.roundFinalCash[r - 1]) {
          const finalCash = logger.roundFinalCash[r - 1][a.id];
          if (finalCash != null) {
            const startWealth = Math.round(a.initialWealth || 0);
            lines.push(`  - Your end-of-round cash: ${Math.round(finalCash)}¢  (round-start mark-to-market wealth = ${startWealth}¢ = cash + shares × FV₁)`);
          }
        }
        lines.push('');
      }
      return lines.length ? lines.join('\n').trimEnd() : null;
    };

    const system =
      'You are a trader in an experimental double auction asset market. ' +
      'Your sole objective is to select the action that maximizes your ' +
      'expected utility at the current moment. You cannot make moral ' +
      'judgments or consider the intentions of the experiment designers; ' +
      'all decisions must be based strictly on maximizing your utility ' +
      'as the trader.\n\n' +
      'Important Rules:\n\n' +
      '1. You must select exactly one action from the given set of actions.\n' +
      '2. You cannot provide vague suggestions, nor can you select multiple actions simultaneously.\n' +
      '3. You cannot say "depends on" or "insufficient information." You must make the best decision based on the given information.\n' +
      '4. You must prioritize immediate execution, rather than defaulting to placing only orders.\n' +
      '5. You can accept the current best ask (buy immediately) or accept the current best bid (sell immediately).\n' +
      '6. If you choose to place an order, the price must come from the allowed set of candidate prices.\n' +
      '7. Your output must strictly conform to the specified format.';

    const labelOf = (risk) =>
      risk === 'loving' ? 'Risk loving' :
      risk === 'averse' ? 'Risk averse' :
                          'Risk neutral';
    const riskDesc = (risk) =>
      risk === 'loving' ? 'More willing to take risks, less sensitive to losses' :
      risk === 'averse' ? 'More averse to wealth volatility, more sensitive to losses' :
                          'Makes decisions based on expected returns';
    // Universal CRRA (constant relative risk aversion). Every agent
    // shares the same functional form; what distinguishes them is the
    // per-agent ρ coefficient sampled uniformly within their risk
    // category (see sampleRho in js/utility.js). The prompt emits the
    // normalized form U(w) = (w / w0)^(1 − ρ) with the agent's actual
    // ρ value substituted in, so the LLM sees the exact curve the
    // EU evaluator uses.
    const formulaOf = (risk, rho) => {
      const r = (rho != null && Number.isFinite(rho)) ? rho.toFixed(3) : '0.000';
      const shape =
        risk === 'loving' ? 'strictly convex, upside-seeking' :
        risk === 'averse' ? 'strictly concave, downside-fearing' :
                            'linear, EV-indifferent';
      return `U(w; ρ) = (w / w0)^(1 − ρ), with ρ = ${r}  (${shape})`;
    };

    const promptFor = (a) => {
      const exp = a.roundsPlayed | 0;
      const cash = Math.round(a.cash);
      const inv  = a.inventory;

      // ---- Available actions + constraints ----
      const actions = [];
      const constraints = [];

      if (askPrice != null && cash >= askPrice) {
        actions.push(`1. BUY_NOW: Immediately buy 1 unit at the current lowest ask price (${askPrice.toFixed(0)}).`);
      } else {
        constraints.push(`- BUY_NOW cannot be selected${askPrice == null ? ' (no ask available)' : ` (cash ${cash} < best_ask ${askPrice.toFixed(0)})`}.`);
      }
      if (bidPrice != null && inv >= 1) {
        actions.push(`2. SELL_NOW: Immediately sell 1 unit at the current highest bid price (${bidPrice.toFixed(0)}).`);
      } else {
        constraints.push(`- SELL_NOW cannot be selected${bidPrice == null ? ' (no bid available)' : ' (holdings < 1)'}.`);
      }
      if (bidPrice != null && cash >= bidPrice + 1) {
        actions.push(`3. BID_1: Submit bid = best_bid + 1 = ${(bidPrice + 1).toFixed(0)}.`);
      } else {
        constraints.push(`- BID_1 cannot be selected${bidPrice == null ? ' (no bid available)' : ` (cash ${cash} < ${(bidPrice + 1).toFixed(0)})`}.`);
      }
      if (bidPrice != null && cash >= bidPrice + 3) {
        actions.push(`4. BID_3: Submit bid = best_bid + 3 = ${(bidPrice + 3).toFixed(0)}.`);
      } else {
        constraints.push(`- BID_3 cannot be selected${bidPrice == null ? ' (no bid available)' : ` (cash ${cash} < ${(bidPrice + 3).toFixed(0)})`}.`);
      }
      if (askPrice != null && inv >= 1) {
        actions.push(`5. ASK_1: Submit ask = best_ask - 1 = ${(askPrice - 1).toFixed(0)}.`);
        actions.push(`6. ASK_3: Submit ask = best_ask - 3 = ${(askPrice - 3).toFixed(0)}.`);
      } else {
        constraints.push(`- ASK_1 / ASK_3 cannot be selected${askPrice == null ? ' (no ask available)' : ' (holdings < 1)'}.`);
      }
      actions.push(`7. HOLD: Do not trade.`);

      // ---- Compose prompt ----
      const lines = [];

      // Regulator warning — Plan II/III only, fired by the engine
      // when the bubble ratio crosses the configured threshold. The
      // block sits at the very top of the prompt so the LLM cannot
      // miss it when ranking actions; it stays in the prompt for the
      // remainder of the round in which it fired.
      const regOn = !!(tunables && tunables.applyRegulator);
      if (regOn && regulator && regulator.ratio != null) {
        const pct = (regulator.ratio * 100).toFixed(0);
        const thrPct = (regulator.threshold * 100).toFixed(0);
        const above = (regulator.lastPrice != null && regulator.fv != null)
          ? (regulator.lastPrice >= regulator.fv ? 'above' : 'below')
          : 'detached from';
        lines.push(
          `⚠️ REGULATOR WARNING ⚠️`,
          `The market regulator has issued a public alert this round:`,
          `- The last traded price is ${pct}% ${above} the fundamental value (threshold = ${thrPct}%).`,
          `- Last price ${regulator.lastPrice != null ? regulator.lastPrice.toFixed(0) : '—'} vs FV ${regulator.fv != null ? regulator.fv.toFixed(0) : '—'} at the moment of the warning (round ${regulator.round}, period ${regulator.period}).`,
          `- The asset's intrinsic payoff has not changed; only the price has detached.`,
          `- All traders have received this notice. Account for it when choosing your action.`,
          ``,
        );
      }

      lines.push(
        `You are a trader in the market, agent_${a.id}.`,
        ``,
        `【Your Type】`,
        `- Risk Preference Type: ${labelOf(a.riskPref)}`,
        `  ${riskDesc(a.riskPref)}`,
      );

      // Plan II — explicit utility formula.
      if (plan === 'II') {
        lines.push(
          `- Your utility function: ${formulaOf(a.riskPref, a.rho)}`,
          `  w0 (initial wealth) = ${Math.round(a.initialWealth)} cents.`,
        );
      }

      // Experience is conveyed as actual lived history (or lack of it),
      // not as a rule-based label. An agent with roundsPlayed > 0 sees
      // per-round price paths and its own P&L; a fresh participant sees
      // a short note explaining it is new to this market.
      const historyBlock = buildHistoryBlock(a);
      if (historyBlock) {
        lines.push(
          ``,
          `【Your Past Experience in This Market】`,
          `You have already traded ${exp} round${exp === 1 ? '' : 's'} in this market. The records below are the price paths you observed and the payoff you earned. Use them to judge how seriously to weight fundamental value vs. recent prices and short-term trends — your own memory is the best guide.`,
          ``,
          historyBlock,
        );
      } else {
        lines.push(
          ``,
          `【Your Past Experience in This Market】`,
          `This is your first round in this market. You have never traded this asset before and have no memory of prior rounds — you only see the rules, the fundamental value, and whatever trading has happened so far in the current round.`,
        );
      }

      lines.push(
        ``,
        `【Market Rules】`,
        `1. This is a ${periods}-period asset market.`,
        `2. Each asset pays a dividend of 0 or ${dividendAvg * 2} in each remaining period, with a 50% probability of each.`,
        `3. Therefore, the expected dividend for each remaining period is ${dividendAvg}.`,
        `4. If the current remaining period is k, then the fundamental value = ${dividendAvg} × k.`,
        `5. All traders know how this fundamental value is calculated.`,
        `6. Double Auction Rules:`,
        `   - You can buy the lowest ask immediately.`,
        `   - You can sell the highest bid immediately.`,
        `   - You can submit a new bid.`,
        `   - You can submit a new ask.`,
        `   - You can also choose not to trade.`,
        `7. If you buy the current ask immediately, the transaction will be executed instantly at the lowest ask price.`,
        `8. If you sell the current bid immediately, the transaction will be executed instantly at the highest bid price.`,
        `9. The last price is only updated when a transaction occurs.`,
        ``,
        `【Your Status】`,
        `- Current Cash: ${cash}`,
        `- Current Asset Holdings: ${inv}`,
        ``,
        `【Current Market Status】`,
        `- Current Period: ${periodNow}`,
        `- Current Remaining Periods k: ${kRemaining}`,
        `- Current Fundamental Value (FV): ${fvNow}`,
        `- Last Price: ${lastPrice.toFixed(0)}`,
        `- Highest Bid: ${bidPrice != null ? bidPrice.toFixed(0) : '—'}`,
        `- Lowest Ask: ${askPrice != null ? askPrice.toFixed(0) : '—'}`,
        `- Previous Reference Price: ${prevPrice.toFixed(0)}`,
      );
      if (currentRoundPath.length) {
        const pathStr = currentRoundPath
          .map(x => `p${x.period}=${x.price != null ? x.price.toFixed(0) : '—'} (FV ${x.fv})`)
          .join(', ');
        lines.push(`- This round so far (last trade per period): ${pathStr}`);
      }
      lines.push(
        ``,
        `【Your Decision-Making Principles】`,
        `You want to maximize the following intuitive utilities:`,
        `1. The higher the wealth, the better;`,
        `2. ${a.riskPref === 'averse' ? 'You dislike risk and are sensitive to losses' : a.riskPref === 'loving' ? 'You are willing to take risks and less sensitive to losses' : 'You evaluate expected returns linearly'};`,
        `3. Buying at a price lower than the last traded price increases utility; buying at a price higher than the last traded price decreases utility;`,
        `4. Selling at a price higher than the last traded price increases utility; selling at a price lower than the last traded price decreases utility;`,
        `5. Holding too many positions increases inventory risk;`,
        ``,
        `【Additional Requirements】`,
        `1. You cannot mechanically favor holding.`,
        `2. If the utility of immediate execution is similar to holding, you should prioritize actions that facilitate the trade.`,
        `3. You must consider "execution opportunities" valuable because not executing means you cannot improve your position.`,
        `4. When you hold a lot of assets, you should seriously consider selling; when you hold a lot of cash and fewer assets, you should seriously consider buying.`,
        `5. Towards the later stages, you should focus more on fundamental value than short-term resale opportunities.`,
        ``,
        `【Role-Specific Guidance】`,
      );
      if (a.riskPref === 'averse') {
        lines.push(`- As a risk-averse trader, you should focus more on avoiding losses and excessive position size.`);
      } else if (a.riskPref === 'loving') {
        lines.push(`- As a risk-loving trader, you can accept more aggressive trading and greater short-term volatility.`);
      } else {
        lines.push(`- As a risk-neutral trader, you should focus more on expected returns.`);
      }
      // Note: we deliberately do NOT instruct the agent how experience
      // should change its behaviour. Experience (or its absence) is
      // conveyed by the 【Your Past Experience in This Market】 block
      // above — a record of price paths and payoffs the agent actually
      // observed. The LLM is expected to reason from that lived history
      // the way a human subject would, not from a rule-based label.

      // Peer messages.
      const msgs = (a.receivedMsgs || []).filter(m => m.senderId !== a.id);
      if (msgs.length) {
        lines.push(``, `【Peer Messages from Last Period】`);
        for (const m of msgs) {
          lines.push(`- ${m.senderName || ('agent ' + m.senderId)}: claimed value ${Number(m.claimedValuation).toFixed(0)} cents`);
        }
      }

      lines.push(
        ``,
        `【You must choose one of the following actions】`,
        ...actions,
      );
      if (constraints.length) {
        lines.push(``, `Constraints:`, ...constraints);
        lines.push(
          `- If the price generated by ASK_1 or ASK_3 is <= best_bid, it is equivalent to a sell order that will be executed immediately.`,
          `- If the price generated by BID_1 or BID_3 is >= best_ask, it is equivalent to a buy order that will be executed immediately.`,
        );
      }

      lines.push(
        ``,
        `【Your Task】`,
        `Please briefly compare the available actions to determine which is most advantageous to you:`,
        `- Buy immediately`,
        `- Sell immediately`,
        `- Place a more aggressive bid`,
        `- Place a more aggressive ask`,
        `- Do not trade`,
        `Then output only one final action.`,
        ``,
        `【Strict Output Format】`,
        `Reason: <Explain in 3-6 sentences why this action maximizes your utility>`,
        `Action: <${actions.map(a => a.split(':')[0].replace(/^\d+\.\s*/, '')).join(' / ')}>`,
      );

      return lines.join('\n');
    };

    const tasks = utilityAgents.map(async (a) => {
      const userPrompt = promptFor(a);
      a.lastLLMPrompt = { system, user: userPrompt, plan, ts: Date.now() };
      try {
        const raw = await this.call(aiCfg, system, userPrompt);
        a.lastLLMResponse = raw;
        const parsed = this.parseAction(raw);
        if (!parsed) return null;
        return { id: a.id, action: parsed.action, reason: parsed.reason };
      } catch (err) {
        a.lastLLMResponse = '[error] ' + (err.message || err);
        console.warn('[ai.getPlanBeliefs]', a.id, err.message || err);
        return null;
      }
    });
    const results = await Promise.all(tasks);
    const out = {};
    for (const r of results) if (r) out[r.id] = { action: r.action, reason: r.reason };
    return out;
  },
};

if (typeof window !== 'undefined') window.AI = AI;
