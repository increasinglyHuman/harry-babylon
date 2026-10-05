/**
 * The declared-spring reader and the fixed-step runtime, against real Babylon
 * (NullEngine), on a synthetic chain.
 *
 * Step-for-step parity with Harry's preview is measured on real exported
 * avatars outside this package; this file pins the properties that make parity
 * possible: frame-rate independence, the rotation landing on the right bone,
 * the colliders, and the stall rule.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import { parseVRMCSpringBone, type SpringBoneDeclaration } from './springBoneDeclaration.js'
import { SpringBoneRuntime } from './SpringBoneRuntime.js'

const SEG = 0.1
const BONES = 6

interface Rig {
  scene: Scene
  root: TransformNode
  hip: TransformNode
  tail: TransformNode[]
  nodes: TransformNode[]
}

let engine: NullEngine | null = null
afterEach(() => {
  engine?.dispose()
  engine = null
})

/** root(0) → hip(1) → tail bones (2…), each SEG behind its parent, rest = identity. */
function rig(): Rig {
  engine = new NullEngine()
  const scene = new Scene(engine)
  const root = new TransformNode('root', scene)
  root.rotationQuaternion = Quaternion.Identity()
  const hip = new TransformNode('hip', scene)
  hip.parent = root
  hip.position.set(0, 1, 0)
  hip.rotationQuaternion = Quaternion.Identity()
  const tail: TransformNode[] = []
  let parent = hip
  for (let i = 0; i < BONES; i++) {
    const n = new TransformNode(`Tail${i + 1}`, scene)
    n.parent = parent
    n.position.set(0, 0, i === 0 ? -0.05 : -SEG)
    n.rotationQuaternion = Quaternion.Identity()
    tail.push(n)
    parent = n
  }
  return { scene, root, hip, tail, nodes: [root, hip, ...tail] }
}

function extension(overrides: { stiffness?: number; gravityPower?: number; dragForce?: number; hitRadius?: number; colliders?: unknown[] } = {}): unknown {
  const joints = Array.from({ length: BONES }, (_, i) => ({
    node: 2 + i,
    hitRadius: overrides.hitRadius ?? 0.02,
    stiffness: overrides.stiffness ?? 1.0,
    gravityPower: overrides.gravityPower ?? 0.05,
    gravityDir: [0, -1, 0],
    dragForce: overrides.dragForce ?? 0.4,
  }))
  const colliders = overrides.colliders ?? []
  return {
    specVersion: '1.0',
    colliders,
    colliderGroups: colliders.length ? [{ name: 'body', colliders: colliders.map((_, i) => i) }] : [],
    springs: [{ name: 'tail', joints, colliderGroups: colliders.length ? [0] : [] }],
  }
}

function declare(r: Rig, ext: unknown = extension()): SpringBoneDeclaration {
  const d = parseVRMCSpringBone(ext, r.nodes.length)
  if (!d) throw new Error('declaration did not parse')
  return d
}

/** The hip walks forward and yaws ±40° at 1.3 Hz, bobbing — a whip the tail must follow. */
function motion(r: Rig): (t: number) => void {
  return (t) => {
    r.root.position.set(0, 0, 0.8 * t)
    r.hip.position.set(0, 1 + 0.03 * Math.sin(2 * Math.PI * 2.6 * t), 0)
    Quaternion.RotationAxisToRef(Vector3.Up(), (40 * Math.PI) / 180 * Math.sin(2 * Math.PI * 1.3 * t), r.hip.rotationQuaternion!)
  }
}

function tipWorld(r: Rig): Vector3 {
  const last = r.tail[r.tail.length - 1]
  r.root.computeWorldMatrix(true)
  r.hip.computeWorldMatrix(true)
  for (const b of r.tail) b.computeWorldMatrix(true)
  return last.getAbsolutePosition().clone()
}

/**
 * The tip in the HIP's frame — the tail's own shape. Live mode leaves the
 * body at the FRAME's time while the chain was solved at the step's, so a
 * world-space tip would charge the body's own travel between the two to
 * the spring; the shape is what the spring decides.
 */
function tipInHip(r: Rig): Vector3 {
  const w = tipWorld(r)
  return Vector3.TransformCoordinates(w, r.hip.getWorldMatrix().clone().invert())
}

type Mode = 'exact' | 'live' | 'raw'

/** Run `seconds` at `fps`; one sample per solver step (exact/live) or per frame (raw). */
function run(fps: number, seconds: number, mode: Mode, ext?: unknown): { t: number; tip: Vector3 }[] {
  const r = rig()
  const move = motion(r)
  move(0)
  const rt = new SpringBoneRuntime(declare(r, ext), r.nodes)
  const out: { t: number; tip: Vector3 }[] = []
  const frames = Math.round(seconds * fps)
  for (let i = 1; i <= frames; i++) {
    const t = i / fps
    if (mode === 'raw') {
      move(t)
      rt.stepRaw(1 / fps)
      out.push({ t, tip: tipInHip(r) })
      continue
    }
    const before = rt.probe().steps
    if (mode === 'exact') rt.advance(1 / fps, (st) => move(st))
    else {
      move(t)
      rt.advance(1 / fps)
    }
    if (rt.probe().steps > before) out.push({ t: rt.time, tip: tipInHip(r) })
  }
  engine!.dispose()
  engine = null
  return out
}

/** Max distance from `base` at matching step times (by nearest time, both on the 60 Hz grid). */
function maxDeviation(a: { t: number; tip: Vector3 }[], base: { t: number; tip: Vector3 }[]): number {
  let worst = 0
  for (const s of a) {
    const b = base.find((x) => Math.abs(x.t - s.t) < 1e-6)
    if (b) worst = Math.max(worst, Vector3.Distance(s.tip, b.tip))
  }
  return worst
}

describe('parseVRMCSpringBone', () => {
  it('pairs joint k with joint k+1 and gives the segment joint k’s settings', () => {
    const d = parseVRMCSpringBone(
      { specVersion: '1.0', springs: [{ name: 's', joints: [{ node: 0, stiffness: 2 }, { node: 1, stiffness: 3 }, { node: 2 }] }] },
      3,
    )!
    expect(d.springs[0].segments.map((s) => [s.node, s.child, s.settings.stiffness])).toEqual([
      [0, 1, 2],
      [1, 2, 3],
    ])
  })

  it('fills spec defaults (dragForce 0.5, gravityDir down)', () => {
    const d = parseVRMCSpringBone({ specVersion: '1.0', springs: [{ joints: [{ node: 0 }, { node: 1 }] }] }, 2)!
    expect(d.springs[0].segments[0].settings).toEqual({ hitRadius: 0, stiffness: 1, gravityPower: 0, gravityDir: [0, -1, 0], dragForce: 0.5 })
    expect(d.springs[0].name).toBe('spring#0')
  })

  it('refuses an unknown specVersion and returns null for no extension', () => {
    const warnings: string[] = []
    expect(parseVRMCSpringBone({ specVersion: '2.0', springs: [] }, 1, (m) => warnings.push(m))).toBeNull()
    expect(warnings[0]).toContain('unknown specVersion "2.0"')
    expect(parseVRMCSpringBone(undefined, 1)).toBeNull()
  })

  it('names what it skips: a bad collider, a dangling group ref, a cut chain', () => {
    const d = parseVRMCSpringBone(
      {
        specVersion: '1.0',
        colliders: [{ node: 9, shape: { sphere: { radius: 1 } } }, { node: 0, shape: { capsule: { offset: [0, 0, 0], tail: [0, 1, 0], radius: 0.1 } } }],
        colliderGroups: [{ colliders: [0, 1, 7] }],
        springs: [{ name: 'hair', joints: [{ node: 0 }, { node: 1 }, { node: 99 }, { node: 2 }], colliderGroups: [0, 3] }],
      },
      3,
    )!
    expect(d.colliders).toHaveLength(1)
    expect(d.colliders[0].shape.kind).toBe('capsule')
    expect(d.springs[0].colliders).toEqual([0])
    expect(d.springs[0].segments).toHaveLength(1) // cut at the bad joint
    expect(d.warnings.join('\n')).toMatch(/collider #0.*skipped[\s\S]*collider #7[\s\S]*joint #2[\s\S]*collider group #3/)
  })
})

describe('SpringBoneRuntime — the clock', () => {
  it('exact mode (pose at step time) is the same trajectory at 30, 60 and 144 fps', () => {
    const base = run(60, 2, 'exact')
    for (const fps of [30, 144]) {
      const other = run(fps, 2, 'exact')
      expect(other.length).toBeGreaterThanOrEqual(60) // one sample per frame that stepped
      expect(maxDeviation(other, base)).toBeLessThan(1e-9)
    }
  })

  it('live mode (interpolated pose) stays within millimetres of exact; raw frame-driven does not', () => {
    const base = run(60, 2, 'exact')
    const rows = [30, 144].map((fps) => ({
      fps,
      liveMm: maxDeviation(run(fps, 2, 'live'), base) * 1000,
      rawMm: (() => {
        // raw samples per frame: compare at frames landing on the 60 Hz grid
        const raw = run(fps, 2, 'raw')
        return maxDeviation(raw, base) * 1000
      })(),
    }))
    console.info('[springs] live vs exact (mm)', JSON.stringify(rows))
    const at30 = rows.find((r) => r.fps === 30)!
    expect(at30.liveMm).toBeLessThan(10)
    expect(at30.liveMm).toBeLessThan(at30.rawMm)
    expect(rows.find((r) => r.fps === 144)!.liveMm).toBeLessThan(10)
  })

  it('a render faster than the step keeps wearing the latest solution', () => {
    const r = rig()
    motion(r)(0)
    const rt = new SpringBoneRuntime(declare(r), r.nodes)
    motion(r)(0.3)
    rt.advance(1 / 60)
    const solved = r.tail.map((b) => b.rotationQuaternion!.clone())
    // Something (a clip) writes the chain; a frame with no step must restore the solution.
    for (const b of r.tail) b.rotationQuaternion!.copyFromFloats(0, 0, 0, 1)
    expect(rt.advance(1 / 240)).toBe(0)
    r.tail.forEach((b, k) => expect(b.rotationQuaternion!.equalsWithEpsilon(solved[k], 1e-12)).toBe(true))
  })

  it('a hitch resets onto the current pose instead of bursting', () => {
    const r = rig()
    motion(r)(0)
    const rt = new SpringBoneRuntime(declare(r), r.nodes)
    expect(rt.advance(1.0)).toBe(0)
    const p = rt.probe()
    expect(p.stallResets).toBe(1)
    expect(p.droppedSeconds).toBeCloseTo(1.0, 9)
    r.tail.forEach((b) => expect(b.rotationQuaternion!.equalsWithEpsilon(Quaternion.Identity(), 1e-12)).toBe(true))
  })
})

describe('SpringBoneRuntime — the reference arithmetic', () => {
  it('holds a weightless chain exactly at rest', () => {
    const r = rig()
    const rt = new SpringBoneRuntime(declare(r, extension({ gravityPower: 0 })), r.nodes)
    const rest = tipWorld(r)
    for (let i = 0; i < 120; i++) rt.advance(1 / 60)
    expect(Vector3.Distance(tipWorld(r), rest)).toBeLessThan(1e-6)
  })

  it('writes each rotation onto the joint’s OWN bone: the child lies along the simulated tail', () => {
    // Direction, not distance: the reference constrains to the child's world
    // as cached at step START, so once a parent joint has moved this step the
    // simulated tail sits slightly off the child's true distance (three-vrm
    // _calcWorldSpaceBoneLength) — parity with Harry depends on keeping that.
    // An older solver rotated node k for segment k−1: 4–6 cm off in angle.
    const r = rig()
    const move = motion(r)
    move(0)
    const rt = new SpringBoneRuntime(declare(r), r.nodes)
    for (let i = 1; i <= 90; i++) rt.advance(1 / 60, (t) => move(t))
    tipWorld(r) // refresh world matrices
    const joints = (rt as unknown as { joints: { bone: { node: TransformNode }; child: { node: TransformNode }; currentTail: Vector3 }[] }).joints
    let worst = 0
    for (const j of joints) {
      const at = j.bone.node.getAbsolutePosition()
      const toChild = j.child.node.getAbsolutePosition().subtract(at).normalize()
      const toTail = j.currentTail.subtract(at).normalize()
      worst = Math.max(worst, Math.acos(Math.min(1, Vector3.Dot(toChild, toTail))))
    }
    expect(worst).toBeLessThan(1e-4) // radians
    expect(joints).toHaveLength(BONES - 1)
  })

  it('gravity droops the tail, and a sphere collider keeps every simulated tail out of it', () => {
    // A 12 cm sphere on the hip, centred under the tail: gravity pulls the tail into it.
    const colliders = [{ node: 1, shape: { sphere: { offset: [0, -0.2, -0.25], radius: 0.12 } } }]
    const r = rig()
    const rt = new SpringBoneRuntime(declare(r, extension({ gravityPower: 2, stiffness: 0.2, colliders })), r.nodes)
    const rest = tipWorld(r)
    for (let i = 0; i < 240; i++) rt.advance(1 / 60)
    const tip = tipWorld(r)
    expect(rest.y - tip.y).toBeGreaterThan(0.05) // it droops
    const centre = Vector3.TransformCoordinates(new Vector3(0, -0.2, -0.25), r.hip.getWorldMatrix())
    const joints = (rt as unknown as { joints: { currentTail: Vector3 }[] }).joints
    for (const j of joints) expect(Vector3.Distance(j.currentTail, centre)).toBeGreaterThanOrEqual(0.12 + 0.02 - 1e-6)
    expect(rt.probe().colliders).toBe(1)
  })

  it('on a height-normalised (scaled) avatar the collider and hit radii scale with the body', () => {
    const colliders = [{ node: 1, shape: { sphere: { offset: [0, -0.2, -0.25], radius: 0.12 } } }]
    const r = rig()
    r.root.scaling.setAll(2) // a unit upload raised ×2
    const rt = new SpringBoneRuntime(declare(r, extension({ gravityPower: 2, stiffness: 0.2, colliders })), r.nodes)
    for (let i = 0; i < 240; i++) rt.advance(1 / 60)
    tipWorld(r)
    const centre = Vector3.TransformCoordinates(new Vector3(0, -0.2, -0.25), r.hip.getWorldMatrix())
    const joints = (rt as unknown as { joints: { currentTail: Vector3 }[] }).joints
    // The drooping tail RESTS ON the 2×-scaled shell (ideal 0.28; the reference's length
    // re-projection after a push lets it sit a few mm inside). With unscaled radii the shell is
    // too small to reach and the closest tail hangs 0.378 m away (measured).
    const closest = Math.min(...joints.map((j) => Vector3.Distance(j.currentTail, centre)))
    expect(closest).toBeGreaterThan(0.26)
    expect(closest).toBeLessThan(0.3)
  })

  it('a tail sitting exactly on a collider centre stays finite (no NaN push)', () => {
    // Dyadic distances (float32-exact through Babylon's matrices), so the tail sits EXACTLY on the
    // centre — with -0.15 it lands 6e-9 m off and never reaches the zero-length push.
    const colliders = [{ node: 1, shape: { sphere: { offset: [0, 0, -0.5], radius: 0.0625 } } }]
    const r = rig()
    r.tail.forEach((b) => b.position.set(0, 0, -0.25))
    const rt = new SpringBoneRuntime(declare(r, extension({ gravityPower: 0, stiffness: 0, colliders })), r.nodes)
    for (let i = 0; i < 30; i++) rt.advance(1 / 60)
    for (const b of r.tail) {
      const q = b.rotationQuaternion!
      expect([q.x, q.y, q.z, q.w].every(Number.isFinite)).toBe(true)
    }
  })

  it('a push that lands the tail exactly on its joint is undone, not renormalised into NaN', () => {
    // A sphere on Tail1 centred 0.5 m down the bone with radius 0.5: its surface passes through
    // Tail1's origin, and the tail (0.25 m down, inside) is pushed along the bone exactly onto the
    // joint. hitRadius 0 and dyadic distances keep it exact in float32.
    const colliders = [{ node: 2, shape: { sphere: { offset: [0, 0, -0.5], radius: 0.5 } } }]
    const r = rig()
    r.tail.forEach((b) => b.position.set(0, 0, -0.25))
    const rt = new SpringBoneRuntime(declare(r, extension({ gravityPower: 0, stiffness: 0, hitRadius: 0, colliders })), r.nodes)
    for (let i = 0; i < 30; i++) rt.advance(1 / 60)
    for (const b of r.tail) {
      const q = b.rotationQuaternion!
      expect([q.x, q.y, q.z, q.w].every(Number.isFinite)).toBe(true)
    }
  })

  it('a SIDEWAYS gravity pulls the same way in glTF space under Babylon’s mirroring __root__', () => {
    const run = (mirror: boolean): Vector3 => {
      const r = rig()
      if (mirror) {
        r.root.rotationQuaternion = new Quaternion(0, 1, 0, 0)
        r.root.scaling.set(1, 1, -1)
      }
      const ext = {
        specVersion: '1.0',
        springs: [{ name: 'tail', joints: Array.from({ length: BONES }, (_, i) => ({ node: 2 + i, stiffness: 0.2, gravityPower: 2, gravityDir: [1, 0, 0], dragForce: 0.4 })) }],
      }
      const rt = new SpringBoneRuntime(parseVRMCSpringBone(ext, r.nodes.length)!, r.nodes)
      for (let i = 0; i < 120; i++) rt.advance(1 / 60)
      const w = tipWorld(r)
      return Vector3.TransformCoordinates(w, r.root.getWorldMatrix().clone().invert()) // into glTF space
    }
    const plain = run(false)
    const mirrored = run(true)
    expect(plain.x).toBeGreaterThan(0.05) // it really swings toward +x (glTF)
    expect(Vector3.Distance(plain, mirrored)).toBeLessThan(1e-6)
  })

  it('refuses a declaration naming a node the model did not load', () => {
    const r = rig()
    const d = declare(r)
    expect(() => new SpringBoneRuntime(d, r.nodes.slice(0, 4))).toThrow(/did not load: 4, 5, 6, 7/)
  })
})
