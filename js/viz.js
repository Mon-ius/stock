'use strict';

/* =====================================================================
   viz.js — HiDPI-aware Canvas drawing primitives.

   Everything is pure 2D context: rectangles, paths, text. No libraries,
   no SVG. Callers build plot rectangles with `plotRect`, pass them to
   `axes` for gridlines/tick labels, then to `line`/`area`/`bars` to
   draw the data. `setupHiDPI` rescales the context so 1 logical pixel
   = 1 CSS pixel even on retina displays.
   ===================================================================== */

const Viz = {
  // Theme defaults for axis drawing. UI.refreshTheme() overwrites these
  // with getComputedStyle values when the active theme changes.
  theme: {
    frame: '#c6cad1',
    grid:  'rgba(0,0,0,0.06)',
    label: '#9aa0ad',
  },
  setTheme(next) { Object.assign(this.theme, next); },

  setupHiDPI(canvas) {
    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width  = Math.max(1, Math.round(rect.width  * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    return { ctx, width: rect.width, height: rect.height };
  },

  clear(ctx, w, h) { ctx.clearRect(0, 0, w, h); },

  plotRect(w, h, padL = 44, padR = 12, padT = 14, padB = 26) {
    return { x: padL, y: padT, w: w - padL - padR, h: h - padT - padB };
  },

  /**
   * Draw a formal axis label outside the plot frame. `side` ∈
   * {'bottom','left','top'}; the 'left' variant draws vertically.
   * Callers must leave room in plotRect padding (padB ≥ 42 for bottom,
   * padL ≥ 58 for left).
   */
  axisLabel(ctx, rect, text, side = 'bottom', color) {
    ctx.save();
    ctx.font = 'italic 10px "SF Mono", ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = color || this.theme.label;
    if (side === 'bottom') {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, rect.x + rect.w / 2, rect.y + rect.h + 34);
    } else if (side === 'top') {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, rect.x + rect.w / 2, rect.y - 4);
    } else { // left — rotated
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.translate(rect.x - 36, rect.y + rect.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(text, 0, 0);
    }
    ctx.restore();
  },

  /**
   * Draw an in-plot legend row of {color, label} entries. Text is measured
   * so entries can carry long formal notation without clipping.
   */
  legendRow(ctx, rect, entries, opts = {}) {
    const x0 = rect.x + (opts.padX ?? 10);
    const y  = rect.y + (opts.padY ?? 12);
    const gap = opts.gap ?? 14;
    ctx.save();
    ctx.font = opts.font || '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    let x = x0;
    for (const e of entries) {
      ctx.fillStyle = e.color;
      ctx.fillText(e.label, x, y);
      x += ctx.measureText(e.label).width + gap;
    }
    ctx.restore();
  },

  mapX(rect, v, xMin, xMax) {
    if (xMax === xMin) return rect.x;
    return rect.x + ((v - xMin) / (xMax - xMin)) * rect.w;
  },
  mapY(rect, v, yMin, yMax) {
    if (yMax === yMin) return rect.y + rect.h;
    return rect.y + rect.h - ((v - yMin) / (yMax - yMin)) * rect.h;
  },

  axes(ctx, rect, {
    xMin, xMax, yMin, yMax,
    xTicks = 8, yTicks = 5,
    xFmt = v => v.toFixed(0),
    yFmt = v => v.toFixed(0),
    color = this.theme.frame,
    grid  = this.theme.grid,
    label = this.theme.label,
    showX = true,
  } = {}) {
    ctx.save();
    ctx.font = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';

    // outer frame
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);

    // horizontal gridlines + y tick labels
    for (let i = 0; i <= yTicks; i++) {
      const t   = i / yTicks;
      const y   = rect.y + rect.h - t * rect.h;
      const val = yMin + t * (yMax - yMin);
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(rect.x, y);
      ctx.lineTo(rect.x + rect.w, y);
      ctx.stroke();
      ctx.fillStyle = label;
      ctx.textAlign = 'right';
      ctx.fillText(yFmt(val), rect.x - 5, y);
    }

    // x tick labels
    if (showX) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = label;
      for (let i = 0; i <= xTicks; i++) {
        const t   = i / xTicks;
        const x   = rect.x + t * rect.w;
        const val = xMin + t * (xMax - xMin);
        ctx.fillText(xFmt(val), x, rect.y + rect.h + 6);
      }
    }
    ctx.restore();
  },

  line(ctx, rect, points, { xMin, xMax, yMin, yMax, color, width = 2, dashed = false }) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = width;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    if (dashed) ctx.setLineDash([6, 5]);
    ctx.beginPath();
    let started = false;
    for (const p of points) {
      if (p.y == null || Number.isNaN(p.y)) { started = false; continue; }
      const x = this.mapX(rect, p.x, xMin, xMax);
      const y = this.mapY(rect, p.y, yMin, yMax);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else           ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  },

  area(ctx, rect, points, { xMin, xMax, yMin, yMax, color }) {
    if (!points.length) return;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    const yBase = this.mapY(rect, Math.max(yMin, 0), yMin, yMax);
    let started = false;
    let lastX = null;
    for (const p of points) {
      if (p.y == null) continue;
      const x = this.mapX(rect, p.x, xMin, xMax);
      const y = this.mapY(rect, p.y, yMin, yMax);
      if (!started) { ctx.moveTo(x, yBase); ctx.lineTo(x, y); started = true; }
      else          { ctx.lineTo(x, y); }
      lastX = x;
    }
    if (lastX != null) ctx.lineTo(lastX, yBase);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },

  bars(ctx, rect, points, { xMin, xMax, yMin, yMax, color, barWidth }) {
    ctx.save();
    ctx.fillStyle = color;
    const y0 = this.mapY(rect, Math.max(yMin, 0), yMin, yMax);
    for (const p of points) {
      if (p.y == null) continue;
      const x = this.mapX(rect, p.x, xMin, xMax);
      const y = this.mapY(rect, p.y, yMin, yMax);
      ctx.fillRect(x - barWidth / 2, Math.min(y, y0), barWidth, Math.abs(y - y0));
    }
    ctx.restore();
  },

  verticalBand(ctx, rect, x1, x2, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.fillRect(x1, rect.y, x2 - x1, rect.h);
    ctx.restore();
  },

  /**
   * Stacked area: each series adds on top of the previous baseline.
   * seriesList: [{ color, name, points: [{x, y}] }]
   * All series must share the same x grid and length.
   */
  stackedArea(ctx, rect, seriesList, { xMin, xMax, yMin, yMax }) {
    if (!seriesList.length) return;
    const n = seriesList[0].points.length;
    if (!n) return;
    const cum = new Array(n).fill(0);
    for (const s of seriesList) {
      ctx.save();
      ctx.fillStyle = s.color;
      ctx.beginPath();
      // Top edge (forward).
      for (let j = 0; j < n; j++) {
        const p = s.points[j];
        const top = cum[j] + (p.y || 0);
        const x = this.mapX(rect, p.x, xMin, xMax);
        const y = this.mapY(rect, top, yMin, yMax);
        if (j === 0) ctx.moveTo(x, y);
        else         ctx.lineTo(x, y);
      }
      // Bottom edge (reverse), closing the polygon.
      for (let j = n - 1; j >= 0; j--) {
        const p = s.points[j];
        const x = this.mapX(rect, p.x, xMin, xMax);
        const y = this.mapY(rect, cum[j], yMin, yMax);
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      for (let j = 0; j < n; j++) cum[j] += (s.points[j].y || 0);
    }
  },

  /**
   * Bucket a flat list of rows by an x key so each bucket carries the
   * y values from every agent at that x. Used by fan-chart callers to
   * collapse a "history[]" stream into a per-tick population slice
   * before computing quantiles.
   *
   *   rows  — [{ [xKey]: number, [yKey]: number, ... }]
   *   xKey  — the tick / period field name
   *   yKey  — the value field name (e.g. 'subjV', 'utility')
   *   → [{ x, ys: number[] }] sorted by x ascending
   */
  bucketByX(rows, xKey, yKey) {
    const buckets = new Map();
    for (const row of rows) {
      const x = row[xKey];
      const y = row[yKey];
      if (x == null || y == null || Number.isNaN(y)) continue;
      let b = buckets.get(x);
      if (!b) { b = { x, ys: [] }; buckets.set(x, b); }
      b.ys.push(y);
    }
    return [...buckets.values()].sort((a, b) => a.x - b.x);
  },

  /**
   * Fan chart — population distribution over time. For each x-bucket,
   * shades the 10/90 envelope, the 25/75 IQR, and draws the median line.
   * Designed as a drop-in replacement for dozens of overlapping per-agent
   * `line()` calls when the population is large (N > ~12) and individual
   * traces degenerate to visual noise.
   *
   *   buckets — [{ x, ys: number[] }] (usually from bucketByX).
   *   opts    — { xMin, xMax, yMin, yMax, colorEnv, colorIQR,
   *              colorMedian, widthMedian }
   */
  fanChart(ctx, rect, buckets, opts) {
    if (!buckets || !buckets.length) return;
    const { xMin, xMax, yMin, yMax } = opts;
    const colorEnv    = opts.colorEnv    || 'rgba(120,140,180,0.18)';
    const colorIQR    = opts.colorIQR    || 'rgba(120,140,180,0.35)';
    const colorMedian = opts.colorMedian || '#445';
    const widthMedian = opts.widthMedian != null ? opts.widthMedian : 2;

    const quantile = (sorted, q) => {
      if (!sorted.length) return null;
      const pos = (sorted.length - 1) * q;
      const lo  = Math.floor(pos);
      const hi  = Math.ceil(pos);
      if (lo === hi) return sorted[lo];
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    };

    const stats = [];
    for (const b of buckets) {
      if (!b.ys.length) continue;
      const ys = b.ys.slice().sort((a, z) => a - z);
      stats.push({
        x:   b.x,
        p10: quantile(ys, 0.10),
        p25: quantile(ys, 0.25),
        p50: quantile(ys, 0.50),
        p75: quantile(ys, 0.75),
        p90: quantile(ys, 0.90),
      });
    }
    if (!stats.length) return;

    const drawBand = (getLow, getHigh, fill) => {
      ctx.save();
      ctx.fillStyle = fill;
      ctx.beginPath();
      for (let i = 0; i < stats.length; i++) {
        const s = stats[i];
        const x = this.mapX(rect, s.x, xMin, xMax);
        const y = this.mapY(rect, getHigh(s), yMin, yMax);
        if (i === 0) ctx.moveTo(x, y);
        else         ctx.lineTo(x, y);
      }
      for (let i = stats.length - 1; i >= 0; i--) {
        const s = stats[i];
        const x = this.mapX(rect, s.x, xMin, xMax);
        const y = this.mapY(rect, getLow(s), yMin, yMax);
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };
    drawBand(s => s.p10, s => s.p90, colorEnv);
    drawBand(s => s.p25, s => s.p75, colorIQR);

    this.line(
      ctx, rect,
      stats.map(s => ({ x: s.x, y: s.p50 })),
      { xMin, xMax, yMin, yMax, color: colorMedian, width: widthMedian },
    );
  },

  /** Scale a value in [0,1] to a cool→hot heat color for the heatmap. */
  heatColor(t) {
    t = Math.max(0, Math.min(1, t));
    const r = Math.round( 40 + t * 215);
    const g = Math.round( 70 + (1 - Math.abs(t - 0.5) * 2) * 110);
    const b = Math.round(200 - t * 170);
    return `rgba(${r},${g},${b},${0.25 + t * 0.6})`;
  },
};
