'use strict';

/* =====================================================================
   main.js — Application bootstrap + control wiring.

   Responsibilities:
     * Own the application state (config, engine, market, logger, agents).
     * Wire up every control in the header and replay panel.
     * Drive render scheduling (coalesced via requestAnimationFrame so
       multiple ticks in one animation frame produce one repaint).
     * Switch between live and replay rendering modes.
   ===================================================================== */

const App = {
  // Market config. Three of these four values are fixed-by-design
  // and surfaced read-only in companion cards at the top of the page:
  //
  //   periods, dividendMean   — paper constants from Dufwenberg,
  //                             Lindqvist & Moore (2005) §I (asset
  //                             life = 10 periods, E[dividend] = 10¢,
  //                             so FV_t = 10 · (T − t + 1)). Shown in
  //                             the "Paper constants" panel.
  //   ticksPerPeriod          — simulator constant. DLM 2005 uses a
  //                             continuous 2-minute z-Tree auction;
  //                             this sim discretizes each period into
  //                             18 decision rounds. Shown in the
  //                             "Simulator constants" panel. Not
  //                             tunable — see the evaluation in the
  //                             commit history for the reasoning.
  //   tickInterval            — wall-clock cadence only, driven by
  //                             the header Speed slider. Zero effect
  //                             on market dynamics.
  // DLM 2005 unit of study is a *session* of four consecutive markets
  // ("rounds") with six traders sharing the same population across
  // rounds 1-3 and a mixed-experience swap in round 4. One round lasts
  // ten periods with a {0,20}¢ i.i.d. dividend, so an entire session
  // is roundsPerSession × periods × ticksPerPeriod = 720 ticks by
  // default. The three numbers below are DLM paper constants and are
  // surfaced read-only in the Paper constants panel — the user does
  // not edit them, so that every comparison holds market structure
  // fixed. ticksPerPeriod is the simulator's own discretisation of
  // DLM's two-minute continuous trading windows and lives alongside
  // the paper constants because it shapes the tick-level dynamics.
  config: {
    roundsPerSession: 4,
    periods:          10,
    ticksPerPeriod:   18,
    dividendMean:     10,
    tickInterval:     340,
    ticksPerFrame:    1,
  },

  // Total population size, fixed at N = 6 per DLM 2005 §I.
  // Not user-adjustable — the paper pins six subjects and all
  // results are calibrated to this market size.
  TOTAL_N: 6,

  // Population composition — feeds the sampling stage in agents.js.
  // Total N is pinned at 6. F (Fundamentalist) and T (Trend follower)
  // are user-adjustable via sliders (can be 0 for a pure utility-agent
  // market); U is derived as TOTAL_N − F − T so all six slots are
  // always filled. F and T provide the initial price heterogeneity
  // that bootstraps non-degenerate trading under Plan I's DLM belief
  // model (prior = FV, peer-message blend with experience weight w).
  mix: { F: 0, T: 0, R: 0, U: 6 },

  // Simulator-invented numeric constants consumed by the engine and
  // utility agents. None of these are proposed by DLM 2005 (which
  // studies human subjects and specifies no agent model), so they
  // are surfaced read-only in the Simulator constants panel rather
  // than as Experiment-settings sliders. Still dropped on ctx here
  // because agents.js/engine.js read them via the tunable() helper,
  // which falls back to UTILITY_DEFAULTS for any missing key — so
  // editing a default value in one place keeps behavior consistent.
  // Note: `periods`, `dividendMean`, and `ticksPerPeriod` live in
  // App.config instead — the first two are DLM 2005 paper constants
  // and the third is the period-discretization simulator constant.
  tunables: {
    naivePriorWeight:     0.6,
    skepticalPriorWeight: 0.9,
    adaptiveWeightCap:    0.5,
    passiveFillProb:      0.3,
    trustAlpha:           0.30,
    valuationNoise:       0.03,
    biasAmount:           0.15,
    applyBias:            true,
    applyNoise:           true,
  },

  // Research plan — 'I' | 'II' | 'III'. Plan I is the algorithm-only
  // baseline: each utility agent's prior equals the current FV and it
  // blends peer messages with weight w = 0.6 + 0.1·min(3, roundsPlayed),
  // so the agent grows less susceptible to influence as rounds of
  // experience accumulate. Plan II calls an LLM every period and
  // includes the explicit utility-function forms (U_L, U_N, U_A) that
  // correspond to each agent's risk preference. Plan III calls the
  // same LLM but only tells it the risk-preference label. On network
  // or API failure, Plans II and III fall back to Plan I's algorithm.
  plan: 'I',

  // DLM treatment size for the round-4 replacement step. 2 = T2
  // (R4-⅔, two fresh), 4 = T4 (R4-⅓, four fresh).
  treatmentSize: 2,

  // Session counter for the 10-session batch. 0 = idle/pre-run,
  // 1-10 during a batch. Updated by start() at every session
  // boundary and reset to 0 by reset() or when the batch completes.
  currentSession: 0,

  // LLM endpoint state for Plans II and III. Populated from the
  // #ai-key / #ai-endpoint / #ai-model inputs on every change event
  // and consumed by start() to gate the run (both plans refuse to
  // launch without a key) and by the engine's period-boundary
  // `_schedulePlanLLM` (which reads ctx.aiConfig on each call).
  // Nothing is persisted to localStorage, matching the lying
  // project's deliberately forgetful design — the key must be
  // re-entered after a page reload. The initial model value is
  // overwritten on init from AI.DEFAULT_MODEL so a future edit in
  // ai.js propagates without touching main.js.
  aiConfig: { provider: '', apiKey: '', endpoint: '', model: '' },

  // Risk-preference composition for utility agents — three linked
  // shares summing to 100. Drives which risk profile each U slot is
  // instantiated with in the sampling stage under every plan.
  riskMix: { loving: 33, neutral: 34, averse: 33 },

  // Extended-mode flags consulted by the engine's communication round
  // and by the utility-agent message-listener. Kept as constants now
  // that the old Communication & deception toggles are gone — the
  // messaging + deception path stays live whenever mix.U > 0.
  extendedConfig: {
    communication: true,
    deception:     true,
  },

  // Engine RNG seed. Rerolled from Math.random() on every reset() so
  // Reset doubles as "redraw the population" and no manual seed input
  // is needed in the UI. rebuild() (soft slider changes, endowment
  // edits) preserves the current seed so the existing draw survives.
  seed: 1,

  // Per-agent spec list produced by the sampling stage (names +
  // endowments + strategy fields). Nulled by reset() so the next
  // rebuild() re-samples against a fresh sample RNG; kept intact by
  // rebuild() when the user edits an individual endowment so those
  // edits survive the next market rebuild.
  agentSpecs: null,

  agents:       {},
  market:       null,
  logger:       null,
  engine:       null,
  messageBus:   null,
  trustTracker: null,
  ctx:          null,
  _rng:         null,

  replayMode: false,
  replayTick: 0,
  rafPending: false,

  init() {
    this._initTheme();
    UI.init();
    // Seed the plan body class so the per-plan AI endpoint panel
    // visibility is correct before _wireControls attaches handlers.
    document.body.classList.add('plan-' + this.plan.toLowerCase());
    this._wireControls();
    this.reset();
  },

  /* -------- Theme: auto / light / dark -------- */

  _initTheme() {
    const saved = localStorage.getItem('bubble-theme') || 'auto';
    document.documentElement.setAttribute('data-theme', saved);
    this._syncThemeButton(saved);
    // Re-apply canvas theme colors when the system scheme changes while
    // the user is on 'auto', so dark-mode OS switches repaint the charts.
    if (window.matchMedia) {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => {
        if (document.documentElement.getAttribute('data-theme') === 'auto') {
          UI.refreshTheme();
          this.requestRender();
        }
      };
      if (mql.addEventListener) mql.addEventListener('change', listener);
      else if (mql.addListener) mql.addListener(listener);
    }
  },

  _cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    const cur   = document.documentElement.getAttribute('data-theme') || 'auto';
    const next  = order[(order.indexOf(cur) + 1) % order.length];
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('bubble-theme', next);
    this._syncThemeButton(next);
    UI.refreshTheme();
    this.requestRender();
  },

  _syncThemeButton(mode) {
    const btn = document.getElementById('btn-theme');
    if (!btn) return;
    const icons = { auto: '◑', light: '☀', dark: '☾' };
    btn.textContent  = icons[mode] || '◑';
    btn.title        = `Theme: ${mode} (click to cycle)`;
  },

  /* -------- Control wiring -------- */

  _wireControls() {
    document.getElementById('btn-start').addEventListener('click', () => this.start());
    document.getElementById('btn-pause').addEventListener('click', () => this.pause());
    document.getElementById('btn-reset').addEventListener('click', () => this.reset());
    const exportBtn = document.getElementById('btn-export');
    if (exportBtn) exportBtn.addEventListener('click', () => this.exportBatchJSON());
    const themeBtn = document.getElementById('btn-theme');
    if (themeBtn) themeBtn.addEventListener('click', () => this._cycleTheme());

    document.getElementById('speed').addEventListener('input', e => {
      // speed 1 → ~953ms, speed 20 → ~60ms (single tick per frame).
      // speed 21-50 → fixed 16ms interval, batching multiple ticks per
      // frame so the simulation accelerates smoothly up to 50×.
      const s = Number(e.target.value);
      if (s <= 20) {
        this.config.tickInterval = Math.max(40, Math.round(1000 - s * 47));
        this.config.ticksPerFrame = 1;
      } else {
        this.config.tickInterval = 16;  // ~60 fps
        this.config.ticksPerFrame = Math.round(1 + (s - 20) * 1.5);  // 2-46 ticks/frame
      }
    });

    this._wireParamsPanel();

    const slider = document.getElementById('replay-slider');
    slider.addEventListener('input', e => this.enterReplayAt(Number(e.target.value)));

    document.getElementById('btn-live').addEventListener('click', () => this.exitReplay());
    document.getElementById('btn-step-back').addEventListener('click', () => {
      const currentT = this.replayMode ? this.replayTick : this.market.tick;
      this.enterReplayAt(Math.max(0, currentT - 1));
    });
    document.getElementById('btn-step-fwd').addEventListener('click', () => {
      const maxT = this.market.tick;
      if (!this.replayMode) return;
      this.enterReplayAt(Math.min(maxT, this.replayTick + 1));
    });
  },

  /* -------- Experiment settings panel -------- */

  /**
   * Map of every slider → the Tunables/mix key it drives. Each entry
   * specifies how to format the readout and whether the value is an
   * integer. The loop below wires change events uniformly so adding
   * a new slider only requires extending this map and the HTML.
   */
  _paramMap: {
    // Population mix — F and T are user-adjustable; U is derived.
    'p-count-f': { target: 'mix.F', out: 'v-count-f', fmt: v => String(v), int: true },
    'p-count-t': { target: 'mix.T', out: 'v-count-t', fmt: v => String(v), int: true },
    // Risk preferences — three linked shares summing to 100.
    'p-risk-loving': { target: 'riskMix.loving',  out: 'v-risk-loving',  fmt: v => v + '%', int: true },
    'p-risk-neutral':{ target: 'riskMix.neutral', out: 'v-risk-neutral', fmt: v => v + '%', int: true },
    'p-risk-averse': { target: 'riskMix.averse',  out: 'v-risk-averse',  fmt: v => v + '%', int: true },
  },

  _wireParamsPanel() {
    // Push the initial tunables/mix values into the sliders so the
    // controls reflect App state on first paint regardless of the
    // values baked into the HTML defaults.
    this._pushStateToSliders();

    // Uniform wiring for every slider in the param map. Sliders that
    // change the population *structure* (mix counts, risk shares) call
    // reset() on release, which rolls a new seed and re-samples the
    // population; everything else calls rebuild() and keeps the
    // cached specs intact.
    for (const [inputId, spec] of Object.entries(this._paramMap)) {
      const input = document.getElementById(inputId);
      if (!input) continue;
      const structural =
        spec.target.startsWith('mix.') ||
        spec.target.startsWith('riskMix.');
      input.addEventListener('input', e => {
        const raw = Number(e.target.value);
        const val = spec.int ? (raw | 0) : raw;
        this._setByPath(spec.target, val);
        const out = document.getElementById(spec.out);
        if (out) out.textContent = spec.fmt(val);
        this._updateSliderPct(e.target);
        if (spec.target.startsWith('riskMix.')) this._constrainRiskMix(inputId);
        if (spec.target.startsWith('mix.'))     this._constrainMix();
      });
      input.addEventListener('change', () => {
        // Structural edits (population mix counts, risk-share shares,
        // background counts) ask for a fresh draw, so they roll a new
        // seed via reset(). Everything else is a soft change that
        // keeps the current draw and just rebuilds the market/engine.
        if (structural) this.reset();
        else            this.rebuild();
      });
    }
    this._updateCompBar();
    this._constrainMix();

    // Boolean toggles in Trade Settings (bias / noise on the prior).
    for (const key of ['applyBias', 'applyNoise']) {
      const cb = document.getElementById('p-' + key);
      if (!cb) continue;
      cb.checked = !!this.tunables[key];
      cb.addEventListener('change', () => {
        this.tunables[key] = cb.checked;
        this.rebuild();
      });
    }

    // Plan switch — the three segmented buttons Plan I / Plan II /
    // Plan III in the navbar drive App.plan, a matching body class
    // (plan-i / plan-ii / plan-iii), and a rebuild so the engine ctx
    // picks up the new plan immediately. Plans II and III additionally
    // reveal the LLM endpoint panel below through the body-class CSS.
    document.querySelectorAll('.plan-btn').forEach(btn => {
      btn.addEventListener('click', () => this._setPlan(btn.dataset.plan));
    });
    this._syncPlanButtons();

    // DLM treatment radio buttons (T2 / T4).
    document.querySelectorAll('input[name="dlm-treatment"]').forEach(radio => {
      radio.addEventListener('change', e => {
        this.treatmentSize = Number(e.target.value);
        this.reset();
      });
    });

    // Prime the custom --pct on every slider so the filled portion of
    // the track matches the initial value before any interaction.
    this._updateAllSliderPcts();

    // Foldable panel header — click anywhere on the strip to toggle
    // the body visibility. Mirrors the pattern used by the lying
    // project's side panels.
    const head = document.getElementById('panel-params-head');
    const panel = document.getElementById('panel-params');
    if (head && panel) {
      head.addEventListener('click', () => panel.classList.toggle('collapsed'));
    }

    // Explicit <details> toggle — `display: flex` on <summary> breaks
    // the native toggle in some browsers. Wire a click handler on every
    // .psec summary that toggles the parent's `open` attribute manually.
    document.querySelectorAll('.psec > summary').forEach(sum => {
      sum.addEventListener('click', (e) => {
        e.preventDefault();
        const details = sum.parentElement;
        if (details.open) details.removeAttribute('open');
        else              details.setAttribute('open', '');
      });
    });


    // AI endpoint inputs — provider, key, endpoint, model.  All synced
    // between the Plan II and Plan III panels via shared CSS classes.
    // Provider change rebuilds the model dropdown and updates the
    // endpoint placeholder.
    const aiProviders = document.querySelectorAll('.ai-shared-provider');
    const aiKeys      = document.querySelectorAll('.ai-shared-key');
    const aiEndpoints = document.querySelectorAll('.ai-shared-endpoint');
    const aiModels    = document.querySelectorAll('.ai-shared-model');

    const _syncModels = (providerKey) => {
      if (typeof AI === 'undefined') return;
      const models = AI.getModels(providerKey);
      const def    = AI.getDefaultModel(providerKey);
      const ep     = AI.getDefaultEndpoint(providerKey);
      const kp     = AI.getKeyPlaceholder(providerKey);
      const optHtml = models
        .map(m => `<option value="${m.id}">${m.label}</option>`)
        .join('');
      aiModels.forEach(sel => { sel.innerHTML = optHtml; sel.value = def; });
      aiEndpoints.forEach(el => el.placeholder = ep);
      aiKeys.forEach(el => el.placeholder = kp);
      this.aiConfig.model = def;
      this.aiConfig.provider = providerKey;
    };

    if (aiProviders.length && typeof AI !== 'undefined') {
      const provHtml = Object.entries(AI.PROVIDERS)
        .map(([k, p]) => `<option value="${k}">${p.label}</option>`)
        .join('');
      aiProviders.forEach(sel => {
        sel.innerHTML = provHtml;
        sel.value = AI.DEFAULT_PROVIDER;
      });
      _syncModels(AI.DEFAULT_PROVIDER);
    }
    aiProviders.forEach(el => el.addEventListener('change', e => {
      const v = e.target.value;
      aiProviders.forEach(o => { if (o !== e.target) o.value = v; });
      _syncModels(v);
    }));
    aiKeys.forEach(el => el.addEventListener('input', e => {
      const v = (e.target.value || '').trim();
      this.aiConfig.apiKey = v;
      aiKeys.forEach(o => { if (o !== e.target) o.value = e.target.value; });
    }));
    aiEndpoints.forEach(el => el.addEventListener('input', e => {
      const v = (e.target.value || '').trim();
      this.aiConfig.endpoint = v;
      aiEndpoints.forEach(o => { if (o !== e.target) o.value = e.target.value; });
    }));
    aiModels.forEach(el => el.addEventListener('change', e => {
      const v = (e.target.value || '').trim();
      this.aiConfig.model = v;
      aiModels.forEach(o => { if (o !== e.target) o.value = e.target.value; });
    }));

    // Nav-tab click handler — swaps which .tab-pane is visible and
    // mirrors the active state onto the tab button. Re-runs KaTeX
    // on the newly-activated pane so formulas inside a previously
    // hidden tab render the moment the user navigates to it.
    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.tab;
        if (!key) return;   // external link (e.g. Analytics) — don't switch panes
        document.querySelectorAll('.nav-tab').forEach(b => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + key));
        const active = document.getElementById('tab-' + key);
        this._renderMath(active);
        if (key === 'slides') this._syncSlide();
      });
    });

    // "Edit in draw.io" — each architecture figure carries its own
    // .drawio file via data-drawio. Wire every such button to the
    // correct app.diagrams.net URL at runtime so GitHub Pages, a
    // local file:// serve, and a localhost dev server all resolve to
    // the right absolute URL. file:// origins are handled gracefully.
    document.querySelectorAll('[data-drawio]').forEach(btn => {
      const origin = window.location.origin;
      if (origin && /^https?:/.test(origin)) {
        const path   = window.location.pathname.replace(/[^/]*$/, '');
        const srcUrl = origin + path + btn.dataset.drawio;
        btn.href = 'https://app.diagrams.net/#U' + encodeURIComponent(srcUrl);
      } else {
        btn.href  = 'https://app.diagrams.net/';
        btn.title = 'Open app.diagrams.net (source file only resolvable over https://)';
      }
    });

    // Slides tab wiring — prev/next, fullscreen, reading-mode, keyboard.
    this._wireSlides();

    // Initial KaTeX pass — covers formulas baked into the default
    // (Experiment) pane. Each tab switch above will re-render its
    // own pane on demand.
    this._renderMath(document.body);
  },

  /**
   * Run KaTeX auto-render on an element subtree. Matches the lying
   * project's delimiter config (`$$…$$` display, `$…$` inline). A
   * missing global is tolerated so the page still works if the CDN
   * is unavailable — the math simply shows as raw source.
   */
  _renderMath(el) {
    if (!el || typeof renderMathInElement !== 'function') return;
    try {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true  },
          { left: '$',  right: '$',  display: false },
        ],
        throwOnError: false,
      });
    } catch (_) { /* ignored — math left as source */ }
  },

  /* -------- Slides -------- */

  // Current slide index (1-based) and a one-time `.active` lock onto
  // the first slide in _wireSlides(). The toolbar prev/next buttons,
  // the global keyboard handler, and every slide-toggle path go
  // through _gotoSlide() so the counter, button disabled-state, and
  // `.active` class stay in lockstep.
  _curSlide: 1,

  _wireSlides() {
    const viewport = document.getElementById('slides-viewport');
    if (!viewport) return;
    const slides = viewport.querySelectorAll('.slide');
    const total  = slides.length;
    const totEl  = document.getElementById('slide-tot');
    if (totEl) totEl.textContent = String(total);

    const prev = document.getElementById('slide-prev');
    const next = document.getElementById('slide-next');
    const fs   = document.getElementById('slide-fs');
    const read = document.getElementById('slide-read');

    if (prev) prev.addEventListener('click', () => this._gotoSlide(this._curSlide - 1));
    if (next) next.addEventListener('click', () => this._gotoSlide(this._curSlide + 1));
    if (fs)   fs.addEventListener('click',   () => this._toggleFullscreen());
    if (read) read.addEventListener('click', () => this._toggleReadingMode());

    // Global keyboard — only fires when the Slides tab is active and
    // focus is not on an interactive form element (otherwise ←/→
    // would hijack number-input adjustment). Esc exits fullscreen.
    document.addEventListener('keydown', (e) => {
      const slidesTab = document.getElementById('tab-slides');
      if (!slidesTab || !slidesTab.classList.contains('active')) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); this._gotoSlide(this._curSlide - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); this._gotoSlide(this._curSlide + 1); }
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); this._toggleFullscreen(); }
      if (e.key === 'Escape') {
        const vp = document.getElementById('slides-viewport');
        if (vp && vp.classList.contains('fullscreen')) this._toggleFullscreen();
      }
    });

    this._syncSlide();
  },

  _gotoSlide(n) {
    const viewport = document.getElementById('slides-viewport');
    if (!viewport) return;
    const total = viewport.querySelectorAll('.slide').length;
    if (total === 0) return;
    if (n < 1)     n = 1;
    if (n > total) n = total;
    this._curSlide = n;
    this._syncSlide();
  },

  _syncSlide() {
    const viewport = document.getElementById('slides-viewport');
    if (!viewport) return;
    const slides = viewport.querySelectorAll('.slide');
    slides.forEach((slide) => {
      const idx = Number(slide.dataset.slide) || 0;
      slide.classList.toggle('active', idx === this._curSlide);
    });
    const cur  = document.getElementById('slide-cur');
    if (cur) cur.textContent = String(this._curSlide);
    const prev = document.getElementById('slide-prev');
    const next = document.getElementById('slide-next');
    if (prev) prev.disabled = this._curSlide <= 1;
    if (next) next.disabled = this._curSlide >= slides.length;
  },

  _toggleFullscreen() {
    const viewport = document.getElementById('slides-viewport');
    if (!viewport) return;
    const willEnter = !viewport.classList.contains('fullscreen');
    viewport.classList.toggle('fullscreen', willEnter);
    let backdrop = document.getElementById('slides-fs-backdrop');
    if (willEnter) {
      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'slides-fs-backdrop';
        backdrop.className = 'slides-fs-backdrop';
        backdrop.addEventListener('click', () => this._toggleFullscreen());
        document.body.appendChild(backdrop);
      }
      const fsBtn = document.getElementById('slide-fs');
      if (fsBtn) fsBtn.classList.add('active');
    } else {
      if (backdrop) backdrop.remove();
      const fsBtn = document.getElementById('slide-fs');
      if (fsBtn) fsBtn.classList.remove('active');
    }
  },

  _toggleReadingMode() {
    const viewport = document.getElementById('slides-viewport');
    if (!viewport) return;
    viewport.classList.toggle('reading-mode');
    const btn = document.getElementById('slide-read');
    if (btn) btn.classList.toggle('active', viewport.classList.contains('reading-mode'));
  },

  /**
   * Apply one of the three research-plan selections from the navbar.
   *
   *   'I'   — algorithm-only belief update. No LLM calls, no network
   *           activity, no API key required.
   *
   *   'II'  — LLM with explicit utility formulas (U_L / U_N / U_A).
   *           Every period boundary the engine schedules an async
   *           `AI.getPlanBeliefs` call whose prompt includes the
   *           matching formula for each agent's risk preference.
   *
   *   'III' — LLM with risk-preference label only. Same channel as
   *           Plan II but the prompt omits the formulas, testing
   *           whether the label alone is enough to recover the
   *           utility-aware belief. Both II and III fall back to
   *           Plan I's algorithm if the network call fails or no
   *           API key is present.
   *
   * Setting a plan toggles a matching body class (plan-i / plan-ii /
   * plan-iii) that the CSS uses to gate the LLM endpoint panel, syncs
   * the three navbar buttons, and rebuilds the engine so the new plan
   * lands on ctx.plan immediately. No reseed — changing the plan is a
   * soft edit that preserves the current draw.
   */
  _setPlan(plan) {
    if (plan !== 'I' && plan !== 'II' && plan !== 'III') return;
    this.plan = plan;
    document.body.classList.toggle('plan-i',   plan === 'I');
    document.body.classList.toggle('plan-ii',  plan === 'II');
    document.body.classList.toggle('plan-iii', plan === 'III');
    this._syncPlanButtons();
    this._setAiStatus('');
    this.rebuild();
  },

  /**
   * Reflect App.plan on the navbar buttons and the body class. Called
   * on init and after every plan change so the segmented control and
   * the CSS gating of the LLM endpoint panel stay in sync.
   */
  _syncPlanButtons() {
    const active = this.plan;
    document.body.classList.toggle('plan-i',   active === 'I');
    document.body.classList.toggle('plan-ii',  active === 'II');
    document.body.classList.toggle('plan-iii', active === 'III');
    document.querySelectorAll('.plan-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.plan === active);
    });
  },

  /**
   * Linked-slider constraint for the three risk-preference shares.
   * When one slider moves to cv, the remaining (100 − cv) is split
   * between the other two in proportion to their previous values,
   * with the residual absorbed by the first of the two. If both
   * others are zero, split the remainder 50/50. After rebalancing,
   * App.riskMix, the readouts, and the comp-bar are all refreshed.
   */
  /**
   * When F or T changes, clamp the other so F + T ≤ TOTAL_N,
   * derive U = TOTAL_N − F − T, and update the readouts + maxes.
   */
  _constrainMix() {
    const N = this.TOTAL_N;
    const elF = document.getElementById('p-count-f');
    const elT = document.getElementById('p-count-t');
    if (!elF || !elT) return;
    const f = this.mix.F | 0;
    const t = this.mix.T | 0;
    // Clamp: if the sum exceeds N, trim the other slider.
    if (f + t > N) {
      this.mix.T = Math.max(0, N - f);
      elT.value = String(this.mix.T);
      const outT = document.getElementById('v-count-t');
      if (outT) outT.textContent = this.mix.T;
      this._updateSliderPct(elT);
    }
    this.mix.U = Math.max(0, N - (this.mix.F | 0) - (this.mix.T | 0));
    // Update the derived U readout and the mix-total badge.
    const outU = document.getElementById('v-util');
    if (outU) outU.textContent = this.mix.U;
    const badge = document.getElementById('mix-total');
    if (badge) badge.textContent = `(N = ${N})`;
    // Cap each slider's max so the user can't push past N.
    elF.max = String(N - (this.mix.T | 0));
    elT.max = String(N - (this.mix.F | 0));
    this._updateSliderPct(elF);
    this._updateSliderPct(elT);
  },

  _constrainRiskMix(changedId) {
    this._constrainLinkedTriplet(changedId, {
      ids:    ['p-risk-loving', 'p-risk-neutral', 'p-risk-averse'],
      keys:   ['loving',        'neutral',        'averse'],
      state:  this.riskMix,
      labels: ['v-risk-loving', 'v-risk-neutral', 'v-risk-averse'],
      onAfter: () => this._updateCompBar(),
    });
  },

  /**
   * Shared linked-triplet rebalancer used by both preference blocks. When
   * one of the three sliders moves to cv, the remaining (100 − cv) is
   * split between the other two in proportion to their previous values,
   * with the residual absorbed by the first of the two. If both others
   * are zero, the remainder is split 50/50. After rebalancing, the bound
   * state object, the readouts, and the supplied onAfter hook (used to
   * refresh the comp-bar) are all called.
   */
  _constrainLinkedTriplet(changedId, cfg) {
    const ci = cfg.ids.indexOf(changedId);
    if (ci < 0) return;
    const els = cfg.ids.map(id => document.getElementById(id));
    const cv  = Number(els[ci].value) | 0;
    const oi  = [0, 1, 2].filter(i => i !== ci);
    const prev0 = Number(els[oi[0]].value) | 0;
    const prev1 = Number(els[oi[1]].value) | 0;
    const sumOthers = prev0 + prev1;
    const remaining = Math.max(0, 100 - cv);
    let r0, r1;
    if (sumOthers > 0) {
      r0 = Math.round(prev0 / sumOthers * remaining);
      r1 = remaining - r0;
    } else {
      r0 = Math.floor(remaining / 2);
      r1 = remaining - r0;
    }
    els[oi[0]].value = String(r0);
    els[oi[1]].value = String(r1);
    this._updateSliderPct(els[oi[0]]);
    this._updateSliderPct(els[oi[1]]);
    cfg.state[cfg.keys[ci]]    = cv;
    cfg.state[cfg.keys[oi[0]]] = r0;
    cfg.state[cfg.keys[oi[1]]] = r1;
    for (let i = 0; i < 3; i++) {
      const out = document.getElementById(cfg.labels[i]);
      if (out) out.textContent = cfg.state[cfg.keys[i]] + '%';
    }
    if (cfg.onAfter) cfg.onAfter();
  },

  /**
   * Write the [min..max]→[0..100] percentage into the --pct custom
   * property on one range input. The CSS track uses this as a
   * linear-gradient stop so the filled portion follows the thumb.
   */
  _updateSliderPct(el) {
    if (!el) return;
    const min = Number(el.min) || 0;
    const max = Number(el.max) || 100;
    const v   = Number(el.value) || 0;
    const pct = max === min ? 0 : ((v - min) / (max - min)) * 100;
    el.style.setProperty('--pct', pct.toFixed(2) + '%');
  },

  _updateAllSliderPcts() {
    const sliders = document.querySelectorAll('.panel-params input[type=range]');
    sliders.forEach(el => this._updateSliderPct(el));
  },

  _updateCompBar() {
    const bar = document.getElementById('comp-bar');
    if (!bar) return;
    const { loving, neutral, averse } = this.riskMix;
    // A 0% segment still needs a nonzero flex or flexbox collapses it
    // asymmetrically; 0.001 keeps it out of sight without side effects.
    bar.children[0].style.flex = loving  || 0.001;
    bar.children[1].style.flex = neutral || 0.001;
    bar.children[2].style.flex = averse  || 0.001;
    bar.children[0].querySelector('span').textContent = loving  + '%';
    bar.children[1].querySelector('span').textContent = neutral + '%';
    bar.children[2].querySelector('span').textContent = averse  + '%';
  },

  _pushStateToSliders() {
    for (const [inputId, spec] of Object.entries(this._paramMap)) {
      const input = document.getElementById(inputId);
      if (!input) continue;
      const val = this._getByPath(spec.target);
      if (val == null) continue;
      input.value = String(val);
      const out = document.getElementById(spec.out);
      if (out) out.textContent = spec.fmt(val);
      this._updateSliderPct(input);
    }
  },

  _getByPath(path) {
    const [root, key] = path.split('.');
    return this[root] ? this[root][key] : undefined;
  },

  _setByPath(path, val) {
    const [root, key] = path.split('.');
    if (this[root]) this[root][key] = val;
  },

  /* -------- Lifecycle -------- */

  /**
   * Full reset — rolls a new random engine seed, drops the cached
   * agentSpecs, and delegates to rebuild() which will re-sample a
   * fresh population against the new seed. This is the only path
   * that changes the seed; rebuild() alone preserves it.
   */
  reset() {
    this.seed = this._rollSeed();
    this.agentSpecs = null;
    if (!this._batchRunning) this.currentSession = 0;
    this.rebuild();
  },

  /**
   * Produce a 32-bit engine seed from Math.random(). Kept as its
   * own method so tests or future URL-parameter overrides can swap
   * the source without touching reset().
   */
  _rollSeed() {
    return (Math.floor(Math.random() * 0x100000000)) >>> 0 || 1;
  },

  /**
   * Rebuild market + engine + agents from the current seed and the
   * current agentSpecs cache. Called directly from soft slider
   * changes and endowment edits (which must preserve both); called
   * indirectly from reset() (which nulls the cache first so a fresh
   * sample is drawn against the new seed).
   */
  rebuild() {
    if (this.engine) this.engine.pause();
    Order.nextId = 1;
    Trade.nextId = 1;

    // Nothing is folded from tunables into config here any more:
    // periods, dividendMean, and ticksPerPeriod are all fixed
    // constants (two from the paper, one from the simulator) and
    // live only in App.config. tickInterval is controlled by the
    // header Speed slider and is intentionally preserved across
    // rebuilds.

    this._rng = makeRNG(this.seed);

    // Sampling RNG is independent of the engine RNG so that editing
    // endowments (which skips the re-sample path) leaves the engine's
    // tick-level draws unchanged.
    const totalN =
      (this.mix.F | 0) + (this.mix.T | 0) + (this.mix.R | 0) + (this.mix.U | 0);
    if (!this.agentSpecs || this.agentSpecs.length !== totalN) {
      const sampleRng = makeRNG((this.seed ^ 0xA5A5A5A5) >>> 0);
      this.agentSpecs = sampleAgents(this.mix, sampleRng, {
        riskMix: this.riskMix,
      });
    }
    this.agents = buildAgentsFromSpecs(this.agentSpecs, {
      biasAmount:     this.tunables.biasAmount,
      valuationNoise: this.tunables.valuationNoise,
    });
    this.market = new Market(this.config);
    this.logger = new Logger();
    // Message bus + trust tracker live for every run. With a mix that
    // has no utility agents they simply stay empty because no agent
    // implements communicate() and the engine's comms round returns early.
    this.messageBus   = new MessageBus();
    const agentIds    = Object.keys(this.agents).map(Number);
    this.trustTracker = new TrustTracker(agentIds);
    this.ctx = {
      messageBus:   this.messageBus,
      trustTracker: this.trustTracker,
      extended:     this.extendedConfig,
      tunables:     this.tunables,
      // agentSpecs is how the engine reaches the original endowment
      // draw when it runs the round-end reset: every agent is rewound
      // to the spec cash/inventory between rounds so each of the
      // four markets in a session starts from the same schedule.
      agentSpecs:   this.agentSpecs,
      // Research plan drives the UtilityAgent belief-update branch.
      // Plans II and III also read aiConfig so they can reach the LLM
      // endpoint at period boundary; Plan I ignores both.
      plan:          this.plan,
      aiConfig:      this.aiConfig,
      // Period-boundary LLM cache (legacy valuation path).
      llmBeliefs:    {},
      // Period-boundary LLM action cache: { [agentId]: {action, reason} }.
      // Populated asynchronously by the engine's comms round when
      // plan ∈ {II, III}, consumed next tick by decide().
      llmActions:    {},
      // Round-4 replacement: 2 (T2/R4-⅔) or 4 (T4/R4-⅓).
      treatmentSize: this.treatmentSize,
      // Current session number (1-10) for the batch display.
      currentSession: this.currentSession,
    };
    this.engine = new Engine(this.market, this.agents, this.logger, this.config, this._rng, this.ctx);
    this.engine.onTick = () => this.requestRender();
    this.engine.onEnd  = () => this.requestRender();
    this.replayMode = false;
    this.replayTick = 0;
    // Toggle the extended-panel visibility class whenever any utility
    // agents are present, then re-measure canvases that were previously
    // display:none.
    document.body.classList.toggle('extended', (this.mix.U | 0) > 0);
    UI.resizeCanvases();
    this.requestRender();
  },

  /**
   * Apply a user edit to one agent's endowment and rebuild the
   * market without re-sampling or reseeding. Called from the
   * per-agent editable inputs in ui.js. Field is 'cash' or
   * 'inventory'; non-finite or negative values are ignored.
   */
  updateEndowment(id, field, value) {
    if (!this.agentSpecs) return;
    const spec = this.agentSpecs.find(s => s.id === id);
    if (!spec) return;
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return;
    spec[field] = field === 'inventory' ? (v | 0) : Math.round(v);
    this.rebuild();
  },

  /**
   * Run the full DLM 2005 10-session batch. Sessions 1-5 use the
   * first treatment (selected by the radio), sessions 6-10 use the
   * other. Each session is a fresh 4-round game with a new seed and
   * fresh agents, animated at the current Speed setting. The onEnd
   * callback chains to the next session automatically.
   *
   * Plan II/III require an API key; Plan I runs immediately.
   */
  start() {
    if (this.replayMode) this.exitReplay();
    if (this._batchRunning) return;   // don't re-enter mid-batch
    if (this.plan === 'II' || this.plan === 'III') {
      const key = this.aiConfig && (this.aiConfig.apiKey || '').trim();
      if (!key) {
        this._setAiStatus(`Plan ${this.plan} requires an API key — enter one in the AI endpoint panel or switch to Plan I.`);
        return;
      }
      this._setAiStatus(`Plan ${this.plan} — period-boundary LLM calls armed.`);
    } else {
      this._setAiStatus('');
    }

    const SESSIONS = 10;
    const firstTreatment  = this.treatmentSize;
    const secondTreatment = firstTreatment === 2 ? 4 : 2;
    this.batchResults = [];
    this._exportSessions = [];
    this._batchRunning = true;
    const btnExport = document.getElementById('btn-export');
    if (btnExport) btnExport.disabled = true;

    const runSession = (s) => {
      if (s >= SESSIONS) {
        this._batchRunning = false;
        this.currentSession = 0;
        this.treatmentSize = firstTreatment;
        console.table(this.batchResults);
        if (btnExport) btnExport.disabled = false;
        this.requestRender();
        return;
      }
      const treatment = s < 5 ? firstTreatment : secondTreatment;
      this.treatmentSize = treatment;
      this.currentSession = s + 1;
      this.reset();
      // Snapshot the original agent specs before any round-4 replacement
      // mutates them — the export needs the pre-replacement population.
      this._sessionOriginalSpecs = this.agentSpecs.map(sp => ({ ...sp }));
      // Patch the ctx session counter after rebuild() so the engine
      // snapshots and the live view carry the right session number.
      this.ctx.currentSession = this.currentSession;

      const sessionNum  = s + 1;
      const txLabel     = treatment === 2 ? 'T2' : 'T4';
      const totalShares = this.TOTAL_N * 3;

      // Collect one round's metrics as soon as it finishes, so Table 2
      // updates progressively instead of waiting for the full session.
      this.engine.onRoundEnd = (round) => {
        const roundTrades = this.market.trades.filter(t => t.round === round);
        const fvAtTr = roundTrades.map(t => {
          const p = t.period != null ? t.period : 1;
          return this.config.dividendMean * (this.config.periods - p + 1);
        });
        const absDev  = roundTrades.map((t, i) => Math.abs(t.price - fvAtTr[i]));
        const meanDev = absDev.length
          ? absDev.reduce((a, b) => a + b, 0) / absDev.length : 0;
        const turnover = roundTrades.length / totalShares;
        const volume   = roundTrades.reduce((sum, t) => sum + t.quantity, 0);
        const cashMap    = this.logger.roundFinalCash[round - 1] || {};
        const roundPayoff = Object.values(cashMap).reduce((a, b) => a + b, 0);

        this.batchResults.push({
          label:     `R${round}_S${sessionNum}`,
          session:   sessionNum,
          round,
          treatment: txLabel,
          trades:    roundTrades.length,
          meanDev:   Math.round(meanDev * 100) / 100,
          turnover:  Math.round(turnover * 100) / 100,
          volume,
          payoff:    Math.round(roundPayoff),
        });
        this.requestRender();
      };

      this.engine.onEnd = () => {
        this.requestRender();
        // Snapshot the completed session before chaining resets state.
        this._exportSessions.push(this._snapshotSession());
        // Chain to next session.
        setTimeout(() => runSession(s + 1), 50);
      };
      this.engine.start();
    };

    runSession(0);
  },

  /**
   * Capture the current session's full state into a plain object for
   * the JSON export. Called from engine.onEnd before the next session
   * chains and reset() clears the market / logger / agents.
   */
  _snapshotSession() {
    const sessionNum = this.currentSession;
    const R = this.config.roundsPerSession;

    // Per-round breakdown — metrics + replacement info + final cash.
    const rounds = [];
    const replEvt = this.logger.events.find(e => e.type === 'round_4_replacement');
    for (let r = 1; r <= R; r++) {
      const label = `R${r}_S${sessionNum}`;
      rounds.push({
        round: r,
        label,
        metrics:        this.batchResults.find(b => b.label === label) || null,
        replacement:    r === 4 && replEvt
          ? { treatmentSize: replEvt.treatmentSize, replaced: replEvt.replaced }
          : null,
        roundFinalCash: this.logger.roundFinalCash[r - 1] || null,
      });
    }

    // Agent final states at session end.
    const agents = Object.values(this.agents).map(a => ({
      id:               a.id,
      name:             a.displayName,
      type:             a.type,
      typeLabel:        a.typeLabel || null,
      riskPref:         a.riskPref || null,
      biasMode:         a.biasMode || null,
      deceptionMode:    a.deceptionMode || null,
      beliefMode:       a.beliefMode || null,
      roundsPlayed:     a.roundsPlayed,
      replacementFresh: !!a.replacementFresh,
      cash:             a.cash,
      inventory:        a.inventory,
      initialCash:      a.initialCash,
      initialInventory: a.initialInventory,
    }));

    return {
      session:    sessionNum,
      treatment:  this.treatmentSize === 2 ? 'T2' : 'T4',
      plan:       this.plan,
      seed:       this.seed,
      agentSpecs: (this._sessionOriginalSpecs || this.agentSpecs).map(s => ({ ...s })),
      agents,
      rounds,
      trades: this.market.trades.map(t => ({
        id:       t.id,
        buyerId:  t.buyerId,
        sellerId: t.sellerId,
        price:    t.price,
        quantity: t.quantity,
        tick:     t.timestamp,
        period:   t.period,
        round:    t.round,
      })),
      priceHistory: this.market.priceHistory.map(p => ({
        tick:   p.tick,
        price:  p.price,
        fv:     p.fv,
        bid:    p.bid,
        ask:    p.ask,
        period: p.period,
        round:  p.round,
      })),
      dividends: this.logger.events
        .filter(e => e.type === 'dividend')
        .map(e => ({ period: e.period, round: e.round, value: e.value, tick: e.tick })),
      messages: this.logger.messages.map(m => ({
        senderId:         m.senderId,
        senderName:       m.senderName,
        round:            m.round,
        period:           m.period,
        tick:             m.tick,
        trueValuation:    m.trueValuation,
        claimedValuation: m.claimedValuation,
        signal:           m.signal,
        deceptionMode:    m.deceptionMode,
        deceptive:        !!m.deceptive,
      })),
      llmCalls: this.logger.llmCalls.slice(),
    };
  },

  /**
   * Build the full batch export object and trigger a browser download.
   * The file contains every session's trades, prices, dividends,
   * messages, agent states, and — for Plans II/III — the complete
   * LLM prompt/response audit trail.
   */
  exportBatchJSON() {
    if (!this._exportSessions || !this._exportSessions.length) return;
    const data = {
      meta: {
        exportedAt:     new Date().toISOString(),
        plan:           this.plan,
        treatmentOrder: [
          this._exportSessions[0].treatment,
          this._exportSessions.length > 5 ? this._exportSessions[5].treatment : null,
        ],
        config:     { ...this.config },
        tunables:   { ...this.tunables },
        population: { ...this.mix },
        riskMix:    { ...this.riskMix },
      },
      sessions:     this._exportSessions,
      batchSummary: this.batchResults,
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `batch_plan${this.plan}_${new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Render a one-line status string under the AI endpoint psec.
   * Purely advisory — the run proceeds regardless of the outcome,
   * and the message is silently dropped if the psec is not mounted.
   */
  _setAiStatus(msg) {
    document.querySelectorAll('[id^="ai-status"]').forEach(el => {
      el.textContent = msg;
    });
  },


  pause() {
    this._batchRunning = false;
    this.engine.pause();
    this.requestRender();
  },

  enterReplayAt(tick) {
    this.replayMode = true;
    this.replayTick = tick;
    if (this.engine.running) this.engine.pause();
    this.requestRender();
  },

  exitReplay() {
    this.replayMode = false;
    this.replayTick = this.market.tick;
    this.requestRender();
  },

  /* -------- Render loop -------- */

  requestRender() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.render();
    });
  },

  render() {
    const view = this.replayMode
      ? Replay.buildViewAt(this.market, this.logger, this.replayTick, this.ctx)
      : Replay.buildLiveView(this.market, this.logger, this.agents, this.ctx);

    UI.render(view, this.config);
    UI.setReplayPosition(view.tick, this.market.tick, !this.replayMode);
  },
};

function bootApp() {
  window.App = App;
  App.init();
}
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootApp);
} else {
  bootApp();
}
