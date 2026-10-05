/**
 * vroidSpringSynthesis on hand-built VRoid-shaped hierarchies (CI; the real
 * prebuilts are measured in vroid.springs.test.ts, locally).
 */
import { describe, expect, it } from 'vitest'
import { categoryOf, REFERENCE_TORSO, synthesizeVRoidSprings, VROID_SETTINGS, type RestSpace, type SynthNode } from './vroidSpringSynthesis.js'
import type { Vec3Tuple } from './springBoneDeclaration.js'

interface N extends SynthNode {
  children: N[]
  parent: N | null
}

function node(name: string, position: Vec3Tuple, ...children: N[]): N {
  const n: N = { name, position, children, parent: null }
  for (const c of children) c.parent = n
  return n
}
/** A chain a → b → c … each `step` below its parent. */
function chain(names: string[], step: Vec3Tuple, first: Vec3Tuple = step): N {
  let n: N | null = null
  for (let i = names.length - 1; i >= 0; i--) n = node(names[i], i === 0 ? first : step, ...(n ? [n] : []))
  return n!
}

/** A VRoid torso of the reference length (0.4813), hair on the head, a pivot-rooted skirt on a thigh, a tail on the hips. */
function body(opts: { torso?: number; hairFirst?: Vec3Tuple } = {}): N {
  const t = (opts.torso ?? REFERENCE_TORSO) / 5
  const hair = chain(['J_Sec_Hair1_01', 'J_Sec_Hair2_01', 'J_Sec_Hair3_01', 'J_Sec_Hair3_end_01'], [0, -0.05, -0.02], opts.hairFirst ?? [0, 0.1, -0.05])
  const head = node('J_Bip_C_Head', [0, t, 0], hair)
  const neck = node('J_Bip_C_Neck', [0, t, 0], head)
  const upperChest = node('J_Bip_C_UpperChest', [0, t, 0], neck, chain(['J_Sec_L_Bust1', 'J_Sec_L_Bust2', 'J_Sec_L_Bust2_end'], [0, 0, 0.05]))
  const chest = node('J_Bip_C_Chest', [0, t, 0], upperChest)
  const spine = node('J_Bip_C_Spine', [0, t, 0], chest)
  // VRoid's leg skirt: a PIVOT (child on the joint), then real segments.
  const skirt = chain(['J_Sec_L_SkirtBack0_01', 'J_Sec_L_SkirtBack1_01', 'J_Sec_L_SkirtBack2_01', 'J_Sec_L_SkirtBack2_end_01'], [0, -0.1, -0.02], [0, 0, -0.05])
  skirt.children[0].position = [1e-8, -6e-8, 0]
  const leg = node('J_Bip_L_UpperLeg', [0.08, -0.05, 0], skirt)
  const tail = chain(['J_Opt_C_FoxTail1_01', 'J_Opt_C_FoxTail2_01', 'J_Opt_C_FoxTail2_end_01'], [0, 0, -0.1])
  const ears = chain(['J_Opt_L_RabbitEar1_01', 'J_Opt_L_RabbitEar2_01', 'J_Opt_L_RabbitEar2_end_01'], [0, 0.08, 0])
  head.children.push(ears)
  ears.parent = head
  const hips = node('J_Bip_C_Hips', [0, 1, 0], spine, leg, tail)
  return node('Root', [0, 0, 0], hips)
}

/** World positions by summing translations (no rotations in these fixtures). */
function space(): RestSpace<N> {
  const world = (n: N): Vec3Tuple => {
    const w: Vec3Tuple = [0, 0, 0]
    for (let p: N | null = n; p; p = p.parent) {
      w[0] += p.position[0]
      w[1] += p.position[1]
      w[2] += p.position[2]
    }
    return w
  }
  return {
    toWorld: (n, local) => {
      const w = world(n)
      return [w[0] + local[0], w[1] + local[1], w[2] + local[2]]
    },
    scaleOf: () => 1,
  }
}

const find = (s: ReturnType<typeof synthesizeVRoidSprings<N>>, root: string) =>
  s!.declaration.springs.find((sp) => sp.name === root)

describe('categoryOf', () => {
  it('reads VRoid names: J_Sec_ by body part, J_Opt_ tails apart from other accessories', () => {
    expect(categoryOf('J_Sec_Hair1_01')).toBe('hair')
    expect(categoryOf('J_Sec_L_HairSide1_00')).toBe('hair')
    expect(categoryOf('J_Sec_R_Bust1')).toBe('bust')
    expect(categoryOf('J_Sec_L_SkirtBack0_01')).toBe('skirt')
    expect(categoryOf('J_Sec_L_CoatSkirtSide1_01')).toBe('skirt')
    expect(categoryOf('J_Sec_L_TipSleeve_01')).toBe('sleeve')
    expect(categoryOf('J_Opt_C_FoxTail1_01')).toBe('tail')
    expect(categoryOf('J_Opt_L_RabbitEar1_01')).toBe('accessory')
    // An unrecognised J_Sec_ bone takes hair's no-gravity settings, never the tail's droop.
    expect(categoryOf('J_Sec_L_HoodString1_01')).toBe('hair')
  })
})

describe('synthesizeVRoidSprings', () => {
  it('builds one spring per chain root, root → tip, with VRoid Studio settings per category', () => {
    const s = synthesizeVRoidSprings(body(), space())!
    expect(s.declaration.springs.map((sp) => sp.name).sort()).toEqual(
      ['J_Opt_C_FoxTail1_01', 'J_Opt_L_RabbitEar1_01', 'J_Sec_Hair1_01', 'J_Sec_L_Bust1', 'J_Sec_L_SkirtBack1_01'].sort(),
    )
    const hair = find(s, 'J_Sec_Hair1_01')!
    expect(hair.jointNodes.map((i) => s.nodes[i].name)).toEqual(['J_Sec_Hair1_01', 'J_Sec_Hair2_01', 'J_Sec_Hair3_01', 'J_Sec_Hair3_end_01'])
    expect(hair.segments).toHaveLength(3)
    expect(hair.segments[0].settings).toMatchObject({ stiffness: VROID_SETTINGS.hair.stiffness, gravityPower: 0, dragForce: 0.4 })
    // Only tails hang; ears and everything VRoid declared hold with no gravity.
    expect(find(s, 'J_Opt_C_FoxTail1_01')!.segments[0].settings.gravityPower).toBeGreaterThan(0)
    for (const name of ['J_Opt_L_RabbitEar1_01', 'J_Sec_Hair1_01', 'J_Sec_L_Bust1', 'J_Sec_L_SkirtBack1_01']) {
      expect(find(s, name)!.segments.every((g) => g.settings.gravityPower === 0)).toBe(true)
    }
    expect(s.counts).toEqual({ hair: 1, bust: 1, skirt: 1, sleeve: 0, tail: 1, accessory: 1 })
  })

  it('starts a leg skirt at its first REAL segment: a zero-length pivot has no axis', () => {
    const s = synthesizeVRoidSprings(body(), space())!
    const skirt = find(s, 'J_Sec_L_SkirtBack1_01')!
    expect(skirt.jointNodes.map((i) => s.nodes[i].name)).toEqual(['J_Sec_L_SkirtBack1_01', 'J_Sec_L_SkirtBack2_01', 'J_Sec_L_SkirtBack2_end_01'])
    expect(s.declaration.springs.some((sp) => sp.jointNodes.some((i) => s.nodes[i].name === 'J_Sec_L_SkirtBack0_01'))).toBe(false)
  })

  it('stops a chain at a zero-length segment in its middle, and says so', () => {
    const root = body()
    const hair2 = root.children[0].children[0].children[0].children[0].children[0].children[0].children[0].children[0]
    expect(hair2.name).toBe('J_Sec_Hair2_01')
    hair2.children[0].position = [0, 0, 0]
    const s = synthesizeVRoidSprings(root, space())!
    expect(find(s, 'J_Sec_Hair1_01')!.jointNodes.map((i) => s.nodes[i].name)).toEqual(['J_Sec_Hair1_01', 'J_Sec_Hair2_01'])
    expect(s.declaration.warnings.join()).toContain('J_Sec_Hair3_01 has no length')
  })

  it('gives hair every collider and nothing else any, sized by the torso like VRoid does', () => {
    const s = synthesizeVRoidSprings(body({ torso: REFERENCE_TORSO * 1.5 }))!
    expect(s.scale).toBeCloseTo(1.5, 6)
    const hair = find(s, 'J_Sec_Hair1_01')!
    expect(hair.colliders).toHaveLength(s.declaration.colliders.length)
    for (const name of ['J_Sec_L_Bust1', 'J_Sec_L_SkirtBack1_01', 'J_Opt_C_FoxTail1_01']) expect(find(s, name)!.colliders).toEqual([])
    const head = s.declaration.colliders.find((c) => s.nodes[c.node].name === 'J_Bip_C_Head')!
    expect(head.shape.radius).toBeCloseTo(0.100016832 * 1.5, 6)
    expect(find(s, 'J_Sec_Hair1_01')!.segments[0].settings.hitRadius).toBeCloseTo(VROID_SETTINGS.hair.hitRadius * 1.5, 9)
  })

  it('fits the colliders to the body: a sphere the hair starts inside shrinks until it clears it', () => {
    // Hair that starts close to the head centre: the template head sphere (r 0.100) would swallow it.
    const s = synthesizeVRoidSprings(body({ hairFirst: [0, 0.06, 0] }), space())!
    const head = s.declaration.colliders.find((c) => s.nodes[c.node].name === 'J_Bip_C_Head')
    const sp = space()
    const hairNodes = find(s, 'J_Sec_Hair1_01')!.jointNodes.slice(1).map((i) => s.nodes[i])
    if (head) {
      const c = sp.toWorld(s.nodes[head.node], head.shape.kind === 'sphere' ? head.shape.offset : [0, 0, 0])
      for (const h of hairNodes) {
        const p = sp.toWorld(h, [0, 0, 0])
        expect(Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])).toBeGreaterThan(head.shape.radius)
      }
    }
    expect(s.fitted.shrunk + s.fitted.dropped).toBeGreaterThan(0)
  })

  it('returns null for a body with no spring chain', () => {
    expect(synthesizeVRoidSprings(node('Root', [0, 0, 0], node('J_Bip_C_Hips', [0, 1, 0])))).toBeNull()
  })
})
