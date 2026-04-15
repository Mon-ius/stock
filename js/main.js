'use strict';

/* =====================================================================
   main.js — Application bootstrap + control wiring.

   Owns App.state: tunables, agents, market, engine, logger, regulator.
   Drives parameter-panel two-way binding, start/pause/reset, per-agent
   trace toggling, replay scrubber.
   ===================================================================== */

const App = {

  state: null,

  config: {
    periods:          10,
    ticksPerPeriod:   18,
    roundsPerSession: 4,
    aggregateWindow:  10000,
    maxTracePerAgent: 5000,
  },

  tunables: {
    // HMM dividend
    muH: 14, muL: 4, sigma: 2.5, pHH: 0.85, pLL: 0.85,
    // Population
    N: 100,
    risk:       { loving: 33, neutral: 34, averse: 33 },
    cognitive:  { naive:  50, kalman:  35, analytical: 15 },
    reaction:   { ignore: 40, discount: 40, panic: 20 },
    biasShare:  0.5,
    llmShare:   0.0,
    tracedCount: 6,
    // Agent mechanics
    biasAmount: 0.15, valuationNoise: 0.03, passiveFillProb: 0.30,
    priorMix: 0.6, discountGamma: 0.12, panicAskBias: 0.05,
    trustLambda: 0.30, applyBias: true, applyNoise: true,
    peerWindow: 1, ticksPerPeriod: 18,
    // Regulator
    regulatorMode:       'warn',   // 'off' | 'warn' | 'halt'
    regulatorThreshold:  1.35,
    regulatorPersistence:4,
    regulatorCooldown:   30,
    regulatorHaltTicks:  6,
    regulatorDiscount:   20,
    // UI
    speed: 14,
  },

  seed:        null,
  agentSpecs:  null,
  bus:         null,
  trust:       null,
  hmm:         null,
  regulator:   null,
  logger:      null,
  engine:      null,
  market:      null,
  agents:      null,
  refEstimator: null,
  scheduled:   false,

  init() {
    this.refreshTheme();
    this._wireParams();
    this._wireControls();
    UI.bindTable(
      (id) => { this.logger.toggleTrace(id, this.agents); this._scheduleRender(); },
      (id) => { this._downloadTrace(id); },
    );
    UI.bindMessageFilter();
    this.reset();
  },

  refreshTheme() { UI.refreshTheme(); },

  /* ---------- Lifecycle ---------------------------------------------- */

  reset() {
    this.seed = Math.floor(Math.random() * 0xFFFFFFFF);
    this.agentSpecs = null;
    this.rebuild();
  },

  rebuild() {
    // Pause any running engine + its render-tick hook before tearing down
    // the state it references — otherwise the old engine keeps stepping
    // the previous agents/market on the next rAF and the UI shows stale
    // counts even though new state was constructed underneath.
    if (this.engine)     this.engine.pause();
    if (this._tickHook) { clearInterval(this._tickHook); this._tickHook = null; }
    const T       = this.tunables;
    const rng     = makeRNG(this.seed ^ 0xA5A5A5A5);
    const engRng  = makeRNG(this.seed);

    this.hmm = new HMMDividend({
      muH: T.muH, muL: T.muL, sigma: T.sigma, pHH: T.pHH, pLL: T.pLL,
    });

    if (!this.agentSpecs) {
      this.agentSpecs = sampleAgents(T.N, {
        risk:        T.risk,
        cognitive:   T.cognitive,
        reaction:    T.reaction,
        biasShare:   T.biasShare,
        llmShare:    T.llmShare,
        tracedCount: T.tracedCount,
        endowment:   { cashLo: 800, cashHi: 1200, invLo: 2, invHi: 4 },
      }, rng);
    }

    this.bus       = new MessageBus();
    this.trust     = new TrustMatrix(T.N);
    this.market    = new Market({ ...this.config, roundsPerSession: this.config.roundsPerSession }, this.hmm);
    this.regulator = new Regulator(this.bus, this.hmm, {
      mode:          T.regulatorMode,
      threshold:     T.regulatorThreshold,
      persistence:   T.regulatorPersistence,
      cooldown:      T.regulatorCooldown,
      haltTicks:     T.regulatorHaltTicks,
      discountTicks: T.regulatorDiscount,
    });
    this.refEstimator = new AnalyticalEstimator(this.hmm);
    this.logger = new Logger(this.config, { trust: this.trust, bus: this.bus });

    const deps = {
      bus:   this.bus,
      trust: this.trust,
      regulator: this.regulator,
      tunables:  { ...T, ticksPerPeriod: this.config.ticksPerPeriod },
      makeEstimator: (kind) => makeEstimator(kind, this.hmm),
      llm:   LLM,
    };
    const agents = {};
    for (const spec of this.agentSpecs) agents[spec.id] = new UtilityAgent(spec, deps);
    this.agents = agents;

    this.engine = new Engine(
      this.market, this.agents, this.logger, this.regulator, this.trust,
      { ...this.config, tunables: T, speed: T.speed },
      engRng, this.refEstimator,
    );

    this._scheduleRender();
  },

  start() {
    if (!this.engine) return;
    this.engine.config.speed = this.tunables.speed;
    if (this._tickHook) clearInterval(this._tickHook);
    this._tickHook = setInterval(() => this._scheduleRender(), 60);
    this.engine.start(() => {
      clearInterval(this._tickHook); this._tickHook = null;
      this._scheduleRender();
    });
  },

  pause() {
    if (this.engine) this.engine.pause();
    if (this._tickHook) { clearInterval(this._tickHook); this._tickHook = null; }
    this._scheduleRender();
  },

  /* ---------- Render scheduling -------------------------------------- */

  _scheduleRender() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      const view = Replay.buildLiveView({
        market:    this.market,
        agents:    this.agents,
        logger:    this.logger,
        bus:       this.bus,
        trust:     this.trust,
        regulator: this.regulator,
        config:    this.config,
        tunables:  this.tunables,
      });
      UI.render(view);
    });
  },

  /* ---------- Parameter panel wiring --------------------------------- */

  _wireParams() {
    const T = this.tunables;

    this._slider('p-N', 'v-N', T.N, 6, 200, 1, (v) => { T.N = v; this.agentSpecs = null; this.rebuild(); });

    // HMM
    this._slider('p-muH',  'v-muH',  T.muH,  5, 30, 0.5, (v) => { T.muH  = v; this.rebuild(); });
    this._slider('p-muL',  'v-muL',  T.muL,  0, 15, 0.5, (v) => { T.muL  = v; this.rebuild(); });
    this._slider('p-sigma','v-sigma',T.sigma,0.1,8,0.1,  (v) => { T.sigma = v; this.rebuild(); });
    this._slider('p-pHH',  'v-pHH',  T.pHH,  0.5, 0.99, 0.01, (v) => { T.pHH = v; this.rebuild(); });
    this._slider('p-pLL',  'v-pLL',  T.pLL,  0.5, 0.99, 0.01, (v) => { T.pLL = v; this.rebuild(); });

    // Risk mix (linked, sum=100)
    this._linkedTriplet('risk',     ['loving', 'neutral', 'averse'],        'p-risk',  'v-risk');
    this._linkedTriplet('cognitive', ['naive', 'kalman', 'analytical'],     'p-cog',   'v-cog');
    this._linkedTriplet('reaction', ['ignore', 'discount', 'panic'],        'p-react', 'v-react');

    // Bias + LLM share + traced count
    this._slider('p-biasShare', 'v-biasShare', T.biasShare, 0, 1, 0.05, (v) => { T.biasShare = v; this.agentSpecs = null; this.rebuild(); });
    this._slider('p-llmShare',  'v-llmShare',  T.llmShare,  0, 1, 0.05, (v) => { T.llmShare  = v; this.agentSpecs = null; this.rebuild(); });
    this._slider('p-traced',    'v-traced',    T.tracedCount, 0, 20, 1,  (v) => { T.tracedCount = v; this._refreshTracing(); });

    this._toggle('p-applyBias',  T.applyBias,  (v) => { T.applyBias = v; this.rebuild(); });
    this._toggle('p-applyNoise', T.applyNoise, (v) => { T.applyNoise = v; this.rebuild(); });

    // Regulator
    this._select('p-regMode', T.regulatorMode, (v) => { T.regulatorMode = v; this.rebuild(); });
    this._slider('p-regThresh', 'v-regThresh', T.regulatorThreshold, 1.05, 2.0, 0.05, (v) => { T.regulatorThreshold = v; this.rebuild(); });
    this._slider('p-regPersist','v-regPersist',T.regulatorPersistence, 1, 20, 1,     (v) => { T.regulatorPersistence = v; this.rebuild(); });
    this._slider('p-regCool',   'v-regCool',   T.regulatorCooldown, 5, 120, 5,        (v) => { T.regulatorCooldown = v; this.rebuild(); });
    this._slider('p-regDisc',   'v-regDisc',   T.regulatorDiscount, 5, 60, 5,          (v) => { T.regulatorDiscount = v; this.rebuild(); });
    this._slider('p-discGamma', 'v-discGamma', T.discountGamma,    0.02, 0.4, 0.02,    (v) => { T.discountGamma = v; });

    // Speed
    this._slider('p-speed', 'v-speed', T.speed, 1, 60, 1, (v) => {
      T.speed = v;
      if (this.engine) this.engine.config.speed = v;
    });
  },

  _slider(inputId, valueId, init, min, max, step, onChange) {
    const input = document.getElementById(inputId);
    const val   = document.getElementById(valueId);
    if (!input) return;
    input.min = min; input.max = max; input.step = step;
    input.value = init;
    if (val) val.textContent = init;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (val) val.textContent = Number.isInteger(step) ? v : v.toFixed(2);
      onChange(v);
    });
  },

  _toggle(id, init, onChange) {
    const input = document.getElementById(id);
    if (!input) return;
    input.checked = init;
    input.addEventListener('change', () => onChange(input.checked));
  },

  _select(id, init, onChange) {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.value = init;
    sel.addEventListener('change', () => onChange(sel.value));
  },

  /**
   * Three linked sliders that sum to 100. `keys` matches the three
   * tunables[prefix][key] slots.
   */
  _linkedTriplet(prefix, keys, inputPrefix, valuePrefix) {
    const T = this.tunables;
    const group = T[prefix];
    const inputs = keys.map(k => document.getElementById(`${inputPrefix}-${k}`));
    const values = keys.map(k => document.getElementById(`${valuePrefix}-${k}`));
    if (inputs.some(el => !el)) return;
    for (let i = 0; i < keys.length; i++) {
      inputs[i].min = 0; inputs[i].max = 100; inputs[i].step = 1;
      inputs[i].value = group[keys[i]];
      if (values[i]) values[i].textContent = `${group[keys[i]]}%`;
    }
    const apply = () => {
      const rawSum = keys.reduce((s, _, i) => s + parseFloat(inputs[i].value), 0) || 1;
      for (let i = 0; i < keys.length; i++) {
        const v = Math.round((parseFloat(inputs[i].value) / rawSum) * 100);
        group[keys[i]] = v;
        if (values[i]) values[i].textContent = `${v}%`;
      }
      this.agentSpecs = null;
      this.rebuild();
    };
    for (const input of inputs) input.addEventListener('change', apply);
  },

  _wireControls() {
    const q = (id) => document.getElementById(id);
    q('btn-start')?.addEventListener('click', () => this.start());
    q('btn-pause')?.addEventListener('click', () => this.pause());
    q('btn-reset')?.addEventListener('click', () => this.reset());
    q('btn-step')?.addEventListener('click',  () => { this.engine.tickOnce(); this._scheduleRender(); });
    q('btn-export')?.addEventListener('click', () => this._exportSession());
  },

  _refreshTracing() {
    const K = this.tunables.tracedCount;
    const ids = Object.keys(this.agents || {}).map(Number).sort((a, b) => a - b);
    for (const id of ids) this.agents[id].traced = id < K;
    this._scheduleRender();
  },

  _downloadTrace(id) {
    if (!this.logger) return;
    const csv = this.logger.exportTraceCSV(id);
    if (!csv) return;
    const agent = this.agents[id];
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href  = url;
    link.download = `trace-${agent ? agent.name : id}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  _exportSession() {
    if (!this.logger) return;
    const payload = {
      seed: this.seed,
      tunables: this.tunables,
      session:  this.logger.exportSession(),
      messages: this.bus.exportCSV(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href  = url;
    link.download = `session-${this.seed}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

};

document.addEventListener('DOMContentLoaded', () => App.init());
