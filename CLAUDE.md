# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Browser-based replication of the Dufwenberg, Lindqvist & Moore (2005) continuous
double auction experimental market, extended with a "Utility" agent type that
supports inter-agent messaging, trust, and optional deception. Pure HTML + CSS +
vanilla JavaScript, no frameworks, no build step, no dependencies. Open
`index.html` directly in a browser to run.

## Architecture

The runtime is organized as a pipeline from simulation core → logging → view
construction → rendering. Each layer only talks to the one below it.

```
main.js       App state, control wiring, render scheduling (rAF-coalesced)
  │
engine.js     Simulation loop + seeded mulberry32 PRNG, dividend draws
  │
market.js    ─ Order, Trade, OrderBook (price-time priority), Market
agents.js    ─ Agent base + Fundamentalist/Trend/Random/DLMTrader/Utility +
                sampling helpers. At runtime all 100 slots are
                `UtilityAgent`; the F/T/R/DLMTrader classes are retained
                for the legacy presets and the Strict-DLM/AIPE paradigms
                described below. Decisions return order objects with a
                reasoning trace attached. `DLMTrader` has a single class
                with a two-branch `decide()` gated on an endogenous
                `roundsPlayed` counter — it starts at 0 and is incremented
                by the engine at every round boundary, flipping the agent
                from the bubble-prone novice branch to the FV-anchored
                veteran branch. No agent is ever instantiated with
                `roundsPlayed > 0`; experience is purely procedural.
messaging.js ─ Message bus + trust tracker (only used by UtilityAgent)
utility.js   ─ UtilityAgent belief/valuation model + UTILITY_DEFAULTS
ai.js        ─ AIPE (Wang) paradigm only: thin wrapper around the OpenAI
                /v1/chat/completions API. `App.start()` awaits
                `AI.getPsychAnchors()` when paradigm === 'wang' and a key
                is set, then writes each returned anchor to the agent's
                `psychAnchor` so the first order reflects the LLM's prior
                instead of `FV × (1 + bias + noise)`. This is the only
                async boundary in the app; the key is never persisted.
logger.js    ─ Append-only trace, snapshot, and event stores
  │
replay.js     Build "view" objects from Market + Logger state, either live
              (buildLiveView) or at a historical tick (buildViewAt)
  │
viz.js        HiDPI canvas drawing primitives
mathml.js     Single source of truth for every math symbol in the UI.
              Native browser MathML (no KaTeX / MathJax — preserves the
              no-dependency promise). Dynamic renderers embed `Sym.<key>`
              in template literals; static HTML uses
              `<span data-sym="key">` placeholders that `hydrateSymbols()`
              fills on `DOMContentLoaded`. New symbols go in the `Sym` map
              here, never inline in ui.js.
ui.js         DOM + canvas rendering; consumes views only, never touches
              Market/Engine/Agent directly — so live and replay rendering
              go through identical code paths
```

Invariants that the replay system relies on:

- History arrays on `Market` (`priceHistory`, `trades`, `volumeByPeriod`,
  `dividendHistory`) and on `Logger` are **append-only**. Never mutate or
  remove entries — `Replay.buildViewAt(tick)` reconstructs a past state by
  slicing to a recorded length.
- All randomness flows through the seeded RNG passed into `Engine`. Do not
  call `Math.random()` from agent or market code, or reproducibility by
  `(population, seed)` pair breaks.
- `ui.js` must never reach into `Market`/`Engine`/`Agent` state directly;
  always go through a view object from `replay.js`.

## Session structure: rounds, periods, and the 10-session batch

A single press of Start runs a **10-session batch** — 5 sessions with the
first selected DLM treatment (T20 or T40) followed by 5 with the other.
Each *session* is `roundsPerSession` consecutive *rounds* (fixed at
`R = 4`, the DLM 2005 design). Each round is a complete `T = 10` period
market that lasts `T × ticksPerPeriod = 180` ticks, so a session is
`R × T × K = 720` ticks and a full batch is 7 200 ticks.

`App.currentSession` tracks which session is active (1–10); it is set to
0 between batches and on manual Reset. The per-round data collector in
`start()`'s `onEnd` callback labels every round with `R{r}_S{s}` (e.g.
`R3_S7` = round 3 of session 7) and stores it in `App.batchResults`.

At the end of period `T` of a non-final round the `Engine`:

1. snapshots every surviving agent's cash into
   `Logger.roundFinalCash[r-1]` for payoff accounting,
2. logs a `round_end` event,
3. **increments every surviving agent's `roundsPlayed` by one**, so any
   `DLMTrader` that just finished a round flips from the inexperienced
   branch to the experienced branch for the next round,
4. if the round that just ended was round 3 and `ctx.treatmentSize > 0`,
   runs `_round4Replacement()` — Fisher-Yates selects `treatmentSize`
   experienced agents (T20 = 20 replacements, T40 = 40), clones their
   specs with a fresh name drawn from `AGENT_NAMES`, and re-instantiates
   them via `buildAgentsFromSpecs` at the vacated numeric ids with
   `roundsPlayed = 0` and `replacementFresh = true`,
5. rewinds every surviving agent's `cash` and `inventory` to its
   `agentSpecs` entry (the fresh splice-ins take their own replacement
   endowment on the same call),
6. clears the order book and sets `lastPrice = null`,
7. increments `Market.round`, resets `Market.period = 1`,
8. logs a `round_start` event,
9. calls `agent.onRoundStart()` so subclasses can null out per-round
   transient state (`TrendFollower` clears slope history; `UtilityAgent`
   rebases `initialWealth` and clears subjective/reported valuations and
   received messages).

What is **deliberately preserved** across the boundary: `roundsPlayed`
(the endogenous experience counter), trust matrices, belief modes, risk
preferences, and the agent's identity. That cross-round learning channel
is the whole point of DLM 2005's session structure (experience kills the
bubble), and the simulator reproduces it by leaving those fields
untouched in `_resetRound()` — only cash, inventory, and per-round
transient state rewind.

The per-round volume series lives in a single `Market.volumeByPeriod` array
of size `R × T + 2`, indexed by a global period
`g = (round − 1) × T + period`. Use `Market.sessionPeriod()` whenever you
need that index. Trades and `priceHistory` entries carry a `round` tag so
multi-round views can bucket them correctly.

The `replay.js` views and the `ui.js` charts both compute the full session
extent from `roundsPerSession` and draw round dividers at every round
boundary; legacy single-round runs still work because all of the multi-round
logic falls through cleanly when `roundsPerSession = 1`.

## Parameters panel and tunables

Every numeric constant that shapes the sim is exposed in the Parameters panel
in `index.html` and mirrored into `App.tunables` in `main.js`. Market-level
knobs mirror `App.config`; the rest mirror `UTILITY_DEFAULTS` in `js/agents.js`.
The engine and agents read from `ctx.tunables` when present and fall back to
`UTILITY_DEFAULTS` via the `tunable()` helper when a key is missing — so
tunables that aren't exposed as sliders still have a safe default.

The Advanced settings panel exposes three boolean toggles — **Prior
Bias**, **Prior Noise**, and **Complex Dividends** — wired to
`App.tunables.applyBias` / `App.tunables.applyNoise` /
`App.tunables.applyComplexDividends`, plus a single **Regulator**
slider (0–100%) gated by the `.plan-llm-only` CSS class so it only
renders when the body carries `plan-ii` or `plan-iii`. The slider
value drives both `App.tunables.regulatorThreshold` (= value/100) and
`App.tunables.applyRegulator` (= value > 0); zero is the canonical
disabled state and is also the default, so a fresh load posts no
regulator interventions until the user moves the slider. Prior Bias and Prior Noise act on
the prior: it becomes `FV̂ × (1 + bias + noise)` where `bias` is the
agent's persistent `biasMode × biasAmount` tilt and `noise` is an
i.i.d. per-tick draw from `U[-valuationNoise, +valuationNoise]`.
When all three are off the prior collapses to the exact FV (pure
Plan I baseline). Toggle state is captured in every engine snapshot
and surfaces in the reasoning trace (`biasActive`, `noiseActive`,
`complexActive`), the replay view (`v.tunables`), and the Plan II/III
LLM prompt (under "YOUR PRIVATE STATE").

**Regulator** is a Plan II/III feature: when the slider value > 0 the
engine computes the bubble ratio `|P_t − FV_t| / FV_t` at every period
boundary and, the first time it crosses `regulatorThreshold` within a
round, sets a sticky
`ctx.regulatorWarning = { ratio, threshold, period, round, firedTick,
lastPrice, fv }` and logs a `regulator_warning` event. `_resetRound()`
clears the warning at the next round boundary so each round starts
clean. `ai.js` reads the warning as the 8th argument to
`getPlanBeliefs` and prepends a top-of-prompt `⚠️ REGULATOR WARNING ⚠️`
block to every Utility agent's LLM prompt for the rest of that round,
naming the bubble ratio and reminding the agent the asset's intrinsic
payoff has not changed. Plan I has no LLM channel, so under Plan I the
toggle is recorded in the snapshot but does not change agent behavior;
the warning event still fires so a replay shows where the regulator
*would* have intervened.

**Complex Dividends** replaces the paper's `{0, 20}¢` coin flip with a
5-point distribution `{0, 4, 10, 20, 40}¢` with probabilities
`{0.30, 0.25, 0.20, 0.15, 0.10}`. The expected dividend is still
`μ_d = 10¢` so the true FV_t is unchanged, but the weighted sum is
non-trivial to read off the table. This models bounded rationality:
when the toggle is ON each `UtilityAgent.updateBelief` stops using
the exact FV and instead forms `FV̂_t = μ̂_i · (T − t + 1)` where
`μ̂_i = x̄_n · (1 + ξ_i)`, `x̄_n` is the agent's empirical mean of
the dividends it has actually observed (filtered by `roundsPlayed`
so round-4 fresh replacements start with an empty sample), and
`ξ_i ~ U[-σ_n, +σ_n]` with `σ_n = 0.35/√(n+1)` is a per-tick
computational-noise term that shrinks as samples accumulate. A
novice with zero draws is off by up to ±35%; a veteran with many
draws converges to the truth — exactly the "experience kills the
bubble" channel DLM documents, here given a computational
interpretation. The distribution constant lives in
`COMPLEX_DIVIDEND_DISTRIBUTION` in `js/market.js`; `Market.payDividend`
reads the tunable off `ctx` and switches draws accordingly.

The **Risk preferences** subsection uses three linked sliders
(α<sub>L</sub>/α<sub>N</sub>/α<sub>A</sub>) that always sum to 100 and drive
a composition bar (`#comp-bar`) above them. `App.riskMix` holds the current
split and is read by the sampling stage; `distributeRiskPrefs` in
`agents.js` turns those percentages into a per-slot `riskPref` override
(loving/neutral/averse), so the sliders directly control how many utility
agents of each risk type are instantiated without disturbing the
bias/deception/belief variety in the strategy cube.

## Sampling stage (names + endowments)

Before the simulation starts, `sampleAgents(mix, rng, options)` in
`agents.js` draws a flat list of per-agent specs from the current `mix`.
Each spec carries:

- `id`, `slot`, `type`, `typeLabel` (U1, U3, …)
- `name` — a random personal name drawn without replacement from
  `AGENT_NAMES`
- `cash`, `inventory` — drawn from `ENDOWMENT_DEFAULT` (uniform
  [800, 1200] cash, uniform {2,3,4} inventory)
- strategy fields for utility agents (`riskPref`, `biasMode`, …)

`App.agentSpecs` caches the current draw. The **Agents** panel shows the
spec list as editable cards before `tick === 0`; editing cash/inventory
commits through `App.updateEndowment(id, field, value)` which mutates the
spec in place and calls `App.rebuild()` — no reseed, no re-sample, the
edits survive. Structural changes (risk shares) and the header's
**Reset** button call `App.reset()` instead, which
rolls a new engine seed via `Math.random()`, nulls the spec cache, and
delegates to `rebuild()` so a fresh population is drawn against the new
seed. There is no seed input in the UI and no separate Resample button
— "start over with different agents" is the default behavior of Reset.

The sample RNG is derived from `seed ^ 0xA5A5A5A5` and is intentionally
independent of the engine RNG (`makeRNG(seed)`), so endowment edits +
rebuild produce the same per-tick trading sequence as a matched run
without an edit.

When adding a new tunable:
1. Add the slider row in `index.html` with a `data-tip` explanation.
2. Add the default to `App.tunables` in `main.js`.
3. Wire read/write in the parameter-panel setup in `main.js`.
4. Read it from `ctx.tunables` in the consuming agent/engine code with a
   fallback to the hard-coded default so legacy callers still work.

Total population is scaled to N = 100 (DLM 2005 §I pins it at 6; the
simulator scales up for a thicker order book while keeping the R = 4
round structure and the round-4 replacement fractions). DLM uses
homogeneous human subjects with no algorithmic agent types
(Fundamentalist/Trend/Random are not part of the DLM design). All
100 slots are utility agents; the only composition knob is the
risk-preference split (αL/αN/αA).

## Paradigms

The navbar switches between three paradigms; each pins a different
sampling pipeline and a different set of visible controls.

| Paradigm    | Composition                                         | Purpose                                                         |
|-------------|-----------------------------------------------------|-----------------------------------------------------------------|
| Strict-DLM  | 100 `DLMTrader`, 50 × type A + 50 × type B          | Scaled replication of Dufwenberg–Lindqvist–Moore (2005)         |
| Lopez-Lira  | 100 `UtilityAgent` (strategy cube over bias/belief/risk) | Expected-utility messaging market from Lopez-Lira (2025)   |
| AIPE        | Utility block + fixed F/T/R background              | AI-Agent Prior Elicitation on top of the Lopez-Lira model       |

The paradigm table above is the conceptual decomposition, but at
runtime the simulator always uses `sampleAgents(mix, rng, options)`
with 100 `UtilityAgent` slots. The T20/T40 treatment selector in Trade
Settings controls the round-4 replacement size.

**10-session batch.** One press of Start runs 10 sessions animated
at the Speed slider rate (5 × first selected treatment + 5 × the
other). Each session calls `reset()` for a fresh seed, then
`engine.start()` with an `onEnd` callback that collects per-round
metrics labeled `R{r}_S{s}` into `App.batchResults` (40 rows total:
4 rounds × 10 sessions). The batch results panel (Table 2 in the
Experiment tab) renders these rows with per-treatment aggregates.
Pause stops the chain via `_batchRunning = false`.

The shorthand T20/T40 preserves DLM's R4-⅔ / R4-⅓ labelling at
N = 100: **T20 ↔ R4-⅔** (20 fresh replacements, 80 veterans) and
**T40 ↔ R4-⅓** (40 fresh replacements, 60 veterans). The DLM
⅔ / ⅓ fractions refer to the original 6-subject design and are
kept as names; at N = 100 the actual remaining-veteran fractions
are 80/100 and 60/100 respectively.

Session payoff for agent `i` is
`π_i = Σ_r roundFinalCash[r-1][i] + 500¢` (the show-up fee), captured
by `Logger.logRoundFinalCash` at the end of period `T` of every round.

Fundamental value at the start of period *t* of any round is
`FV_t = dividendMean × (T − t + 1)` — a staircase from `FV_1 = 100` to
`FV_T = 10` that resets at every round boundary.

## Companion directories

- `latex/` — LaTeX source for the accompanying paper (has its own `README.md`).
- `pdf/` — compiled paper artifacts.
- `arch-*.drawio` (four files in the repo root: `pipeline`, `microstructure`,
  `elicitation`, `revision`) — architecture diagrams. Open these in drawio
  when the big picture is in question rather than inferring it from code.

## Working in this repo

- No build, no tests, no package manager. Verify changes by opening
  `index.html` in a browser (`open index.html` on macOS) and exercising
  the sliders and Start/Pause/Reset.
- Live site <https://stock.m0nius.com> is served via GitHub Pages
  (`CNAME` in repo root). Pushes to `master` auto-deploy, so keep commits
  scoped tightly and do the browser check before pushing.
- Prefer editing existing modules over adding new ones — the module boundaries
  above are load-bearing for the replay system.
- Keep the code framework-free and dependency-free. No npm, no bundler, no
  transpilation. All JS files use `'use strict'` and are loaded as plain
  `<script>` tags from `index.html`.
- Match the existing commenting style: module header block explaining the
  role of the file, short inline comments only where the *why* is non-obvious.
