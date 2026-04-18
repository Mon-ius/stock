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
  // ("rounds") with the same population sharing across rounds 1-3 (the
  // paper pins it at six traders; this simulator scales to one hundred)
  // and a mixed-experience swap in round 4. One round lasts
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

  // Total population size, scaled to N = 100 (was fixed at 6 per
  // DLM 2005 §I; the scaled-up regime keeps the same round-4
  // treatment fractions while giving the order book a thicker
  // population).
  TOTAL_N: 100,

  // Population composition — feeds the sampling stage in agents.js.
  // Total N is pinned at 100. F (Fundamentalist) and T (Trend follower)
  // are user-adjustable via sliders (can be 0 for a pure utility-agent
  // market); U is derived as TOTAL_N − F − T so all 100 slots are
  // always filled. F and T provide the initial price heterogeneity
  // that bootstraps non-degenerate trading under Plan I's DLM belief
  // model (prior = FV, peer-message blend with experience weight w).
  mix: { F: 0, T: 0, R: 0, U: 100 },

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
    // When true the per-period dividend is drawn from a non-trivial
    // 5-point distribution with the same mean μ_d = 10¢ as the paper's
    // {0, 20}¢ coin flip, and each UtilityAgent builds its prior from
    // its own empirical dividend mean plus shrinking computational
    // noise instead of from the exact FV — a bounded-rationality
    // model where experienced agents compute FV more accurately than
    // novices. See Market.payDividend and UtilityAgent.updateBelief.
    applyComplexDividends: false,
    // Plan II / Plan III — Regulator. A single slider in Advanced
    // settings drives both `applyRegulator` and `regulatorThreshold`:
    // value = 0 → disabled; value ∈ (0, 100] → enabled with threshold
    // value/100 (so 50 = 0.50 = warn when |P − FV|/FV ≥ 50%). When
    // enabled the engine monitors the bubble ratio at every period
    // boundary and the first time it crosses the threshold within a
    // round it injects a one-shot REGULATOR WARNING into every Utility
    // agent's LLM prompt for the rest of that round. Plan I has no LLM
    // channel and ignores the warning; the snapshot still captures the
    // toggle so a replay shows where the regulator would have fired.
    applyRegulator:        false,
    regulatorThreshold:    0,
  },

  // Research plan — 'I' | 'II' | 'III'. Plan I is the algorithm-only
  // baseline: each utility agent's prior equals the current FV and it
  // blends peer messages with weight w = 0.6 + 0.1·min(3, roundsPlayed),
  // so the agent grows less susceptible to influence as rounds of
  // experience accumulate. Plan II calls an LLM every period and
  // includes the explicit universal CRRA form U(w; ρ) = w^(1−ρ)/(1−ρ)
  // with each agent's sampled ρ substituted in. Plan III calls the
  // same LLM but only tells it the risk-preference label. On network
  // or API failure, Plans II and III fall back to Plan I's algorithm.
  plan: 'I',

  // DLM treatment size for the round-4 replacement step (scaled to
  // N = 100). 20 = T20 (R4-⅔, 20 fresh, 80 veterans remain),
  // 40 = T40 (R4-⅓, 40 fresh, 60 veterans remain).
  treatmentSize: 20,

  // Round at which the treatment replacement fires: the engine swaps
  // `treatmentSize` veterans for fresh agents at the end of round
  // (replacementRound − 1), so replacementRound = 4 reproduces the DLM
  // 2005 paper schedule (fresh agents arrive for round 4). Exposed as
  // a slider in Advanced settings with range [2, roundsPerSession];
  // clamped automatically when the user shrinks R below the current r.
  replacementRound: 4,

  // Per-session treatment sizes for the 10-session batch (integers in
  // [0, TOTAL_N]). Default seed reproduces DLM 2005 at the symmetric
  // split once setTotalN fires for the first time: sessions 1-5 take
  // T-small, sessions 6-10 take T-big. Values populate lazily in
  // rebuild() because we need _treatmentsFor(TOTAL_N) to resolve first.
  sessionRates: null,

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
    this._initRichTips();
    this.reset();
  },

  /* ----- Rich hover tooltips ---------------------------------------
     A single floating <div class="rich-tip"> is appended to the body
     once, then populated from a <template id="tpl-<key>"> matching
     the hovered element's data-tip-id. Native MathML inside the
     template renders through the browser's math engine, so the
     formulas in the Advanced settings popups use the same rendering
     path as the Architecture tab — no plain-text Unicode math, no
     drift from the app's canonical look. Hydration runs on the
     cloned subtree so any <span data-sym="..."> placeholders in the
     template get filled from the shared Sym map. */
  _initRichTips() {
    if (this._richTip) return;
    const tip = document.createElement('div');
    tip.className = 'rich-tip';
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tip);
    this._richTip = tip;
    let current = null;
    const hydrate = (typeof window !== 'undefined' && window.hydrateSymbols) || null;

    const position = (target) => {
      // .rich-tip uses `position: fixed`, so coordinates are viewport-
      // relative and must NOT include window.scrollX/Y. getBoundingClientRect
      // already returns viewport-relative values; clamp against innerWidth
      // / innerHeight directly. Adding scroll offsets here (the previous
      // behaviour) was the reason the Prior Bias tooltip drifted off-
      // screen once the Advanced Settings section was scrolled into view.
      const rect = target.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      const margin  = 10;
      let left = rect.left;
      const maxLeft = window.innerWidth - tipRect.width - 4;
      if (left > maxLeft) left = maxLeft;
      if (left < 4) left = 4;
      // Prefer above; flip below if there isn't room.
      let top = rect.top - tipRect.height - margin;
      if (top < 4) top = rect.bottom + margin;
      tip.style.left = left + 'px';
      tip.style.top  = top + 'px';
    };

    const show = (target) => {
      const key = target.getAttribute('data-tip-id');
      if (!key) return;
      const tpl = document.getElementById('tpl-' + key);
      if (!tpl || !tpl.content) return;
      tip.innerHTML = '';
      tip.appendChild(tpl.content.cloneNode(true));
      if (hydrate) hydrate(tip);
      // Position requires the tip to be measurable — show invisibly
      // first so we can read its size, then flip to visible.
      tip.style.visibility = 'hidden';
      tip.classList.add('show');
      position(target);
      tip.style.visibility = '';
      tip.setAttribute('aria-hidden', 'false');
      current = target;
    };

    const hide = () => {
      if (!current) return;
      tip.classList.remove('show');
      tip.setAttribute('aria-hidden', 'true');
      current = null;
    };

    document.addEventListener('mouseover', (e) => {
      const t = e.target && e.target.closest && e.target.closest('[data-tip-id]');
      if (!t) return;
      if (t === current) return;
      if (current) hide();
      show(t);
    });
    document.addEventListener('mouseout', (e) => {
      const t = e.target && e.target.closest && e.target.closest('[data-tip-id]');
      if (!t || t !== current) return;
      // Only hide if the pointer left the target itself (not a child).
      if (t.contains(e.relatedTarget)) return;
      hide();
    });
    document.addEventListener('focusin', (e) => {
      const t = e.target && e.target.closest && e.target.closest('[data-tip-id]');
      if (!t || t === current) return;
      if (current) hide();
      show(t);
    });
    document.addEventListener('focusout', (e) => {
      const t = e.target && e.target.closest && e.target.closest('[data-tip-id]');
      if (!t || t !== current) return;
      hide();
    });
    window.addEventListener('scroll', hide, { passive: true });
    window.addEventListener('resize', hide);
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

    // Boolean toggles in Advanced settings (bias / noise on the prior,
    // complex-dividend regime).
    for (const key of ['applyBias', 'applyNoise', 'applyComplexDividends']) {
      const cb = document.getElementById('p-' + key);
      if (!cb) continue;
      cb.checked = !!this.tunables[key];
      cb.addEventListener('change', () => {
        this.tunables[key] = cb.checked;
        this.rebuild();
      });
    }

    // Regulator slider — single 0–100 control that drives both the
    // boolean enable flag and the threshold. Value 0 means disabled
    // (the canonical "off" state); values > 0 enable the regulator
    // with threshold = value / 100. Lives in the Plan II/III-only
    // row, hidden under Plan I. The enclosing tile gets the
    // .regulator-active class whenever the threshold is non-zero so
    // the border + readout pick up the red intervention accent.
    const regSlider = document.getElementById('p-regulator-threshold');
    if (regSlider) {
      const initPct = Math.round((this.tunables.regulatorThreshold || 0) * 100);
      regSlider.value = String(initPct);
      const out  = document.getElementById('v-regulator-threshold');
      const tile = regSlider.closest('.regulator-tile');
      const paint = (pct) => {
        if (out) out.textContent = pct > 0 ? pct + '%' : 'off';
        if (tile) tile.classList.toggle('regulator-active', pct > 0);
      };
      paint(initPct);
      regSlider.addEventListener('input', e => {
        const pct = (Number(e.target.value) | 0);
        this.tunables.regulatorThreshold = pct / 100;
        this.tunables.applyRegulator     = pct > 0;
        paint(pct);
        this._updateSliderPct(e.target);
      });
      regSlider.addEventListener('change', () => this.rebuild());
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

    // Per-session treatment-size grid. 10 compact sliders (one per
    // session), each spanning [0, TOTAL_N]. Built here once with the
    // current N as the upper bound; _rebuildSessionRateGrid rebuilds
    // the DOM from App.sessionRates whenever N or the underlying array
    // changes. Live `input` updates the chip summary; `change` commits
    // to App.sessionRates and triggers a reset so the next Start
    // picks up the new schedule.
    this._ensureSessionRates();
    this._rebuildSessionRateGrid();

    // Advanced settings — continuous population-scale slider (6 … 100).
    // The slider rewrites mix, treatmentSize, treatment radio labels,
    // the paper-constants N display, and reseeds the engine in one shot.
    // Live-update the readout while dragging; commit (rebuild) on release
    // so the user can scrub without triggering a full reset every pixel.
    const advN = document.getElementById('p-adv-n-total');
    const advNout = document.getElementById('v-adv-n-total');
    if (advN) {
      const _clampN = v => Math.max(6, Math.min(100, Number(v) | 0 || 100));
      advN.addEventListener('input', () => {
        const n = _clampN(advN.value);
        if (advNout) advNout.textContent = `${n} agents`;
        this._updateSliderPct(advN);
      });
      advN.addEventListener('change', () => {
        const n = _clampN(advN.value);
        this.setTotalN(n);
      });
    }

    // Advanced settings — rounds-per-session (R) and replacement-round
    // (r) sliders. Both share the same [2, 10] scale so their tracks
    // line up visually; every change to either slider repaints the
    // three-zone amber gradient on BOTH tracks (0 → r dark, r → R
    // medium, R → 10 neutral) so the r-must-lie-within-R invariant is
    // visible at a glance. Dragging R down past r drags r with it;
    // dragging r up past R is impossible — r gets clamped.
    const advR     = document.getElementById('p-adv-rounds');
    const advRout  = document.getElementById('v-adv-rounds');
    const advRep   = document.getElementById('p-adv-replace-round');
    const advRepOut = document.getElementById('v-adv-replace-round');
    const _clampR = v => Math.max(2, Math.min(10, Number(v) | 0 || 4));
    if (advR) {
      advR.addEventListener('input', () => {
        const R = _clampR(advR.value);
        if (advRout) advRout.textContent = `${R} rounds`;
        // Drag r down in lockstep when R drops below the current r —
        // the invariant r ≤ R must hold every animation frame, not
        // just on commit. The readout + slider handle update together.
        if (advRep && (Number(advRep.value) | 0) > R) {
          advRep.value = String(R);
          if (advRepOut) advRepOut.textContent = `r = ${R}`;
        }
        this._syncRrTracks();
      });
      advR.addEventListener('change', () => {
        const R = _clampR(advR.value);
        this.config.roundsPerSession = R;
        if (this.replacementRound > R) this.replacementRound = R;
        if (this.replacementRound < 2) this.replacementRound = 2;
        this._syncRoundsUi();
        this.reset();
      });
    }

    if (advRep) {
      const _clampRep = v => {
        const R = (this.config && this.config.roundsPerSession) || 4;
        return Math.max(2, Math.min(R, Number(v) | 0 || R));
      };
      advRep.addEventListener('input', () => {
        // Clamp visually too — if the user tries to drag beyond R,
        // snap the slider handle back to R so the handle stays
        // inside the amber medium band.
        const R = (this.config && this.config.roundsPerSession) || 4;
        if ((Number(advRep.value) | 0) > R) advRep.value = String(R);
        const r = _clampRep(advRep.value);
        if (advRepOut) advRepOut.textContent = `r = ${r}`;
        this._syncRrTracks();
      });
      advRep.addEventListener('change', () => {
        const r = _clampRep(advRep.value);
        this.replacementRound = r;
        this._syncRoundsUi();
        this.reset();
      });
    }

    // Prime the custom --pct on every slider so the filled portion of
    // the track matches the initial value before any interaction.
    this._updateAllSliderPcts();
    // Keep the paper-constants round card synced with the current
    // (R, r) pair in case defaults differ from the static HTML.
    this._syncRoundsUi();

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
   *   'II'  — LLM with the explicit universal CRRA utility
   *           U(w; ρ) = w^(1−ρ)/(1−ρ). Every period boundary the
   *           engine schedules an async `AI.getPlanBeliefs` call whose
   *           prompt substitutes each agent's sampled ρ into the
   *           shared functional form.
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
  /**
   * Round-4 replacement sizes for the selected population scale.
   * Linearly interpolates between the two anchor points so the slider
   * returns the paper-faithful T2/T4 pair at N = 6 and the scaled
   * T20/T40 pair at N = 100, with integer sizes in between. Both map
   * onto the same R4-⅔ / R4-⅓ semantic labels.
   */
  _treatmentsFor(n) {
    n = Math.max(6, Math.min(100, Number(n) | 0 || 100));
    const t = (n - 6) / (100 - 6);
    const small = Math.max(1, Math.round(2 + t * (20 - 2)));
    const big   = Math.max(small + 1, Math.round(4 + t * (40 - 4)));
    return { small, big, smallLabel: `T${small}`, bigLabel: `T${big}` };
  },

  /**
   * Keep the paper-constants round card and the replacement-round
   * slider's upper bound aligned with the current (R, r) pair. The
   * card's DLM 2005 quote is preserved; a short "currently running
   * at R = X" sentence is appended when R differs from the paper's 4.
   */
  _syncRoundsUi() {
    const R = (this.config && this.config.roundsPerSession) || 4;
    const r = this.replacementRound || 4;
    const constR = document.getElementById('const-rounds-total');
    if (constR) constR.textContent = `= ${R}`;
    const constNote = document.getElementById('const-rounds-note');
    if (constNote) {
      const paperQuote = '&ldquo;A session involved four consecutive markets. In the following, we shall talk in terms of four different rounds. Note the distinction between rounds and periods; a round (being a market) consists of ten periods.&rdquo;';
      const src = '<span class="const-src">§I, p. 1733 &middot; slider in Advanced settings</span>';
      constNote.innerHTML = (R === 4 && r === 4)
        ? `${paperQuote}${src}`
        : `${paperQuote} Currently running R = ${R} round${R === 1 ? '' : 's'} per session with replacement at the end of round ${r - 1} (fresh agents arrive for round ${r}).${src}`;
    }
    const advR = document.getElementById('p-adv-rounds');
    if (advR && Number(advR.value) !== R) {
      advR.value = String(R);
      this._updateSliderPct(advR);
      const advRout = document.getElementById('v-adv-rounds');
      if (advRout) advRout.textContent = `${R} rounds`;
    }
    const advRep = document.getElementById('p-adv-replace-round');
    if (advRep) {
      if (Number(advRep.value) !== r) {
        advRep.value = String(r);
        const advRepOut = document.getElementById('v-adv-replace-round');
        if (advRepOut) advRepOut.textContent = `r = ${r}`;
      }
    }
    this._syncRrTracks();
  },

  /**
   * Paint the three-zone amber gradient on the R and r slider tracks
   * from the current (R, r) pair. Both sliders use a shared [2, 10]
   * scale so the gradient stops project onto identical pixel positions
   * on both tracks — the user sees the invariant r ≤ R as a literal
   * stacking of colored bands that line up across rows.
   *
   *   0 → r : solid amber (rounds up to and including the replacement
   *           boundary — this is where the treatment fires).
   *   r → R : medium amber (rounds in session but after replacement).
   *   R → 10: neutral (rounds beyond the session horizon — greyed out).
   *
   * Each slider carries --r-pct / --R-pct custom properties consumed
   * by the track-gradient rule in styles.css. Reads the live DOM
   * values (not this.* state) so the tracks update mid-drag before
   * the `change` event commits.
   */
  _syncRrTracks() {
    const advR   = document.getElementById('p-adv-rounds');
    const advRep = document.getElementById('p-adv-replace-round');
    if (!advR && !advRep) return;
    const MIN = 2, MAX = 10, span = MAX - MIN;
    const Rv = Math.max(MIN, Math.min(MAX, Number(advR   && advR.value)   | 0 || 4));
    const rv = Math.max(MIN, Math.min(Rv,  Number(advRep && advRep.value) | 0 || 4));
    const rPct = ((rv - MIN) / span) * 100;
    const RPct = ((Rv - MIN) / span) * 100;
    [advR, advRep].forEach(el => {
      if (!el) return;
      el.style.setProperty('--r-pct', rPct + '%');
      el.style.setProperty('--R-pct', RPct + '%');
    });
  },

  /**
   * Switch the simulator population size. Rewrites every dependent
   * tunable in lockstep so no downstream caller is left holding a
   * stale N-derived value: mix shares, the F/T slider maxes and
   * badge, the round-4 treatment radio set (values + visible labels),
   * the paper-constants N display, and finally a full reset() so the
   * engine rebuilds its agent roster at the new scale.
   */
  setTotalN(n) {
    n = Math.max(6, Math.min(100, Number(n) | 0 || 100));
    this.TOTAL_N = n;
    this.mix = { F: 0, T: 0, R: 0, U: n };

    // Body class drives CSS overrides that rescale the canvases whose
    // default heights were tuned for the 100-agent regime (chart-trust
    // in particular). The cutover at N ≤ 12 keeps the thin-book layout
    // active for the paper-faithful six-subject scale and any nearby
    // values; above that the fan-out renderers take over automatically
    // via the UI.FAN_THRESHOLD branch in their own code paths.
    document.body.classList.toggle('n-small', n <= 12);

    // Keep the slider knob and readout in sync when setTotalN is called
    // programmatically (e.g. from the Reset button) rather than by user
    // drag — the `input` event path already covers drag updates.
    const advN = document.getElementById('p-adv-n-total');
    if (advN && Number(advN.value) !== n) {
      advN.value = String(n);
      this._updateSliderPct(advN);
    }
    const advNout = document.getElementById('v-adv-n-total');
    if (advNout) advNout.textContent = `${n} agents`;

    const tx = this._treatmentsFor(n);
    this.treatmentSize = tx.small;

    const elF = document.getElementById('p-count-f');
    const elT = document.getElementById('p-count-t');
    if (elF) { elF.max = String(Math.max(0, n - 1)); elF.value = '0'; this._updateSliderPct(elF); }
    if (elT) { elT.max = String(Math.max(0, n - 1)); elT.value = '0'; this._updateSliderPct(elT); }
    const outF = document.getElementById('v-count-f'); if (outF) outF.textContent = '0';
    const outT = document.getElementById('v-count-t'); if (outT) outT.textContent = '0';
    const outU = document.getElementById('v-util');    if (outU) outU.textContent = String(n);

    const badge = document.getElementById('mix-total');
    if (badge) badge.textContent = `(N = ${n})`;

    const constN = document.getElementById('const-n-total');
    if (constN) constN.textContent = `= ${n}`;
    const constNote = document.getElementById('const-n-note');
    if (constNote) {
      const paperQuote = '&ldquo;At each session, six subjects participated in a sequence of four consecutive markets for an experimental asset.&rdquo;';
      const src = '<span class="const-src">§I, p. 1733 &middot; slider in Advanced settings</span>';
      constNote.innerHTML = n === 6
        ? `DLM 2005 &sect;I: ${paperQuote} The simulator is currently running the paper-faithful six-subject population with ${tx.smallLabel}/${tx.bigLabel} round-4 treatments.${src}`
        : n === 100
          ? `DLM 2005 &sect;I pins the original design at six subjects &mdash; ${paperQuote} This simulator scales the population to N = 100 for a thicker order book while preserving the four-round session structure.${src}`
          : `DLM 2005 &sect;I pins the original design at six subjects &mdash; ${paperQuote} This session is running at an intermediate scale N = ${n}, with round-4 treatments ${tx.smallLabel}/${tx.bigLabel} interpolated linearly between the paper (6 &rarr; T2/T4) and scaled (100 &rarr; T20/T40) endpoints.${src}`;
    }

    // Refresh the treatment labels wherever they render (.tx-small-label
    // / .tx-big-label still appear in batch-result tables and copy,
    // even though the Trade-settings chip row no longer uses them).
    // querySelectorAll returns a NodeList so every occurrence updates
    // in a single pass.
    document.querySelectorAll('.tx-small-label').forEach(el => { el.textContent = tx.smallLabel; });
    document.querySelectorAll('.tx-big-label').forEach(el   => { el.textContent = tx.bigLabel;   });

    // Session rates are fractions in [0.10, 0.50] — invariant under N.
    // No reseed needed, but the chip tints / label readouts depend on
    // the percentage so we refresh the summary UI.
    this._syncSessionMixUi();
    this.reset();
  },

  /**
   * Ensure App.sessionRates is a populated 10-float array of replacement
   * fractions in [SESSION_RATE_MIN, SESSION_RATE_MAX]. Storing the
   * fraction (not an absolute agent count) makes the schedule invariant
   * under N changes — 20% replacement means 20% whether the population
   * is 6 or 100. The first-time default reproduces DLM 2005's symmetric
   * split at N = 100 (5 × T20 + 5 × T40 ↔ 5 × 0.20 + 5 × 0.40).
   */
  SESSION_RATE_MIN:  0.10,
  SESSION_RATE_MAX:  0.50,
  SESSION_RATE_STEP: 0.01,
  _ensureSessionRates() {
    if (!Array.isArray(this.sessionRates) || this.sessionRates.length !== 10) {
      this.sessionRates = new Array(10).fill(0).map((_, i) => i < 5 ? 0.20 : 0.40);
      return;
    }
    const lo = this.SESSION_RATE_MIN, hi = this.SESSION_RATE_MAX;
    for (let i = 0; i < 10; i++) {
      const v = Number(this.sessionRates[i]);
      this.sessionRates[i] = Math.max(lo, Math.min(hi,
        Number.isFinite(v) ? Math.round(v * 100) / 100 : 0.20,
      ));
    }
  },

  /** Convert a session-rate fraction + current N into an integer
   *  treatmentSize (number of agents replaced at the r-1 → r boundary).
   *  Centralised so start() and the export metadata agree on rounding. */
  _rateToTreatment(rate) {
    const N = this.TOTAL_N || 0;
    return Math.max(0, Math.min(N, Math.round(Number(rate) * N)));
  },

  /**
   * (Re)build the Advanced-settings per-session slider grid from the
   * current App.sessionRates + TOTAL_N. Called on init and whenever N
   * changes (slider max depends on N). Attaches input/change handlers
   * inline — `input` updates the chip summary live without reseeding,
   * `change` writes back to sessionRates and calls reset() so the new
   * schedule is picked up on the next Start.
   */
  _rebuildSessionRateGrid() {
    const grid = document.getElementById('session-rate-grid');
    if (!grid) return;
    this._ensureSessionRates();
    const lo = this.SESSION_RATE_MIN;
    const hi = this.SESSION_RATE_MAX;
    const step = this.SESSION_RATE_STEP;
    const fmt = (rate) => `${Math.round(rate * 100)}%`;
    grid.innerHTML = '';
    for (let s = 0; s < 10; s++) {
      const row = document.createElement('div');
      row.className = 'session-rate-item';

      const idx = document.createElement('span');
      idx.className = 'session-rate-idx';
      idx.textContent = `S${s + 1}`;

      const sl = document.createElement('input');
      sl.type = 'range';
      sl.className = 'session-rate-slider';
      sl.min = String(lo);
      sl.max = String(hi);
      sl.step = String(step);
      sl.value = String(this.sessionRates[s]);
      sl.dataset.session = String(s);

      const val = document.createElement('span');
      val.className = 'session-rate-val';
      val.textContent = fmt(this.sessionRates[s]);

      sl.addEventListener('input', () => {
        const raw = Number(sl.value);
        const v = Math.max(lo, Math.min(hi,
          Number.isFinite(raw) ? Math.round(raw * 100) / 100 : lo,
        ));
        val.textContent = fmt(v);
        this.sessionRates[s] = v;
        this._updateSliderPct(sl);
        this._syncSessionMixUi();
      });
      sl.addEventListener('change', () => {
        this.reset();
      });

      row.appendChild(idx);
      row.appendChild(sl);
      row.appendChild(val);
      grid.appendChild(row);
      this._updateSliderPct(sl);
    }
    this._syncSessionMixUi();
  },

  /**
   * Sync the Trade-settings session-mix summary + the Advanced-settings
   * rate-tile readout from the current App.sessionRates. Safe to call
   * any time. Builds 10 chips (one per session) with a rate-weighted
   * amber tint so the user can eyeball the schedule's distribution.
   */
  _syncSessionMixUi() {
    this._ensureSessionRates();
    const hi = this.SESSION_RATE_MAX || 0.5;
    const summary = document.getElementById('session-mix-summary');
    // The slider bar operates in percent (see _rebuildSessionRateGrid),
    // but the Trade-settings chips and the aggregate readout still
    // report the *integer* treatment count derived from rate × N — so
    // the session summary reads the same `T{n}` vocabulary as the
    // legacy UI and the batch-results table.
    if (summary) {
      summary.innerHTML = '';
      for (let s = 0; s < 10; s++) {
        const rate = this.sessionRates[s];
        const tn   = this._rateToTreatment(rate);
        const chip = document.createElement('span');
        chip.className = 'session-chip';
        chip.dataset.rate = String(tn);
        chip.style.setProperty('--intensity', String(Math.max(0, Math.min(1, rate / hi))));
        chip.innerHTML = `<span class="session-chip-idx">S${s + 1}</span><span class="session-chip-val">T${tn}</span>`;
        summary.appendChild(chip);
      }
    }
    const advOut = document.getElementById('v-adv-session-rates');
    if (advOut) {
      const meanRate = this.sessionRates.reduce((a, b) => a + b, 0) / 10;
      const meanTn   = this._rateToTreatment(meanRate);
      advOut.textContent = `mean T${meanTn}`;
    }
  },

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
      // Round-4 replacement: 20 (T20/R4-⅔) or 40 (T40/R4-⅓).
      treatmentSize: this.treatmentSize,
      // Round at which replacement fires (end of replacementRound − 1).
      // Defaults to 4 (DLM paper schedule); user-adjustable in Advanced
      // settings. Clamped to [2, roundsPerSession] at wiring time.
      replacementRound: this.replacementRound,
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
   * Run the 10-session batch. The Advanced-settings Session-split
   * slider decides how many of the 10 sessions use the small treatment
   * (round(split/10)); the rest use the big treatment. Sessions are
   * ordered small-first. Each session is a fresh game with a new seed
   * and fresh agents, animated at the current Speed setting. The onEnd
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
    this._ensureSessionRates();
    const rates = this.sessionRates.slice();
    this.batchResults = [];
    this._exportSessions = [];
    this._batchRunning = true;
    const btnExport = document.getElementById('btn-export');
    if (btnExport) btnExport.disabled = true;

    const runSession = (s) => {
      if (s >= SESSIONS) {
        this._batchRunning = false;
        this.currentSession = 0;
        this.treatmentSize = this._rateToTreatment(rates[0]);
        console.table(this.batchResults);
        if (btnExport) btnExport.disabled = false;
        this.requestRender();
        return;
      }
      // Rates are fractions in [0.1, 0.5]; the engine consumes an
      // integer agent count, so we project through the current N.
      const treatment = this._rateToTreatment(rates[s]);
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
      const txLabel     = `T${treatment}`;
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
    const replaceR = this.replacementRound || 4;
    for (let r = 1; r <= R; r++) {
      const label = `R${r}_S${sessionNum}`;
      rounds.push({
        round: r,
        label,
        metrics:        this.batchResults.find(b => b.label === label) || null,
        replacement:    r === replaceR && replEvt
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
      treatment:  `T${this.treatmentSize}`,
      treatmentPct: this.TOTAL_N > 0
        ? Math.round((this.treatmentSize / this.TOTAL_N) * 1000) / 10
        : 0,
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
