'use strict';

/* =====================================================================
   messaging.js — Message bus + O(N²) trust matrix stored as Float32Array.

   Scales to ~200 agents without DOM-reflow pressure. Trust is accessed
   only through topK()/get()/set() so the storage layout can change
   without touching the UI. Messages are capped at `bufferSize`; older
   entries spill into `archived` which is only read for CSV export.

   Message shape:
     { id, tick, round, period, fromId, toId | 'all', kind, payload }

     kind ∈ {
       'valuation-report',   // agent shares subjective V̂
       'peer-broadcast',     // general commentary (LLM stub)
       'regulator-warning',  // from regulator module, toId = 'all'
       'regulator-all-clear',
     }

   Trust lives in a flat Float32Array of length N², indexed by
   `src * N + dst`. Default value 0.5, self-trust = 1. EMA-updated at
   period close based on VWAP alignment of each sender's reported
   valuation.
   ===================================================================== */

class MessageBus {
  constructor(opts = {}) {
    this.bufferSize  = opts.bufferSize  || 2000;
    this.archiveSize = opts.archiveSize || 50000;
    this.messages    = [];
    this.archived    = [];
    this._nextId     = 1;
  }

  post(msg) {
    msg.id = this._nextId++;
    this.messages.push(msg);
    if (this.messages.length > this.bufferSize) {
      const drop = this.messages.shift();
      if (this.archived.length < this.archiveSize) this.archived.push(drop);
    }
    return msg;
  }

  /** Messages received by recipient (or broadcast) since tick cutoff. */
  recent(recipientId, sinceTick) {
    const out = [];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.tick < sinceTick) break;
      if (m.toId === 'all' || m.toId === recipientId) out.push(m);
    }
    return out.reverse();
  }

  /** All messages posted this period (regardless of recipient). */
  byPeriod(period, round) {
    const out = [];
    for (const m of this.messages) {
      if (m.period === period && m.round === round) out.push(m);
    }
    return out;
  }

  /** Flat list for UI message log, most recent first. */
  tail(k = 100) {
    return this.messages.slice(-k).reverse();
  }

  exportCSV() {
    const header = 'id,tick,round,period,fromId,toId,kind,payload\n';
    const esc = (s) => {
      if (s == null) return '';
      const str = typeof s === 'string' ? s : JSON.stringify(s);
      return '"' + str.replace(/"/g, '""') + '"';
    };
    const rows = [...this.archived, ...this.messages].map(m =>
      [m.id, m.tick, m.round, m.period, m.fromId, m.toId, m.kind, esc(m.payload)].join(',')
    );
    return header + rows.join('\n');
  }

  clear() { this.messages = []; this.archived = []; this._nextId = 1; }
}

class TrustMatrix {
  constructor(n) {
    this.n = n;
    this.data = new Float32Array(n * n);
    this.data.fill(0.5);
    for (let i = 0; i < n; i++) this.data[i * n + i] = 1;
  }

  get(src, dst) { return this.data[src * this.n + dst]; }
  set(src, dst, v) { this.data[src * this.n + dst] = Math.max(0, Math.min(1, v)); }

  emaUpdate(src, dst, closeness, lambda = 0.3) {
    const idx = src * this.n + dst;
    const cur = this.data[idx];
    this.data[idx] = (1 - lambda) * cur + lambda * closeness;
  }

  topK(src, k) {
    const n = this.n;
    const out = [];
    for (let dst = 0; dst < n; dst++) {
      if (dst === src) continue;
      out.push({ id: dst, value: this.data[src * n + dst] });
    }
    out.sort((a, b) => b.value - a.value);
    return out.slice(0, k);
  }

  meanInbound(dst) {
    let sum = 0, count = 0;
    for (let src = 0; src < this.n; src++) {
      if (src === dst) continue;
      sum += this.data[src * this.n + dst];
      count++;
    }
    return count ? sum / count : 0;
  }

  /** Copy underlying array for heatmap rendering. */
  snapshot() { return new Float32Array(this.data); }

  /**
   * Update trust for every agent who posted a valuation-report this
   * period against the observed VWAP.
   *   closeness = max(0, 1 − |reported − vwap| / vwap)
   */
  updateFromReports(reports, vwap, lambda = 0.3) {
    if (!vwap || vwap <= 0 || !reports.length) return;
    for (const r of reports) {
      const closeness = Math.max(0, 1 - Math.abs(r.reportedV - vwap) / vwap);
      for (let src = 0; src < this.n; src++) {
        if (src === r.fromId) continue;
        this.emaUpdate(src, r.fromId, closeness, lambda);
      }
    }
  }
}

if (typeof module !== 'undefined') module.exports = { MessageBus, TrustMatrix };
