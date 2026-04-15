'use strict';

/* =====================================================================
   ui.js — DOM + canvas rendering.

   Reads only a view object (from replay.js), never touches Market /
   Engine / Agent directly. Live and replay paths render identically.
   ===================================================================== */

const UI = {
  tableSort:     { key: 'wealth', dir: -1 },
  expandedIds:   new Set(),
  messageFilter: 'all',
  _tickCounter:  0,

  refreshTheme() {
    const styles = getComputedStyle(document.documentElement);
    Viz.setTheme({
      frame: styles.getPropertyValue('--frame').trim() || '#c6cad1',
      grid:  styles.getPropertyValue('--grid').trim()  || 'rgba(0,0,0,0.08)',
      label: styles.getPropertyValue('--muted').trim() || '#9aa0ad',
    });
  },

  render(view) {
    this._tickCounter++;
    this._renderStats(view);
    this._renderPriceChart(view);
    this._renderBubbleChart(view);
    this._renderFanChart(view);
    this._renderVolumeChart(view);
    this._renderRegulatorChart(view);
    this._renderTrustHeatmap(view);
    const throttle = view.N > 120 && (this._tickCounter & 3);
    if (!throttle) this._renderAgentTable(view);
    this._renderMessageLog(view);
    this._renderEvents(view);
  },

  _renderStats(v) {
    const set = (id, text, cls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      if (cls != null) el.className = `value ${cls}`;
    };
    set('stat-tick',   String(v.tick));
    set('stat-round',  `${v.round} / ${v.roundsPerSession}`);
    set('stat-period', `${v.period} / ${v.periods}`);
    set('stat-price',  v.lastPrice != null ? v.lastPrice.toFixed(2) : '—');
    set('stat-fv',     v.fvRef != null ? v.fvRef.toFixed(2) : '—');
    const ratio = v.regulator.ratio;
    set('stat-ratio',  ratio != null ? ratio.toFixed(2) : '—',
      ratio != null && ratio >= v.regulator.threshold ? 'value warn' : 'value');
    const reg = document.getElementById('stat-reg');
    if (reg) {
      reg.textContent = v.regulator.active ? 'ACTIVE'
                        : v.regulator.mode === 'off' ? 'OFF' : 'idle';
      reg.className   = `value ${v.regulator.active ? 'warn' : 'ok'}`;
    }
    set('stat-regime', v.hmmRegime || '—');
    set('stat-n',      String(v.N));
  },

  _renderPriceChart(v) {
    const canvas = document.getElementById('chart-price');
    if (!canvas) return;
    const { ctx, width, height } = Viz.setupHiDPI(canvas);
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 52, 14, 18, 32);
    const hist = v.priceHistory;
    if (!hist.length) { Viz.axes(ctx, rect, { xMin:0, xMax:1, yMin:0, yMax:1 }); return; }
    const xMin = hist[0].tick, xMax = hist[hist.length - 1].tick;
    let yMin =  Infinity, yMax = -Infinity;
    for (const p of hist) {
      if (p.price != null) { yMin = Math.min(yMin, p.price); yMax = Math.max(yMax, p.price); }
      if (p.fvRef != null) { yMin = Math.min(yMin, p.fvRef); yMax = Math.max(yMax, p.fvRef); }
    }
    if (!isFinite(yMin)) { yMin = 0; yMax = 100; }
    yMin = Math.floor(yMin * 0.9); yMax = Math.ceil(yMax * 1.1);
    Viz.axes(ctx, rect, { xMin, xMax, yMin, yMax, xTicks: 6, yTicks: 5 });
    ctx.save();
    ctx.fillStyle = 'rgba(230,90,80,0.08)';
    for (const h of v.regulator.history) {
      if (h.warn) {
        const x = Viz.mapX(rect, h.tick, xMin, xMax);
        ctx.fillRect(x - 1, rect.y, 3, rect.h);
      }
    }
    ctx.restore();
    Viz.line(ctx, rect, hist.map(p => ({ x: p.tick, y: p.fvRef })),
      { xMin, xMax, yMin, yMax, color: 'rgba(216,155,40,0.85)', width: 1.5, dashed: true });
    Viz.line(ctx, rect, hist.map(p => ({ x: p.tick, y: p.price })),
      { xMin, xMax, yMin, yMax, color: 'rgba(56,124,255,0.95)', width: 2 });
    Viz.legendRow(ctx, rect,
      [{ color: 'rgba(56,124,255,0.95)', label: 'Price' },
       { color: 'rgba(216,155,40,0.85)', label: 'Analytical FV' },
       { color: 'rgba(230,90,80,0.6)',   label: 'Regulator warn' }]);
    Viz.axisLabel(ctx, rect, 'tick', 'bottom');
    Viz.axisLabel(ctx, rect, 'cents', 'left');
  },

  _renderBubbleChart(v) {
    const canvas = document.getElementById('chart-bubble');
    if (!canvas) return;
    const { ctx, width, height } = Viz.setupHiDPI(canvas);
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 52, 14, 18, 32);
    const hist = v.regulator.history.filter(h => h.ratio != null);
    if (!hist.length) { Viz.axes(ctx, rect, { xMin:0, xMax:1, yMin:0, yMax:2 }); return; }
    const xMin = hist[0].tick, xMax = hist[hist.length - 1].tick;
    const yMin = 0.4, yMax = 2.2;
    Viz.axes(ctx, rect, { xMin, xMax, yMin, yMax, xTicks: 6, yTicks: 5, yFmt: v => v.toFixed(2) });
    Viz.line(ctx, rect, [{ x: xMin, y: v.regulator.threshold }, { x: xMax, y: v.regulator.threshold }],
      { xMin, xMax, yMin, yMax, color: 'rgba(230,90,80,0.8)', width: 1, dashed: true });
    Viz.line(ctx, rect, [{ x: xMin, y: 1 }, { x: xMax, y: 1 }],
      { xMin, xMax, yMin, yMax, color: 'rgba(120,120,120,0.35)', width: 1, dashed: true });
    Viz.line(ctx, rect, hist.map(h => ({ x: h.tick, y: h.ratio })),
      { xMin, xMax, yMin, yMax, color: 'rgba(170,56,96,0.95)', width: 2 });
    Viz.legendRow(ctx, rect,
      [{ color: 'rgba(170,56,96,0.95)', label: 'ρ = P / FV' },
       { color: 'rgba(230,90,80,0.8)',  label: `threshold ${v.regulator.threshold}` }]);
    Viz.axisLabel(ctx, rect, 'tick', 'bottom');
    Viz.axisLabel(ctx, rect, 'ratio', 'left');
  },

  _renderFanChart(v) {
    const canvas = document.getElementById('chart-fan');
    if (!canvas) return;
    const { ctx, width, height } = Viz.setupHiDPI(canvas);
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 52, 14, 18, 32);
    const agg = v.aggregates;
    if (!agg.length) { Viz.axes(ctx, rect, { xMin:0, xMax:1, yMin:0, yMax:1 }); return; }
    const xMin = agg[0].tick, xMax = agg[agg.length - 1].tick;
    let yMin =  Infinity, yMax = -Infinity;
    for (const a of agg) {
      yMin = Math.min(yMin, a.valuation.p25);
      yMax = Math.max(yMax, a.valuation.p75);
    }
    if (!isFinite(yMin)) { yMin = 0; yMax = 100; }
    yMin = Math.floor(yMin * 0.85); yMax = Math.ceil(yMax * 1.15);
    Viz.axes(ctx, rect, { xMin, xMax, yMin, yMax, xTicks: 6, yTicks: 5 });
    const series = agg.map(a => ({
      x: a.tick, p25: a.valuation.p25, p50: a.valuation.p50, p75: a.valuation.p75,
    }));
    Viz.fanChart(ctx, rect, series, { xMin, xMax, yMin, yMax, color: 'rgba(90,130,220,0.32)' });
    Viz.line(ctx, rect, agg.map(a => ({ x: a.tick, y: a.valuation.p50 })),
      { xMin, xMax, yMin, yMax, color: 'rgba(40,70,160,0.9)', width: 1.5 });
    const palette = ['#ff8a65','#5ec1ff','#7bd88f','#f2b24a','#b57edc','#ff6bcb'];
    let ci = 0;
    for (const id of v.tracedIds) {
      const recs = v.traceByAgent[id] || [];
      if (!recs.length) continue;
      const pts = recs.map(r => ({ x: r.tick, y: r.trace && r.trace.V ? r.trace.V : null }));
      Viz.line(ctx, rect, pts, { xMin, xMax, yMin, yMax, color: palette[ci % palette.length], width: 1.2 });
      ci++;
    }
    const legend = [
      { color: 'rgba(90,130,220,0.55)', label: 'Cohort V̂ (IQR)' },
      { color: 'rgba(40,70,160,0.9)',   label: 'Median' },
    ];
    for (let i = 0; i < Math.min(v.tracedIds.length, 6); i++) {
      const a = v.agents.find(x => x.id === v.tracedIds[i]);
      legend.push({ color: palette[i % palette.length], label: a ? a.name : '#' + v.tracedIds[i] });
    }
    Viz.legendRow(ctx, rect, legend);
    Viz.axisLabel(ctx, rect, 'tick', 'bottom');
    Viz.axisLabel(ctx, rect, 'V̂', 'left');
  },

  _renderVolumeChart(v) {
    const canvas = document.getElementById('chart-volume');
    if (!canvas) return;
    const { ctx, width, height } = Viz.setupHiDPI(canvas);
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 52, 14, 18, 32);
    const vol = v.volumeByPeriod;
    const totalPeriods = v.periods * v.roundsPerSession;
    const points = [];
    for (let p = 1; p <= totalPeriods; p++) points.push({ x: p, y: vol[p] || 0 });
    const xMin = 1, xMax = totalPeriods;
    const yMax = Math.max(10, ...points.map(p => p.y));
    Viz.axes(ctx, rect, { xMin, xMax, yMin: 0, yMax, xTicks: Math.min(10, totalPeriods), yTicks: 4 });
    ctx.save(); ctx.strokeStyle = 'rgba(120,120,120,0.35)'; ctx.setLineDash([2,3]);
    for (let r = 1; r < v.roundsPerSession; r++) {
      const x = Viz.mapX(rect, r * v.periods + 0.5, xMin, xMax);
      ctx.beginPath(); ctx.moveTo(x, rect.y); ctx.lineTo(x, rect.y + rect.h); ctx.stroke();
    }
    ctx.restore();
    Viz.bars(ctx, rect, points,
      { xMin, xMax, yMin: 0, yMax, color: 'rgba(70,140,100,0.7)',
        barWidth: Math.max(3, rect.w / (totalPeriods * 1.4)) });
    Viz.axisLabel(ctx, rect, 'global period', 'bottom');
    Viz.axisLabel(ctx, rect, 'shares', 'left');
  },

  _renderRegulatorChart(v) {
    const canvas = document.getElementById('chart-reg');
    if (!canvas) return;
    const { ctx, width, height } = Viz.setupHiDPI(canvas);
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 44, 14, 10, 26);
    const hist = v.regulator.history;
    if (!hist.length) { Viz.axes(ctx, rect, { xMin:0, xMax:1, yMin:0, yMax:1 }); return; }
    const xMin = hist[0].tick, xMax = hist[hist.length - 1].tick;
    Viz.axes(ctx, rect, { xMin, xMax, yMin: 0, yMax: 1, xTicks: 6, yTicks: 2, yFmt: v => v ? 'warn' : 'ok' });
    ctx.save();
    for (const h of hist) {
      if (h.warn) {
        ctx.fillStyle = 'rgba(230,90,80,0.9)';
        const x = Viz.mapX(rect, h.tick, xMin, xMax);
        ctx.fillRect(x - 1, rect.y + 4, 3, rect.h - 8);
      }
    }
    ctx.restore();
    Viz.axisLabel(ctx, rect, 'tick', 'bottom');
  },

  _renderTrustHeatmap(v) {
    const canvas = document.getElementById('chart-trust');
    if (!canvas) return;
    const { ctx, width, height } = Viz.setupHiDPI(canvas);
    Viz.clear(ctx, width, height);
    const side = Math.min(width, height);
    const rect = { x: (width - side) / 2 + 4, y: 4, w: side - 8, h: side - 8 };
    Viz.drawHeatmap(ctx, rect, v.trustSnapshot, v.N);
  },

  _renderAgentTable(v) {
    const tbody = document.getElementById('agent-tbody');
    if (!tbody) return;
    const rows = v.agents.slice();
    const { key, dir } = this.tableSort;
    rows.sort((a, b) => {
      const av = a[key]; const bv = b[key];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    const frag = document.createDocumentFragment();
    for (const a of rows) {
      const tr = document.createElement('tr');
      tr.dataset.agentId = a.id;
      if (this.expandedIds.has(a.id)) tr.classList.add('expanded');
      if (a.traced) tr.classList.add('traced');
      tr.innerHTML = `
        <td class="col-trace"><input type="checkbox" class="trace-toggle" data-id="${a.id}" ${a.traced ? 'checked' : ''}></td>
        <td class="col-name">${a.name}${a.isLLM ? ' <span class="badge llm">LLM</span>' : ''}</td>
        <td class="col-role">${a.role}</td>
        <td class="col-risk">${a.riskPref}</td>
        <td class="col-cog">${a.cognitiveType}</td>
        <td class="col-react">${a.regulatorReaction}</td>
        <td class="col-cash">${a.cash.toFixed(0)}</td>
        <td class="col-inv">${a.inventory}</td>
        <td class="col-wealth">${a.wealth.toFixed(0)}</td>
        <td class="col-action"><span class="tag action-${a.lastAction}">${a.lastAction}</span></td>
      `;
      frag.appendChild(tr);
      if (this.expandedIds.has(a.id)) {
        const expand = document.createElement('tr');
        expand.className = 'expand-row';
        expand.innerHTML = `<td colspan="10">${this._renderExpand(v, a)}</td>`;
        frag.appendChild(expand);
      }
    }
    tbody.innerHTML = '';
    tbody.appendChild(frag);
  },

  _renderExpand(v, a) {
    if (!a.traced) {
      return `<div class="expand-pad"><em>Tracing disabled.</em> Enable the Trace checkbox to record this agent's decision trail.</div>`;
    }
    const trace = (v.traceByAgent[a.id] || []).slice(-20);
    if (!trace.length) return `<div class="expand-pad"><em>No trace recorded yet.</em></div>`;
    const rows = trace.map(r => {
      const t = r.trace || {};
      const cands = (t.candidates || []).map(c => `${c.type}${c.price ? '@'+c.price : ''} eu=${c.eu}`).join(' · ');
      return `<tr>
        <td>${r.tick}</td><td>${r.round}·${r.period}</td><td>${r.action}</td>
        <td>${t.fvHat ?? '—'}</td><td>${t.V ?? '—'}</td>
        <td>${t.regActive ? 'Y' : ''}</td>
        <td>${t.chosen || t.source || ''}</td>
        <td class="mono">${cands}</td>
      </tr>`;
    }).join('');
    return `
      <div class="expand-pad">
        <div class="expand-head">
          <strong>${a.name}</strong> · ${a.riskPref}/${a.cognitiveType}/${a.regulatorReaction}
          · alert: ${a.receivedAlert ? `ρ=${a.receivedAlert.ratio} (${a.receivedAlert.level})` : 'none'}
          <button class="export-trace" data-id="${a.id}">Export CSV</button>
        </div>
        <table class="trace-table">
          <thead><tr><th>tick</th><th>R·P</th><th>action</th><th>fvHat</th><th>V</th><th>reg</th><th>chosen</th><th>candidates</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  },

  _renderMessageLog(v) {
    const list = document.getElementById('message-log');
    if (!list) return;
    const msgs = v.messages.filter(m => this.messageFilter === 'all' || m.kind === this.messageFilter);
    list.innerHTML = '';
    for (const m of msgs.slice(0, 60)) {
      const li = document.createElement('li');
      li.className = `msg kind-${m.kind}`;
      const from = m.fromId === 'REGULATOR' ? 'REGULATOR'
        : (v.agents.find(a => a.id === m.fromId) || {}).name || `#${m.fromId}`;
      const to = m.toId === 'all' ? '→ all'
        : `→ ${(v.agents.find(a => a.id === m.toId) || {}).name || '#' + m.toId}`;
      const body = m.kind === 'regulator-warning'
        ? `<span class="warn">${m.payload.text}</span>`
        : m.kind === 'valuation-report'
          ? `V̂ = ${Number(m.payload.reportedV).toFixed(1)}`
          : JSON.stringify(m.payload);
      li.innerHTML = `<span class="msg-tick">t${m.tick}</span><span class="msg-from">${from}</span><span class="msg-to">${to}</span><span class="msg-kind">${m.kind}</span><span class="msg-body">${body}</span>`;
      list.appendChild(li);
    }
  },

  _renderEvents(v) {
    const el = document.getElementById('event-log');
    if (!el) return;
    const recent = v.events.slice(-12).reverse();
    el.innerHTML = recent.map(e => {
      let body = '';
      if (e.type === 'dividend') body = `d=${e.value.toFixed(2)} (${e.regime})`;
      else if (e.type === 'regulator_warning') body = `ρ=${e.ratio} ${e.level}`;
      else if (e.type === 'period_end') body = `VWAP=${e.vwap ? e.vwap.toFixed(2) : '—'}`;
      else if (e.type === 'round_start' || e.type === 'round_end') body = `round ${e.round}`;
      return `<li class="event ev-${e.type}"><span class="ev-tick">t${e.tick || '—'}</span><span class="ev-type">${e.type}</span><span class="ev-body">${body}</span></li>`;
    }).join('');
  },

  bindTable(onToggle, onExport) {
    const table = document.getElementById('agent-table');
    if (!table) return;
    table.addEventListener('click', (e) => {
      const toggleBtn = e.target.closest('.trace-toggle');
      if (toggleBtn) { e.stopPropagation(); onToggle(Number(toggleBtn.dataset.id)); return; }
      const exportBtn = e.target.closest('.export-trace');
      if (exportBtn) { onExport(Number(exportBtn.dataset.id)); return; }
      const row = e.target.closest('tr[data-agent-id]');
      if (row) {
        const id = Number(row.dataset.agentId);
        if (this.expandedIds.has(id)) this.expandedIds.delete(id);
        else this.expandedIds.add(id);
      }
    });
    const thead = document.querySelector('#agent-table thead');
    if (thead) thead.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      const key = th.dataset.sort;
      if (this.tableSort.key === key) this.tableSort.dir *= -1;
      else { this.tableSort.key = key; this.tableSort.dir = -1; }
    });
  },

  bindMessageFilter() {
    const sel = document.getElementById('message-filter');
    if (!sel) return;
    sel.addEventListener('change', () => { this.messageFilter = sel.value; });
  },
};
