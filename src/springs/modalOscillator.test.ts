/**
 * modalOscillator — test vectors shared with Harry's own oscillator: exact
 * decay/rate, and saturation that never inverts. The Babylon reader must
 * reproduce the same numbers Harry's preview does.
 */
import { describe, expect, it } from 'vitest'
import { createModalOscillator } from './modalOscillator.js'

describe('createModalOscillator', () => {
  it('rings at its frequency and decays as e^(−ζωt) (reference vectors)', () => {
    const f = 8.6
    const z = 0.09
    const osc = createModalOscillator([{ freqHz: f, zeta: z, max: 0 }])
    osc.kick(0, 1)
    const h = 1 / 600
    const peaks: Array<{ t: number; q: number }> = []
    let prev = 0
    let prevPrev = 0
    for (let i = 1; i <= 1200; i++) {
      osc.step(h)
      const q = osc.state().q[0]!
      if (i > 2 && prev > prevPrev && prev > q && prev > 0) peaks.push({ t: (i - 1) * h, q: prev })
      prevPrev = prev
      prev = q
    }
    // Period between peaks = 1 / (f √(1−ζ²)).
    const period = peaks[1]!.t - peaks[0]!.t
    expect(period).toBeCloseTo(1 / (f * Math.sqrt(1 - z * z)), 2)
    // Peak ratio per period = e^(−ζ ω T).
    const ratio = peaks[1]!.q / peaks[0]!.q
    expect(ratio).toBeCloseTo(Math.exp(-z * 2 * Math.PI * f * period), 2)
  })

  it('is frame-rate independent: 30, 60 and 144 fps land on the same state at the same time (reference vectors)', () => {
    const modes = [
      { freqHz: 8.6, zeta: 0.09, max: 0 },
      { freqHz: 13.7, zeta: 0.09, max: 0 },
      { freqHz: 19.5, zeta: 0.09, max: 0 },
    ]
    const run = (fps: number): Float64Array => {
      const osc = createModalOscillator(modes)
      for (let k = 0; k < 3; k++) osc.kick(k, 1 + k)
      for (let i = 0; i < fps / 2; i++) osc.step(1 / fps) // 0.5 s
      return osc.state().q
    }
    const a = run(30)
    const b = run(60)
    const c = run(144)
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(a[k]! - b[k]!)).toBeLessThan(1e-12)
      expect(Math.abs(b[k]! - c[k]!)).toBeLessThan(1e-12)
    }
  })

  it('saturates weights with tanh, never past its cap, sign kept (reference vectors)', () => {
    const osc = createModalOscillator([{ freqHz: 5, zeta: 0.1, max: 0.01 }])
    osc.kick(0, 50)
    let peak = 0
    for (let i = 0; i < 120; i++) {
      osc.step(1 / 240)
      const wgt = osc.weights()[0]!
      peak = Math.max(peak, Math.abs(wgt))
      expect(Math.sign(wgt) === Math.sign(osc.state().q[0]!) || wgt === 0).toBe(true)
    }
    expect(peak).toBeLessThanOrEqual(0.01)
    expect(peak).toBeGreaterThan(0.0099)
  })

  it('a kick of 0 leaves every mode at rest forever (the "gain 0" case in the Babylon reader)', () => {
    const osc = createModalOscillator([{ freqHz: 6, zeta: 0.2, max: 0.02 }])
    osc.kick(0, 0)
    for (let i = 0; i < 60; i++) osc.step(1 / 60)
    expect(osc.weights()[0]).toBe(0)
    expect(osc.state().q[0]).toBe(0)
    expect(osc.state().qd[0]).toBe(0)
  })

  it('refuses a mode that cannot ring', () => {
    expect(() => createModalOscillator([{ freqHz: 0, zeta: 0.1, max: 0 }])).toThrow(/needs freqHz/)
    expect(() => createModalOscillator([{ freqHz: 5, zeta: 1, max: 0 }])).toThrow(/needs freqHz/)
  })
})
