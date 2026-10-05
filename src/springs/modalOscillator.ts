/**
 * modalOscillator — one damped spring per surface-jiggle mode, kicked by a
 * velocity change, stepped exactly, saturated for render.
 *
 * The arithmetic is identical to Harry's own modal oscillator, so a model's
 * surface jiggle plays the same in Harry's preview and in Babylon.
 *
 * ONE responsibility: the weight of each mode over time. Each mode k obeys
 *   q̈ = −2 ζ ω q̇ − ω² q,   ω = 2π · freqHz
 * and a kick adds Δv straight to q̇. The step is the EXACT propagator of that
 * equation over h, not an Euler sub-step: stable for any ω·h and the same
 * state at the same time whatever the frame rate.
 *
 * Rendering reads `weights()`: q saturated as max · tanh(q / max) so a linear
 * mode can never invert the flesh; the state itself stays linear.
 *
 * ENGINE-FREE: numbers in, numbers out — no Babylon import here. The Babylon
 * side (SurfaceJiggleReader.ts) owns the tip/owner world math and the morph
 * target writes.
 */

export interface ModeSpring {
  /** Natural frequency, Hz. */
  readonly freqHz: number
  /** Damping ratio (0 < ζ < 1: it rings; the envelope is e^(−ζωt)). */
  readonly zeta: number
  /** The render cap for this mode's weight (tanh saturation); 0 = no cap. */
  readonly max: number
}

export interface ModalOscillator {
  /** Add a velocity change to mode k (Δv into q̇). */
  kick(k: number, dv: number): void
  /** Advance every mode by `dt` seconds, exactly. */
  step(dt: number): void
  /** The saturated weights to render, one per mode (a fresh array). */
  weights(): Float64Array
  /** The raw linear state (tests, probes). */
  state(): { readonly q: Float64Array; readonly qd: Float64Array }
  /** Every mode at rest. */
  reset(): void
}

/**
 * Builds the oscillator for one region's modes. Throws when a mode cannot
 * ring (freqHz ≤ 0, or ζ outside (0, 1)) — the caller (surfaceJiggleDeclaration.ts)
 * validates this before construction, so a throw here means a declaration
 * bypassed that check.
 */
export function createModalOscillator(modes: readonly ModeSpring[]): ModalOscillator {
  for (const m of modes) {
    if (!(m.freqHz > 0) || !(m.zeta > 0) || !(m.zeta < 1)) {
      throw new Error(`modalOscillator: a mode needs freqHz > 0 and 0 < zeta < 1 (got ${m.freqHz} Hz, ζ ${m.zeta})`)
    }
  }
  const n = modes.length
  const q = new Float64Array(n)
  const qd = new Float64Array(n)
  // The propagator depends only on h; cache the last one (a steady clock asks for the same h).
  let cachedH = NaN
  const P = new Float64Array(4 * n)
  const propagator = (h: number): void => {
    if (h === cachedH) return
    cachedH = h
    for (let k = 0; k < n; k++) {
      const w = 2 * Math.PI * modes[k]!.freqHz
      const z = modes[k]!.zeta
      const wd = w * Math.sqrt(1 - z * z)
      const e = Math.exp(-z * w * h)
      const c = Math.cos(wd * h)
      const s = Math.sin(wd * h)
      // x(h) = e[(c + zw/wd s) x0 + (s/wd) v0];  v(h) = e[(−w²/wd s) x0 + (c − zw/wd s) v0]
      P[4 * k] = e * (c + ((z * w) / wd) * s)
      P[4 * k + 1] = e * (s / wd)
      P[4 * k + 2] = e * ((-w * w * s) / wd)
      P[4 * k + 3] = e * (c - ((z * w) / wd) * s)
    }
  }
  return {
    kick(k, dv) {
      qd[k] = qd[k]! + dv
    },
    step(dt) {
      if (!(dt > 0)) return
      propagator(dt)
      for (let k = 0; k < n; k++) {
        const x = q[k]!
        const v = qd[k]!
        q[k] = P[4 * k]! * x + P[4 * k + 1]! * v
        qd[k] = P[4 * k + 2]! * x + P[4 * k + 3]! * v
      }
    },
    weights() {
      return Float64Array.from(q, (x, k) => {
        const m = modes[k]!.max
        return m > 0 ? m * Math.tanh(x / m) : x
      })
    },
    state: () => ({ q: Float64Array.from(q), qd: Float64Array.from(qd) }),
    reset() {
      q.fill(0)
      qd.fill(0)
    },
  }
}
