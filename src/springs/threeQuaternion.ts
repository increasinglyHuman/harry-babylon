/**
 * threeQuaternion — three.js r18x Quaternion `angleTo` / `slerp` /
 * `rotateTowards` / `setFromAxisAngle`, on Babylon quaternions.
 *
 * Why not Babylon's own: `Quaternion.SlerpToRef` switches to a linear blend
 * below a different threshold (dot > 0.999999) than three (sin² ≤ ε), and
 * `RotationAxisToRef` normalises its axis argument in place. The layered drive
 * applies these every step to every driven joint; Harry previews with three,
 * so this runtime uses three's arithmetic (quaternion components are convention-free: both
 * engines use the Hamilton product and rotate v by q·v·q*).
 */

import type { Quaternion, Vector3 } from '@babylonjs/core'

export function angleTo(a: Quaternion, b: Quaternion): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  return 2 * Math.acos(Math.abs(Math.min(1, Math.max(-1, dot))))
}

/** In place: `q` ← slerp(q, b, t), three's algorithm. */
export function slerpThree(q: Quaternion, b: Quaternion, t: number): Quaternion {
  if (t === 0) return q
  if (t === 1) return q.copyFrom(b)
  const x = q.x
  const y = q.y
  const z = q.z
  const w = q.w
  let cosHalfTheta = w * b.w + x * b.x + y * b.y + z * b.z
  if (cosHalfTheta < 0) {
    q.set(-b.x, -b.y, -b.z, -b.w)
    cosHalfTheta = -cosHalfTheta
  } else {
    q.copyFrom(b)
  }
  if (cosHalfTheta >= 1.0) {
    return q.set(x, y, z, w)
  }
  const sqrSinHalfTheta = 1.0 - cosHalfTheta * cosHalfTheta
  if (sqrSinHalfTheta <= Number.EPSILON) {
    const s = 1 - t
    q.set(s * x + t * q.x, s * y + t * q.y, s * z + t * q.z, s * w + t * q.w)
    return q.normalize()
  }
  const sinHalfTheta = Math.sqrt(sqrSinHalfTheta)
  const halfTheta = Math.atan2(sinHalfTheta, cosHalfTheta)
  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta
  const ratioB = Math.sin(t * halfTheta) / sinHalfTheta
  return q.set(x * ratioA + q.x * ratioB, y * ratioA + q.y * ratioB, z * ratioA + q.z * ratioB, w * ratioA + q.w * ratioB)
}

/** In place: turn `q` toward `b` by at most `step` radians. */
export function rotateTowards(q: Quaternion, b: Quaternion, step: number): Quaternion {
  const angle = angleTo(q, b)
  if (angle === 0) return q
  return slerpThree(q, b, Math.min(1, step / angle))
}

/** `out` ← rotation of `angle` about the unit `axis` (not normalised, not mutated). */
export function fromAxisAngle(axis: Vector3, angle: number, out: Quaternion): Quaternion {
  const half = angle / 2
  const s = Math.sin(half)
  return out.set(axis.x * s, axis.y * s, axis.z * s, Math.cos(half))
}
