/**
 * springBoneDeclaration — parse the `VRMC_springBone` 1.0 glTF extension into
 * a plain declaration (springs are declared in the file, not guessed from bone
 * names).
 *
 * ONE responsibility: JSON in, validated data out. No Babylon, no scene — the
 * runtime (SpringBoneRuntime.ts) resolves node indices to TransformNodes.
 *
 * Spec: https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_springBone-1.0
 * Mapping follows the reference reader (three-vrm-springbone 3.5.5
 * `VRMSpringBoneLoaderPlugin._v1Import`): a spring's joints are listed root →
 * tip; joint k and joint k+1 form ONE simulated segment whose settings are
 * joint k's. The last joint has no tail and is not simulated.
 *
 * Anything the file gets wrong is reported by name in `warnings` and skipped
 * (the reference reader does the same, silently); the caller logs them.
 */

export type Vec3Tuple = [number, number, number]

export interface SpringColliderSphere {
  kind: 'sphere'
  offset: Vec3Tuple
  radius: number
}

export interface SpringColliderCapsule {
  kind: 'capsule'
  offset: Vec3Tuple
  tail: Vec3Tuple
  radius: number
}

export interface SpringCollider {
  /** glTF node index the collider rides on. Offsets are in that node's LOCAL frame. */
  node: number
  shape: SpringColliderSphere | SpringColliderCapsule
}

export interface SpringJointSettings {
  hitRadius: number
  stiffness: number
  gravityPower: number
  gravityDir: Vec3Tuple
  dragForce: number
}

/** One simulated segment: `node` rotates so that `child` follows the spring. */
export interface SpringSegment {
  node: number
  child: number
  settings: SpringJointSettings
}

export interface SpringDeclarationEntry {
  name: string
  /** Every joint node, root → tip (the last one has no segment of its own). */
  jointNodes: number[]
  segments: SpringSegment[]
  /** Indices into `SpringBoneDeclaration.colliders`, flattened from the spring's collider groups. */
  colliders: number[]
  /** `center` node index, if the spring is evaluated in a center space. Not supported yet — see runtime. */
  center: number | null
  /** `springs[i].extras` verbatim (Harry's `poqpoq.drive` rides here; read by the layered drive). */
  extras: unknown
}

export interface SpringBoneDeclaration {
  specVersion: string
  colliders: SpringCollider[]
  springs: SpringDeclarationEntry[]
  warnings: string[]
}

export const VRMC_SPRING_BONE = 'VRMC_springBone'
const SPEC_VERSIONS = new Set(['1.0', '1.0-beta'])

// Spec defaults (VRMC_springBone-1.0 schema). three-vrm's joint constructor
// falls back to dragForce 0.4 instead; the file's meaning is the spec's.
const DEFAULTS: SpringJointSettings = {
  hitRadius: 0,
  stiffness: 1,
  gravityPower: 0,
  gravityDir: [0, -1, 0],
  dragForce: 0.5,
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const vec3 = (v: unknown, fallback: Vec3Tuple): Vec3Tuple =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))
    ? [v[0], v[1], v[2]]
    : [...fallback]
const nodeIndex = (v: unknown, nodeCount: number): number | null =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) < nodeCount ? (v as number) : null

/**
 * Parse `json.extensions.VRMC_springBone`. Returns null when the extension is
 * absent or of an unknown spec version (the latter with a warning in the
 * returned-null case logged by the caller via `onWarn`).
 */
export function parseVRMCSpringBone(
  extension: unknown,
  nodeCount: number,
  onWarn: (message: string) => void = () => {},
): SpringBoneDeclaration | null {
  if (!isObj(extension)) return null
  const specVersion = typeof extension.specVersion === 'string' ? extension.specVersion : ''
  if (!SPEC_VERSIONS.has(specVersion)) {
    onWarn(`${VRMC_SPRING_BONE}: unknown specVersion "${specVersion}" — springs not read`)
    return null
  }
  const warnings: string[] = []
  const warn = (m: string): void => {
    warnings.push(m)
    onWarn(`${VRMC_SPRING_BONE}: ${m}`)
  }

  // Colliders. Index positions are preserved (null = skipped) so groups keep pointing at the right one.
  const rawColliders = Array.isArray(extension.colliders) ? extension.colliders : []
  const colliderSlots: (number | null)[] = []
  const colliders: SpringCollider[] = []
  rawColliders.forEach((c, i) => {
    const node = isObj(c) ? nodeIndex(c.node, nodeCount) : null
    const shape = isObj(c) && isObj(c.shape) ? c.shape : null
    if (node === null || shape === null) {
      warn(`collider #${i} has no valid node or shape — skipped`)
      colliderSlots.push(null)
      return
    }
    if (isObj(shape.sphere)) {
      colliders.push({ node, shape: { kind: 'sphere', offset: vec3(shape.sphere.offset, [0, 0, 0]), radius: num(shape.sphere.radius, 0) } })
    } else if (isObj(shape.capsule)) {
      colliders.push({
        node,
        shape: {
          kind: 'capsule',
          offset: vec3(shape.capsule.offset, [0, 0, 0]),
          tail: vec3(shape.capsule.tail, [0, 0, 0]),
          radius: num(shape.capsule.radius, 0),
        },
      })
    } else {
      warn(`collider #${i} has neither a sphere nor a capsule — skipped`)
      colliderSlots.push(null)
      return
    }
    colliderSlots.push(colliders.length - 1)
  })

  const rawGroups = Array.isArray(extension.colliderGroups) ? extension.colliderGroups : []
  const groups: number[][] = rawGroups.map((g, gi) => {
    const list = isObj(g) && Array.isArray(g.colliders) ? g.colliders : []
    const out: number[] = []
    for (const ci of list) {
      const slot = Number.isInteger(ci) ? colliderSlots[ci as number] : undefined
      if (slot === undefined || slot === null) warn(`collider group #${gi} names collider #${String(ci)}, which does not exist — skipped`)
      else out.push(slot)
    }
    return out
  })

  const rawSprings = Array.isArray(extension.springs) ? extension.springs : []
  const springs: SpringDeclarationEntry[] = []
  rawSprings.forEach((s, si) => {
    if (!isObj(s) || !Array.isArray(s.joints)) {
      warn(`spring #${si} has no joints — skipped`)
      return
    }
    const name = typeof s.name === 'string' && s.name !== '' ? s.name : `spring#${si}`
    const jointNodes: number[] = []
    const settings: SpringJointSettings[] = []
    for (const [ji, j] of s.joints.entries()) {
      const node = isObj(j) ? nodeIndex(j.node, nodeCount) : null
      if (node === null) {
        // A hole breaks the chain; the reference reader would pair across it. Stop here instead.
        warn(`spring "${name}" joint #${ji} names no valid node — the chain is cut there`)
        break
      }
      const jo = j as Record<string, unknown>
      jointNodes.push(node)
      settings.push({
        hitRadius: num(jo.hitRadius, DEFAULTS.hitRadius),
        stiffness: num(jo.stiffness, DEFAULTS.stiffness),
        gravityPower: num(jo.gravityPower, DEFAULTS.gravityPower),
        gravityDir: vec3(jo.gravityDir, DEFAULTS.gravityDir),
        dragForce: num(jo.dragForce, DEFAULTS.dragForce),
      })
    }
    if (jointNodes.length < 2) {
      warn(`spring "${name}" has fewer than two joints — nothing to simulate`)
      return
    }
    const segments: SpringSegment[] = []
    for (let k = 0; k + 1 < jointNodes.length; k++) {
      segments.push({ node: jointNodes[k], child: jointNodes[k + 1], settings: settings[k] })
    }
    const colliderSet = new Set<number>()
    const groupRefs = Array.isArray(s.colliderGroups) ? s.colliderGroups : []
    for (const gi of groupRefs) {
      const g = Number.isInteger(gi) ? groups[gi as number] : undefined
      if (g === undefined) warn(`spring "${name}" names collider group #${String(gi)}, which does not exist — skipped`)
      else for (const c of g) colliderSet.add(c)
    }
    springs.push({
      name,
      jointNodes,
      segments,
      colliders: [...colliderSet],
      center: s.center === undefined ? null : nodeIndex(s.center, nodeCount),
      extras: s.extras,
    })
  })

  return { specVersion, colliders, springs, warnings }
}
