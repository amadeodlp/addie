/**
 * automation.js — Breakpoint math for automation envelopes.
 *
 * Translates high-level shape descriptions into concrete breakpoint arrays
 * that the Python bridge writes via insert_step(time, value, duration).
 *
 * The LLM generates a shape name + start/end values + duration in bars.
 * This module expands that into the actual [time, value, duration] tuples,
 * handling tempo conversion, value clamping, and curve math.
 *
 * All times are in beats (quarter notes). Duration in bars is converted
 * using beatsPerBar (from time signature, default 4).
 *
 * insert_step(time, value, duration):
 *   - time:     beat position in the clip where this step starts
 *   - value:    parameter value (clamped to min/max by the bridge)
 *   - duration: how long this step holds before the next one
 *               (Live interpolates linearly between steps)
 */

// ─── SHAPE GENERATORS ────────────────────────────────────────────────────────
//
// Each generator returns an array of [time, value, duration] tuples.
//
// Parameters common to all shapes:
//   startVal    — parameter value at the beginning
//   endVal      — parameter value at the end
//   bars        — duration in bars
//   resolution  — breakpoints per bar (default 4 = one per beat at 4/4)
//   beatsPerBar — beats per bar from time signature (default 4)

const SHAPES = {};

/**
 * Linear ramp from startVal to endVal.
 */
SHAPES.ramp = function (startVal, endVal, bars, resolution, beatsPerBar) {
  const totalBeats = bars * beatsPerBar;
  const steps      = Math.max(1, Math.round(bars * resolution));
  const stepDur    = totalBeats / steps;
  const points     = [];

  for (let i = 0; i <= steps; i++) {
    const t     = i * stepDur;
    const ratio = steps === 0 ? 1 : i / steps;
    const value = startVal + (endVal - startVal) * ratio;
    // Duration = stepDur for all points except the last (which has 0 duration)
    const dur = i < steps ? stepDur : 0;
    points.push([round4(t), value, round4(dur)]);
  }
  return points;
};

// Convenience aliases
SHAPES.ramp_up   = SHAPES.ramp;
SHAPES.ramp_down = SHAPES.ramp;
SHAPES.fade_in   = SHAPES.ramp;
SHAPES.fade_out  = SHAPES.ramp;

/**
 * S-curve (sigmoid) — slow start, fast middle, slow end.
 * Uses a smoothstep function: 3t² - 2t³
 */
SHAPES.s_curve = function (startVal, endVal, bars, resolution, beatsPerBar) {
  const totalBeats = bars * beatsPerBar;
  const steps      = Math.max(1, Math.round(bars * resolution));
  const stepDur    = totalBeats / steps;
  const points     = [];

  for (let i = 0; i <= steps; i++) {
    const t     = i * stepDur;
    const ratio = steps === 0 ? 1 : i / steps;
    // Smoothstep: 3x² - 2x³
    const curved = ratio * ratio * (3 - 2 * ratio);
    const value  = startVal + (endVal - startVal) * curved;
    const dur    = i < steps ? stepDur : 0;
    points.push([round4(t), value, round4(dur)]);
  }
  return points;
};

/**
 * Exponential curve — fast start, slow end (or slow start, fast end).
 * exponent > 1 = slow start / fast end (logarithmic feel)
 * exponent < 1 = fast start / slow end (exponential decay feel)
 * Default exponent = 2 (quadratic).
 */
SHAPES.exponential = function (startVal, endVal, bars, resolution, beatsPerBar, exponent = 2) {
  const totalBeats = bars * beatsPerBar;
  const steps      = Math.max(1, Math.round(bars * resolution));
  const stepDur    = totalBeats / steps;
  const points     = [];

  for (let i = 0; i <= steps; i++) {
    const t     = i * stepDur;
    const ratio = steps === 0 ? 1 : i / steps;
    const curved = Math.pow(ratio, exponent);
    const value  = startVal + (endVal - startVal) * curved;
    const dur    = i < steps ? stepDur : 0;
    points.push([round4(t), value, round4(dur)]);
  }
  return points;
};

/**
 * Triangle — ramp up to peak at midpoint, then ramp back down.
 * startVal is used at both ends, endVal is the peak.
 */
SHAPES.triangle = function (startVal, endVal, bars, resolution, beatsPerBar) {
  const totalBeats = bars * beatsPerBar;
  const steps      = Math.max(2, Math.round(bars * resolution));
  const stepDur    = totalBeats / steps;
  const mid        = steps / 2;
  const points     = [];

  for (let i = 0; i <= steps; i++) {
    const t     = i * stepDur;
    const ratio = i <= mid
      ? i / mid                        // ascending half
      : (steps - i) / (steps - mid);   // descending half
    const value = startVal + (endVal - startVal) * ratio;
    const dur   = i < steps ? stepDur : 0;
    points.push([round4(t), value, round4(dur)]);
  }
  return points;
};

/**
 * Sine — one full sine wave cycle. startVal is the baseline,
 * endVal is the peak amplitude. Ends back at startVal.
 */
SHAPES.sine = function (startVal, endVal, bars, resolution, beatsPerBar) {
  const totalBeats = bars * beatsPerBar;
  const steps      = Math.max(2, Math.round(bars * resolution));
  const stepDur    = totalBeats / steps;
  const amplitude  = endVal - startVal;
  const points     = [];

  for (let i = 0; i <= steps; i++) {
    const t     = i * stepDur;
    const ratio = i / steps;
    // sin goes 0 → 1 → 0 → -1 → 0 over one cycle
    // We map to 0 → 1 → 0 (half cycle, positive only) for musical use
    const value = startVal + amplitude * Math.sin(ratio * Math.PI);
    const dur   = i < steps ? stepDur : 0;
    points.push([round4(t), value, round4(dur)]);
  }
  return points;
};

/**
 * Stepped — staircase pattern. Jumps between startVal and endVal
 * in equal steps. Like a quantized ramp.
 */
SHAPES.stepped = function (startVal, endVal, bars, resolution, beatsPerBar) {
  const totalBeats = bars * beatsPerBar;
  const numSteps   = Math.max(1, Math.round(bars * resolution));
  const stepDur    = totalBeats / numSteps;
  const points     = [];

  for (let i = 0; i < numSteps; i++) {
    const t     = i * stepDur;
    const ratio = numSteps <= 1 ? 1 : i / (numSteps - 1);
    const value = startVal + (endVal - startVal) * ratio;
    points.push([round4(t), value, round4(stepDur)]);
  }
  return points;
};

/**
 * LFO — repeating wave over the duration. startVal is the center,
 * endVal is the peak. cycles controls how many full oscillations.
 */
SHAPES.lfo = function (startVal, endVal, bars, resolution, beatsPerBar, cycles = 4) {
  const totalBeats = bars * beatsPerBar;
  const steps      = Math.max(4, Math.round(bars * resolution * 2)); // higher res for LFO
  const stepDur    = totalBeats / steps;
  const amplitude  = endVal - startVal;
  const center     = startVal;
  const points     = [];

  for (let i = 0; i <= steps; i++) {
    const t     = i * stepDur;
    const ratio = i / steps;
    const value = center + amplitude * Math.sin(ratio * cycles * 2 * Math.PI);
    const dur   = i < steps ? stepDur : 0;
    points.push([round4(t), value, round4(dur)]);
  }
  return points;
};


// ─── MAIN ENTRY POINT ────────────────────────────────────────────────────────

/**
 * Expand a high-level shape description into concrete breakpoints.
 *
 * @param {string}  shape       — Shape name (ramp, s_curve, triangle, etc.)
 * @param {number}  startVal    — Starting parameter value
 * @param {number}  endVal      — Ending parameter value
 * @param {number}  bars        — Duration in bars
 * @param {object}  [opts]      — Optional overrides
 * @param {number}  [opts.resolution=4]    — Breakpoints per bar
 * @param {number}  [opts.beatsPerBar=4]   — From time signature
 * @param {number}  [opts.paramMin]        — Clamp floor (from Live param)
 * @param {number}  [opts.paramMax]        — Clamp ceiling (from Live param)
 * @param {number}  [opts.startBeat=0]     — Offset all times by this many beats
 * @param {number}  [opts.exponent]        — For exponential shape
 * @param {number}  [opts.cycles]          — For LFO shape
 * @returns {{ breakpoints: number[][], shape: string, totalBeats: number }}
 */
function expandShape(shape, startVal, endVal, bars, opts = {}) {
  const {
    resolution  = 4,
    beatsPerBar = 4,
    paramMin,
    paramMax,
    startBeat   = 0,
    exponent,
    cycles,
  } = opts;

  const shapeLower = (shape || 'ramp').toLowerCase().replace(/[-\s]/g, '_');
  const generator  = SHAPES[shapeLower];

  if (!generator) {
    const available = Object.keys(SHAPES).join(', ');
    throw new Error(`Unknown automation shape: "${shape}". Available: ${available}`);
  }

  // Build extra args for shapes that accept them
  const extraArgs = [];
  if (shapeLower === 'exponential' && exponent != null) extraArgs.push(exponent);
  if (shapeLower === 'lfo' && cycles != null) extraArgs.push(cycles);

  let points = generator(startVal, endVal, bars, resolution, beatsPerBar, ...extraArgs);

  // Offset times if starting mid-clip
  if (startBeat > 0) {
    points = points.map(([t, v, d]) => [round4(t + startBeat), v, d]);
  }

  // Clamp values to parameter range
  if (paramMin != null || paramMax != null) {
    const lo = paramMin ?? -Infinity;
    const hi = paramMax ?? Infinity;
    points = points.map(([t, v, d]) => [t, Math.max(lo, Math.min(hi, v)), d]);
  }

  return {
    breakpoints: points,
    shape:       shapeLower,
    totalBeats:  bars * beatsPerBar,
  };
}


// ─── UTILITIES ───────────────────────────────────────────────────────────────

function round4(n) { return Math.round(n * 10000) / 10000; }

/**
 * Describe a breakpoint array as a human-readable verification string.
 * Used after writing automation to show the user what was created.
 *
 * @param {number[][]} samples — [[time, value], ...] from read_automation
 * @param {number}     paramMin
 * @param {number}     paramMax
 * @returns {string}   e.g. "0% → 17% → 35% → 52% → 70%"
 */
function describeEnvelope(samples, paramMin = 0, paramMax = 1) {
  if (!samples?.length) return 'empty';
  const range = paramMax - paramMin;
  if (range === 0) return samples.map(([, v]) => v.toFixed(2)).join(' → ');

  return samples
    .map(([, v]) => {
      if (v == null) return '?';
      const pct = ((v - paramMin) / range * 100);
      return `${Math.round(pct)}%`;
    })
    .join(' → ');
}

/**
 * List available shape names for prompt instructions.
 */
function getAvailableShapes() {
  // Deduplicate aliases
  const unique = new Set(Object.keys(SHAPES));
  return [...unique];
}

module.exports = { expandShape, describeEnvelope, getAvailableShapes, SHAPES };
