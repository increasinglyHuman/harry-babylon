/**
 * vroidSpringSynthesis — a VRMC_springBone declaration for a VRoid body whose
 * file no longer carries one (so those bodies run on SpringBoneRuntime rather
 * than a separate name-guessing solver).
 *
 * Why the declaration goes missing: VRoid Studio writes VRMC_springBone, but a
 * re-export through a generic glTF exporter (e.g. THREE.GLTFExporter) drops
 * every extension. Such bodies arrive as bare GLBs with their spring bones
 * still NAMED (`J_Sec_*` hair/skirt/bust/sleeves, `J_Opt_*` accessories such
 * as a fox tail) but no settings.
 *
 * What replaces the lost settings — VRoid Studio's OWN values, measured from
 * two genuine VRoid Studio 2.10 exports (reference avatars A and B):
 *   - gravityPower 0 on every spring; hair stiffness 0.60–0.90 (drag 0.4),
 *     bust 0.75 (drag 0.05), coat skirt 1.125 (drag 0).
 *   - 22 sphere colliders on the torso, neck, head, arms and hands; hair
 *     collides with all of them, nothing else collides.
 * An older name-guessing solver used hair 0.3 stiffness + gravity 0.10 and
 * skirt 0.7 + gravity 0.2 — half VRoid's hold, plus a pull VRoid never
 * applies: the "underwater" hair.
 *
 * Two values are NOT measured (no reference VRoid file declares them): sleeves
 * and `J_Opt_` accessories. Sleeves take hair's settings; `J_Opt_` tails take a
 * small gravity so they hang instead of standing out rigid (tuned by eye on a
 * fox-tailed avatar); other accessories (rabbit ears) hold their shape. All
 * are named constants below — tune them there.
 *
 * ONE responsibility: a VRoid hierarchy in, a declaration + its node table out.
 * Babylon-free: the caller adapts its nodes to `SynthNode`.
 */

import type { SpringBoneDeclaration, SpringCollider, SpringDeclarationEntry, SpringJointSettings, Vec3Tuple } from './springBoneDeclaration.js'

/** The minimum the synthesis needs from a scene node. */
export interface SynthNode {
  name: string
  children: SynthNode[]
  /** Local translation (rest), in the parent's units. */
  position: Vec3Tuple
}

export type VRoidSpringCategory = 'hair' | 'bust' | 'skirt' | 'sleeve' | 'tail' | 'accessory'

type Settings = Omit<SpringJointSettings, 'gravityDir'>

/** Per category, at reference avatar A's scale (torso 0.4813). hitRadius scales with the body. */
export const VROID_SETTINGS: Record<VRoidSpringCategory, Settings> = {
  // Measured (VRoid Studio 2.10): median of reference A's 17 hair springs (0.60–0.85) and reference B's 13 (0.71–0.90).
  hair: { stiffness: 0.7, gravityPower: 0, dragForce: 0.4, hitRadius: 0.01 },
  // Measured: reference A's bust.
  bust: { stiffness: 0.75, gravityPower: 0, dragForce: 0.05, hitRadius: 0.0134 },
  // Measured: reference B's coat skirt (hitRadius 0.039 at torso 0.7177 → 0.026 at reference A's).
  skirt: { stiffness: 1.125, gravityPower: 0, dragForce: 0, hitRadius: 0.026 },
  // NOT measured: sleeves take hair's settings.
  sleeve: { stiffness: 0.7, gravityPower: 0, dragForce: 0.4, hitRadius: 0.01 },
  // NOT measured: J_Opt_ tails (fox and rabbit tails) take a little gravity so they
  // hang instead of standing out rigid, tuned by eye (tune here).
  tail: { stiffness: 0.8, gravityPower: 0.3, dragForce: 0.4, hitRadius: 0 },
  // NOT measured: every other J_Opt_ accessory (the rabbit EARS) holds its authored shape:
  // no gravity, stiffer than hair, so ears stay up and still swing with the head.
  accessory: { stiffness: 1.0, gravityPower: 0, dragForce: 0.4, hitRadius: 0 },
}

/** Reference A's hips → head length, in its local units: the scale the constants above are written at. */
export const REFERENCE_TORSO = 0.4813

/** VRoid Studio 2.10's collider layout (reference A, verbatim): [bone, offset, radius]. */
const COLLIDER_TEMPLATE: [string, Vec3Tuple, number][] = [
  ['J_Bip_C_Spine', [0, 0, 0], 0.113120355],
  ['J_Bip_C_UpperChest', [0, 0, 0.009426696], 0.094266966],
  ['J_Bip_C_UpperChest', [0.047133483, 0.0612735227, -0.009426696], 0.06598687],
  ['J_Bip_C_UpperChest', [-0.047133483, 0.0612735227, -0.009426696], 0.06598687],
  ['J_Bip_C_Neck', [0, 0.0282800868, 0.0122547047], 0.04713348],
  ['J_Bip_C_Head', [0, 0.100016832, -0.014402424], 0.100016832],
  ['J_Bip_L_UpperArm', [0, -0.009426698, 0], 0.04713349],
  ['J_Bip_L_UpperArm', [0.0707002357, -0.009426698, 0], 0.04713349],
  ['J_Bip_L_UpperArm', [0.141400471, -0.009426698, 0], 0.04713349],
  ['J_Bip_L_LowerArm', [0, 0, 0], 0.0282800943],
  ['J_Bip_L_LowerArm', [0.04713349, 0, 0], 0.0329934433],
  ['J_Bip_L_LowerArm', [0.09426698, 0, 0], 0.0282800943],
  ['J_Bip_L_LowerArm', [0.141400471, 0, 0], 0.0282800943],
  ['J_Bip_L_Hand', [0.0188533962, 0, 0], 0.0282800943],
  ['J_Bip_R_UpperArm', [0, -0.009426698, 0], 0.04713349],
  ['J_Bip_R_UpperArm', [-0.0707002357, -0.009426698, 0], 0.04713349],
  ['J_Bip_R_UpperArm', [-0.141400471, -0.009426698, 0], 0.04713349],
  ['J_Bip_R_LowerArm', [0, 0, 0], 0.0282800943],
  ['J_Bip_R_LowerArm', [-0.04713349, 0, 0], 0.0329934433],
  ['J_Bip_R_LowerArm', [-0.09426698, 0, 0], 0.0282800943],
  ['J_Bip_R_LowerArm', [-0.141400471, 0, 0], 0.0282800943],
  ['J_Bip_R_Hand', [-0.0188533962, 0, 0], 0.0282800943],
]

const SPRING_NAME = /^J_(Sec|Opt)_/
const TORSO_CHAIN = ['J_Bip_C_Head', 'J_Bip_C_Neck', 'J_Bip_C_UpperChest', 'J_Bip_C_Chest', 'J_Bip_C_Spine', 'J_Bip_C_Hips']

export function categoryOf(boneName: string): VRoidSpringCategory {
  if (boneName.startsWith('J_Opt_')) return /Tail/i.test(boneName) ? 'tail' : 'accessory'
  const rest = boneName.replace(/^J_Sec_(?:[LRC]_)?/, '')
  if (/^Hair/i.test(rest)) return 'hair'
  if (/^Bust/i.test(rest)) return 'bust'
  if (/Skirt/i.test(rest)) return 'skirt'
  if (/Sleeve/i.test(rest)) return 'sleeve'
  // A J_Sec_ bone we don't recognise (e.g. a HoodString): VRoid gives every J_Sec_ spring
  // no gravity, so it takes hair's settings, not the accessories' droop.
  return 'hair'
}

/**
 * The body's rest pose in world space, for fitting the colliders to it. Optional: without
 * it the template is used as scaled (tests of the chain logic need no scene).
 */
export interface RestSpace<N extends SynthNode> {
  /** A point in `node`'s local frame, in world space. */
  toWorld(node: N, local: Vec3Tuple): Vec3Tuple
  /** `node`'s uniform world scale (local units → world). */
  scaleOf(node: N): number
}

/** Below this length a segment is a pivot (VRoid's leg-skirt roots: the child sits ON the joint). */
const ZERO_SEGMENT = 1e-5
/** A fitted collider smaller than this share of its template radius is dropped. */
const MIN_FIT_SHARE = 0.25
/** Clearance kept between a fitted collider and the hair it guards, in world units. */
const FIT_CLEARANCE = 0.002

export interface VRoidSynthesis<N extends SynthNode> {
  declaration: SpringBoneDeclaration
  /** Index i = the node `declaration` calls i. */
  nodes: N[]
  /** Body scale relative to reference A (torso ratio); 1 when the torso could not be measured. */
  scale: number
  counts: Record<VRoidSpringCategory, number>
  /** Colliders shrunk (or dropped) so that no hair joint starts inside one. */
  fitted: { shrunk: number; dropped: number }
}

/**
 * Null when the body has no `J_Sec_` / `J_Opt_` chain of two or more joints.
 * Chains are root → tip along the first spring child; a branch is reported in
 * `warnings` and only its first arm is simulated (no reference body has one).
 */
export function synthesizeVRoidSprings<N extends SynthNode>(root: N, space?: RestSpace<N>): VRoidSynthesis<N> | null {
  const all: N[] = []
  const parentOf = new Map<N, N>()
  const walk = (n: N): void => {
    all.push(n)
    for (const c of n.children as N[]) {
      parentOf.set(c, n)
      walk(c)
    }
  }
  walk(root)
  const byName = new Map<string, N>()
  for (const n of all) if (!byName.has(n.name)) byName.set(n.name, n)

  const nodes: N[] = []
  const index = new Map<N, number>()
  const idx = (n: N): number => {
    let i = index.get(n)
    if (i === undefined) {
      i = nodes.length
      nodes.push(n)
      index.set(n, i)
    }
    return i
  }
  const warnings: string[] = []
  const isSpring = (n: N): boolean => SPRING_NAME.test(n.name)

  const scale = torsoScale(byName)

  // Colliders, grouped per bone; only bones the body has.
  const template: { node: N; offset: Vec3Tuple; radius: number }[] = []
  for (const [bone, offset, radius] of COLLIDER_TEMPLATE) {
    const node = byName.get(bone)
    if (node) template.push({ node, offset: [offset[0] * scale, offset[1] * scale, offset[2] * scale], radius: radius * scale })
  }

  const counts: Record<VRoidSpringCategory, number> = { hair: 0, bust: 0, skirt: 0, sleeve: 0, tail: 0, accessory: 0 }
  const springs: SpringDeclarationEntry[] = []
  for (const start of all) {
    if (!isSpring(start)) continue
    const parent = parentOf.get(start)
    if (parent && isSpring(parent)) continue // not a chain root
    const chain: N[] = [start]
    let at: N = start
    for (;;) {
      const next = (at.children as N[]).filter(isSpring)
      if (next.length === 0) break
      if (next.length > 1) warnings.push(`${at.name} branches into ${next.length} — only ${next[0].name} is simulated`)
      at = next[0]
      chain.push(at)
    }
    // VRoid's leg-skirt roots are pivots: the first child sits ON the joint. A zero-length
    // segment has no axis (normalising float noise spins the joint about itself: one
    // skirt turned 89 degrees standing still), so the chain starts at its first real segment;
    // the pivot still rides the leg as the chain's parent.
    while (chain.length >= 2 && length(chain[1].position) < ZERO_SEGMENT) chain.shift()
    const cut = chain.findIndex((n, k) => k > 0 && length(n.position) < ZERO_SEGMENT)
    if (cut > 0) {
      warnings.push(`${chain[cut - 1].name} → ${chain[cut].name} has no length — the chain stops there`)
      chain.length = cut
    }
    if (chain.length < 2) continue
    const category = categoryOf(start.name)
    const s = VROID_SETTINGS[category]
    const settings: SpringJointSettings = { ...s, hitRadius: s.hitRadius * scale, gravityDir: [0, -1, 0] }
    const jointNodes = chain.map(idx)
    springs.push({
      name: chain[0].name,
      jointNodes,
      segments: jointNodes.slice(0, -1).map((node, k) => ({ node, child: jointNodes[k + 1], settings })),
      colliders: [], // hair's are set once the colliders are fitted, below
      center: null,
      extras: { poqpoq: { synthesized: 'vroid', category } },
    })
    counts[category]++
  }
  if (springs.length === 0) return null

  // Fit the colliders to THIS body: VRoid sized them to reference A's head and hair. A sphere a
  // hair joint already sits inside pushes that hair out every step (3 to 17 degrees of drift
  // standing still, measured). Shrink it to clear the hair; drop it if little is left.
  const fitted = { shrunk: 0, dropped: 0 }
  const colliders: SpringCollider[] = []
  const isHair = (s: SpringDeclarationEntry): boolean => categoryOf(nodes[s.jointNodes[0]].name) === 'hair'
  const hairJoints = springs.filter(isHair).flatMap((s) => s.jointNodes.slice(1))
  for (const t of template) {
    let radius = t.radius
    if (space) {
      const k = space.scaleOf(t.node)
      const centre = space.toWorld(t.node, t.offset)
      let world = radius * k
      for (const ji of hairJoints) {
        const hit = VROID_SETTINGS.hair.hitRadius * scale * space.scaleOf(nodes[ji])
        const p = space.toWorld(nodes[ji], [0, 0, 0])
        const clear = Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]) - hit - FIT_CLEARANCE
        if (clear < world) world = clear
      }
      if (world < radius * k * MIN_FIT_SHARE) {
        fitted.dropped++
        continue
      }
      if (world < radius * k) fitted.shrunk++
      radius = world / k
    }
    colliders.push({ node: idx(t.node), shape: { kind: 'sphere', offset: t.offset, radius } })
  }
  const every = colliders.map((_, i) => i)
  for (const s of springs) if (isHair(s)) s.colliders = every

  return { declaration: { specVersion: '1.0', colliders, springs, warnings }, nodes, scale, counts, fitted }
}

const length = (v: Vec3Tuple): number => Math.hypot(v[0], v[1], v[2])

/** Hips → head length over reference A's, in the body's own local units (VRoid sizes its colliders the same way). */
function torsoScale<N extends SynthNode>(byName: Map<string, N>): number {
  const hips = byName.get('J_Bip_C_Hips')
  const head = byName.get('J_Bip_C_Head')
  if (!hips || !head) return 1
  // Sum local translations from the head up to the hips (VRoid torso bones carry no rotation at rest).
  const sum: Vec3Tuple = [0, 0, 0]
  const present = TORSO_CHAIN.map((n) => byName.get(n)).filter((n): n is N => !!n)
  for (const n of present) {
    if (n === hips) break
    sum[0] += n.position[0]
    sum[1] += n.position[1]
    sum[2] += n.position[2]
  }
  const len = Math.hypot(sum[0], sum[1], sum[2])
  return len > 1e-4 ? len / REFERENCE_TORSO : 1
}
