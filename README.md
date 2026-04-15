# Virtual Trading Platform

A fully self-contained, browser-based replication of the continuous double
auction experimental market from **Dufwenberg, Lindqvist & Moore, "Bubbles and
Experience: An Experiment" (AER 2005)**, extended with an AI-agent-style
**Utility (EU-maximizer)** agent that supports inter-agent messaging, trust,
and optional deception — inspired by Lopez-Lira (2025), *"Can Large Language
Models Trade?"*.

Pure HTML, CSS, and vanilla JavaScript. No frameworks, no build step, no
external libraries. Open `index.html` in any modern browser to run.

## Live demo

<https://stock.m0nius.com>

## What it does

- Simulates a continuous double auction where a finite-life asset is traded
  over **T periods** (default 10). Dividend per period is drawn uniformly from
  `{0, 2·μ}`, so the theoretical fundamental value at the start of period *t*
  is
  ```
  FV_t = (T − t + 1) · μ_d
  ```
  With the default `μ_d = 10`, FV starts at 100 and decays by 10 each period.
- Five agent strategies, each producing real order objects with a per-decision
  reasoning trace: **F** Fundamentalist, **T** Trend follower, **R** Random
  zero-intelligence, **E** Experienced, and **U** Utility. The Utility agent
  runs an explicit expected-utility argmax over candidate actions under one of
  three risk preferences — `U(w) = w²` (loving), `U(w) = w` (neutral), or
  `U(w) = √w` (averse) — and can optionally exchange messages, track trust in
  its peers, and lie about its valuation.
- On the default population the app boots with **100 Utility agents** so every
  extended panel (messaging, deception, trust) is reachable out of the box. The
  slider-driven mix reproduces the paper's classic bubble-under-inexperienced
  and convergence-under-experienced regimes as well.

## Features

- **Price-time priority order book** with self-match prevention.
- **Seedable PRNG** (mulberry32). Every run is reproducible from its
  `(population, seed)` pair; the Reset button rolls a fresh random seed and
  redraws the population, so "start over" is one click.
- **Pre-run agent draft.** Before `tick 0`, each agent appears as an editable
  card with a random personal name and endowment drawn from `[800, 1200]` cash
  and `{2, 3, 4}` shares. You can rewrite cash or inventory in place; edits
  survive non-structural slider changes.
- **Universal Parameters panel.** Every numeric constant that shapes the
  simulation is exposed as a slider with a tooltip explaining what it does and
  why the default is what it is: periods, ticks per period, dividend mean,
  total-N (proportional rescaling), per-type counts, risk-preference shares
  (α<sub>L</sub> / α<sub>N</sub> / α<sub>A</sub>), belief-update weights, trust
  learning rate, passive fill probability, valuation noise, and default bias
  magnitude.
- **Rich formal notation on every chart.** Each panel carries the paper's
  symbols (`FV_t = (T − t + 1)·μ_d`, `|P_t − FV_t|`, `ρ = P/FV`, `V̂_{i,t}` vs
  `Ṽ_{i,t}`, `a_{i,t}`, `q_{i,t}`, `u_{i,t}`, `m_{i→*,t}`, `T_{r→s}`) in its
  title, axes, and legend.
- **Extended Experiment Metrics** computed live: Haessel R², normalized
  absolute and average price deviation, price amplitude, and turnover (all from
  Dufwenberg 2005), plus the Lopez-Lira price-to-fundamental ratio `ρ = P/FV`,
  allocative efficiency, total welfare `Σ u_i`, and lie magnitude.
- **Full decision-trace system.** Every agent action is logged with the rule
  used, the trigger condition, expected utility / profit, and the agent's
  state at decision time.
- **Replay scrubber.** Pause the simulation, drag the slider to any past tick,
  and inspect the exact market state, agent wealth, and decision traces at
  that moment. Live and replay rendering go through identical code paths.
- **Dark / light / auto theme** with canvas colors synced from CSS custom
  properties.
- **No build step, no bundler, no dependencies.** Just open the file.

## Charts

| Chart                               | Notation                                  |
|-------------------------------------|-------------------------------------------|
| Price vs Fundamental Value          | `P̄_t` vs `FV_t = (T − t + 1)·μ_d`         |
| Bubble Magnitude                    | `|P_t − FV_t|` · `ρ_t = P_t / FV_t`       |
| Trade Volume per Period             | `V_t = Σ q`                               |
| Price × Period Density              | `H(P, t)`                                 |
| Agent Action Timeline               | `α ∈ {hold, buy@A_t, sell@B_t, bid, ask}` |
| Subjective Valuation (ext.)         | `V̂_{i,t}` vs reported `Ṽ_{i,t}`          |
| Agent Utility Over Time (ext.)      | `u_{i,t} = U_i(w_t) / U_i(w_0)`           |
| Asset Ownership Over Time (ext.)    | `q_{i,t}`, `Σ q_{i,t} = Q`                |
| Message Log Timeline (ext.)         | `m_{i→*,t} = (signal, Ṽ_{i,t})`           |
| Trust Matrix (ext.)                 | `T_{r→s} ∈ [0, 1]`                        |

Panels marked *(ext.)* are only visible when at least one Utility agent is in
the mix.

## File layout

```
index.html         HTML structure + parameters panel + chart panels
styles.css         Grid layout, custom range-input styling, light/dark theme
js/market.js       Order, Trade, OrderBook (price-time priority), Market
js/agents.js       Agent base + F/T/R/E/Utility strategies, sampling, names,
                   endowment draws, population presets
js/utility.js      UtilityAgent belief/valuation model + UTILITY_DEFAULTS
js/messaging.js    Message bus + trust tracker (used by UtilityAgent)
js/logger.js       Append-only trace, snapshot, and event stores
js/viz.js          HiDPI canvas primitives (axes, lines, areas, bars,
                   stacked areas, heat color, axis labels, legend rows)
js/engine.js       Simulation loop + seeded mulberry32 PRNG, dividend draws
js/replay.js       Live + historical view builders
js/ui.js           DOM + canvas rendering from view objects only
js/main.js         App state, parameter wiring, rAF-coalesced render scheduler
```

The replay system depends on the history arrays on `Market` and `Logger` being
append-only — `Replay.buildViewAt(tick)` reconstructs a past state by slicing
to a recorded length.

## Reference configurations

| Preset          | Composition                       | Expected outcome           |
|-----------------|-----------------------------------|----------------------------|
| Utility         | 100 Utility                       | Default on first load      |
| Inexperienced   | 2 Trend · 2 Random · 1 F · 1 E    | Classic bubble + crash     |
| Experienced     | 3 Experienced · 2 Fund · 1 Trend  | Tight convergence to FV    |
| Mixed           | 2 Fund · 2 Exp · 1 Trend · 1 Rand | Closest tracking of FV     |

Dial these in with the Population-mix sliders in the Parameters panel.

## References

- Dufwenberg, M., Lindqvist, T., & Moore, E. (2005). *Bubbles and Experience:
  An Experiment.* American Economic Review, 95(5), 1731–1737.
- Lopez-Lira, A. (2025). *Can Large Language Models Trade? Testing Financial
  Theories with LLM Agents in Market Simulations.* arXiv:2504.10789.
- Haessel, W. (1978). *Measuring Goodness of Fit in Linear and Nonlinear
  Models.* Southern Economic Journal, 44(3), 648–652.
