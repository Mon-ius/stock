'use strict';

/* =====================================================================
   messaging.js — Inter-agent communication + trust tracking.

   Communication model:
     1. At the end of every period, every agent emits one message via
        its `communicate()` method. The message contains the agent's
        true private valuation AND a claimedValuation which can differ
        according to the agent's deceptionMode.
     2. All messages are appended to a shared MessageBus, visible to
        everyone.
     3. At the start of the next period, each agent reads the previous
        period's messages and folds them into its own subjective
        valuation using its beliefMode (naive / skeptical / adaptive).

   Trust model:
     * trust[receiver][sender] ∈ [0, 1], initialized to 0.5 (0.5 = no
       prior), with self-trust fixed at 1.
     * At period end, we compare each sender's claimedValuation for
       that period to the period's volume-weighted mean trade price.
     * closeness = clamp(1 - |claim - avgPrice| / avgPrice, 0, 1)
     * trust[r][s] ← (1-α) × trust[r][s] + α × closeness   for r ≠ s
     * α (learning rate) = 0.3 by default.

     Adaptive agents use trust as a weight on incoming messages.
     Naive agents ignore trust and take a flat average.
     Skeptical agents heavily discount all messages regardless.

   Message shape:
   {
     senderId, senderName,
     round, period, tick,
     trueValuation,         // the sender's actual belief
     claimedValuation,      // what the sender broadcast
     signal,                // 'buy' | 'sell' | 'hold'
     deceptionMode,         // 'honest' | 'biased' | 'deceptive'
     deceptive,             // boolean — |claim - true|/true > 0.05
   }
   ===================================================================== */

class MessageBus {
  constructor() {
    this.messages = [];
  }

  post(msg) {
    this.messages.push(msg);
  }

  byPeriod(period, round) {
    const out = [];
    for (const m of this.messages) {
      if (m.period !== period) continue;
      if (round != null && m.round !== round) continue;
      out.push(m);
    }
    return out;
  }

  upToTick(tick) {
    const out = [];
    for (const m of this.messages) if (m.tick <= tick) out.push(m);
    return out;
  }

  count() { return this.messages.length; }
  clear() { this.messages = []; }
}

class TrustTracker {
  constructor(agentIds) {
    this.agentIds = agentIds.map(Number);
    this.trust    = {};     // trust[receiver][sender] ∈ [0,1]
    this.history  = [];     // snapshots of the matrix over time
    for (const r of this.agentIds) {
      this.trust[r] = {};
      for (const s of this.agentIds) this.trust[r][s] = r === s ? 1 : 0.5;
    }
  }

  get(receiver, sender) {
    const row = this.trust[receiver];
    if (!row) return 0.5;
    const v = row[sender];
    return v == null ? 0.5 : v;
  }

  /**
   * Update trust scores after a period's trading is complete.
   * Compares each sender's claimedValuation for that period to the
   * period's volume-weighted mean trade price. Every receiver's trust
   * in that sender moves toward the "closeness" score by learning
   * rate α. Self-trust is never updated.
   */
  update(messageBus, market, period, alpha = 0.3) {
    const round = market.round;
    const msgs = messageBus.byPeriod(period, round);
    if (!msgs.length) return;
    let vwap = 0, qw = 0;
    for (const t of market.trades) {
      if (t.period !== period || t.round !== round) continue;
      vwap += t.price * t.quantity;
      qw   += t.quantity;
    }
    if (qw === 0) return;
    const avgPrice = vwap / qw;
    for (const msg of msgs) {
      const err       = Math.abs(msg.claimedValuation - avgPrice) / Math.max(1, avgPrice);
      const closeness = Math.max(0, Math.min(1, 1 - err));
      for (const r of this.agentIds) {
        if (r === msg.senderId) continue;
        const cur = this.trust[r][msg.senderId];
        this.trust[r][msg.senderId] = (1 - alpha) * cur + alpha * closeness;
      }
    }
  }

  /** Deep-copy the trust matrix and append it to history. */
  snapshot(tick) {
    const copy = {};
    for (const r of this.agentIds) {
      copy[r] = {};
      for (const s of this.agentIds) copy[r][s] = this.trust[r][s];
    }
    this.history.push({ tick, trust: copy });
    return copy;
  }

  copy() {
    const out = {};
    for (const r of this.agentIds) {
      out[r] = {};
      for (const s of this.agentIds) out[r][s] = this.trust[r][s];
    }
    return out;
  }
}
