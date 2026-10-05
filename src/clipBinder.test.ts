/**
 * clipBinder — one binder for player avatars and NPCs alike, so every body
 * gets the same hip compensation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Animation, AnimationGroup, Bone, NullEngine, Quaternion, Scene, Skeleton, TransformNode, Vector3, Matrix } from '@babylonjs/core'
import { bindClipToSkeleton } from './clipBinder.js'

let engine: NullEngine
let scene: Scene
beforeEach(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
})
afterEach(() => {
  scene.dispose()
  engine.dispose()
})

/** A rig whose hip rests `hipRest` above the root, with `extra` bones beside it. */
function rig(hipRest: number, extra: string[] = []): Skeleton {
  const sk = new Skeleton('rig', 'rig', scene)
  const hip = new Bone('J_Bip_C_Hips', sk, null, Matrix.Translation(0, hipRest, 0))
  hip.linkTransformNode(new TransformNode('J_Bip_C_Hips', scene))
  for (const n of ['J_Bip_C_Spine', ...extra]) {
    const b = new Bone(n, sk, hip, Matrix.Identity())
    b.linkTransformNode(new TransformNode(n, scene))
  }
  return sk
}

/** A clip whose donor hip rests at `donorHip`, keying the hip position and the given bones' rotation. */
function clip(donorHip: number, bones: string[]): AnimationGroup {
  const g = new AnimationGroup('clip', scene)
  const donorHipNode = new TransformNode('J_Bip_C_Hips', scene)
  donorHipNode.position.set(0, donorHip, 0)
  const pos = new Animation('hipPos', 'position', 30, Animation.ANIMATIONTYPE_VECTOR3)
  pos.setKeys([{ frame: 0, value: new Vector3(0, donorHip, 0) }, { frame: 10, value: new Vector3(0.1, donorHip + 0.05, 0) }])
  g.addTargetedAnimation(pos, donorHipNode)
  for (const b of bones) {
    const rot = new Animation(`${b}Rot`, 'rotationQuaternion', 30, Animation.ANIMATIONTYPE_QUATERNION)
    rot.setKeys([{ frame: 0, value: { x: 0, y: 0, z: 0, w: 1 } }])
    g.addTargetedAnimation(rot, new TransformNode(b, scene))
  }
  return g
}

describe('bindClipToSkeleton', () => {
  it('scales the hip POSITION keys by this rig over the donor (a short body must not squat on a tall donor clip)', () => {
    const g = clip(1.0, ['J_Bip_C_Spine'])
    const r = bindClipToSkeleton(g, rig(0.8), 'default', false)
    expect(r.hip?.reason).toBe('scaled')
    expect(r.hip?.factor).toBeCloseTo(0.8, 6)
    const keys = g.targetedAnimations.find((ta) => ta.animation.targetProperty === 'position')!.animation.getKeys()
    expect((keys[0].value as Vector3).y).toBeCloseTo(0.8, 6)
    expect((keys[1].value as Vector3).y).toBeCloseTo(0.84, 6)
  })

  it('leaves grounded poses alone (death lands on the floor the donor authored)', () => {
    const g = clip(1.0, [])
    const r = bindClipToSkeleton(g, rig(0.8), 'death_0', false)
    expect(r.hip?.reason).toBe('grounded-pose')
    const keys = g.targetedAnimations[0].animation.getKeys()
    expect((keys[0].value as Vector3).y).toBeCloseTo(1.0, 6)
  })

  it('strips the root motion of a locomotion clip and keeps its rotations', () => {
    const g = clip(1.0, ['J_Bip_C_Spine'])
    const r = bindClipToSkeleton(g, rig(0.8), 'walk', true)
    expect(r.rootMotionStripped).toBe(1)
    expect(r.hip).toBeNull()
    expect(g.targetedAnimations.map((ta) => ta.animation.targetProperty)).toEqual(['rotationQuaternion'])
  })

  it('re-points tracks to this rig and reports every bone it does not have', () => {
    const sk = rig(1.0)
    const g = clip(1.0, ['J_Bip_C_Spine', 'J_Bip_L_Toe', 'J_Bip_R_Toe'])
    const r = bindClipToSkeleton(g, sk, 'default', false, 1)
    expect(r.bound).toBe(2)
    expect(r.skipped).toBe(2)
    expect([...r.missingBones].sort()).toEqual(['J_Bip_L_Toe', 'J_Bip_R_Toe'])
    expect(r.unboundSample).toHaveLength(1)
    const spine = sk.bones.find((b) => b.name === 'J_Bip_C_Spine')!.getTransformNode()
    expect(g.targetedAnimations.some((ta) => ta.target === spine)).toBe(true)
  })
})

describe('rest-anchored clavicles (the football shoulders)', () => {
  const Q = (x: number, y: number, z: number, angle: number): Quaternion => Quaternion.RotationAxis(new Vector3(x, y, z).normalize(), angle)
  const near = (a: Quaternion, b: Quaternion): number => Math.min(a.subtract(b).length(), a.add(b).length())

  // This body's clavicle rests 20° lower than the donor's (the class of auto-rigged body that shrugs).
  const bodyRest = Q(0, 0, 1, -0.35)
  const donorRest = Q(0, 0, 1, 0)
  function shoulderRig(clavicleRest: Quaternion): Skeleton {
    const sk = new Skeleton('rig', 'rig', scene)
    const spine = new Bone('Spine02', sk, null, Matrix.Translation(0, 1.2, 0))
    spine.linkTransformNode(new TransformNode('Spine02', scene))
    const clav = new Bone('L_Clavicle', sk, spine, Matrix.Compose(Vector3.One(), clavicleRest, new Vector3(0.02, 0.1, 0)))
    clav.linkTransformNode(new TransformNode('L_Clavicle', scene))
    const arm = new Bone('L_Upperarm', sk, clav, Matrix.Translation(0.15, 0, 0))
    arm.linkTransformNode(new TransformNode('L_Upperarm', scene))
    return sk
  }
  /** A clip whose clavicle rests at the DONOR's rest, then raises 15°; the arm swings. */
  const clavKeys = [donorRest.clone(), Q(0, 0, 1, 0.26).multiply(donorRest)]
  const armKeys = [Q(0, 0, 1, -1.2), Q(1, 0, 0, 0.5).multiply(Q(0, 0, 1, -1.2))]
  function shoulderClip(): AnimationGroup {
    const g = new AnimationGroup('clip', scene)
    const donorClav = new TransformNode('L_Clavicle', scene)
    donorClav.rotationQuaternion = donorRest.clone()
    const c = new Animation('clav', 'rotationQuaternion', 30, Animation.ANIMATIONTYPE_QUATERNION)
    c.setKeys(clavKeys.map((q, i) => ({ frame: i * 10, value: q.clone() })))
    g.addTargetedAnimation(c, donorClav)
    const a = new Animation('arm', 'rotationQuaternion', 30, Animation.ANIMATIONTYPE_QUATERNION)
    a.setKeys(armKeys.map((q, i) => ({ frame: i * 10, value: q.clone() })))
    g.addTargetedAnimation(a, new TransformNode('L_Upperarm', scene))
    return g
  }
  const keysOf = (g: AnimationGroup, bone: string): Quaternion[] =>
    g.targetedAnimations.find((ta) => ta.target?.name === bone)!.animation.getKeys().map((k) => k.value as Quaternion)

  it("holds THIS body's clavicle rest at the clip's rest frame, and still plays the clip's raise", () => {
    const g = shoulderClip()
    const r = bindClipToSkeleton(g, shoulderRig(bodyRest), 'idle', false)
    expect(r.restAnchored).toEqual(['L_Clavicle'])
    const clav = keysOf(g, 'L_Clavicle')
    expect(near(clav[0], bodyRest)).toBeLessThan(1e-6) // no shrug: the body's own shoulder
    // the raise is the clip's, as a parent-frame delta
    expect(near(clav[1].multiply(Quaternion.Inverse(clav[0])), clavKeys[1].multiply(Quaternion.Inverse(clavKeys[0])))).toBeLessThan(1e-6)
  })

  it("keeps the arm's world direction: the child cancels the clavicle's anchor", () => {
    const g = shoulderClip()
    bindClipToSkeleton(g, shoulderRig(bodyRest), 'idle', false)
    const clav = keysOf(g, 'L_Clavicle')
    const arm = keysOf(g, 'L_Upperarm')
    for (let k = 0; k < 2; k++) {
      expect(near(clav[k].multiply(arm[k]), clavKeys[k].multiply(armKeys[k]))).toBeLessThan(1e-6)
    }
  })

  it('a rebind does not compound the anchor', () => {
    const g = shoulderClip()
    const sk = shoulderRig(bodyRest)
    bindClipToSkeleton(g, sk, 'idle', false)
    const once = keysOf(g, 'L_Clavicle').map((q) => q.clone())
    bindClipToSkeleton(g, sk, 'idle', false)
    keysOf(g, 'L_Clavicle').forEach((q, i) => expect(near(q, once[i])).toBeLessThan(1e-9))
  })

  it('a body resting where the donor does plays the clip untouched', () => {
    const g = shoulderClip()
    const r = bindClipToSkeleton(g, shoulderRig(donorRest), 'idle', false)
    expect(r.restAnchored).toEqual([])
    keysOf(g, 'L_Clavicle').forEach((q, i) => expect(near(q, clavKeys[i])).toBeLessThan(1e-9))
    keysOf(g, 'L_Upperarm').forEach((q, i) => expect(near(q, armKeys[i])).toBeLessThan(1e-9))
  })

  it('the shoulder joint stays where this body put it (the measured lift goes to zero)', () => {
    const sk = shoulderRig(bodyRest)
    const g = shoulderClip()
    bindClipToSkeleton(g, sk, 'idle', false)
    const node = (n: string) => sk.bones.find((b) => b.name === n)!.getTransformNode()!
    node('L_Clavicle').parent = node('Spine02')
    node('L_Upperarm').parent = node('L_Clavicle')
    const shoulderAt = (clavRot: Quaternion): Vector3 => {
      node('Spine02').position.set(0, 1.2, 0)
      node('L_Clavicle').position.set(0.02, 0.1, 0)
      node('L_Clavicle').rotationQuaternion = clavRot.clone()
      node('L_Upperarm').position.set(0.15, 0, 0)
      node('L_Upperarm').computeWorldMatrix(true)
      return node('L_Upperarm').getAbsolutePosition().clone()
    }
    const rest = shoulderAt(bodyRest)
    const played = shoulderAt(keysOf(g, 'L_Clavicle')[0])
    expect(Vector3.Distance(played, rest)).toBeLessThan(1e-6)
    // before the fix the donor's absolute rotation lifted it
    expect(shoulderAt(donorRest).y - rest.y).toBeGreaterThan(0.04)
  })
})
