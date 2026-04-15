'use strict';

/* =====================================================================
   logger.js — Per-agent opt-in tracing + bounded aggregate ring buffer.

   At N=100 the old "append every agent's snapshot every tick" pattern
   produces ~720 × 100 = 72 000 snapshots per session. The new model
   splits storage:

     traceStore[agentId] → per-decision full trace, ONLY for agents with
                           `agent.traced === true`. Runtime-toggleable.
     aggregateStore      → fixed-size ring buffer of per-tick cohort
                           aggregates (wealth/valuation quantiles,
                           action histogram, regulator state).
     events              — sparse event log kept in full.
     roundFinalCash      — payoff accounting per round.
   ===================================================================== */

class Logger {
  constructor(config, deps) {
    this.config           = config;
    this.deps             = deps;
    this.traceStore       = {};
    this.aggregateStore   = new RingBuffer(config.aggregateWindow || 10000);
    this.events           = [];
    this.roundFinalCash   = [];
    this.archivedTraces   = {};
    this.maxTracePerAgent = config.maxTracePerAgent || 5000;
  }

  recordTrace(id, rec) {
    if (!this.traceStore[id]) this.traceStore[id] = [];
    this.traceStore[id].push(rec);
    if (this.traceStore[id].length > this.maxTracePerAgent) {
      if (!this.archivedTraces[id]) this.archivedTraces[id] = [];
      this.archivedTraces[id].push(this.traceStore[id].shift());
    }
  }

  recordEvent(type, payload) { this.events.push({ type, ...payload }); }

  recordAggregate(market, agentList, regulator, fvRef) {
    const wealths = [];
    const vals    = [];
    const actions = { hold: 0, bid: 0, ask: 0 };
    for (const a of agentList) {
      const v = a.subjectiveV != null ? a.subjectiveV : (fvRef || 0);
      wealths.push(a.cash + a.inventory * v);
      vals.push(v);
      const act = a.lastAction || 'hold';
      if (act in actions) actions[act]++;
      else actions.hold++;
    }
    wealths.sort((a, b) => a - b);
    vals.sort((a, b) => a - b);
    const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : 0;
    const mean = wealths.length ? wealths.reduce((s, x) => s + x, 0) / wealths.length : 0;
    const sp   = market.sessionPeriod();
    this.aggregateStore.push({
      tick:   market.tick,
      round:  market.round,
      period: market.period,
      price:  market.lastPrice,
      fvRef,
      wealth: {
        mean,
        p25: q(wealths, 0.25), p50: q(wealths, 0.5), p75: q(wealths, 0.75),
        min: wealths[0] || 0,
        max: wealths[wealths.length - 1] || 0,
      },
      valuation: { p25: q(vals, 0.25), p50: q(vals, 0.5), p75: q(vals, 0.75) },
      actions,
      regActive:    regulator.isActive(market.tick),
      regRatio:     regulator.currentRatio(),
      volumePeriod: market.volumeByPeriod[sp] || 0,
    });
  }

  recordRoundFinalCash(round, agentList) {
    if (!this.roundFinalCash[round - 1]) this.roundFinalCash[round - 1] = {};
    for (const a of agentList) this.roundFinalCash[round - 1][a.id] = a.cash;
  }

  toggleTrace(id, agents) {
    const a = agents[id];
    if (!a) return false;
    a.traced = !a.traced;
    if (!this.traceStore[id]) this.traceStore[id] = [];
    return a.traced;
  }

  getTrace(id) {
    return (this.archivedTraces[id] || []).concat(this.traceStore[id] || []);
  }

  aggregates() { return this.aggregateStore.toArray(); }

  aggregateAt(tick) {
    const arr = this.aggregateStore.toArray();
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i].tick <= tick) return arr[i];
    return null;
  }

  exportSession() {
    return {
      events:         this.events,
      aggregates:     this.aggregateStore.toArray(),
      roundFinalCash: this.roundFinalCash,
      tracedAgents:   Object.keys(this.traceStore).map(Number),
      traceCounts:    Object.fromEntries(
        Object.entries(this.traceStore).map(([k, v]) => [k, v.length])
      ),
    };
  }

  exportTraceCSV(id) {
    const rows = this.getTrace(id);
    if (!rows.length) return '';
    const header = 'tick,round,period,action,fvHat,V,regActive,source,chosen\n';
    const body = rows.map(r => {
      const t = r.trace || {};
      return [r.tick, r.round, r.period, r.action,
              t.fvHat ?? '', t.V ?? '', t.regActive ?? '',
              t.source ?? '', String(t.chosen ?? '').replace(/,/g, ';')].join(',');
    }).join('\n');
    return header + body;
  }

  clear() {
    this.traceStore     = {};
    this.archivedTraces = {};
    this.aggregateStore.clear();
    this.events         = [];
    this.roundFinalCash = [];
  }
}

class RingBuffer {
  constructor(capacity) {
    this.cap   = capacity;
    this.buf   = [];
    this._head = 0;
  }
  push(x) {
    if (this.buf.length < this.cap) this.buf.push(x);
    else { this.buf[this._head] = x; this._head = (this._head + 1) % this.cap; }
  }
  toArray() {
    if (this.buf.length < this.cap) return this.buf.slice();
    const out = new Array(this.buf.length);
    for (let i = 0; i < this.buf.length; i++) out[i] = this.buf[(this._head + i) % this.cap];
    return out;
  }
  clear() { this.buf = []; this._head = 0; }
  get length() { return this.buf.length; }
}

if (typeof module !== 'undefined') module.exports = { Logger, RingBuffer };
