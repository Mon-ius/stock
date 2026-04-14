'use strict';

/* =====================================================================
   logger.js — Append-only trace + snapshot store.

   Streams recorded by the simulation (all append-only so replay can
   slice them at a snapshot's recorded length):

     * traces              — one record per agent decision
     * snapshots           — indexed by tick; enough state to rebuild
                             the UI at that moment. Large arrays are
                             not copied; length fields are recorded.
     * events              — dividend payments, period transitions
     * messages            — inter-agent broadcasts (utility agents)
     * valuationHistory    — per-tick per-agent {trueV, subjV, reportedV}
     * utilityHistory      — per-tick per-agent {wealth, utility, riskPref}
     * decisionEvaluations — per-decision EU candidate table
     * beliefChanges       — per-update {prior, posterior, mode, source}
     * trustHistory        — per-period trust matrix snapshot

   Trace shape (base):
   {
     timestamp: tick,
     period,
     agentId, agentName, agentType,
     state:     { cash, inventory, estimatedValue, observedPrice },
     decision:  { type, price, quantity },
     reasoning: { ruleUsed, expectedProfit, triggerCondition,
                  utility?, beliefMode?, receivedMsgs? },
     filled:    quantity actually executed at submission time
   }

   Extended streams are empty for legacy populations — all downstream
   consumers (Replay, UI) must handle empty arrays gracefully.
   ===================================================================== */

class Logger {
  constructor() {
    this.traces              = [];
    this.snapshots           = [];   // index by tick: snapshots[tick] = {...}
    this.events              = [];
    this.messages            = [];
    this.valuationHistory    = [];
    this.utilityHistory      = [];
    this.decisionEvaluations = [];
    this.beliefChanges       = [];
    this.trustHistory        = [];
    // DLM 2005 payoff tracking. The Engine snapshots each agent's
    // final cash holdings at the end of every round (after the last
    // dividend has been paid and before the round-end reset rewinds
    // cash to the spec). Indexed by round: roundFinalCash[r-1] is a
    // {agentId: cash} map. Session payoff is the sum across rounds
    // plus the $5 (= 500¢) show-up fee, exactly as in DLM 2005.
    this.roundFinalCash      = [];
    // LLM prompt/response audit trail for Plans II/III. Each entry
    // records the system prompt, user prompt, raw response, and parsed
    // action for one agent at one period boundary. Empty for Plan I.
    this.llmCalls            = [];
  }

  logTrace(trace)         { this.traces.push(trace); }
  logEvent(event)         { this.events.push(event); }
  logMessage(msg)         { this.messages.push(msg); }
  logValuation(entry)     { this.valuationHistory.push(entry); }
  logUtility(entry)       { this.utilityHistory.push(entry); }
  logEvaluation(entry)    { this.decisionEvaluations.push(entry); }
  logBeliefChange(entry)  { this.beliefChanges.push(entry); }
  logTrust(entry)         { this.trustHistory.push(entry); }
  logRoundFinalCash(round, byAgent) { this.roundFinalCash[round - 1] = byAgent; }
  logLLMCall(entry)       { this.llmCalls.push(entry); }
  snapshot(s)             { this.snapshots[s.tick] = s; }

  clear() {
    this.traces              = [];
    this.snapshots           = [];
    this.events              = [];
    this.messages            = [];
    this.valuationHistory    = [];
    this.utilityHistory      = [];
    this.decisionEvaluations = [];
    this.beliefChanges       = [];
    this.trustHistory        = [];
    this.roundFinalCash      = [];
    this.llmCalls            = [];
  }

  /** Nearest snapshot at or before the requested tick. */
  getSnapshot(tick) {
    for (let t = tick; t >= 0; t--) if (this.snapshots[t]) return this.snapshots[t];
    return null;
  }

  /** All decisions filed at exactly this tick. */
  tracesAt(tick) {
    return this.traces.filter(t => t.timestamp === tick);
  }
}
