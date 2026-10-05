import { describe, expect, it } from 'vitest'
import { Vector3 } from '@babylonjs/core'
import { scaleHipKeysOnce } from './hipHeightCompensation.js'

/**
 * The hip sawtooth on a static seated pose.
 *
 * Trace: the playing group's hip
 * position keys read 0:0.474, 4:0.474, 200:0.504 for a bake whose two keys
 * are both 0.536. The rig's hip factor is 0.940: 0.536 × 0.940² = 0.474 and
 * 0.536 × 0.940 = 0.504. The first two keys had been scaled TWICE — they
 * share one Vector3 (Babylon's AnimationGroup.normalize pads a track to the
 * group start with a key that reuses the first key's value object) — and the
 * last once. The loop then ramps 3 cm between them and snaps at the wrap.
 *
 * The rule: scale each distinct value object once, however many keys point
 * at it.
 */
describe('scaleHipKeysOnce', () => {
  it('scales aliased keys once — a static wait clip after normalize()', () => {
    const shared = new Vector3(0, 0, 0.536)
    const keys = [
      { frame: 0, value: shared }, // normalize()'s pad — same object as frame 4
      { frame: 4, value: shared },
      { frame: 200, value: new Vector3(0, 0, 0.536) },
    ]

    scaleHipKeysOnce(keys, 0.94)

    for (const k of keys) expect(k.value.z).toBeCloseTo(0.536 * 0.94, 6)
    expect(keys[0].value.z).toBeCloseTo(keys[2].value.z, 6) // no ramp left to loop over
  })

  it('scales every distinct key exactly once, including lateral sway', () => {
    const keys = [
      { frame: 0, value: new Vector3(0.1, 0, 0.5) },
      { frame: 10, value: new Vector3(-0.1, 0.02, 0.5) },
    ]
    scaleHipKeysOnce(keys, 0.5)
    expect(keys[0].value.asArray()).toEqual([0.05, 0, 0.25])
    expect(keys[1].value.asArray()).toEqual([-0.05, 0.01, 0.25])
  })

  it('scales aliased tangents once too — the pad shares the next key\'s tangent objects', () => {
    const sharedValue = new Vector3(0, 0, 1)
    const sharedIn = new Vector3(0, 0, 2)
    const sharedOut = new Vector3(0, 0, 4)
    const keys = [
      { frame: 0, value: sharedValue, inTangent: sharedIn, outTangent: sharedOut }, // normalize()'s pad
      { frame: 4, value: sharedValue, inTangent: sharedIn, outTangent: sharedOut },
      { frame: 8, value: new Vector3(0, 0, 1), inTangent: new Vector3(0, 0, 2), outTangent: new Vector3(0, 0, 4) },
    ]

    scaleHipKeysOnce(keys, 0.5)

    expect(keys.map((k) => k.value.z)).toEqual([0.5, 0.5, 0.5])
    expect(keys.map((k) => k.inTangent.z)).toEqual([1, 1, 1])
    expect(keys.map((k) => k.outTangent.z)).toEqual([2, 2, 2])
  })

  it('leaves keys without tangents alone apart from the value', () => {
    const keys = [{ frame: 0, value: new Vector3(0, 0, 1) }]
    scaleHipKeysOnce(keys, 0.5)
    expect(keys[0].value.z).toBe(0.5)
    expect('inTangent' in keys[0]).toBe(false)
  })

  it('tolerates keys without a scalable value', () => {
    const keys = [
      { frame: 0, value: undefined },
      { frame: 1, value: 3 as unknown as Vector3 },
    ]
    expect(() => scaleHipKeysOnce(keys as never, 0.9)).not.toThrow()
  })
})
