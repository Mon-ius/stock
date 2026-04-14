'use strict';

const UI = {
  els:     {},
  charts:  {},
  canvases: {},

  _riskLabel: {
    loving:  'Risk-loving',
    neutral: 'Risk-neutral',
    averse:  'Risk-averse',
  },
  _typeLabel: {
    fundamentalist: 'Fundamentalist',
    trend:          'Trend follower',
    random:         'Random (ZI)',
    dlm:            'DLM trader',
    utility:        'Utility',
  },
  // Paper-symbol cross-reference for each utility-agent risk preference
  // and each classic strategy type. Both maps key into Sym (js/mathml.js),
  // so every symbol rendered here goes through the same MathML source of
  // truth as the static HTML notes and figure captions.
  _riskSym: {
    loving:  'uLoving',
    neutral: 'uNeutral',
    averse:  'uAverse',
  },
  // Exact normalized utility functionals — keyed into Sym so each
  // Utility agent card can render its per-agent welfare function
  // in the same MathML source of truth as every other symbol.
  _riskFormula: {
    loving:  'uLovingNorm',
    neutral: 'uNeutralNorm',
    averse:  'uAverseNorm',
  },
  _typeSym: {
    fundamentalist: 'inF',
    trend:          'inT',
    random:         'inR',
    dlm:            'inE',
    utility:        'inU',
  },

  // Minimal HTML escaper for injecting plain-text strings into
  // template literals rendered via innerHTML (LLM prompt display).
  _escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  // Canvas-time theme cache. Populated by refreshTheme() which reads
  // CSS custom properties off :root via getComputedStyle. Every chart
  // renderer pulls colors from here so a theme switch flows through
  // the canvas layer identically to the DOM layer.
  theme: {
    fg0: '#1a1d23', fg2: '#6b7080', fg3: '#9aa0ad',
    bg1: '#ffffff', bg2: '#f4f5f7',
    accent: '#2563eb', amber: '#d97706', red: '#dc2626',
    green:  '#16a34a', purple: '#7c3aed', teal:   '#0d9488',
    frame:  '#c6cad1', grid:   'rgba(0,0,0,0.06)',
    stripe: 'rgba(0,0,0,0.025)', band: 'rgba(0,0,0,0.022)',
    palette: [],
  },

  refreshTheme() {
    const cs = getComputedStyle(document.documentElement);
    const read = k => (cs.getPropertyValue(k) || '').trim();
    const t = this.theme;
    t.fg0    = read('--fg-0')     || t.fg0;
    t.fg2    = read('--fg-2')     || t.fg2;
    t.fg3    = read('--fg-3')     || t.fg3;
    t.bg1    = read('--bg-1')     || t.bg1;
    t.bg2    = read('--bg-2')     || t.bg2;
    t.accent = read('--accent')   || t.accent;
    t.amber  = read('--amber')    || t.amber;
    t.red    = read('--red')      || t.red;
    t.green  = read('--green')    || t.green;
    t.purple = read('--purple')   || t.purple;
    t.teal   = read('--teal')     || t.teal;
    t.frame  = read('--chart-frame')  || t.frame;
    t.grid   = read('--chart-grid')   || t.grid;
    t.stripe = read('--chart-stripe') || t.stripe;
    t.band   = read('--chart-band')   || t.band;
    // Six-slot palette for multi-series charts, drawn from semantic
    // tokens so it shifts with the theme without breaking its meaning.
    t.palette = [t.accent, t.amber, t.green, t.red, t.purple, t.teal];
    if (typeof Viz !== 'undefined' && typeof Viz.setTheme === 'function') {
      Viz.setTheme({ frame: t.frame, grid: t.grid, label: t.fg3 });
    }
  },

  // Agent ids whose card is currently flipped to the back face.
  _flipped: new Set(),

  init() {
    this.refreshTheme();
    // Stat cells
    this.els.session = document.getElementById('stat-session');
    this.els.round   = document.getElementById('stat-round');
    this.els.period  = document.getElementById('stat-period');
    this.els.tick    = document.getElementById('stat-tick');
    this.els.price   = document.getElementById('stat-price');
    this.els.fv      = document.getElementById('stat-fv');
    this.els.bubble  = document.getElementById('stat-bubble');
    this.els.volume  = document.getElementById('stat-volume');

    this.els.bidsList   = document.getElementById('bids-list');
    this.els.asksList   = document.getElementById('asks-list');
    this.els.tradeFeed  = document.getElementById('trade-feed');
    this.els.agentsGrid = document.getElementById('agents-grid');

    this.els.traceBody    = document.getElementById('trace-body');
    this.els.replayPos    = document.getElementById('replay-position');
    this.els.replaySlider = document.getElementById('replay-slider');

    // Extended-mode elements (may be absent in legacy builds).
    this.els.metricsBody = document.getElementById('metrics-body');

    this.canvases = {
      price:     document.getElementById('chart-price'),
      bubble:    document.getElementById('chart-bubble'),
      volume:    document.getElementById('chart-volume'),
      timeline:  document.getElementById('chart-timeline'),
      heatmap:   document.getElementById('chart-heatmap'),
      valuation: document.getElementById('chart-valuation'),
      utility:   document.getElementById('chart-utility'),
      messages:  document.getElementById('chart-messages'),
      trust:     document.getElementById('chart-trust'),
      ownership: document.getElementById('chart-ownership'),
    };

    this.resizeCanvases();
    window.addEventListener('resize', () => {
      this.resizeCanvases();
      if (window.App) window.App.requestRender();
    });
  },

  resizeCanvases() {
    this.charts = {};
    for (const [k, c] of Object.entries(this.canvases)) {
      if (!c) continue;
      // Skip canvases that are currently hidden (display:none makes
      // getBoundingClientRect return 0×0). They'll be re-setup next
      // time extended mode toggles on.
      const rect = c.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      this.charts[k] = Viz.setupHiDPI(c);
    }
  },

  /** Deterministic color per utility agent id for multi-series charts. */
  agentColor(id) {
    const palette = this.theme.palette;
    return palette[(Number(id) - 1) % palette.length];
  },

  /* -------- Top-level render dispatcher -------- */

  render(view, config) {
    this.renderStats(view, config);
    this.renderBook(view);
    this.renderAgents(view, config);
    this.renderFeed(view);
    this.renderPriceChart(view, config);
    this.renderBubbleChart(view, config);
    this.renderVolumeChart(view, config);
    this.renderHeatmapChart(view, config);
    this.renderTimelineChart(view, config);
    // Extended panels — no-ops when their canvases are absent/hidden.
    this.renderValuationChart(view, config);
    this.renderUtilityChart(view, config);
    this.renderMessagesChart(view, config);
    this.renderTrustChart(view, config);
    this.renderOwnershipChart(view, config);
    this.renderMetrics(view, config);
    this.renderTraces(view);
    // 10-session batch results table. Per-round data labeled
    // R{r}_S{s} across all sessions. No-op when there are no
    // results yet.
    this.renderBatchResults();
  },

  /**
   * Render the 10-session batch results into #batch-results. Reads
   * per-round data from App.batchResults (populated by start()'s
   * onEnd callback). Each row is labeled R{r}_S{s} to identify the
   * round and session. After the table, shows per-treatment aggregates.
   */
  renderBatchResults() {
    const host = document.getElementById('batch-results');
    if (!host) return;
    const results = window.App && window.App.batchResults;
    if (!results || !results.length) {
      host.innerHTML = `
        <div class="batch-agg"><div class="batch-agg-row"><span class="treat">—</span>
          <strong>&mu;&nbsp;dev</strong> — &middot;
          <strong>&mu;&nbsp;turn</strong> — &middot;
          <strong>trades</strong> — &middot;
          <strong>&mu;&nbsp;payoff</strong> —
        </div></div>
        <table class="batch-table">
          <thead>
            <tr><th>Label</th><th>Tx</th><th>S</th><th>R</th><th>dev ¢</th><th>turn</th><th>trades</th><th>vol</th><th>payoff</th></tr>
          </thead>
          <tbody>
            <tr><td class="batch-label">—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>
          </tbody>
        </table>`;
      return;
    }

    // Build per-row HTML — one row per round per session.
    const rowsHtml = results.map(r => `<tr>
      <td class="batch-label">${r.label}</td>
      <td>${r.treatment}</td>
      <td>${r.session}</td>
      <td>${r.round}</td>
      <td>${r.meanDev.toFixed(1)}</td>
      <td>${r.turnover.toFixed(2)}</td>
      <td>${r.trades}</td>
      <td>${r.volume}</td>
      <td>${r.payoff}¢</td>
    </tr>`).join('');

    // Compute per-treatment aggregates across all rounds.
    const byTreatment = {};
    for (const r of results) {
      if (!byTreatment[r.treatment]) byTreatment[r.treatment] = [];
      byTreatment[r.treatment].push(r);
    }
    const aggHtml = Object.entries(byTreatment).map(([tx, rows]) => {
      const n       = rows.length;
      const avgDev  = rows.reduce((s, r) => s + r.meanDev, 0) / n;
      const avgTurn = rows.reduce((s, r) => s + r.turnover, 0) / n;
      const avgPay  = rows.reduce((s, r) => s + r.payoff, 0) / n;
      const totTr   = rows.reduce((s, r) => s + r.trades, 0);
      return `<div class="batch-agg-row"><span class="treat">${tx}</span>
        <strong>&mu;&nbsp;dev</strong> ${avgDev.toFixed(1)}¢ &middot;
        <strong>&mu;&nbsp;turn</strong> ${avgTurn.toFixed(2)} &middot;
        <strong>trades</strong> ${totTr} &middot;
        <strong>&mu;&nbsp;payoff</strong> ${avgPay.toFixed(0)}¢
      </div>`;
    }).join('');

    host.innerHTML = `
      <div class="batch-agg">${aggHtml}</div>
      <table class="batch-table">
        <thead>
          <tr><th>Label</th><th>Tx</th><th>S</th><th>R</th><th>dev ¢</th><th>turn</th><th>trades</th><th>vol</th><th>payoff</th></tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>`;
  },

  /* -------- Stats row -------- */

  renderStats(v, config) {
    const rounds = config.roundsPerSession || 1;
    const round  = v.round || 1;
    if (this.els.session) {
      const s = v.session || 0;
      this.els.session.textContent = s > 0 ? `${s} / 10` : '— / 10';
    }
    if (this.els.round) this.els.round.textContent = `${round} / ${rounds}`;
    this.els.period.textContent = `${v.period} / ${config.periods}`;
    this.els.tick.textContent   = v.tick;
    this.els.price.textContent  = v.lastPrice == null ? '—' : v.lastPrice.toFixed(2);
    this.els.fv.textContent     = v.fv.toFixed(2);
    this.els.bubble.textContent = v.lastPrice == null
      ? '—'
      : Math.abs(v.lastPrice - v.fv).toFixed(2);
    // Volume readout tracks the current round's period, indexed into
    // the session-wide array via the global period index.
    const g = (round - 1) * config.periods + v.period;
    this.els.volume.textContent = v.volumeByPeriod[g] || 0;
  },

  /* -------- Order book -------- */

  /**
   * Order book renders as two side-by-side <ul> lists rather than
   * tables so the panel can stretch vertically to match the sibling
   * .chart-price figure. Each list's row count is derived from its
   * own measured clientHeight divided by the row height (22px grid
   * cell + border), with a 6-row floor and a 14-row fallback on the
   * very first paint before layout has happened. This mirrors the
   * dynamic-slice approach used in renderFeed.
   */
  renderBook(v) {
    const rowH = 22;
    const drawSide = (list, orders) => {
      const avail = list.clientHeight || (rowH * 14);
      const rows  = Math.max(6, Math.floor(avail / rowH));
      const slice = orders.slice(0, rows);
      if (!slice.length) { list.innerHTML = '<li class="empty">empty</li>'; return; }
      list.innerHTML = slice.map(o => {
        const name = v.agents[o.agentId]?.name || ('A' + o.agentId);
        return `<li>`
          + `<span class="price">${o.price.toFixed(2)}</span>`
          + `<span class="qty">${o.remaining}</span>`
          + `<span class="agent">${name}</span>`
          + `</li>`;
      }).join('');
    };
    drawSide(this.els.bidsList, v.bids);
    drawSide(this.els.asksList, v.asks);
  },

  /* -------- Agent cards -------- */

  renderAgents(v, config) {
    const initialFV = config.dividendMean * config.periods;
    // Pre-run: live view, tick still at 0. Only then do we render the
    // editable endowment inputs — once the engine has ticked past 0,
    // the numbers reflect live trading state and must not be edited.
    const editable = !v.isReplay && v.tick === 0;
    const panel = document.querySelector('.panel-agents');
    if (panel) panel.classList.toggle('preview', editable);
    this._toggleAgentStageLabel(editable);

    const html = Object.values(v.agents).map(a => {
      const action = a.lastAction || 'hold';
      const isUtil = a.riskPref != null;
      const wealth = a.cash + a.inventory * (v.lastPrice != null ? v.lastPrice : v.fv);
      const init   = a.initialWealth != null ? a.initialWealth : (1000 + 3 * initialFV);
      const pnl    = wealth - init;
      const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(0);
      const pnlColor = pnl >= 0 ? 'var(--volume)' : 'var(--ask)';
      const borderStyle = isUtil ? ` style="border-left-color:${this.agentColor(a.id)}"` : '';
      // Subtitle is one of the three risk preferences for utility
      // agents, or a human-readable role for classic agents. The
      // strategy-cube code (U3, F1, …) is intentionally dropped here
      // because the #N prefix on displayName already carries the slot
      // number, and the full risk-mode label is easier to scan than
      // the cube notation.
      const subtitle = isUtil
        ? (UI._riskLabel[a.riskPref] || a.riskPref)
        : (UI._typeLabel[a.type] || a.type);
      const subtitleKey = isUtil
        ? UI._riskSym[a.riskPref]
        : UI._typeSym[a.type];
      const subtitleSym = (subtitleKey && window.Sym) ? window.Sym[subtitleKey] : '';
      const sym = window.Sym || {};
      const displayName = a.name || ('A' + a.id);
      // Experience and replacement badges — shown for every agent type
      // since all agents participate in the 4-round session and the
      // round-4 replacement step.
      const rp = a.roundsPlayed | 0;
      const expBadge = rp === 0
        ? '<span class="dlm-badge dlm-badge-novice">inexperienced</span>'
        : `<span class="dlm-badge dlm-badge-vet">experienced · ${rp}R</span>`;
      const endowBadge = a.endowmentType
        ? `<span class="dlm-badge dlm-badge-endow">type&nbsp;${a.endowmentType}</span>`
        : '';
      const freshBadge = a.replacementFresh
        ? '<span class="dlm-badge dlm-badge-fresh">R4 replacement</span>'
        : '';
      const badgeRow = `<div class="dlm-badges">${endowBadge}${expBadge}${freshBadge}</div>`;
      // Live-updating numeric values plus the agent's exact welfare
      // functional. The utility row is pinned to the per-agent
      // riskPref via _riskFormula, so every U-agent card carries the
      // same equation the decision engine actually evaluates in
      // computeUtility() (js/utility.js).
      const formulaKey = isUtil ? UI._riskFormula[a.riskPref] : '';
      const formulaSym = (formulaKey && window.Sym) ? window.Sym[formulaKey] : '';
      const extraRows = isUtil ? `
          <span class="metric">Subj V <span class="sym">${sym.subjV || ''}</span></span> <span class="metric-val">${a.subjectiveValuation != null ? a.subjectiveValuation.toFixed(1) : '—'}</span>
          <span class="metric">Report <span class="sym">${sym.reportV || ''}</span></span> <span class="metric-val">${a.reportedValuation != null ? a.reportedValuation.toFixed(1) : '—'}</span>
          <span class="metric metric-util">Utility <span class="sym">${sym.uOfW || ''}</span></span> <span class="metric-val metric-util-val"><span class="sym">${formulaSym}</span></span>` : '';

      // Back-face content — LLM prompt for utility agents, rule
      // explanation for algorithmic agents.
      const hasLLM = isUtil && a.lastLLMPrompt;
      const ruleDesc = {
        fundamentalist: 'Fundamentalist agents make decisions through coded rules — FV-anchored spreads that cross the book when mispricing exceeds ±2%, otherwise post passive quotes around the fundamental value.',
        trend:          'Trend Follower agents make decisions through coded rules — momentum chasing that bids aggressively on positive slopes and flees on negative slopes, with no horizon model.',
        random:         'Random (Zero-Intelligence) agents draw uniform prices bounded by the fundamental value. They provide a price-discovery floor/ceiling pinned to fundamentals.',
        dlm:            'DLM Trader agents follow the Dufwenberg–Lindqvist–Moore (2005) protocol — inexperienced traders chase trends while experienced traders anchor to the fundamental value.',
      };
      let cardBack;
      if (hasLLM) {
        cardBack = `
          <div class="card-back">
            <div class="card-back-head">
              <span class="card-back-title">LLM · Plan ${a.lastLLMPrompt.plan || '?'}</span>
              <span class="card-back-hint">click to flip back</span>
            </div>
            <div class="llm-prompt-body">
              <div class="llm-section">
                <div class="llm-label">System <span class="copy-hint">click to copy</span></div>
                <pre class="llm-text llm-copyable">${UI._escHtml(a.lastLLMPrompt.system || '')}</pre>
              </div>
              <div class="llm-section">
                <div class="llm-label">User <span class="copy-hint">click to copy</span></div>
                <pre class="llm-text llm-copyable">${UI._escHtml(a.lastLLMPrompt.user || '')}</pre>
              </div>
              <div class="llm-section">
                <div class="llm-label">Response</div>
                <pre class="llm-text llm-response">${UI._escHtml(String(a.lastLLMResponse || '—'))}</pre>
              </div>
            </div>
          </div>`;
      } else {
        const desc = ruleDesc[a.type] || 'This agent uses algorithmic decision rules. No LLM prompt is generated.';
        cardBack = `
          <div class="card-back">
            <div class="card-back-head">
              <span class="card-back-title">Decision rule</span>
              <span class="card-back-hint">click to flip back</span>
            </div>
            <p class="card-back-note">${desc}</p>
          </div>`;
      }

      const cashCell = editable
        ? `<input class="endow-input" type="number" min="0" step="10"
                  data-agent-id="${a.id}" data-field="cash"
                  value="${a.cash.toFixed(0)}">`
        : a.cash.toFixed(0);
      const invCell = editable
        ? `<input class="endow-input" type="number" min="0" step="1"
                  data-agent-id="${a.id}" data-field="inventory"
                  value="${a.inventory}">`
        : a.inventory;

      const isFlipped = UI._flipped.has(a.id);
      return `
        <div class="agent-card-wrap flippable${isFlipped ? ' flipped' : ''}" data-agent-id="${a.id}">
          <div class="agent-card-inner">
            <div class="agent-card card-front ${a.type}"${borderStyle}>
              <div class="agent-header">
                <div class="agent-head-left">
                  <div class="agent-name">${displayName}</div>
                  <div class="agent-type">${subtitle}${subtitleSym ? ` <span class="sym">${subtitleSym}</span>` : ''}</div>
                </div>
                <div class="agent-head-right">
                  <span class="last-action ${action}">${action}</span>
                  <span class="sym action-sym">${sym.action || ''}</span>
                </div>
              </div>
              ${badgeRow}
              <div class="metrics">
                <span class="metric">Cash <span class="sym">${sym.cash || ''}</span></span>    <span class="metric-val">${cashCell}</span>
                <span class="metric">Shares <span class="sym">${sym.shares || ''}</span></span>  <span class="metric-val">${invCell}</span>
                <span class="metric">Wealth <span class="sym">${sym.wealth || ''}</span></span>  <span class="metric-val">${wealth.toFixed(0)}</span>
                <span class="metric">P&amp;L <span class="sym">${sym.pnl || ''}</span></span> <span class="metric-val" style="color:${pnlColor}">${pnlStr}</span>${extraRows}
              </div>
              <div class="card-flip-hint">click to view prompt</div>
            </div>
            ${cardBack}
          </div>
        </div>`;
    }).join('');

    // Detach flipped card DOM nodes before innerHTML so their
    // interactions (text selection, etc.) survive the per-frame rebuild.
    // The back face is static between period boundaries, so keeping the
    // old node is correct.  Scroll positions are snapshotted explicitly
    // because some browsers reset scrollTop on absolutely-positioned
    // overflow elements when the node is removed from / reinserted into
    // the DOM tree.
    const preserved = {};
    const scrollSnap = {};
    this.els.agentsGrid.querySelectorAll('.agent-card-wrap.flipped').forEach(wrap => {
      const aid = wrap.dataset.agentId;
      preserved[aid] = wrap;
      const back = wrap.querySelector('.card-back');
      scrollSnap[aid] = {
        back: back ? back.scrollTop : 0,
        texts: [...wrap.querySelectorAll('.llm-text')].map(el => el.scrollTop),
      };
      wrap.remove();
    });

    this.els.agentsGrid.innerHTML = html;

    // Re-insert preserved flipped cards and restore scroll positions.
    for (const [id, oldWrap] of Object.entries(preserved)) {
      const fresh = this.els.agentsGrid.querySelector(
        `.agent-card-wrap[data-agent-id="${id}"]`,
      );
      if (fresh) {
        fresh.replaceWith(oldWrap);
        const ss = scrollSnap[id];
        if (ss) {
          const back = oldWrap.querySelector('.card-back');
          if (back) back.scrollTop = ss.back;
          const texts = oldWrap.querySelectorAll('.llm-text');
          ss.texts.forEach((top, i) => {
            if (texts[i]) texts[i].scrollTop = top;
          });
        }
      }
    }

    // Wire event delegation once — avoids per-card handler accumulation.
    if (!this._agentGridWired) {
      this._agentGridWired = true;
      this.els.agentsGrid.addEventListener('click', (e) => {
        // Click-to-copy on prompt text blocks.
        const copyable = e.target.closest('.llm-copyable');
        if (copyable) {
          e.stopPropagation();
          navigator.clipboard.writeText(copyable.textContent).then(() => {
            const label = copyable.previousElementSibling;
            const hint = label && label.querySelector('.copy-hint');
            if (hint) {
              hint.textContent = 'copied!';
              setTimeout(() => { hint.textContent = 'click to copy'; }, 1200);
            }
          });
          return;
        }
        // Flip card toggle.
        const wrap = e.target.closest('.agent-card-wrap.flippable');
        if (!wrap) return;
        if (e.target.closest('.endow-input')) return;
        if (e.target.closest('.card-back') && !e.target.closest('.card-back-head')) return;
        const id = Number(wrap.dataset.agentId);
        if (UI._flipped.has(id)) UI._flipped.delete(id);
        else                     UI._flipped.add(id);
        wrap.classList.toggle('flipped');
      });
    }

    if (editable) this._wireEndowmentInputs();
  },

  /**
   * Bind change handlers to the inline endowment inputs so edits are
   * committed through App.updateEndowment. Called every render while
   * in the pre-run preview stage since the grid HTML is replaced.
   */
  _wireEndowmentInputs() {
    const inputs = this.els.agentsGrid.querySelectorAll('.endow-input');
    inputs.forEach(inp => {
      inp.addEventListener('change', e => {
        const id    = Number(e.target.dataset.agentId);
        const field = e.target.dataset.field;
        const val   = Number(e.target.value);
        if (window.App && typeof window.App.updateEndowment === 'function') {
          window.App.updateEndowment(id, field, val);
        }
      });
      // Prevent Enter from bubbling up to any global keybindings;
      // commit the change on Enter instead of waiting for blur.
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
      });
    });
  },

  /**
   * Toggle a small pre-run status label on the agents panel header.
   * Separated out so renderAgents stays readable.
   */
  _toggleAgentStageLabel(on) {
    const h = document.querySelector('.panel-agents .agents-header .stage-label');
    if (!h) return;
    h.textContent = on
      ? 'Pre-run draft · editable before the simulation starts'
      : 'Running · live state';
    h.classList.toggle('live', !on);
  },

  /* -------- Trade feed (trades + dividend events) -------- */

  renderFeed(v) {
    const currentTick = v.tick | 0;
    if (currentTick <= 0) {
      this.els.tradeFeed.innerHTML = '<li class="muted">no activity yet</li>';
      return;
    }

    // Index trades and dividend events by their tick so the per-tick
    // walk below can probe in O(1). Multiple trades can land on the
    // same tick (all crosses execute inside one match pass), so each
    // bucket is a list.
    const byTick = new Map();
    const push = (tick, entry) => {
      const arr = byTick.get(tick);
      if (arr) arr.push(entry); else byTick.set(tick, [entry]);
    };
    for (const t of v.trades) push(t.timestamp, { kind: 'trade', t });
    for (const e of v.events) {
      if (e.type === 'dividend') push(e.tick, { kind: 'dividend', e });
    }

    // Walk ticks newest → oldest and emit a `silent` placeholder for
    // any tick with no trade and no dividend so the feed reads as an
    // exhaustive per-tick record. The 500-item cap keeps DOM cost
    // bounded; anything beyond the cap is still reachable through the
    // UL's own overflow-y scroll for recent-tick browsing, and the
    // older history is recoverable via the replay slider.
    const items = [];
    for (let tick = currentTick; tick >= 1 && items.length < 500; tick--) {
      const entries = byTick.get(tick);
      if (entries && entries.length) {
        for (const entry of entries) items.push({ ...entry, tick });
      } else {
        items.push({ kind: 'silent', tick });
      }
    }

    this.els.tradeFeed.innerHTML = items.map(r => {
      if (r.kind === 'trade') {
        const t = r.t;
        const buyer  = v.agents[t.buyerId]?.name  || t.buyerId;
        const seller = v.agents[t.sellerId]?.name || t.sellerId;
        return `<li>
          <span class="t-tick">t${t.timestamp}</span>
          <span class="t-price">$${t.price.toFixed(2)}</span>
          <span class="t-agents">${buyer} ← ${seller}</span>
        </li>`;
      }
      if (r.kind === 'dividend') {
        const where = r.e.round != null
          ? `R${r.e.round}·P${r.e.period}`
          : `Period ${r.e.period}`;
        return `<li class="feed-dividend">
          <span class="t-tick">t${r.e.tick}</span>
          <span class="t-price">DIV $${r.e.value.toFixed(0)}</span>
          <span class="t-agents">${where} · all holders</span>
        </li>`;
      }
      // kind === 'silent' — no trade and no dividend fired at this
      // tick. Rendered as a muted row so the reader can see the gap
      // without mistaking it for activity.
      return `<li class="feed-silent">
        <span class="t-tick">t${r.tick}</span>
        <span class="t-price">—</span>
        <span class="t-agents">no trade</span>
      </li>`;
    }).join('');
  },

  /**
   * Format an x-axis tick label for round-based charts. When a batch
   * session is active (v.session > 0), labels read "R{r}_S{s}" so the
   * round is identifiable across sessions; otherwise just "R{r}".
   */
  _roundLabel(v, config, x) {
    const rounds = config.roundsPerSession || 1;
    const r = Math.min(rounds, Math.floor(x / (config.periods * config.ticksPerPeriod)) + 1);
    if (v.session > 0) return 'R' + r + '_S' + v.session;
    return 'R' + r;
  },

  /**
   * Draw round dividers and highlight the R3→R4 replacement boundary.
   * Used by every chart that spans the full session tick range.
   *
   * Normal round boundaries get a thin solid line in `frame` colour.
   * The R3→R4 boundary (round === 3) gets a thicker dashed red line
   * with a small "R4 swap" label so the replacement step is visible
   * in every chart at a glance.
   *
   * @param {CanvasRenderingContext2D} cx  — chart canvas context
   * @param {object} rect   — plot rectangle {x, y, w, h}
   * @param {object} config — App.config
   * @param {number} xMin
   * @param {number} xMax
   * @param {object} v      — view (v.events carries round_4_replacement)
   */
  _drawRoundDividers(cx, rect, config, xMin, xMax, v) {
    const rounds = config.roundsPerSession || 1;
    if (rounds <= 1) return;
    const ticksPerRnd = config.periods * config.ticksPerPeriod;

    // Check whether a replacement actually fired (the event may not
    // exist yet if the session hasn't reached round 4).
    const hasReplacement = (v.events || []).some(e => e.type === 'round_4_replacement');

    cx.save();
    for (let r = 1; r < rounds; r++) {
      const x = Viz.mapX(rect, r * ticksPerRnd, xMin, xMax);
      if (r === 3 && hasReplacement) {
        // R3→R4 replacement boundary: dashed red line + label.
        cx.strokeStyle = this.theme.red;
        cx.lineWidth   = 1.5;
        cx.setLineDash([5, 3]);
        cx.beginPath();
        cx.moveTo(x + 0.5, rect.y);
        cx.lineTo(x + 0.5, rect.y + rect.h);
        cx.stroke();
        cx.setLineDash([]);
        // Small annotation at the top.
        cx.font      = '9px "Helvetica Neue", Helvetica, Arial, sans-serif';
        cx.fillStyle = this.theme.red;
        cx.textAlign = 'center';
        cx.textBaseline = 'bottom';
        cx.fillText('R4 swap', x, rect.y - 2);
      } else {
        // Normal round boundary.
        cx.strokeStyle = this.theme.frame;
        cx.lineWidth   = 1;
        cx.beginPath();
        cx.moveTo(x + 0.5, rect.y);
        cx.lineTo(x + 0.5, rect.y + rect.h);
        cx.stroke();
      }
    }
    cx.restore();
  },

  /* -------- Price vs FV chart -------- */

  renderPriceChart(v, config) {
    if (!this.charts.price) return;
    const { ctx, width, height } = this.charts.price;
    Viz.clear(ctx, width, height);
    // padL 44: y-tick numerics only. padB 38: tick row + "Period t" label.
    const rect = Viz.plotRect(width, height, 44, 14, 16, 38);

    const rounds         = config.roundsPerSession || 1;
    const sessionPeriods = rounds * config.periods;
    const totalTicks     = sessionPeriods * config.ticksPerPeriod;
    const maxFV          = config.dividendMean * config.periods;
    const priceMax       = Math.max(
      maxFV * 1.3,
      ...v.priceHistory.map(p => p.price || 0),
    );
    const xMin = 0, xMax = totalTicks;
    const yMin = 0, yMax = Math.max(10, priceMax * 1.05);

    // Alternating period bands for visual separation, iterated across
    // every period of every round in the session.
    for (let p = 1; p <= sessionPeriods; p++) {
      if (p % 2 === 0) {
        const x1 = Viz.mapX(rect, (p - 1) * config.ticksPerPeriod, xMin, xMax);
        const x2 = Viz.mapX(rect,  p      * config.ticksPerPeriod, xMin, xMax);
        Viz.verticalBand(ctx, rect, x1, x2, this.theme.band);
      }
    }

    Viz.axes(ctx, rect, {
      xMin, xMax, yMin, yMax,
      xTicks: rounds, yTicks: 5,
      xFmt: x => this._roundLabel(v, config, x),
      yFmt: y => y.toFixed(0),
    });

    this._drawRoundDividers(ctx, rect, config, xMin, xMax, v);

    // Deterministic FV saw-tooth — FV_t = (T − t + 1)·μ_d resets at
    // each round start, so the line climbs back to maxFV at every
    // round boundary and declines to μ_d at every round end.
    const fvPoints = [];
    for (let g = 1; g <= sessionPeriods; g++) {
      const localP = ((g - 1) % config.periods) + 1;
      const fv     = config.dividendMean * (config.periods - localP + 1);
      fvPoints.push({ x: (g - 1) * config.ticksPerPeriod, y: fv });
      fvPoints.push({ x:  g      * config.ticksPerPeriod, y: fv });
    }
    Viz.line(ctx, rect, fvPoints, { xMin, xMax, yMin, yMax, color: this.theme.amber, width: 2, dashed: true });

    // Observed price line P_t. The priceHistory entries at the very
    // start of each round (and any other tick with no trade yet) carry
    // `price = null`, so a straight Viz.line draw would leave visible
    // gaps wherever the book has not yet produced a first trade — most
    // noticeably at the round-end → round-start boundary. We underlay
    // a faint dashed connector through only the non-null points so the
    // gap is visually bridged without claiming a trade occurred there,
    // then overlay the real series with null-aware breaks on top. The
    // bridge is 1px and 33% alpha so it disappears under the 2px solid
    // line wherever trades exist and only shows through in the gap.
    const pricePoints  = v.priceHistory.map(p => ({ x: p.tick, y: p.price }));
    const bridgePoints = pricePoints.filter(p => p.y != null);
    Viz.line(ctx, rect, bridgePoints, { xMin, xMax, yMin, yMax, color: this.theme.accent + '55', width: 1, dashed: true });
    Viz.line(ctx, rect, pricePoints,  { xMin, xMax, yMin, yMax, color: this.theme.accent,        width: 2 });

    // Individual trade prints — one dot per executed trade.
    ctx.save();
    ctx.fillStyle = this.theme.accent;
    for (const t of v.trades) {
      const x = Viz.mapX(rect, t.timestamp, xMin, xMax);
      const y = Viz.mapY(rect, t.price,     yMin, yMax);
      ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    Viz.axisLabel(ctx, rect, v.session > 0 ? 'Round R · Session ' + v.session : 'Round R', 'bottom');

    Viz.legendRow(ctx, rect, [
      { color: this.theme.accent, label: '● observed price' },
      { color: this.theme.amber,  label: '▬ fundamental value' },
    ]);
  },

  /* -------- Bubble magnitude chart -------- */

  renderBubbleChart(v, config) {
    if (!this.charts.bubble) return;
    const { ctx, width, height } = this.charts.bubble;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 44, 14, 16, 38);

    const rounds         = config.roundsPerSession || 1;
    const sessionPeriods = rounds * config.periods;
    const totalTicks     = sessionPeriods * config.ticksPerPeriod;
    const pts = v.priceHistory.map(p => ({
      x: p.tick,
      y: p.price != null ? Math.abs(p.price - p.fv) : null,
    }));
    const ys   = pts.filter(p => p.y != null).map(p => p.y);
    const yMax = Math.max(10, ...(ys.length ? ys : [10])) * 1.1;
    const yMin = 0;

    Viz.axes(ctx, rect, {
      xMin: 0, xMax: totalTicks, yMin, yMax,
      xTicks: rounds, yTicks: 4,
      xFmt: x => this._roundLabel(v, config, x),
      yFmt: y => y.toFixed(0),
    });
    // Absolute mispricing |P_t − FV_t| inherits the same null-aware
    // breaks as Figure 1 (the y is null wherever the underlying price
    // is null), so the stroke drops out at every round boundary until
    // the new round's first trade lands. Underlay a faint dashed
    // connector through the non-null points so the line reads as one
    // series across the whole session without claiming a trade in the
    // gap; the area fill already spans gaps via Viz.area's continue.
    const bridgePts = pts.filter(p => p.y != null);
    Viz.area(ctx, rect, pts,       { xMin: 0, xMax: totalTicks, yMin, yMax, color: this.theme.red + '30' });
    Viz.line(ctx, rect, bridgePts, { xMin: 0, xMax: totalTicks, yMin, yMax, color: this.theme.red + '55', width: 1, dashed: true });
    Viz.line(ctx, rect, pts,       { xMin: 0, xMax: totalTicks, yMin, yMax, color: this.theme.red, width: 2 });

    this._drawRoundDividers(ctx, rect, config, 0, totalTicks, v);

    Viz.axisLabel(ctx, rect, v.session > 0 ? 'Round R · Session ' + v.session : 'Round R', 'bottom');
    Viz.legendRow(ctx, rect, [
      { color: this.theme.red, label: '▬ absolute mispricing' },
    ]);
  },

  /* -------- Volume-per-period chart -------- */

  renderVolumeChart(v, config) {
    if (!this.charts.volume) return;
    const { ctx, width, height } = this.charts.volume;
    Viz.clear(ctx, width, height);
    // padT 28: extra headroom so the legend can sit above the plot frame
    // instead of inside it. The canvas is only 160px tall, so an in-plot
    // legend would overlap the tallest bars (which are usually green on
    // green and unreadable).
    const rect = Viz.plotRect(width, height, 44, 14, 28, 38);

    // Share the totalTicks coordinate frame with the price and bubble
    // charts so all three row-1 figures anchor periods to the same
    // horizontal positions — across every round in the session.
    const rounds         = config.roundsPerSession || 1;
    const sessionPeriods = rounds * config.periods;
    const totalTicks     = sessionPeriods * config.ticksPerPeriod;
    const xMin = 0, xMax = totalTicks;

    const pts = [];
    for (let g = 1; g <= sessionPeriods; g++) {
      pts.push({
        x: (g - 0.5) * config.ticksPerPeriod,
        y: v.volumeByPeriod[g] || 0,
      });
    }
    const yMax = Math.max(4, ...pts.map(p => p.y)) * 1.1;

    // Alternating period bands — same pattern used by renderPriceChart.
    for (let g = 1; g <= sessionPeriods; g++) {
      if (g % 2 === 0) {
        const x1 = Viz.mapX(rect, (g - 1) * config.ticksPerPeriod, xMin, xMax);
        const x2 = Viz.mapX(rect,  g      * config.ticksPerPeriod, xMin, xMax);
        Viz.verticalBand(ctx, rect, x1, x2, this.theme.band);
      }
    }

    Viz.axes(ctx, rect, {
      xMin, xMax, yMin: 0, yMax,
      xTicks: rounds, yTicks: 4,
      xFmt: x => this._roundLabel(v, config, x),
      yFmt: y => y.toFixed(0),
    });

    const barW = (rect.w / sessionPeriods) * 0.55;
    Viz.bars(ctx, rect, pts, {
      xMin, xMax, yMin: 0, yMax,
      color: this.theme.green,
      barWidth: barW,
    });

    this._drawRoundDividers(ctx, rect, config, xMin, xMax, v);

    Viz.axisLabel(ctx, rect, v.session > 0 ? 'Round R · Session ' + v.session : 'Round R', 'bottom');
    Viz.legendRow(ctx, rect, [
      { color: this.theme.green, label: '▮ shares traded' },
    ], { padY: -10 });
  },

  /* -------- Price × period trade-density heatmap -------- */

  renderHeatmapChart(v, config) {
    if (!this.charts.heatmap) return;
    const { ctx, width, height } = this.charts.heatmap;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 44, 14, 16, 38);

    const rounds         = config.roundsPerSession || 1;
    const sessionPeriods = rounds * config.periods;
    const maxFV    = config.dividendMean * config.periods;
    const maxPrice = Math.max(maxFV * 1.4, ...v.trades.map(t => t.price || 0));
    const nCols    = sessionPeriods;
    const nRows    = 10;
    const grid     = Array.from({ length: nRows }, () => new Array(nCols).fill(0));
    let maxCount   = 0;
    for (const t of v.trades) {
      const tRound = t.round || 1;
      const g      = (tRound - 1) * config.periods + t.period;
      const col    = Math.min(nCols - 1, Math.max(0, g - 1));
      const row    = Math.min(nRows - 1, Math.floor((t.price / maxPrice) * nRows));
      grid[row][col] += t.quantity;
      if (grid[row][col] > maxCount) maxCount = grid[row][col];
    }

    const cellW = rect.w / nCols;
    const cellH = rect.h / nRows;

    if (maxCount > 0) {
      for (let r = 0; r < nRows; r++) {
        for (let c = 0; c < nCols; c++) {
          const count = grid[r][c];
          if (count <= 0) continue;
          ctx.fillStyle = Viz.heatColor(count / maxCount);
          const x = rect.x + c * cellW;
          const y = rect.y + (nRows - 1 - r) * cellH;
          ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
        }
      }
    }
    ctx.strokeStyle = this.theme.frame;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);

    // Round dividers within the period-indexed grid. The R3→R4
    // boundary gets the same replacement marker as tick-based charts.
    const hasReplacement = (v.events || []).some(e => e.type === 'round_4_replacement');
    if (rounds > 1) {
      ctx.save();
      for (let r = 1; r < rounds; r++) {
        const x = rect.x + r * config.periods * cellW;
        if (r === 3 && hasReplacement) {
          ctx.strokeStyle = this.theme.red;
          ctx.lineWidth   = 1.5;
          ctx.setLineDash([5, 3]);
          ctx.beginPath(); ctx.moveTo(x + 0.5, rect.y); ctx.lineTo(x + 0.5, rect.y + rect.h); ctx.stroke();
          ctx.setLineDash([]);
          ctx.font      = '9px "Helvetica Neue", Helvetica, Arial, sans-serif';
          ctx.fillStyle = this.theme.red;
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillText('R4 swap', x, rect.y - 2);
        } else {
          ctx.strokeStyle = this.theme.frame;
          ctx.lineWidth   = 1;
          ctx.beginPath(); ctx.moveTo(x + 0.5, rect.y); ctx.lineTo(x + 0.5, rect.y + rect.h); ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Price axis labels (left)
    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.fillStyle = this.theme.fg3;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let r = 0; r <= nRows; r += 2) {
      const val = (r / nRows) * maxPrice;
      const y   = rect.y + (nRows - r) * cellH;
      ctx.fillText(val.toFixed(0), rect.x - 5, y);
    }
    // Round labels (bottom) — one label per round, centred above that
    // round's block of period columns.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let r = 1; r <= rounds; r++) {
      const mid = (r - 0.5) * config.periods;
      const x   = rect.x + mid * cellW;
      ctx.fillText(this._roundLabel(v, config, (r - 0.5) * config.periods * config.ticksPerPeriod), x, rect.y + rect.h + 6);
    }
    ctx.restore();

    Viz.axisLabel(ctx, rect, v.session > 0 ? 'Round R · Session ' + v.session : 'Round R', 'bottom');
  },

  /* -------- Agent action timeline -------- */

  renderTimelineChart(v, config) {
    if (!this.charts.timeline) return;
    const { ctx, width, height } = this.charts.timeline;
    Viz.clear(ctx, width, height);
    // padL 66: wide enough for the longest agent name (e.g. "Quinn").
    const rect = Viz.plotRect(width, height, 66, 14, 16, 38);

    const rounds         = config.roundsPerSession || 1;
    const sessionPeriods = rounds * config.periods;
    const totalTicks     = sessionPeriods * config.ticksPerPeriod;
    const ids            = Object.keys(v.agents).map(Number).sort((a, b) => a - b);
    const nA             = Math.max(1, ids.length);
    const rowH           = rect.h / nA;

    // Row backgrounds + names.
    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'right';
    for (let i = 0; i < nA; i++) {
      const y = rect.y + i * rowH;
      if (i % 2 === 0) {
        ctx.fillStyle = this.theme.stripe;
        ctx.fillRect(rect.x, y, rect.w, rowH);
      }
      ctx.fillStyle = this.agentColor(ids[i]);
      ctx.fillText(v.agents[ids[i]]?.name || ('A' + ids[i]), rect.x - 6, y + rowH / 2);
    }
    ctx.strokeStyle = this.theme.frame;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);
    ctx.restore();

    // Period separators across every round in the session, then heavier
    // round dividers on top so the eye can pick out round boundaries.
    ctx.save();
    ctx.strokeStyle = this.theme.grid;
    for (let g = 1; g < sessionPeriods; g++) {
      const x = Viz.mapX(rect, g * config.ticksPerPeriod, 0, totalTicks);
      ctx.beginPath();
      ctx.moveTo(x, rect.y);
      ctx.lineTo(x, rect.y + rect.h);
      ctx.stroke();
    }
    ctx.restore();
    this._drawRoundDividers(ctx, rect, config, 0, totalTicks, v);

    // One rect per agent decision, colored by action type.
    const colors = { bid: this.theme.green, ask: this.theme.red, hold: this.theme.fg3 };
    const mW     = Math.max(1.6, (rect.w / totalTicks) * 0.85);

    for (const tr of v.traces) {
      const rowIdx = ids.indexOf(tr.agentId);
      if (rowIdx < 0) continue;
      const x = Viz.mapX(rect, tr.timestamp, 0, totalTicks);
      const y = rect.y + rowIdx * rowH + rowH * 0.28;
      const h = rowH * 0.44;
      ctx.fillStyle = colors[tr.decision.type] || this.theme.fg3;
      ctx.fillRect(x - mW / 2, y, mW, h);
      if (tr.filled > 0) {
        ctx.fillStyle = this.theme.accent;
        ctx.beginPath();
        ctx.arc(x, y + h + 3, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // X labels — one R label per round, centred under that round's
    // block of ticks. Period-level labels would crowd a 4-round
    // session so we elide them.
    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.fillStyle = this.theme.fg3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let r = 1; r <= rounds; r++) {
      const mid = (r - 0.5) * config.periods * config.ticksPerPeriod;
      const x   = Viz.mapX(rect, mid, 0, totalTicks);
      ctx.fillText(this._roundLabel(v, config, mid), x, rect.y + rect.h + 6);
    }
    ctx.restore();

    Viz.axisLabel(ctx, rect, v.session > 0 ? 'Round R · Session ' + v.session : 'Round R', 'bottom');
  },

  /* ============================================================
     Extended panels (utility experiment mode).
     Each panel is a no-op when its canvas is missing/hidden or
     when the required data array is empty — legacy populations
     render nothing from these methods.
     ============================================================ */

  /* -------- Valuation chart: true vs reported over time -------- */
  renderValuationChart(v, config) {
    const chart = this.charts.valuation;
    if (!chart) return;
    const { ctx, width, height } = chart;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 44, 14, 16, 38);

    const totalTicks = (config.roundsPerSession || 1) * config.periods * config.ticksPerPeriod;
    const hist       = v.valuationHistory || [];
    const byAgent    = {};
    for (const row of hist) {
      if (!byAgent[row.agentId]) byAgent[row.agentId] = [];
      byAgent[row.agentId].push({ x: row.tick, y: row.subjV });
    }

    let yMax = config.dividendMean * config.periods * 1.4;
    for (const row of hist) {
      if (row.subjV != null && row.subjV > yMax) yMax = row.subjV;
    }
    if (v.messages && v.messages.length) {
      for (const m of v.messages) {
        if (m.claimedValuation > yMax) yMax = m.claimedValuation;
      }
    }
    yMax = Math.max(10, yMax * 1.08);

    Viz.axes(ctx, rect, {
      xMin: 0, xMax: totalTicks, yMin: 0, yMax,
      xTicks: config.roundsPerSession || 1, yTicks: 4,
      xFmt: x => this._roundLabel(v, config, x),
      yFmt: y => y.toFixed(0),
    });

    // Dashed FV reference saw-tooth — resets to maxFV at every round
    // boundary so the line mirrors the price chart's saw-tooth across
    // the full session.
    const sessionPeriodsVal = (config.roundsPerSession || 1) * config.periods;
    const fvPoints = [];
    for (let g = 1; g <= sessionPeriodsVal; g++) {
      const localP = ((g - 1) % config.periods) + 1;
      const fv     = config.dividendMean * (config.periods - localP + 1);
      fvPoints.push({ x: (g - 1) * config.ticksPerPeriod, y: fv });
      fvPoints.push({ x:  g      * config.ticksPerPeriod, y: fv });
    }
    Viz.line(ctx, rect, fvPoints, { xMin: 0, xMax: totalTicks, yMin: 0, yMax, color: this.theme.amber, width: 2, dashed: true });

    this._drawRoundDividers(ctx, rect, config, 0, totalTicks, v);

    // One subjective-valuation line per agent.
    const ids = Object.keys(byAgent).map(Number).sort((a, b) => a - b);
    for (const id of ids) {
      Viz.line(ctx, rect, byAgent[id], { xMin: 0, xMax: totalTicks, yMin: 0, yMax, color: this.agentColor(id), width: 1.6 });
    }

    // Reported-valuation markers. Deceptive messages are ringed red
    // and connected to the sender's true valuation by a dotted line,
    // so you can see the "lie gap" directly.
    const msgs = v.messages || [];
    if (msgs.length) {
      ctx.save();
      for (const m of msgs) {
        const x     = Viz.mapX(rect, m.tick, 0, totalTicks);
        const yRep  = Viz.mapY(rect, m.claimedValuation, 0, yMax);
        ctx.fillStyle = this.agentColor(m.senderId);
        ctx.beginPath(); ctx.arc(x, yRep, 3, 0, Math.PI * 2); ctx.fill();
        if (m.deceptive) {
          const yTrue = Viz.mapY(rect, m.trueValuation, 0, yMax);
          ctx.strokeStyle = this.theme.red;
          ctx.setLineDash([2, 2]);
          ctx.beginPath(); ctx.moveTo(x, yRep); ctx.lineTo(x, yTrue); ctx.stroke();
          ctx.setLineDash([]);
          ctx.strokeStyle = this.theme.red;
          ctx.beginPath(); ctx.arc(x, yRep, 5, 0, Math.PI * 2); ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Legend row. Each entry's horizontal advance is measured from the
    // rendered text so longer agent names can't overlap the next label.
    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    const gap = 12;
    const y   = rect.y + 12;
    let legendX = rect.x + 10;
    const drawEntry = (label, color) => {
      ctx.fillStyle = color;
      ctx.fillText(label, legendX, y);
      legendX += ctx.measureText(label).width + gap;
    };
    drawEntry('▬ FVₜ', this.theme.amber);
    drawEntry('▬ V̂ᵢ,ₜ', this.theme.fg2);
    for (const id of ids) {
      const name = v.agents[id] ? v.agents[id].name : 'U' + id;
      drawEntry('● ' + name, this.agentColor(id));
    }
    drawEntry('○ Ṽ ≠ V̂  (lie gap)', this.theme.red);
    ctx.restore();

    Viz.axisLabel(ctx, rect, v.session > 0 ? 'Round R · Session ' + v.session : 'Round R', 'bottom');
  },

  /* -------- Utility-over-time chart -------- */
  renderUtilityChart(v, config) {
    const chart = this.charts.utility;
    if (!chart) return;
    const { ctx, width, height } = chart;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 44, 14, 16, 38);

    const totalTicks = (config.roundsPerSession || 1) * config.periods * config.ticksPerPeriod;
    const hist       = v.utilityHistory || [];
    const byAgent    = {};
    for (const row of hist) {
      if (!byAgent[row.agentId]) byAgent[row.agentId] = [];
      byAgent[row.agentId].push({ x: row.tick, y: row.utility });
    }

    let yMin = 0.7, yMax = 1.3;
    for (const row of hist) {
      if (row.utility != null) {
        if (row.utility < yMin) yMin = row.utility;
        if (row.utility > yMax) yMax = row.utility;
      }
    }
    const span = Math.max(0.2, yMax - yMin);
    yMin = Math.max(0, yMin - span * 0.1);
    yMax = yMax + span * 0.1;

    Viz.axes(ctx, rect, {
      xMin: 0, xMax: totalTicks, yMin, yMax,
      xTicks: config.roundsPerSession || 1, yTicks: 4,
      xFmt: x => this._roundLabel(v, config, x),
      yFmt: y => y.toFixed(2),
    });

    // Baseline at U = 1.0 (each agent's initial utility).
    const baseY = Viz.mapY(rect, 1, yMin, yMax);
    ctx.save();
    ctx.strokeStyle = this.theme.fg3;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(rect.x, baseY); ctx.lineTo(rect.x + rect.w, baseY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    this._drawRoundDividers(ctx, rect, config, 0, totalTicks, v);

    const ids = Object.keys(byAgent).map(Number).sort((a, b) => a - b);
    for (const id of ids) {
      Viz.line(ctx, rect, byAgent[id], { xMin: 0, xMax: totalTicks, yMin, yMax, color: this.agentColor(id), width: 1.6 });
    }

    Viz.axisLabel(ctx, rect, v.session > 0 ? 'Round R · Session ' + v.session : 'Round R', 'bottom');
  },

  /* -------- Messages timeline -------- */
  renderMessagesChart(v, config) {
    const chart = this.charts.messages;
    if (!chart) return;
    const { ctx, width, height } = chart;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 66, 14, 16, 38);

    const rounds         = config.roundsPerSession || 1;
    const sessionPeriods = rounds * config.periods;
    const totalTicks     = sessionPeriods * config.ticksPerPeriod;
    const ids            = Object.keys(v.agents).map(Number).sort((a, b) => a - b);
    const nA             = Math.max(1, ids.length);
    const rowH           = rect.h / nA;

    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'right';
    for (let i = 0; i < nA; i++) {
      const y = rect.y + i * rowH;
      if (i % 2 === 0) {
        ctx.fillStyle = this.theme.stripe;
        ctx.fillRect(rect.x, y, rect.w, rowH);
      }
      ctx.fillStyle = this.agentColor(ids[i]);
      const name = v.agents[ids[i]] ? v.agents[ids[i]].name : 'U' + ids[i];
      ctx.fillText(name, rect.x - 6, y + rowH / 2);
    }
    ctx.strokeStyle = this.theme.frame;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);
    ctx.restore();

    // Period separators across the whole session, with heavier round
    // dividers laid on top.
    ctx.save();
    ctx.strokeStyle = this.theme.grid;
    for (let g = 1; g < sessionPeriods; g++) {
      const x = Viz.mapX(rect, g * config.ticksPerPeriod, 0, totalTicks);
      ctx.beginPath(); ctx.moveTo(x, rect.y); ctx.lineTo(x, rect.y + rect.h); ctx.stroke();
    }
    ctx.restore();
    this._drawRoundDividers(ctx, rect, config, 0, totalTicks, v);

    // Messages: one dot per broadcast, colored by signal, ringed red if deceptive.
    const msgs = v.messages || [];
    for (const m of msgs) {
      const rowIdx = ids.indexOf(m.senderId);
      if (rowIdx < 0) continue;
      const x = Viz.mapX(rect, m.tick, 0, totalTicks);
      const y = rect.y + rowIdx * rowH + rowH / 2;
      const sigColor = m.signal === 'buy' ? this.theme.green
                     : m.signal === 'sell' ? this.theme.red
                     : this.theme.fg2;
      ctx.fillStyle = sigColor;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      if (m.deceptive) {
        ctx.strokeStyle = this.theme.red;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // X labels — one R label per round.
    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.fillStyle = this.theme.fg3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let r = 1; r <= rounds; r++) {
      const mid = (r - 0.5) * config.periods * config.ticksPerPeriod;
      const x   = Viz.mapX(rect, mid, 0, totalTicks);
      ctx.fillText(this._roundLabel(v, config, mid), x, rect.y + rect.h + 6);
    }
    ctx.restore();

    Viz.axisLabel(ctx, rect, v.session > 0 ? 'Round R · Session ' + v.session : 'Round R', 'bottom');
  },

  /* -------- Trust matrix heatmap -------- */
  renderTrustChart(v, config) {
    const chart = this.charts.trust;
    if (!chart) return;
    const { ctx, width, height } = chart;
    Viz.clear(ctx, width, height);
    const rect = Viz.plotRect(width, height, 66, 12, 14, 44);

    const agentIds = Object.keys(v.agents).map(Number).sort((a, b) => a - b);
    const n = agentIds.length;
    if (!n) return;

    const cellW = rect.w / n;
    const cellH = rect.h / n;
    const trust = v.trust || null;

    for (let i = 0; i < n; i++) {          // i = receiver (row)
      for (let j = 0; j < n; j++) {        // j = sender   (col)
        const r = agentIds[i];
        const s = agentIds[j];
        const val = trust && trust[r] && trust[r][s] != null ? trust[r][s] : 0.5;
        const x = rect.x + j * cellW;
        const y = rect.y + i * cellH;
        if (r === s) {
          ctx.fillStyle = this.theme.stripe;
          ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
        } else {
          ctx.fillStyle = Viz.heatColor(val);
          ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
          if (cellW > 24 && cellH > 18) {
            ctx.fillStyle = this.theme.fg0;
            ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(val.toFixed(2), x + cellW / 2, y + cellH / 2);
          }
        }
      }
    }
    ctx.strokeStyle = this.theme.frame;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);

    // Axis labels.
    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.fillStyle = this.theme.fg3;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      const name = v.agents[agentIds[i]] ? v.agents[agentIds[i]].name : 'U' + agentIds[i];
      ctx.fillText(name, rect.x - 4, rect.y + i * cellH + cellH / 2);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let j = 0; j < n; j++) {
      const name = v.agents[agentIds[j]] ? v.agents[agentIds[j]].name : 'U' + agentIds[j];
      ctx.fillText(name, rect.x + j * cellW + cellW / 2, rect.y + rect.h + 6);
    }
    ctx.restore();

    Viz.axisLabel(ctx, rect, 'sender', 'bottom');
  },

  /* -------- Ownership over time (stacked) -------- */
  renderOwnershipChart(v, config) {
    const chart = this.charts.ownership;
    if (!chart) return;
    const { ctx, width, height } = chart;
    Viz.clear(ctx, width, height);
    // padT 28 leaves room for the in-plot legend row above the chart.
    const rect = Viz.plotRect(width, height, 44, 14, 28, 38);

    const rounds      = config.roundsPerSession || 1;
    const ticksPerRnd = config.periods * config.ticksPerPeriod;
    const totalTicks  = rounds * ticksPerRnd;
    const ids         = Object.keys(v.agents).map(Number).sort((a, b) => a - b);
    const n           = ids.length;
    if (!n) return;

    // Per-agent initial inventory comes from the spec captured at draw
    // time (sampleAgents pulls from {2,3,4}); fall back to 3 only if
    // the view doesn't carry the field for legacy snapshots.
    const initialInv = {};
    let totalShares  = 0;
    for (const id of ids) {
      const inv = v.agents[id] && v.agents[id].initialInventory != null
        ? v.agents[id].initialInventory
        : 3;
      initialInv[id] = inv;
      totalShares   += inv;
    }
    const yMax = Math.max(totalShares, totalShares + 2);

    Viz.axes(ctx, rect, {
      xMin: 0, xMax: totalTicks, yMin: 0, yMax,
      xTicks: rounds, yTicks: 4,
      xFmt: x => this._roundLabel(v, config, x),
      yFmt: y => y.toFixed(0),
    });

    // Build inv[tick][id] by walking through trades in order. At every
    // round boundary the engine rewinds each agent's inventory back to
    // the spec value, so the replay walk has to mirror that — without
    // this reset, rounds 2-4 would inherit drifted balances and the
    // stacked area would no longer sum to totalShares.
    const invByTick = new Array(totalTicks + 1);
    const start     = {};
    for (const id of ids) start[id] = initialInv[id];
    invByTick[0] = start;
    let tIdx = 0;
    const sortedTrades = v.trades;
    for (let tick = 1; tick <= totalTicks; tick++) {
      const cur  = {};
      const prev = invByTick[tick - 1];
      // Round-boundary reset: ticks at the end of period T of a non-final
      // round restart every agent's inventory before the next tick's
      // trades land.
      const isRoundBoundary =
        rounds > 1 &&
        tick % ticksPerRnd === 1 &&
        tick > 1;
      if (isRoundBoundary) {
        for (const id of ids) cur[id] = initialInv[id];
      } else {
        for (const id of ids) cur[id] = prev[id];
      }
      while (tIdx < sortedTrades.length && sortedTrades[tIdx].timestamp <= tick) {
        const t = sortedTrades[tIdx];
        if (cur[t.buyerId]  != null) cur[t.buyerId]  += t.quantity;
        if (cur[t.sellerId] != null) cur[t.sellerId] -= t.quantity;
        tIdx++;
      }
      invByTick[tick] = cur;
    }

    const series = ids.map(id => ({
      color: this.agentColor(id),
      name:  v.agents[id] ? v.agents[id].name : 'U' + id,
      points: invByTick.map((m, tick) => ({ x: tick, y: Math.max(0, m[id] || 0) })),
    }));
    Viz.stackedArea(ctx, rect, series, { xMin: 0, xMax: totalTicks, yMin: 0, yMax });
    this._drawRoundDividers(ctx, rect, config, 0, totalTicks, v);

    // Inline legend above the plot. Per-entry advance is measured
    // from the rendered name so long names can't overlap.
    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    const swatch = 10;
    const gap    = 14;
    let legendX = rect.x + 4;
    for (const s of series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(legendX, rect.y - 16, swatch, swatch);
      ctx.fillStyle = this.theme.fg0;
      ctx.fillText(s.name, legendX + swatch + 3, rect.y - 10);
      legendX += swatch + 3 + ctx.measureText(s.name).width + gap;
    }
    ctx.restore();

    Viz.axisLabel(ctx, rect, v.session > 0 ? 'Round R · Session ' + v.session : 'Round R', 'bottom');
  },

  /* -------- Extended metrics panel -------- */
  renderMetrics(v, config) {
    const el = this.els.metricsBody;
    if (!el) return;

    const hasExtended = (v.valuationHistory && v.valuationHistory.length) ||
                        (v.utilityHistory && v.utilityHistory.length);
    if (!hasExtended) {
      el.innerHTML = '<div class="muted">Select the Utility population to see extended metrics.</div>';
      return;
    }

    // ---- Dufwenberg, Lindqvist & Moore (2005) market-quality statistics.
    // All of these operate on the per-period mean trade price P̄_t and the
    // deterministic fundamental value FV_t = (T − t + 1)·μ_d. With the
    // multi-round session wrapper a "period" key needs to be (round,
    // period) so a round-2 period-5 trade isn't lumped with a round-1
    // period-5 trade. We index every aggregator by the global period
    // g = (round−1)·T + period and compute FV from the local period.
    const rounds = config.roundsPerSession || 1;
    const sumByG = {}, cntByG = {};
    for (const t of v.trades) {
      const tRound = t.round || 1;
      const g      = (tRound - 1) * config.periods + t.period;
      sumByG[g] = (sumByG[g] || 0) + t.price;
      cntByG[g] = (cntByG[g] || 0) + 1;
    }
    const sessionPeriodsM = rounds * config.periods;
    const meanP = new Array(sessionPeriodsM + 1).fill(null);
    for (let g = 1; g <= sessionPeriodsM; g++) {
      if (cntByG[g]) meanP[g] = sumByG[g] / cntByG[g];
    }
    const localPeriodOf = g => ((g - 1) % config.periods) + 1;
    const fvOfG = g => config.dividendMean * (config.periods - localPeriodOf(g) + 1);
    // Per-trade FV uses the trade's own period within its own round; the
    // round dimension cancels because FV is round-invariant.
    const fvOfTrade = t => config.dividendMean * (config.periods - t.period + 1);

    // Total shares outstanding (conserved under double-auction trades).
    let totalShares = 0;
    for (const a of Object.values(v.agents)) totalShares += (a.inventory || 0);

    // Haessel (1978) R²: 1 − Σ(P̄_g − FV_g)² / Σ(P̄_g − mean P̄)². Uses only
    // periods that had trades. Can be negative if the fit is worse than
    // predicting the sample mean of P̄.
    let haessel = null;
    {
      const obs = [];
      for (let g = 1; g <= sessionPeriodsM; g++) {
        if (meanP[g] != null) obs.push({ y: meanP[g], x: fvOfG(g) });
      }
      if (obs.length >= 2) {
        const ybar = obs.reduce((s, c) => s + c.y, 0) / obs.length;
        let ssRes = 0, ssTot = 0;
        for (const o of obs) {
          ssRes += (o.y - o.x) ** 2;
          ssTot += (o.y - ybar) ** 2;
        }
        if (ssTot > 0) haessel = 1 - ssRes / ssTot;
      }
    }

    // Normalized absolute price deviation:
    // Σ_trades |P_trade − FV_period| · q / total shares outstanding.
    let normAbsDev = null;
    if (totalShares > 0 && v.trades.length) {
      let s = 0;
      for (const t of v.trades) s += Math.abs(t.price - fvOfTrade(t)) * t.quantity;
      normAbsDev = s / totalShares;
    }

    // Normalized average price deviation:
    // Σ_periods |P̄_t − FV_t| / total shares outstanding, summed over
    // every period of every round in the session.
    let normAvgDev = null;
    if (totalShares > 0) {
      let s = 0;
      for (let g = 1; g <= sessionPeriodsM; g++) {
        if (meanP[g] != null) s += Math.abs(meanP[g] - fvOfG(g));
      }
      normAvgDev = s / totalShares;
    }

    // Price amplitude: (max (P̄_g − FV_g) − min (P̄_g − FV_g)) / FV_1.
    // Pooled across all rounds — DLM 2005 reports per-round amplitudes
    // as well, but the dashboard surface is one number per session.
    let amplitude = null;
    {
      const diffs = [];
      for (let g = 1; g <= sessionPeriodsM; g++) {
        if (meanP[g] != null) diffs.push(meanP[g] - fvOfG(g));
      }
      const fv1 = config.dividendMean * config.periods;
      if (diffs.length && fv1 > 0) amplitude = (Math.max(...diffs) - Math.min(...diffs)) / fv1;
    }

    // Turnover: Σ q_traded / total shares outstanding. Standard SSW
    // measure of churn — 1.0 means every share changed hands once.
    let turnover = null;
    if (totalShares > 0) {
      let sharesTraded = 0;
      for (const t of v.trades) sharesTraded += t.quantity;
      turnover = sharesTraded / totalShares;
    }

    // Lopez-Lira (2025) price-to-fundamental ratio ρ = P / FV.
    let rho = null;
    if (v.lastPrice != null && v.priceHistory.length) {
      const lastFV = v.priceHistory[v.priceHistory.length - 1].fv;
      if (lastFV > 0) rho = v.lastPrice / lastFV;
    }

    // ---- Extended (Utility-mode) aggregates.
    const latestV = {};
    for (const row of v.valuationHistory) latestV[row.agentId] = row.subjV;
    const Vlist = Object.entries(latestV).map(([id, vv]) => ({ id: Number(id), vv }));
    const avgV  = Vlist.length ? Vlist.reduce((s, c) => s + c.vv, 0) / Vlist.length : null;

    let efficiency = null;
    if (Vlist.length) {
      let maxVV = -Infinity;
      for (const c of Vlist) if (c.vv > maxVV) maxVV = c.vv;
      let actual = 0;
      for (const c of Vlist) {
        const agent = v.agents[c.id];
        if (agent) actual += c.vv * (agent.inventory || 0);
      }
      const optimal = maxVV * totalShares;
      efficiency = optimal > 0 ? actual / optimal : 0;
    }

    let totalWelfare = null;
    const latestU = {};
    for (const row of v.utilityHistory) latestU[row.agentId] = row.utility;
    const uvals = Object.values(latestU);
    if (uvals.length) totalWelfare = uvals.reduce((s, x) => s + x, 0);

    const pDev = (v.lastPrice != null && avgV != null) ? Math.abs(v.lastPrice - avgV) : null;

    // ---- AIPE psychological allocation outcome.
    // Research question: does the asset ultimately end up in the hands
    // of the agent with the highest psychological valuation? Identifies
    // the top-holder (agent with the most shares) and the agent with
    // the maximum subjective V̂, compares their ids, and reports a
    // normalized gap = (max V̂ − top-holder V̂) / max V̂ so a zero means
    // the asset is already with the right hands.
    let psychTopHolderId = null;
    let psychTopHolderV  = null;
    let psychMaxVid      = null;
    let psychMaxV        = null;
    let psychGap         = null;
    let psychMatch       = null;
    if (Vlist.length) {
      let maxInv = -Infinity;
      for (const c of Vlist) {
        const agent = v.agents[c.id];
        if (!agent) continue;
        if ((agent.inventory || 0) > maxInv) {
          maxInv = agent.inventory || 0;
          psychTopHolderId = c.id;
          psychTopHolderV  = c.vv;
        }
      }
      let maxV = -Infinity;
      for (const c of Vlist) {
        if (c.vv > maxV) { maxV = c.vv; psychMaxVid = c.id; psychMaxV = c.vv; }
      }
      if (psychTopHolderV != null && psychMaxV != null && psychMaxV > 0) {
        psychGap   = (psychMaxV - psychTopHolderV) / psychMaxV;
        psychMatch = psychTopHolderId === psychMaxVid;
      }
    }

    let deceptionMag = null;
    let nDeceptive = 0;
    const msgs = v.messages || [];
    if (msgs.length) {
      let total = 0;
      for (const m of msgs) {
        total += Math.abs(m.claimedValuation - m.trueValuation);
        if (m.deceptive) nDeceptive++;
      }
      deceptionMag = total / msgs.length;
    }

    const fmt = (x, d = 2) => x == null ? '—' : x.toFixed(d);
    const sym = window.Sym || {};
    const row = (name, formula, val) =>
      `<tr><td class="batch-metric-name">${name}${formula ? '<em>' + formula + '</em>' : ''}</td><td>${val}</td></tr>`;
    const grp = label =>
      `<tr class="batch-group-label"><td colspan="2">${label}</td></tr>`;

    el.innerHTML = `<table class="batch-table"><tbody>
      ${grp('Market quality &middot; Dufwenberg, Lindqvist &amp; Moore (2005)')}
      ${row('Haessel R&sup2;', '1 &minus; &Sigma;(P&#772;&minus;FV)&sup2; / &Sigma;(P&#772;&minus;P&#772;&#772;)&sup2;', fmt(haessel, 3))}
      ${row('Norm. absolute price deviation', '&Sigma;|P&minus;FV|&middot;q / Q', fmt(normAbsDev, 2))}
      ${row('Norm. average price deviation', sym.normAvgDev || '', fmt(normAvgDev, 2))}
      ${row('Price amplitude', '(max&minus;min)(P&#772;&minus;FV) / FV&#8321;', fmt(amplitude, 3))}
      ${row('Turnover', '&Sigma; q / Q', fmt(turnover, 3))}
      ${row('P / FV ratio', (sym.rhoT || '') + ' (Lopez-Lira 2025)', fmt(rho, 3))}

      ${grp('Utility-agent welfare &amp; deception')}
      ${row('Avg subjective V&#770;', sym.avgVbar || '', fmt(avgV))}
      ${row('Allocative efficiency', sym.efficiencyEq || '', fmt(efficiency, 3))}
      ${row('Total welfare', sym.totalWelfareEq || '', fmt(totalWelfare, 3))}
      ${row('|P &minus; &langle;V&#770;&rangle;|', '', fmt(pDev))}
      ${row('Mean lie magnitude', '&langle;' + (sym.lieGap || '') + '&rangle;', fmt(deceptionMag))}
      ${row('Deceptive / total msgs', '', nDeceptive + ' / ' + msgs.length)}

      ${grp('Psychological allocation &middot; AIPE')}
      ${row('Top holder vs highest V&#770;', '', '<span class="' + (psychMatch === true ? 'ok' : psychMatch === false ? 'bad' : '') + '">' + (psychMatch == null ? '—' : psychMatch ? 'match' : 'miss') + '</span>')}
      ${row('Top-holder id &middot; V&#770;', '', psychTopHolderId == null ? '—' : 'A' + psychTopHolderId + ' &middot; ' + fmt(psychTopHolderV))}
      ${row('Max-V&#770; id &middot; V&#770;*', '', psychMaxVid == null ? '—' : 'A' + psychMaxVid + ' &middot; ' + fmt(psychMaxV))}
      ${row('Valuation gap', '(V&#770;* &minus; V&#770;&#8341;) / V&#770;*', fmt(psychGap, 3))}
    </tbody></table>`;
  },

  /* -------- Trace inspector -------- */

  renderTraces(v) {
    const tick   = v.tick;
    const traces = v.traces.filter(t => t.timestamp === tick);
    if (!traces.length) {
      this.els.traceBody.innerHTML =
        `<div class="muted">No decisions recorded at tick ${tick}.</div>`;
      return;
    }
    this.els.traceBody.innerHTML = traces.map(t => {
      const d         = t.decision;
      const r         = t.reasoning;
      const kind      = d.type;
      const valStr    = r.estimatedValue != null ? r.estimatedValue.toFixed(2) : '—';
      const profitStr = r.expectedProfit != null ? r.expectedProfit.toFixed(2) : '—';
      const priceStr  = d.price          != null ? d.price.toFixed(2)          : '—';
      const qtyStr    = d.quantity       != null ? d.quantity                  : '—';
      const agentName = t.agentName || ('A' + t.agentId);
      const kindLabel = kind === 'hold'
        ? 'hold'
        : `${kind} ${qtyStr} @ ${priceStr}${t.filled ? ' ✓' : ''}`;

      // Extended: expected-utility candidate table.
      const u = r.utility;
      const uBlock = u ? `
          <div class="trace-row">subj V <strong>${u.subjectiveValue != null ? u.subjectiveValue.toFixed(2) : '—'}</strong> <span class="muted">(true ${u.trueValuation != null ? u.trueValuation.toFixed(2) : '—'})</span></div>
          <div class="trace-row">w₀ <strong>${u.wealth0 != null ? u.wealth0.toFixed(0) : '—'}</strong> · U₀ <strong>${u.U0 != null ? u.U0.toFixed(3) : '—'}</strong> <span class="muted">(${u.riskPref})</span></div>
          <div class="trace-eu">
            ${(u.candidates || []).map(c => `
              <div class="eu-row${c.label === u.chosen ? ' chosen' : ''}">
                <span class="eu-lbl">${c.label}</span>
                <span class="eu-val">${c.eu.toFixed(4)}</span>
              </div>`).join('')}
          </div>` : '';

      // Prior adjustment flags.
      const priorFlags = [];
      if (r.biasActive)  priorFlags.push(`bias:${r.biasMode || '—'}(${r.biasAmount != null ? r.biasAmount.toFixed(2) : '—'})`);
      if (r.noiseActive) priorFlags.push('noise');
      const priorBlock = priorFlags.length
        ? `<div class="trace-row muted">prior adj: ${priorFlags.join(' + ')}</div>`
        : '';

      // LLM reasoning (Plan II/III direct action).
      const llmBlock = r.llmReason
        ? `<div class="trace-row muted llm-reason">LLM: ${UI._escHtml(r.llmReason)}</div>`
        : '';

      // Extended: messages heard this period.
      const msgBlock = (r.receivedMsgs && r.receivedMsgs.length)
        ? `<div class="trace-row muted">heard ${r.receivedMsgs.map(m => `${m.from}:${m.claim.toFixed(0)}(${m.sig})`).join(', ')}</div>`
        : '';

      return `
        <div class="trace-card">
          <div class="trace-head">
            <span>${agentName} <span class="muted">· ${t.agentType}</span></span>
            <span class="trace-kind ${kind}">${kindLabel}</span>
          </div>
          <div class="trace-row">rule <strong>${r.ruleUsed}</strong></div>
          <div class="trace-row">trigger <strong>${r.triggerCondition || '—'}</strong></div>
          <div class="trace-row">est value <strong>${valStr}</strong> · E[π] <strong>${profitStr}</strong></div>
          <div class="trace-row">cash <strong>${t.state.cash.toFixed(0)}</strong> · inv <strong>${t.state.inventory}</strong></div>
          ${uBlock}
          ${llmBlock}
          ${priorBlock}
          ${msgBlock}
        </div>`;
    }).join('');
  },

  /* -------- Replay slider sync -------- */

  setReplayPosition(tick, total, isLive) {
    this.els.replayPos.textContent = isLive
      ? `Live — tick ${tick}`
      : `Replay — tick ${tick} / ${total}`;
    this.els.replaySlider.max = Math.max(1, total);
    if (isLive) this.els.replaySlider.value = tick;
  },
};
