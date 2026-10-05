/**
 * surfaceJiggleDeclaration — parses `extras.poqpoq.surface` per Harry's
 * surface-jiggle export shape (hair included). A file
 * that gets it wrong fails safe: the mode (or the whole block) is dropped,
 * never thrown — the rest shape plays.
 */
import { describe, expect, it } from 'vitest'
import { parseSurfaceJiggle } from './surfaceJiggleDeclaration.js'

/** A minimal, valid sample in the contract's exact shape (a single-mode hair leaf). */
function sample(overrides: Record<string, unknown> = {}): unknown {
  return {
    poqpoq: {
      surface: {
        version: 1,
        tip: 'HairJiggle',
        owner: 'Head',
        gain: 0.4,
        modes: [{ target: 'surface.Hair.1', freqHz: 4.1, zeta: 0.12, max: 0.009, participation: [0, 0.6, 0.8] }],
        ...overrides,
      },
    },
  }
}

describe('parseSurfaceJiggle', () => {
  it('parses a minimal valid sample (hair leaf, the contract shape)', () => {
    const d = parseSurfaceJiggle(sample())
    expect(d).toEqual({
      version: 1,
      tip: 'HairJiggle',
      owner: 'Head',
      gain: 0.4,
      modes: [{ target: 'surface.Hair.1', freqHz: 4.1, zeta: 0.12, max: 0.009, participation: [0, 0.6, 0.8] }],
    })
  })

  it('no extras.poqpoq.surface: null, no warning needed (the common case — nothing changes)', () => {
    const warns: string[] = []
    expect(parseSurfaceJiggle(undefined, (w) => warns.push(w))).toBeNull()
    expect(parseSurfaceJiggle({}, (w) => warns.push(w))).toBeNull()
    expect(parseSurfaceJiggle({ poqpoq: { drive: {} } }, (w) => warns.push(w))).toBeNull()
    expect(warns).toEqual([])
  })

  it('gain 0 is a valid declaration (authored silent, not malformed)', () => {
    const d = parseSurfaceJiggle(sample({ gain: 0 }))
    expect(d?.gain).toBe(0)
  })

  it('rejects a non-object surface block, by name', () => {
    const warns: string[] = []
    const extras = { poqpoq: { surface: 'nope' } }
    expect(parseSurfaceJiggle(extras, (w) => warns.push(w))).toBeNull()
    expect(warns[0]).toMatch(/not an object/)
  })

  it('rejects an unknown version', () => {
    expect(parseSurfaceJiggle(sample({ version: 2 }))).toBeNull()
  })

  it('rejects missing tip/owner/gain', () => {
    expect(parseSurfaceJiggle(sample({ tip: '' }))).toBeNull()
    expect(parseSurfaceJiggle(sample({ owner: undefined }))).toBeNull()
    expect(parseSurfaceJiggle(sample({ gain: 'two' }))).toBeNull()
  })

  it('drops one malformed mode but keeps the rest of the declaration', () => {
    const warns: string[] = []
    const d = parseSurfaceJiggle(
      sample({
        modes: [
          { target: 'surface.Hair.1', freqHz: 4.1, zeta: 0.12, max: 0.009, participation: [0, 0.6, 0.8] },
          { target: 'surface.Hair.2', freqHz: 0, zeta: 0.12, max: 0.009, participation: [0, 0, 1] }, // freqHz <= 0
        ],
      }),
      (w) => warns.push(w),
    )
    expect(d?.modes.length).toBe(1)
    expect(d?.modes[0]!.target).toBe('surface.Hair.1')
    expect(warns.some((w) => w.includes('mode #1') && w.includes('freqHz'))).toBe(true)
  })

  it('rejects every mode malformed: null, not a silently empty declaration', () => {
    const d = parseSurfaceJiggle(sample({ modes: [{ target: 'x', freqHz: -1, zeta: 0.1, max: 0.01, participation: [0, 0, 0] }] }))
    expect(d).toBeNull()
  })

  it('rejects zeta outside (0, 1) — the modal oscillator would refuse it anyway', () => {
    const d1 = parseSurfaceJiggle(sample({ modes: [{ target: 'x', freqHz: 5, zeta: 0, max: 0.01, participation: [1, 0, 0] }] }))
    const d2 = parseSurfaceJiggle(sample({ modes: [{ target: 'x', freqHz: 5, zeta: 1, max: 0.01, participation: [1, 0, 0] }] }))
    expect(d1).toBeNull()
    expect(d2).toBeNull()
  })

  it('rejects max <= 0 (the render cap must be a positive displacement in metres)', () => {
    const d = parseSurfaceJiggle(sample({ modes: [{ target: 'x', freqHz: 5, zeta: 0.1, max: 0, participation: [1, 0, 0] }] }))
    expect(d).toBeNull()
  })

  it('rejects a participation vector that is not 3 finite numbers', () => {
    const d = parseSurfaceJiggle(sample({ modes: [{ target: 'x', freqHz: 5, zeta: 0.1, max: 0.01, participation: [1, 0] }] }))
    expect(d).toBeNull()
  })
})
