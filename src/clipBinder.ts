/**
 * clipBinder — bind a same-family clip to a skeleton. One binder serves both
 * a player avatar and NPCs, so every character gets the same hip compensation
 * (a separate, thinner NPC binder that skipped it made short-legged bodies
 * squat or float).
 *
 * Direct bind: find each track's bone by exact name, re-point the track to the
 * bone's TransformNode. No quaternion math: the clip was authored (baked) on
 * this family's rig, in its joint frames.
 *
 * Three adjustments:
 *  - locomotion clips lose their root/hip POSITION tracks (the host's movement
 *    controller owns travel);
 *  - hip POSITION keys are scaled by this rig's hip rest over the clip donor's,
 *    grounded poses exempt — unscaled keys drive this rig's hips to the donor's
 *    absolute height (short bodies float, tall ones squat);
 *  - clavicles play REST-ANCHORED (see REST_ANCHORED_BONES).
 *
 * Pure of reporting: the caller decides what to log from the result.
 */

import { Quaternion, type AnimationGroup, type Skeleton } from '@babylonjs/core'
import { isHipPositionTrack, resolveHipScale, scaleHipKeysOnce, type HipScaleDecision } from './hipHeightCompensation.js'

/** Root/hip bone names across the supported rig families (VRM, Mixamo, Blender-exported, VRoid). */
const ROOT_BONE_NAMES: readonly string[] = ['Hips', 'mixamorig:Hips', 'Armature|Hips', 'J_Bip_C_Hips']
/** Root bones on Tripo-style rigs, which can carry travel on the root itself. */
const TRIPO_ROOT_BONES: readonly string[] = ['Root', 'Hip', 'Pelvis']

export interface ClipBindResult {
  bound: number
  /** Tracks whose bone is not on this skeleton (dropped). */
  skipped: number
  rootMotionStripped: number
  /** The COMPLETE set of missing bone names (a dedup key for warnings). */
  missingBones: Set<string>
  /** The first `sampleCap` missing names, for display. */
  unboundSample: string[]
  /** The hip-height decision, or null when the clip had no hip position track to scale. */
  hip: HipScaleDecision | null
  /** Rest-anchored bones whose keys were carried onto this body's rest. */
  restAnchored: string[]
}

/**
 * Bones played REST-ANCHORED (Harry's `restAnchoredTransport` rule). A clavicle's rest direction is
 * per-body ANATOMY, not pose, but a family clip writes the DONOR's absolute clavicle rotation: a body
 * whose clavicles rest lower than the donor's shrugs from the first frame ("football shoulders" —
 * common on auto-rigged generated bodies, where the shoulder joint can sit tens of millimetres off
 * the donor's). So the clavicle plays q·R with R = donorRest⁻¹·bodyRest — the donor's rest lands on
 * this body's rest, the clip's motion still plays — and each keyed child plays R⁻¹·q, which cancels
 * R: the arm keeps the clip's world direction. Babylon composes world = parent·child (measured), the
 * order this relies on.
 */
export const REST_ANCHORED_BONES: readonly string[] = ['L_Clavicle', 'R_Clavicle']

/** Animations already carried onto a body: a rebind must not compound the anchor. */
const anchoredOnce = new WeakSet<object>()

type QuatKey = { value?: unknown; inTangent?: unknown; outTangent?: unknown }

function transformQuatKeysOnce(keys: ReadonlyArray<QuatKey>, f: (q: Quaternion) => Quaternion): void {
  const done = new Set<object>()
  const once = (v: unknown): void => {
    if (!(v instanceof Quaternion) || done.has(v)) return
    done.add(v)
    v.copyFrom(f(v))
  }
  for (const k of keys) {
    once(k.value)
    once(k.inTangent)
    once(k.outTangent)
  }
}

/**
 * Read each rest-anchored bone's anchor BEFORE the tracks are re-pointed (the donor's rest is the
 * clip's own node, as the hip compensation reads it), then carry its keys and its keyed children's.
 */
function anchorRestedBones(animGroup: AnimationGroup, skeleton: Skeleton): string[] {
  const anchors = new Map<string, Quaternion>()
  for (const ta of animGroup.targetedAnimations) {
    const name = ta.target?.name
    if (!name || !REST_ANCHORED_BONES.includes(name) || ta.animation?.targetProperty !== 'rotationQuaternion') continue
    const donorRest = (ta.target as { rotationQuaternion?: Quaternion | null }).rotationQuaternion
    const bone = skeleton.bones.find((b: { name: string }) => b.name === name)
    if (!donorRest || !bone) continue
    const bodyRest = new Quaternion()
    bone.getRestMatrix().decompose(undefined, bodyRest, undefined)
    const anchor = Quaternion.Inverse(donorRest).multiply(bodyRest)
    if (Math.abs(Math.abs(anchor.w) - 1) < 1e-9) continue // this body rests where the donor does
    anchors.set(name, anchor)
  }
  if (anchors.size === 0) return []
  for (const ta of animGroup.targetedAnimations) {
    const name = ta.target?.name
    if (!name || ta.animation?.targetProperty !== 'rotationQuaternion' || anchoredOnce.has(ta.animation)) continue
    const own = anchors.get(name)
    const parentName = skeleton.bones.find((b: { name: string }) => b.name === name)?.getParent()?.name
    const parent = parentName === undefined ? undefined : anchors.get(parentName)
    if (own === undefined && parent === undefined) continue
    const parentInverse = parent === undefined ? undefined : Quaternion.Inverse(parent)
    transformQuatKeysOnce(ta.animation.getKeys(), (q) => {
      let out = q
      if (parentInverse !== undefined) out = parentInverse.multiply(out)
      if (own !== undefined) out = out.multiply(own)
      return out
    })
    anchoredOnce.add(ta.animation)
  }
  return [...anchors.keys()]
}

export function bindClipToSkeleton(
  animGroup: AnimationGroup,
  skeleton: Skeleton,
  animKey: string,
  stripRootMotion: boolean,
  sampleCap = 8,
): ClipBindResult {
  const result: ClipBindResult = { bound: 0, skipped: 0, rootMotionStripped: 0, missingBones: new Set(), unboundSample: [], hip: null, restAnchored: [] }

  // The clip GLB carries the donor skeleton's rest pose: read the donor hip rest from the
  // clip's own node BEFORE it is re-pointed, this rig's from its bone REST matrix (the live
  // node may already be animated when later clips bind). Locomotion clips have those keys
  // stripped below, so there is nothing to scale.
  const hipTrack = stripRootMotion
    ? undefined
    : animGroup.targetedAnimations.find((ta) => isHipPositionTrack(ta.target?.name, ta.animation?.targetProperty))
  if (hipTrack) {
    const donor = hipTrack.target as { position?: { length(): number } } | null
    const targetBone = skeleton.bones.find((b: { name: string }) => b.name === hipTrack.target?.name)
    const donorLen = donor?.position?.length() ?? 0
    const targetLen = targetBone ? targetBone.getRestMatrix().getTranslation().length() : 0
    result.hip = resolveHipScale(donorLen, targetLen, animKey)
  }
  const hip = result.hip
  result.restAnchored = anchorRestedBones(animGroup, skeleton)

  const kept = animGroup.targetedAnimations.filter((ta) => {
    const targetName = ta.target?.name
    if (!targetName) return false

    // Strip root bone position tracks for locomotion (Tripo-style travel-carrying
    // roots too, or a Tripo walk double-moves against the controller's travel).
    if (stripRootMotion) {
      const isRootBone = [...ROOT_BONE_NAMES, ...TRIPO_ROOT_BONES].some((rb) => targetName === rb || targetName.includes(rb))
      const isPositionAnim = (ta.animation?.targetProperty || '').includes('position')
      if (isRootBone && isPositionAnim) {
        result.rootMotionStripped++
        return false
      }
    }

    const targetBone = skeleton.bones.find((b: { name: string }) => b.name === targetName)
    if (!targetBone) {
      result.skipped++
      result.missingBones.add(targetName)
      if (result.unboundSample.length < sampleCap) result.unboundSample.push(targetName)
      return false
    }

    if (hip && hip.factor !== 1 && isHipPositionTrack(targetName, ta.animation?.targetProperty)) {
      // Each distinct key object once: keys can alias (the padded first key reuses the
      // next key's Vector3), and scaling per key made a static pose ramp and snap.
      scaleHipKeysOnce(ta.animation.getKeys(), hip.factor)
    }

    // Re-point to the bone's TransformNode (critical for Babylon.js GLB skeletons).
    ta.target = targetBone.getTransformNode() ?? targetBone
    result.bound++
    return true
  })

  animGroup.targetedAnimations.length = 0
  kept.forEach((ta) => animGroup.targetedAnimations.push(ta))
  return result
}
