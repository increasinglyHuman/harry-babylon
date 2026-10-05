/**
 * Hip-height compensation for same-family clips.
 *
 * A same-family clip carries hip POSITION keys authored on the bake rig, whose
 * hips rest at one height. Bound as-is, they drive every rig's hips to the
 * DONOR's absolute height — a short-legged body rides up until its feet clear
 * the ground by exactly the difference. Scaling the body does not change the
 * ratio, so uniform scaling cannot fix it.
 *
 * The fix: the clip GLB ships the donor skeleton's rest pose, so the donor hip
 * height is read from the clip and this rig's from its own bind, and the hip
 * position keys are scaled by the ratio. No hard-coded numbers; the
 * expectation travels inside the clip. This module is that rule, pure, so
 * every binder can share it and a test can pin it.
 *
 * Only DEATH is exempt (a scaled corpse sinks through the ground): it has no
 * placement system under it, so its authored floor endpoint is the only
 * reference.
 *
 * SIT IS NOT EXEMPT. A typical seating system never reads the clip's absolute
 * hip height: it places the mesh origin at `seat − hipLift`, where hipLift is
 * measured from the LIVE idle pose — already in this rig's scaled frame — and
 * the sit clip then drives the hips. Example: the bake rig's idle holds the
 * hip at ~0.466 and its sit takes it to 0.321, a 0.145 descent the placement
 * is calibrated for. An unscaled sit on a short body (idle at 0.259 after
 * ×0.556) moved its hips UP to 0.321 instead of down to its own 0.178.
 * Everything that plays after placement must be in the same frame as the
 * measurement.
 */

/** Skeleton-side names of the bone whose position keys carry hip height, by family. */
export const HIP_BONE_NAMES: readonly string[] = ['J_Bip_C_Hips', 'Hips', 'mixamorig:Hips', 'Armature|Hips', 'Hip']

/** Below this rest length a hip node is degenerate (origin-pinned) — refuse to divide. */
export const MIN_HIP_REST_LENGTH = 0.01

/** Ratios this close to 1 are noise from the bake; skip the key rewrite. */
export const HIP_SCALE_EPSILON = 0.01

export interface HipScaleDecision {
  /** Multiply every hip position key by this. 1 = leave the clip alone. */
  factor: number
  reason: 'scaled' | 'identity' | 'grounded-pose' | 'unmeasurable'
  donorRestLen: number
  targetRestLen: number
}

/**
 * Clip keys whose hip travel is authored to a FLOOR endpoint with no placement
 * system under it — death, and only death (see the module note on sit). Not
 * only contract keys: scripted inventory clips reach the binder under their
 * literal names (`Death_From_The_Front`), so the test is
 * per TOKEN and case-insensitive, never a bare prefix on the whole string.
 */
export function isGroundedPoseKey(animKey: string): boolean {
  return animKey
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((token) => token.startsWith('dead') || token.startsWith('death'))
}

export function resolveHipScale(donorRestLen: number, targetRestLen: number, animKey: string): HipScaleDecision {
  const base = { donorRestLen, targetRestLen }
  if (isGroundedPoseKey(animKey)) return { factor: 1, reason: 'grounded-pose', ...base }
  if (
    !Number.isFinite(donorRestLen) ||
    !Number.isFinite(targetRestLen) ||
    donorRestLen < MIN_HIP_REST_LENGTH ||
    targetRestLen < MIN_HIP_REST_LENGTH
  ) {
    return { factor: 1, reason: 'unmeasurable', ...base }
  }
  const factor = targetRestLen / donorRestLen
  if (Math.abs(factor - 1) <= HIP_SCALE_EPSILON) return { factor: 1, reason: 'identity', ...base }
  return { factor, reason: 'scaled', ...base }
}

/** Is this track the hip's POSITION track — the one that carries height? */
export function isHipPositionTrack(targetName: string | undefined, targetProperty: string | undefined): boolean {
  return !!targetName && HIP_BONE_NAMES.includes(targetName) && (targetProperty ?? '').includes('position')
}

/** Anything with a Babylon-style in-place scale — Vector3 in practice. */
type Scalable = { scaleInPlace?: (f: number) => unknown } | null | undefined

/** The shape of a hip position key as every binder sees it: a value, and Hermite tangents when the track is CUBICSPLINE. */
export interface HipKeyLike {
  value?: Scalable
  inTangent?: Scalable
  outTangent?: Scalable
}

/**
 * Scale a hip position track's keys by the ratio — each distinct object ONCE:
 * the value, and the Hermite tangents when the key has them (they are
 * derivatives of the values, so they scale with them).
 *
 * Keys can alias one Vector3: a track padded to the group's start frame gets a
 * synthetic first key that reuses the next key's value AND tangent objects
 * (Babylon's AnimationGroup.normalize; the glTF loader normalizes every group
 * to frame 0). Scaling "in place, per key" then hits each shared object once
 * per alias. Worked example on a STATIC wait pose (two identical keys at
 * 0.536), rig factor 0.940: keys 0 and 4 read 0.474 (= 0.536 × 0.940²), key
 * 200 read 0.504 (= 0.536 × 0.940). The loop interpolated 3 cm between them
 * and snapped at the wrap — a hip sawtooth the clip's content could not
 * explain.
 *
 * One rule for every binder: player, NPC, and preview stages alike.
 */
export function scaleHipKeysOnce(keys: ReadonlyArray<HipKeyLike>, factor: number): void {
  const scaled = new Set<object>()
  const once = (v: Scalable): void => {
    if (!v || typeof v !== 'object' || typeof v.scaleInPlace !== 'function' || scaled.has(v)) return
    scaled.add(v)
    v.scaleInPlace(factor)
  }
  for (const k of keys) {
    once(k.value)
    once(k.inTangent)
    once(k.outTangent)
  }
}
