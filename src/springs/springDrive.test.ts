/**
 * The layered drive on a synthetic chain, against real Babylon (NullEngine).
 * Step-for-step parity with Harry is measured on real exported avatars outside
 * this package; this file pins what a real avatar cannot:
 *
 *   - MIRROR INVARIANCE. Babylon loads a glTF under a `__root__` that flips
 *     handedness (rotation Y 180°, scaling z −1). Harry's drive composes world
 *     orientations as quaternions, which a mirror breaks; this reflex uses a
 *     matrix conjugation instead. The same motion under a mirroring root must
 *     give the same tail in the root's local frame — with the reflex ON (typical
 *     exports ship it off).
 *   - the parser refuses what it cannot play, by name, and the spring plays passive.
 *   - the mood formulas: wag oscillates at its hz, tuck pitches down.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Animation, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import { rotationKeyed } from './DeclaredSpringBones.js'
import { parseVRMCSpringBone } from './springBoneDeclaration.js'
import { SpringBoneRuntime } from './SpringBoneRuntime.js'
import { DriveState, moodAngles, parseSpringDrive, type MoodDefinition, type TailMood } from './springDrive.js'

const BONES = 6

const MOODS: Record<TailMood, MoodDefinition> = {
  wag: { gain: { base: 0.8, mid: 0.3, tip: 0.25 }, pitchDeg: -12, carriageReach: 0.45, osc: { ampDeg: 30, hz: 1.4, lagRad: 0.3, sharpness: 1, burstHz: 0, joints: 3 } },
  lash: { gain: { base: 1, mid: 0.75, tip: 0.5 }, pitchDeg: 0, carriageReach: 0.45, osc: { ampDeg: 55, hz: 2.2, lagRad: 0.35, sharpness: 0.35, burstHz: 0.4, joints: 3 } },
  tuck: { gain: { base: 1, mid: 0.9, tip: 0.8 }, pitchDeg: 85, carriageReach: 0.8 },
  still: { gain: { base: 0.9, mid: 0.8, tip: 0.6 }, pitchDeg: 10, carriageReach: 0.45, twitch: { ampDeg: 25, from: 0.6, cycleS: 2.3, at: [0.35, 1.25], widthS: 0.2 } },
  twitch: { gain: { base: 0.8, mid: 0.5, tip: 0.8 }, pitchDeg: 0, carriageReach: 0.45, twitch: { ampDeg: 18, from: 0.65, hz: 3 } },
  loose: { gain: { base: 0, mid: 0, tip: 0 }, pitchDeg: 0, carriageReach: 0.45 },
}

function driveBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const joints = BONES - 1
  const gains = Array.from({ length: joints }, (_, k) => {
    const t = k / joints
    const g = MOODS.wag.gain
    const p = t <= 0.5 ? g.base + (g.mid - g.base) * (t / 0.5) : g.mid + (g.tip - g.mid) * ((t - 0.5) / 0.5)
    return Math.min(1, 2 * 0.5 * p)
  })
  return {
    target: 'animated-pose',
    moodSet: 'tail-moods@1',
    mood: 'wag',
    muscle: 0.5,
    wag: { amplitudeDeg: 30, hz: 1.4, bias: 0 },
    reflex: true,
    gains,
    halfLivesS: gains.map((g) => 0.01 / g),
    dynamics: {
      stepHz: 60, tightHalfLifeS: 0.01, maxDegPerS: 720, muscleMomentum: 0.35, coneDeg: 30, inertia: 0.3,
      maxInheritSpeed: 1.5, maxInheritDegPerS: 360, maxParticleSpeed: 10, teleportMeters: 1, teleportDeg: 90,
      reflex: { gainS: 0.12, maxDeg: 40, smoothHalfLifeS: 0.05, joints: 3 },
    },
    moods: MOODS,
    // Tail bones rest at identity, pointing −Z: yaw about +Y, pitch (down) about −X... in each bone's frame.
    axes: Array.from({ length: BONES }, () => ({ yaw: [0, 1, 0], pitch: [-1, 0, 0] })),
    ...overrides,
  }
}

let engines: NullEngine[] = []
afterEach(() => {
  for (const e of engines) e.dispose()
  engines = []
})

interface Rig {
  root: TransformNode
  hip: TransformNode
  tail: TransformNode[]
  nodes: TransformNode[]
}

/**
 * root → model (the glTF scene: optionally Babylon's handedness flip) → hip → tail.
 * The motion is applied to `hip` in the MODEL's local terms, so both rigs make
 * the same glTF-space motion; only the world they live in differs.
 */
function rig(mirror: boolean): Rig {
  const engine = new NullEngine()
  engines.push(engine)
  const scene = new Scene(engine)
  const root = new TransformNode('__root__', scene)
  root.rotationQuaternion = mirror ? new Quaternion(0, 1, 0, 0) : Quaternion.Identity()
  if (mirror) root.scaling.set(1, 1, -1)
  const hip = new TransformNode('hip', scene)
  hip.parent = root
  hip.rotationQuaternion = Quaternion.Identity()
  const tail: TransformNode[] = []
  let parent = hip
  for (let i = 0; i < BONES; i++) {
    const n = new TransformNode(`Tail${i + 1}`, scene)
    n.parent = parent
    n.position.set(0, 0, i === 0 ? -0.05 : -0.1)
    n.rotationQuaternion = Quaternion.Identity()
    tail.push(n)
    parent = n
  }
  return { root, hip, tail, nodes: [root, hip, ...tail] }
}

function motion(r: Rig): (t: number) => void {
  return (t) => {
    r.hip.position.set(0.3 * Math.sin(2 * Math.PI * 0.7 * t), 1 + 0.05 * Math.sin(2 * Math.PI * 2.1 * t), 0.4 * t)
    const yaw = Quaternion.RotationAxis(new Vector3(0, 1, 0), (60 * Math.PI) / 180 * Math.sin(2 * Math.PI * 1.1 * t))
    const roll = Quaternion.RotationAxis(new Vector3(0, 0, 1), (25 * Math.PI) / 180 * Math.sin(2 * Math.PI * 0.8 * t))
    yaw.multiplyToRef(roll, r.hip.rotationQuaternion!)
  }
}

function runtimeFor(r: Rig, drive: Record<string, unknown>): SpringBoneRuntime {
  const ext = {
    specVersion: '1.0',
    springs: [
      {
        name: 'tail',
        joints: Array.from({ length: BONES }, (_, i) => ({ node: 2 + i, hitRadius: 0.02, stiffness: 1, gravityPower: 0.05, gravityDir: [0, -1, 0], dragForce: 0.4 })),
        extras: { poqpoq: { drive } },
      },
    ],
  }
  const warnings: string[] = []
  const rt = new SpringBoneRuntime(parseVRMCSpringBone(ext, r.nodes.length)!, r.nodes, { onWarn: (m) => warnings.push(m) })
  expect(warnings).toEqual([])
  return rt
}

/** The tail tip in the MODEL's (root's) local frame — glTF space. */
function tipInModel(r: Rig): Vector3 {
  r.root.computeWorldMatrix(true)
  r.hip.computeWorldMatrix(true)
  for (const b of r.tail) b.computeWorldMatrix(true)
  const w = r.tail[r.tail.length - 1].getAbsolutePosition()
  return Vector3.TransformCoordinates(w, r.root.getWorldMatrix().clone().invert())
}

function trajectory(mirror: boolean, drive: Record<string, unknown>, steps = 240): Vector3[] {
  const r = rig(mirror)
  const move = motion(r)
  move(0)
  const rt = runtimeFor(r, drive)
  const out: Vector3[] = []
  for (let i = 0; i < steps; i++) {
    rt.advance(1 / 60, move)
    out.push(tipInModel(r))
  }
  return out
}

const worst = (a: Vector3[], b: Vector3[]): number => Math.max(...a.map((v, i) => Vector3.Distance(v, b[i])))

describe('the layered drive under Babylon’s handedness flip', () => {
  it('the reflex-ON drive gives the same tail in glTF space with and without the mirroring __root__', () => {
    const plain = trajectory(false, driveBlock())
    const mirrored = trajectory(true, driveBlock())
    const d = worst(plain, mirrored)
    console.info('[springs] mirror invariance, reflex on (mm)', d * 1000)
    expect(d).toBeLessThan(1e-5)
  })

  it('the reflex actually acts (it is not a no-op that passes the mirror test trivially)', () => {
    const on = trajectory(false, driveBlock())
    const off = trajectory(false, driveBlock({ reflex: false }))
    expect(worst(on, off)).toBeGreaterThan(0.005)
  })
})

describe('the drive in the live game (no poseAt)', () => {
  /** A clip that KEYS the tail's base (a wag authored in the animation), body still. */
  function keyedTail(r: Rig): (t: number) => void {
    return (t) => {
      r.hip.position.set(0, 1, 0)
      Quaternion.RotationAxisToRef(new Vector3(0, 1, 0), (40 * Math.PI) / 180 * Math.sin(2 * Math.PI * 1.5 * t), r.tail[0].rotationQuaternion!)
    }
  }
  function tipsAt(mode: 'exact' | 'live', fps: number): Map<number, Vector3> {
    const r = rig(false)
    const move = keyedTail(r)
    move(0)
    const rt = runtimeFor(r, driveBlock({ reflex: false }))
    const out = new Map<number, Vector3>()
    for (let i = 1; i <= Math.round(2 * fps); i++) {
      const before = rt.probe().steps
      if (mode === 'exact') rt.advance(1 / fps, move)
      else {
        move(i / fps)
        rt.advance(1 / fps)
      }
      if (rt.probe().steps > before) out.set(rt.probe().steps, tipInModel(r))
    }
    return out
  }
  const worstVs = (a: Map<number, Vector3>, b: Map<number, Vector3>): number => {
    let w = 0
    for (const [k, v] of a) if (b.has(k)) w = Math.max(w, Vector3.Distance(v, b.get(k)!))
    return w
  }

  it('a KEYED tail is interpolated between frames: live at 30 fps stays close to exact', () => {
    const exact = tipsAt('exact', 60)
    const live30 = tipsAt('live', 30)
    const live144 = tipsAt('live', 144)
    const d30 = worstVs(live30, exact)
    const d144 = worstVs(live144, exact)
    console.info('[springs] keyed tail, live vs exact (mm)', JSON.stringify({ fps30: d30 * 1000, fps144: d144 * 1000 }))
    // Measured — interpolated: 22.1 mm @30, 1.5 mm @144; the end-of-frame pose it
    // replaced: 24.6 @30, 8.7 @144. At 30 fps a slerp across 33 ms cannot reproduce the clip's
    // curve INSIDE the frame and the muscle/cone amplify the gap; closing it would mean evaluating
    // the AnimationGroups at every substep (exact mode) — a cost the live game does not pay.
    expect(d144).toBeLessThan(0.004) // the end-of-frame pose fails this (8.7 mm)
    expect(d30).toBeLessThan(0.03)
  })

  it('a clip HOLDING a tail pose keeps it every frame when ownership is known', () => {
    // Mood 'loose' adds no offset, so the tip's target IS the held keyed pose — the case where the
    // equality inference mistakes the clip's value for the runtime's own output and flips to bind.
    const held = Quaternion.RotationAxis(new Vector3(0, 1, 0), (35 * Math.PI) / 180)
    const run = (withOwnership: boolean): number => {
      const r = rig(false)
      const tip = r.tail[r.tail.length - 1]
      const hold = (): void => void tip.rotationQuaternion!.copyFrom(held)
      // Built at BIND (identity); the clip starts holding afterwards — as in the game.
      const ext = {
        specVersion: '1.0',
        springs: [{ name: 'tail', joints: Array.from({ length: BONES }, (_, i) => ({ node: 2 + i, stiffness: 1, gravityPower: 0, dragForce: 0.4 })), extras: { poqpoq: { drive: driveBlock({ reflex: false, mood: 'loose' }) } } }],
      }
      const rt = new SpringBoneRuntime(parseVRMCSpringBone(ext, r.nodes.length)!, r.nodes, withOwnership ? { isKeyed: (n) => n === tip } : {})
      let wrong = 0
      for (let i = 0; i < 20; i++) {
        hold() // the clip writes its held value each frame
        rt.advance(1 / 60)
        if (!tip.rotationQuaternion!.equalsWithEpsilon(held, 1e-9)) wrong++
      }
      return wrong
    }
    expect(run(true)).toBe(0)
    expect(run(false)).toBeGreaterThan(0) // the inference fails exactly as described above
  })

  it('a mood set mid-fade starts from the blend being worn — no snap', () => {
    const d = parseSpringDrive({ poqpoq: { drive: driveBlock() } }, BONES)!
    const state = new DriveState(d)
    const yaw = new Array<number>(BONES).fill(0)
    const pitch = new Array<number>(BONES).fill(0)
    const gains = new Array<number>(BONES - 1).fill(0)
    const sampleAt = (t: number): number[] => {
      state.sample(t, BONES, yaw, pitch, gains)
      return [...pitch, ...gains]
    }
    state.setMood('tuck', 1.0)
    const before = sampleAt(1.1) // 0.1 s into wag → tuck
    state.setMood('wag', 1.1) // back before the fade ends
    const after = sampleAt(1.1) // same instant: must be the same blend
    const jump = Math.max(...before.map((v, k) => Math.abs(v - after[k])))
    expect(jump).toBeLessThan(1e-12)
    expect(Math.max(...sampleAt(1.4).map((v, k) => Math.abs(v - sampleAt(5)[k])))).toBeLessThan(1e-12) // settles on wag
  })

  it('four mood changes inside one fade never jump: the truncated history collapses to the worn blend', () => {
    const state = new DriveState(parseSpringDrive({ poqpoq: { drive: driveBlock() } }, BONES)!)
    const yaw = new Array<number>(BONES).fill(0)
    const pitch = new Array<number>(BONES).fill(0)
    const gains = new Array<number>(BONES - 1).fill(0)
    const at = (t: number): number[] => {
      state.sample(t, BONES, yaw, pitch, gains)
      return [...yaw, ...pitch, ...gains]
    }
    let worst = 0
    const moods: TailMood[] = ['tuck', 'still', 'twitch', 'lash', 'tuck', 'wag']
    moods.forEach((m, i) => {
      const t = 1 + i * 0.01
      const before = at(t)
      state.setMood(m, t)
      const after = at(t)
      worst = Math.max(worst, ...before.map((v, k) => Math.abs(v - after[k])))
    })
    expect(worst).toBeLessThan(1e-12)
  })

  it('a KEYED tail POSITION is interpolated too: live at 144 fps tracks exact', () => {
    // Compare the spring's SOLVED joint rotations, not the tip: the tip also carries the keyed
    // position itself, read at frame time in live mode and at step time in exact mode.
    const keyedPos = (r: Rig) => (t: number): void => {
      r.hip.position.set(0, 1, 0)
      r.tail[0].position.set(0.08 * Math.sin(2 * Math.PI * 1.5 * t), 0, -0.05)
    }
    const solved = (mode: 'exact' | 'live', fps: number): Map<number, Quaternion[]> => {
      const r = rig(false)
      const move = keyedPos(r)
      move(0)
      const rt = runtimeFor(r, driveBlock({ reflex: false }))
      const out = new Map<number, Quaternion[]>()
      for (let i = 1; i <= Math.round(2 * fps); i++) {
        const before = rt.probe().steps
        if (mode === 'exact') rt.advance(1 / fps, move)
        else {
          move(i / fps)
          rt.advance(1 / fps)
        }
        if (rt.probe().steps > before) out.set(rt.probe().steps, r.tail.map((b) => b.rotationQuaternion!.clone()))
      }
      return out
    }
    const exact = solved('exact', 60)
    const live = solved('live', 144)
    let worst = 0
    for (const [k, qs] of live) {
      const e = exact.get(k)
      if (e) qs.forEach((q, i) => (worst = Math.max(worst, angleBetween(q, e[i]))))
    }
    console.info('[springs] keyed position, live 144 vs exact (deg)', (worst * 180) / Math.PI)
    expect((worst * 180) / Math.PI).toBeLessThan(0.1) // measured 0.0076° with the lerp, 1.27° without
  })

  it('after a reset, the first 30 fps substeps interpolate from the pose the chain was reset ON', () => {
    const held = (r: Rig) => (): void => {
      r.hip.position.set(0, 1, 0)
      r.tail[0].position.set(0.1, 0.05, -0.05) // a clip holds the base off its bind position
    }
    const solve = (live: boolean): Quaternion[] => {
      const r = rig(false)
      const rt = runtimeFor(r, driveBlock({ reflex: false }))
      const hold = held(r)
      hold()
      rt.reset() // e.g. the first scheduled frame, or LOD re-entry
      if (live) {
        hold()
        rt.advance(1 / 30)
      } else rt.advance(1 / 30, hold)
      return r.tail.map((b) => b.rotationQuaternion!.clone())
    }
    const live = solve(true)
    const exact = solve(false)
    const worst = Math.max(...live.map((q, i) => angleBetween(q, exact[i])))
    // Measured: 2.4e-6° with the snapshot (float noise), 12.65° without it.
    expect((worst * 180) / Math.PI).toBeLessThan(1e-3)
  })

  it('a reset seeds each particle from its child’s CURRENT (keyed) offset, not the bind offset', () => {
    const r = rig(false)
    const rt = runtimeFor(r, driveBlock({ reflex: false }))
    r.tail[2].position.set(0.07, 0.03, -0.14) // a clip keys a NON-root chain bone (tail[2] is joint 1's child)
    rt.reset()
    tipInModel(r) // refresh world matrices
    const joints = (rt as unknown as { joints: { child: { node: TransformNode }; currentTail: Vector3 }[] }).joints
    const j1 = joints.find((j) => j.child.node === r.tail[2])!
    expect(Vector3.Distance(j1.currentTail, r.tail[2].getAbsolutePosition())).toBeLessThan(1e-6)
  })

  it('a keyed child offset that changes DIRECTION behaves like a bind built with it', () => {
    const OFFSET = new Vector3(0.07, 0, -0.07) // tail[2] swung 45° off its bind (0,0,-0.1)
    const run = (keyedAfterBuild: boolean): Quaternion[] => {
      const r = rig(false)
      if (!keyedAfterBuild) r.tail[2].position.copyFrom(OFFSET) // B: the bind itself carries the offset
      const rt = runtimeFor(r, driveBlock({ reflex: false }))
      const key = (): void => {
        if (keyedAfterBuild) r.tail[2].position.copyFrom(OFFSET) // A: a clip keys it after the build
      }
      key()
      rt.reset()
      for (let i = 0; i < 30; i++) {
        key()
        rt.advance(1 / 60)
      }
      return r.tail.map((b) => b.rotationQuaternion!.clone())
    }
    const keyed = run(true)
    const built = run(false)
    const worst = Math.max(...keyed.map((q, i) => angleBetween(q, built[i])))
    console.info('[springs] keyed vs built offset, 30 steps (deg)', (worst * 180) / Math.PI)
    expect((worst * 180) / Math.PI).toBeLessThan(1e-3)
  })

  it('a reset seats a driven tail on its CURRENT target, not its bind', () => {
    const r = rig(false)
    const rt = runtimeFor(r, driveBlock({ reflex: false }))
    rt.setMood('tuck')
    for (let i = 0; i < 60; i++) rt.advance(1 / 60) // past the 0.25 s cross-fade
    rt.reset()
    // tuck pitches the carriage down 85° over the proximal bones: the base is far from bind right after the reset
    expect(angleBetween(r.tail[0].rotationQuaternion!, Quaternion.Identity())).toBeGreaterThan((5 * Math.PI) / 180)
  })
})

function angleBetween(a: Quaternion, b: Quaternion): number {
  return 2 * Math.acos(Math.min(1, Math.abs(Quaternion.Dot(a, b))))
}

describe('parseSpringDrive', () => {
  it('reads a well-formed block', () => {
    const d = parseSpringDrive({ poqpoq: { drive: driveBlock() } }, BONES)!
    expect(d.mood).toBe('wag')
    expect(d.axes).toHaveLength(BONES)
    expect(d.dynamics.reflex.joints).toBe(3)
  })

  it('refuses, by name, what it cannot play — and the spring then plays passive', () => {
    const warnings: string[] = []
    expect(parseSpringDrive({ poqpoq: { drive: driveBlock({ moodSet: 'tail-moods@2' }) } }, BONES, (m) => warnings.push(m))).toBeNull()
    expect(parseSpringDrive({ poqpoq: { drive: driveBlock({ axes: [] }) } }, BONES, (m) => warnings.push(m))).toBeNull()
    expect(parseSpringDrive({ poqpoq: { drive: driveBlock({ moods: { ...MOODS, tuck: { gain: {} } } }) } }, BONES, (m) => warnings.push(m))).toBeNull()
    expect(warnings.join('\n')).toMatch(/moodSet "tail-moods@2"[\s\S]*axes \(need 6\)[\s\S]*mood "tuck"/)
    expect(parseSpringDrive({ poqpoq: {} }, BONES)).toBeNull() // no block: silent
    // A zero period would poison the target with NaN: refused, the spring plays passive.
    const zeroCycle = { ...MOODS, still: { ...MOODS.still, twitch: { ...MOODS.still.twitch!, cycleS: 0 } } }
    expect(parseSpringDrive({ poqpoq: { drive: driveBlock({ moods: zeroCycle }) } }, BONES)).toBeNull()
    // Negative or zero dynamics would poison the arithmetic (vCap / v with v = 0, a zero half-life): refused.
    for (const bad of [{ maxParticleSpeed: -1 }, { tightHalfLifeS: 0 }, { inertia: 1.5 }, { coneDeg: 0 }]) {
      const dyn = { ...(driveBlock().dynamics as Record<string, unknown>), ...bad }
      expect(parseSpringDrive({ poqpoq: { drive: driveBlock({ dynamics: dyn }) } }, BONES)).toBeNull()
    }
    // A non-positive top-level wag hz, or a zero-length axis, is refused.
    expect(parseSpringDrive({ poqpoq: { drive: driveBlock({ wag: { amplitudeDeg: 30, hz: 0, bias: 0 } }) } }, BONES)).toBeNull()
    const zeroAxis = Array.from({ length: BONES }, (_, k) => ({ yaw: k === 2 ? [0, 0, 0] : [0, 1, 0], pitch: [-1, 0, 0] }))
    expect(parseSpringDrive({ poqpoq: { drive: driveBlock({ axes: zeroAxis }) } }, BONES)).toBeNull()
    // A non-unit axis is normalised, not refused.
    const long = Array.from({ length: BONES }, () => ({ yaw: [0, 3, 0], pitch: [-2, 0, 0] }))
    expect(parseSpringDrive({ poqpoq: { drive: driveBlock({ axes: long }) } }, BONES)!.axes[0]).toEqual({ yaw: [0, 1, 0], pitch: [-1, 0, 0] })
    const pulsesPlusBadHz = { ...MOODS, still: { ...MOODS.still, twitch: { ...MOODS.still.twitch!, hz: 0 } } }
    expect(parseSpringDrive({ poqpoq: { drive: driveBlock({ moods: pulsesPlusBadHz }) } }, BONES)).toBeNull()
    const zeroHz = { ...MOODS, wag: { ...MOODS.wag, osc: { ...MOODS.wag.osc!, hz: 0 } } }
    expect(parseSpringDrive({ poqpoq: { drive: driveBlock({ moods: zeroHz }) } }, BONES)).toBeNull()
  })
})

describe('tail-moods@1', () => {
  it('wag swings the base at its hz; tuck pitches the carriage down over the proximal bones', () => {
    const wag = (t: number) => moodAngles(MOODS, 'wag', t, BONES, { amplitudeDeg: 30, hz: 1.4, bias: 0 })
    expect(wag(0.25 / 1.4).yaw[0]).toBeGreaterThan(0)
    expect(wag(0.75 / 1.4).yaw[0]).toBeLessThan(0)
    expect(wag(0.1).yaw[4]).toBe(0) // only the first 3 bones are driven; the spring carries the wave
    const tuck = moodAngles(MOODS, 'tuck', 0, BONES, { amplitudeDeg: 30, hz: 1.4, bias: 0 })
    const total = tuck.pitch.reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo((85 * Math.PI) / 180, 12)
    expect(tuck.pitch[0]).toBeGreaterThan(tuck.pitch[3])
  })
})

describe('rotation ownership', () => {
  it('a clip keying only a tail bone’s POSITION does not own its rotation; a rotation track does', () => {
    const engine = new NullEngine()
    engines.push(engine)
    const scene = new Scene(engine)
    const node = new TransformNode('Tail3', scene)
    node.rotationQuaternion = Quaternion.Identity()
    const pos = new Animation('p', 'position', 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE)
    pos.setKeys([{ frame: 0, value: Vector3.Zero() }, { frame: 30, value: new Vector3(0, 0.1, 0) }])
    scene.beginDirectAnimation(node, [pos], 0, 30, true)
    expect(rotationKeyed(scene, node)).toBe(false)
    const rot = new Animation('r', 'rotationQuaternion', 30, Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CYCLE)
    rot.setKeys([{ frame: 0, value: Quaternion.Identity() }, { frame: 30, value: Quaternion.RotationAxis(Vector3.Up(), 0.5) }])
    scene.beginDirectAnimation(node, [rot], 0, 30, true)
    expect(rotationKeyed(scene, node)).toBe(true)
  })
})
