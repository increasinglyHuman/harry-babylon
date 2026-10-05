import { describe, it, expect } from 'vitest'
import { resolveHipScale, isGroundedPoseKey, isHipPositionTrack, HIP_BONE_NAMES } from './hipHeightCompensation.js'

describe('resolveHipScale', () => {
  it('scales a short-hipped rig down to its own rest height (a short body on a bake-rig clip)', () => {
    // bake rig hips rest at 0.95 of its root frame; the short body's at 0.62 → hips driven to 0.95 float it.
    const d = resolveHipScale(0.95, 0.62, 'default')
    expect(d.reason).toBe('scaled')
    expect(d.factor).toBeCloseTo(0.62 / 0.95, 6)
  })

  it('scales a tall rig UP — hips measured resting 0.45–0.56 across one family', () => {
    const d = resolveHipScale(0.45, 0.56, 'default')
    expect(d.reason).toBe('scaled')
    expect(d.factor).toBeCloseTo(0.56 / 0.45, 6)
  })

  it('leaves a same-rest rig alone — the bake rig playing its own clip is identity', () => {
    for (const [donor, target] of [
      [0.95, 0.95],
      [0.95, 0.954],
      [0.5, 0.496],
    ]) {
      const d = resolveHipScale(donor, target, 'default')
      expect(d.factor).toBe(1)
      expect(d.reason).toBe('identity')
    }
  })

  it('never divides by a degenerate hip — an origin-pinned node is unmeasurable, not zero-height', () => {
    for (const [donor, target] of [
      [0, 0.6],
      [0.6, 0],
      [NaN, 0.6],
      [0.6, Infinity],
      [0.005, 0.6],
    ]) {
      const d = resolveHipScale(donor, target, 'default')
      expect(d.factor).toBe(1)
      expect(d.reason).toBe('unmeasurable')
    }
  })

  it('exempts death even when the ratio is far from 1 — the corpse must not sink', () => {
    for (const key of ['dead', 'death_0', 'Death_From_The_Front', 'DEAD']) {
      const d = resolveHipScale(0.95, 0.62, key)
      expect(d.factor).toBe(1)
      expect(d.reason).toBe('grounded-pose')
    }
  })

  it('SCALES sit — seating places the origin from the live idle hip lift, so the sit clip must share that frame (a short body sat 0.25 above the seat when it was exempt)', () => {
    for (const key of ['sit', 'sitting', 'Sit_Formal', 'Chair-Sit-Bored', 'Sitting_2__anim_v2']) {
      const d = resolveHipScale(0.534, 0.297, key)
      expect(d.reason, key).toBe('scaled')
      expect(d.factor).toBeCloseTo(0.297 / 0.534, 6)
    }
    // The bake rig's sit descends 0.466 → 0.321 in its frame; the short body's must descend
    // in ITS OWN (0.259 → 0.178), not jump up to the donor's absolute 0.321.
    expect(0.321 * (0.297 / 0.534)).toBeLessThan(0.259)
  })

  it('does not exempt standing clips that merely contain the letters mid-token', () => {
    expect(isGroundedPoseKey('default')).toBe(false)
    expect(isGroundedPoseKey('spellCast')).toBe(false)
    expect(isGroundedPoseKey('hitReact_0')).toBe(false)
    expect(isGroundedPoseKey('undead_walk')).toBe(false) // 'dead' inside a token is not a death
    expect(isGroundedPoseKey('deadlift')).toBe(true) // documented edge: token prefix, acceptable
  })
})

describe('isHipPositionTrack', () => {
  it('matches the hip position track of every family and nothing else', () => {
    for (const name of HIP_BONE_NAMES) {
      expect(isHipPositionTrack(name, 'position')).toBe(true)
      expect(isHipPositionTrack(name, 'rotationQuaternion')).toBe(false)
    }
    expect(isHipPositionTrack('L_Thigh', 'position')).toBe(false)
    expect(isHipPositionTrack('R_BicepLeaf_corr', 'position')).toBe(false) // corrective leaf translation, not height
    expect(isHipPositionTrack(undefined, 'position')).toBe(false)
  })
})
