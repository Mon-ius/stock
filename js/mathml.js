/* ============================================================
 * mathml.js — single source of truth for every mathematical
 * symbol rendered in an HTML context anywhere in the app.
 *
 * Rendering engine
 * ----------------
 * We use native browser MathML — the math display engine built
 * into Chrome, Safari, Firefox and Edge. MathML is the W3C
 * standard for rendering mathematics in HTML: the browser
 * selects a real math font (STIX Two Math / Latin Modern Math
 * / Cambria Math) and uses the same sub/sup layout rules as a
 * typeset paper would. Picking native MathML instead of KaTeX
 * or MathJax keeps the project's no-dependency / no-build-step
 * promise intact while still solving the cross-surface
 * rendering inconsistency that plain <sub> + UI-font fallback
 * was causing on the agent cards.
 *
 * Source of truth
 * ---------------
 * Every symbol used anywhere in the UI is defined exactly
 * once in the Sym map below. Dynamic renderers (renderAgents,
 * renderMetrics) embed `Sym.<key>` directly in their template
 * literals; static HTML uses `<span data-sym="key"></span>`
 * placeholders that hydrateSymbols() fills in on
 * DOMContentLoaded. This means the same symbol renders through
 * the same MathML fragment on the card, in the notes, in the
 * figure equation, and in the table — no more visual drift.
 *
 * Plain-text exceptions
 * ---------------------
 * Two contexts cannot render HTML/MathML at all:
 *   - CSS `content: attr(data-tip)` pseudo-element tooltips
 *   - Canvas fillText on chart legends
 * Those continue to use Unicode subscript characters (Uₜ, αₗ,
 * V̂ᵢ,ₜ, …). They are the only places in the codebase where
 * math is not routed through Sym.
 * ============================================================ */

'use strict';

/* ---- Element builders -------------------------------------- */

const _mi  = s => `<mi>${s}</mi>`;
const _mn  = s => `<mn>${s}</mn>`;
const _mo  = s => `<mo>${s}</mo>`;
const _row = (...kids) => `<mrow>${kids.join('')}</mrow>`;
const _sub = (base, sub) => `<msub>${base}${sub}</msub>`;
const _sup = (base, sup) => `<msup>${base}${sup}</msup>`;
const _subsup = (base, sub, sup) => `<msubsup>${base}${sub}${sup}</msubsup>`;
const _hat   = base => `<mover accent="true">${base}<mo>^</mo></mover>`;
const _tilde = base => `<mover accent="true">${base}<mo>~</mo></mover>`;
const _bar   = base => `<mover accent="true">${base}<mo>‾</mo></mover>`;
const _sqrt  = body => `<msqrt>${body}</msqrt>`;
const _frac  = (num, den) => `<mfrac>${num}${den}</mfrac>`;
const _abs   = body => `<mrow><mo>|</mo>${body}<mo>|</mo></mrow>`;
const _wrap  = body => `<math display="inline" xmlns="http://www.w3.org/1998/Math/MathML">${body}</math>`;

/* ---- Reusable sub-expressions ------------------------------ */

// Subscript "{i, t}" — appears on almost every per-agent quantity.
const _it = _row(_mi('i'), _mo(','), _mi('t'));
// Subscript "{r → s}" — for pairwise trust.
const _rarrs = _row(_mi('r'), _mo('→'), _mi('s'));
// Subscript "{i → *, t}" — for broadcast messages.
const _imsgT = _row(_mi('i'), _mo('→'), _mo('*'), _mo(','), _mi('t'));

/* ---- Canonical symbol map ---------------------------------- *
 * Keys are referenced from both ui.js (template strings) and
 * index.html (`data-sym="..."`). Keep the key set small and
 * stable.
 * ------------------------------------------------------------ */

const Sym = {
  /* Agent-level, time-indexed */
  cash:      _wrap(_sub(_mi('c'), _it)),                                     // c_{i,t}
  cash0:     _wrap(_sub(_mi('c'), _row(_mi('i'), _mo(','), _mn('0')))),      // c_{i,0}
  shares:    _wrap(_sub(_mi('q'), _it)),                                     // q_{i,t}
  shares0:   _wrap(_sub(_mi('q'), _row(_mi('i'), _mo(','), _mn('0')))),      // q_{i,0}
  wealth:    _wrap(_sub(_mi('w'), _it)),                                     // w_{i,t}
  wealth0:   _wrap(_sub(_mi('w'), _row(_mi('i'), _mo(','), _mn('0')))),      // w_{i,0}
  pnl:       _wrap(_sub(_row(_mo('Δ'), _mi('w')), _it)),                     // Δw_{i,t}
  subjV:     _wrap(_sub(_hat(_mi('V')), _it)),                               // V̂_{i,t}
  reportV:   _wrap(_sub(_tilde(_mi('V')), _it)),                             // Ṽ_{i,t}
  action:    _wrap(_sub(_mi('a'), _it)),                                     // a_{i,t}
  utilityI:  _wrap(_sub(_mi('u'), _it)),                                     // u_{i,t}
  agentI:    _wrap(_mi('i')),                                                 // i
  periodT:   _wrap(_mi('t')),                                                 // t

  /* Market-level */
  price:     _wrap(_sub(_mi('P'), _mi('t'))),                                 // P_t
  meanP:     _wrap(_sub(_bar(_mi('P')), _mi('t'))),                           // P̄_t
  fv:        _wrap(_sub(_row(_mi('F'), _mi('V')), _mi('t'))),                 // FV_t
  fvT:       _wrap(_sub(_row(_mi('F'), _mi('V')), _mi('T'))),                 // FV_T
  fvDef:     _wrap(_row(                                                      // FV_t = (T − t + 1)·μ_d
    _sub(_row(_mi('F'), _mi('V')), _mi('t')), _mo('='),
    _mo('('), _mi('T'), _mo('−'), _mi('t'), _mo('+'), _mn('1'), _mo(')'),
    _mo('·'), _sub(_mi('μ'), _mi('d')),
  )),
  rhoT:      _wrap(_sub(_mi('ρ'), _mi('t'))),                                 // ρ_t
  rhoDef:    _wrap(_row(                                                      // ρ_t = P_t / FV_t
    _sub(_mi('ρ'), _mi('t')), _mo('='),
    _frac(_sub(_mi('P'), _mi('t')), _sub(_row(_mi('F'), _mi('V')), _mi('t'))),
  )),
  muD:       _wrap(_sub(_mi('μ'), _mi('d'))),                                 // μ_d
  bigT:      _wrap(_mi('T')),                                                 // T
  bigQ:      _wrap(_mi('Q')),                                                 // Q
  volT:      _wrap(_sub(_mi('V'), _mi('t'))),                                 // V_t

  /* Utility functionals — compact form used by slider labels and the
     agent-card subtitle where horizontal space is tight. */
  uLoving:   _wrap(_row(
    _mi('U'), _mo('('), _mi('w'), _mo(')'), _mo('='),
    _sup(_mi('w'), _mn('2')),
  )),
  uNeutral:  _wrap(_row(
    _mi('U'), _mo('('), _mi('w'), _mo(')'), _mo('='), _mi('w'),
  )),
  uAverse:   _wrap(_row(
    _mi('U'), _mo('('), _mi('w'), _mo(')'), _mo('='),
    _sqrt(_mi('w')),
  )),
  /* Exact normalized utility right-hand sides — match computeUtility()
     in js/utility.js, which evaluates U on r = w / w₀ so every agent
     starts at U(w₀) = 1 regardless of initial wealth. Rendered on the
     utility agent cards in the value column, with `U_i(w)` as the
     label subscript, so the row reads as "Utility U_i(w) | (w/w₀)²"
     and lines up with every other "label | value" metric row. */
  uLovingNorm:  _wrap(
    _sup(_row(_mo('('), _frac(_mi('w'), _sub(_mi('w'), _mn('0'))), _mo(')')), _mn('2')),
  ),
  uNeutralNorm: _wrap(
    _frac(_mi('w'), _sub(_mi('w'), _mn('0'))),
  ),
  uAverseNorm:  _wrap(
    _sqrt(_frac(_mi('w'), _sub(_mi('w'), _mn('0')))),
  ),
  uOfW:      _wrap(_row(_sub(_mi('U'), _mi('i')), _mo('('), _mi('w'), _mo(')'))),   // U_i(w)
  uDef:      _wrap(_row(                                                            // u_{i,t} = U_i(w_{i,t}) / U_i(w_{i,0})
    _sub(_mi('u'), _it), _mo('='),
    _frac(
      _row(_sub(_mi('U'), _mi('i')), _mo('('), _sub(_mi('w'), _it), _mo(')')),
      _row(_sub(_mi('U'), _mi('i')), _mo('('), _sub(_mi('w'), _row(_mi('i'), _mo(','), _mn('0'))), _mo(')')),
    ),
  )),

  /* Risk-mix shares and population counts */
  alphaL:    _wrap(_sub(_mi('α'), _mi('L'))),                                 // α_L
  alphaN:    _wrap(_sub(_mi('α'), _mi('N'))),                                 // α_N
  alphaA:    _wrap(_sub(_mi('α'), _mi('A'))),                                 // α_A
  nF:        _wrap(_sub(_mi('N'), _mi('F'))),                                 // N_F
  nT:        _wrap(_sub(_mi('N'), _mi('T'))),                                 // N_T
  nR:        _wrap(_sub(_mi('N'), _mi('R'))),                                 // N_R
  nE:        _wrap(_sub(_mi('N'), _mi('E'))),                                 // N_E
  nU:        _wrap(_sub(_mi('N'), _mi('U'))),                                 // N_U

  /* Classic agent class membership labels */
  inF:       _wrap(_row(_mi('i'), _mo('∈'), _mi('F'))),                       // i ∈ F
  inT:       _wrap(_row(_mi('i'), _mo('∈'), _mi('T'))),                       // i ∈ T
  inR:       _wrap(_row(_mi('i'), _mo('∈'), _mi('R'))),                       // i ∈ R
  inE:       _wrap(_row(_mi('i'), _mo('∈'), _mi('E'))),                       // i ∈ E
  inU:       _wrap(_row(_mi('i'), _mo('∈'), _mi('U'))),                       // i ∈ U

  /* Messaging + trust */
  msgIt:     _wrap(_sub(_mi('m'), _imsgT)),                                   // m_{i→*,t}
  trustRS:   _wrap(_sub(_mi('T'), _rarrs)),                                   // T_{r→s}
  lieGap:    _wrap(_abs(_row(_sub(_tilde(_mi('V')), _it), _mo('−'), _sub(_hat(_mi('V')), _it)))),  // |Ṽ−V̂|

  /* Compound equations used in figure eq strips */
  absMispricing: _wrap(_abs(_row(_sub(_mi('P'), _mi('t')), _mo('−'), _sub(_row(_mi('F'), _mi('V')), _mi('t'))))),  // |P_t − FV_t|
  volDef:    _wrap(_row(                                                      // V_t = Σ_{trades ∈ t} q
    _sub(_mi('V'), _mi('t')), _mo('='),
    _sub(_mo('Σ'), _row(_mi('trades'), _mo('∈'), _mi('t'))),
    _mi('q'),
  )),
  actionSet: _wrap(_row(                                                      // a_{i,t} ∈ { bid, ask, hold }
    _sub(_mi('a'), _it), _mo('∈'),
    _mo('{'), _mi('bid'), _mo(','), _mi('ask'), _mo(','), _mi('hold'), _mo('}'),
  )),
  valCompare: _wrap(_row(                                                     // V̂_{i,t} vs Ṽ_{i,t}
    _sub(_hat(_mi('V')), _it), _mi('vs'), _sub(_tilde(_mi('V')), _it),
  )),
  ownershipEq: _wrap(_row(                                                    // q_{i,t} · Σ_i q_{i,t} = Q
    _sub(_mi('q'), _it), _mo('·'),
    _sub(_mo('Σ'), _mi('i')), _sub(_mi('q'), _it),
    _mo('='), _mi('Q'),
  )),
  msgDef:    _wrap(_row(                                                      // m_{i→*,t} = (signal, Ṽ_{i,t})
    _sub(_mi('m'), _imsgT), _mo('='),
    _mo('('), _mi('signal'), _mo(','), _sub(_tilde(_mi('V')), _it), _mo(')'),
  )),
  trustEq:   _wrap(_row(                                                      // T_{r→s} ← (1−λ)·T_{r→s} + λ·closeness_{r,s}
    _sub(_mi('T'), _rarrs), _mo('←'),
    _mo('('), _mn('1'), _mo('−'), _mi('λ'), _mo(')'), _mo('·'),
    _sub(_mi('T'), _rarrs), _mo('+'),
    _mi('λ'), _mo('·'),
    _sub(_mi('closeness'), _row(_mi('r'), _mo(','), _mi('s'))),
  )),

  /* Figure-specific symbols that previously lived as raw text */
  qOrder:      _wrap(_mi('q')),                                               // q
  lambdaRate:  _wrap(_mi('λ')),                                               // λ
  closenessRS: _wrap(_sub(_mi('closeness'), _row(_mi('r'), _mo(','), _mi('s')))), // closeness_{r,s}
  heatBin:     _wrap(_row(                                                    // H(P, t)
    _mi('H'), _mo('('), _mi('P'), _mo(','), _mi('t'), _mo(')'),
  )),
  heatBinDef:  _wrap(_row(                                                    // H(P, t) = Σ q over (P, t) bins
    _mi('H'), _mo('('), _mi('P'), _mo(','), _mi('t'), _mo(')'), _mo('='),
    _sub(_mo('Σ'), _row(_mo('('), _mi('P'), _mo(','), _mi('t'), _mo(')'))),
    _mi('q'),
  )),

  /* Metrics table compound expressions */
  normAvgDev: _wrap(_frac(                                                    // Σ|P̄_t − FV_t| / Q
    _row(_mo('Σ'), _abs(_row(_sub(_bar(_mi('P')), _mi('t')), _mo('−'), _sub(_row(_mi('F'), _mi('V')), _mi('t'))))),
    _mi('Q'),
  )),
  avgVbar:   _wrap(_row(_mo('⟨'), _sub(_hat(_mi('V')), _mi('i')), _mo('⟩'))), // ⟨V̂_i⟩
  efficiencyEq: _wrap(_frac(                                                  // Σ V̂_i · q_i / (V̂* · Q)
    _row(_mo('Σ'), _sub(_hat(_mi('V')), _mi('i')), _mo('·'), _sub(_mi('q'), _mi('i'))),
    _row(_mo('('), _sup(_hat(_mi('V')), _mo('*')), _mo('·'), _mi('Q'), _mo(')')),
  )),
  totalWelfareEq: _wrap(_row(                                                 // Σ u_i(w_{i,t})
    _mo('Σ'), _sub(_mi('u'), _mi('i')), _mo('('), _sub(_mi('w'), _it), _mo(')'),
  )),
};

/* ---- Hydration --------------------------------------------- *
 * Scan the DOM (or a subtree) for `<span data-sym="key">` place-
 * holders and replace their contents with the matching MathML.
 * Safe to call repeatedly; an already-hydrated placeholder is
 * re-assigned the same HTML so the DOM stays idempotent.
 * ------------------------------------------------------------ */

function hydrateSymbols(root) {
  const scope = root || document;
  const nodes = scope.querySelectorAll('[data-sym]');
  nodes.forEach(el => {
    const key = el.getAttribute('data-sym');
    if (key && Sym[key]) el.innerHTML = Sym[key];
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => hydrateSymbols(document));
  } else {
    hydrateSymbols(document);
  }
}

window.Sym = Sym;
window.hydrateSymbols = hydrateSymbols;
