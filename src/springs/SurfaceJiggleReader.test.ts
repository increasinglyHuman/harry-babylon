/**
 * SurfaceJiggleReader — the surface-jiggle reader, on a synthetic rig (no file):
 * the bind-frame isolation (owner's own motion must not leak into the kick),
 * the kick-then-step-same-frame ordering shared with Harry's preview, the
 * throw-detaches guardrail (a throw inside a Babylon frame observer freezes
 * the render loop), and
 * the tier-pause gate and the far-LOD lockstep with
 * DeclaredSpringBones — "one authority, not a second toggle".
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Mesh, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import { MorphTarget } from '@babylonjs/core/Morph/morphTarget'
import { MorphTargetManager } from '@babylonjs/core/Morph/morphTargetManager'
import { DeclaredSpringBones, type SpringFrameSignal } from './DeclaredSpringBones.js'
import { createModalOscillator } from './modalOscillator.js'
import { SurfaceJiggleReader, type SpringLockstep } from './SurfaceJiggleReader.js'

const FRAME_DT = 1000 / 60 / 1000 // the exact expression DeclaredSpringBones derives from getDeltaTime()

let engine: NullEngine | null = null
afterEach(() => {
  engine?.dispose()
  engine = null
  DeclaredSpringBones.globalPaused = false // a static flag — never leak it into the next test
})

/** A fake DeclaredSpringBones: the reader only ever needs `frameSignal()`. Defaults to 'advanced' every frame at FRAME_DT. */
function fakeLockstep(initial: SpringFrameSignal = { kind: 'advanced', dt: FRAME_DT }): SpringLockstep & { set(s: SpringFrameSignal): void } {
  let signal = initial
  return {
    frameSignal: () => signal,
    set: (s) => {
      signal = s
    },
  }
}

/** owner → tip, plus a mesh carrying the morph target(s) the declaration names. */
function rig(targetNames: string[]) {
  engine = new NullEngine()
  const scene = new Scene(engine)
  const root = new TransformNode('__root__', scene)
  const owner = new TransformNode('Head', scene)
  owner.parent = root
  owner.position.set(0, 1.5, 0)
  owner.rotationQuaternion = Quaternion.Identity()
  const tip = new TransformNode('HairJiggle', scene)
  tip.parent = owner
  tip.position.set(0, 0, -0.1)
  tip.rotationQuaternion = Quaternion.Identity()

  const mesh = new Mesh('face', scene)
  const manager = new MorphTargetManager(scene)
  for (const name of targetNames) manager.addTarget(new MorphTarget(name))
  ;(mesh as unknown as { morphTargetManager: MorphTargetManager }).morphTargetManager = manager

  return { scene, root, owner, tip, mesh, manager }
}

function surfaceExtras(overrides: Record<string, unknown> = {}): unknown {
  return {
    poqpoq: {
      surface: {
        version: 1,
        tip: 'HairJiggle',
        owner: 'Head',
        gain: 1,
        modes: [{ target: 'surface.Hair.1', freqHz: 5, zeta: 0.3, max: 1, participation: [0, 0, 1] }],
        ...overrides,
      },
    },
  }
}

function influenceOf(manager: MorphTargetManager, name: string): number {
  for (let i = 0; i < manager.numTargets; i++) {
    const t = manager.getTarget(i)
    if (t.name === name) return t.influence
  }
  throw new Error(`no target named ${name}`)
}

describe('SurfaceJiggleReader.attach', () => {
  it('missing extras.poqpoq.surface on every spring: null, and NO observer is registered (zero cost)', () => {
    const r = rig(['surface.Hair.1'])
    const before = r.scene.onBeforeRenderObservable.observers.length
    const reader = SurfaceJiggleReader.attach(r.root, r.scene, [r.mesh], [{ name: 'jiggle-Hair', extras: {} }], fakeLockstep(), 'test')
    expect(reader).toBeNull()
    expect(r.scene.onBeforeRenderObservable.observers.length).toBe(before)
  })

  it('no springs at all: null, no observer', () => {
    const r = rig(['surface.Hair.1'])
    const before = r.scene.onBeforeRenderObservable.observers.length
    expect(SurfaceJiggleReader.attach(r.root, r.scene, [r.mesh], [], fakeLockstep(), 'test')).toBeNull()
    expect(r.scene.onBeforeRenderObservable.observers.length).toBe(before)
  })

  it('a declared tip the loaded file does not have: null for that region, no crash', () => {
    const r = rig(['surface.Hair.1'])
    const reader = SurfaceJiggleReader.attach(r.root, r.scene, [r.mesh], [{ name: 'jiggle-Hair', extras: surfaceExtras({ tip: 'NoSuchNode' }) }], fakeLockstep(), 'test')
    expect(reader).toBeNull()
  })

  it('bind-frame isolation: the owner swinging on its own, with the tip rigidly attached (no local swing), kicks nothing', () => {
    const r = rig(['surface.Hair.1'])
    const reader = SurfaceJiggleReader.attach(r.root, r.scene, [r.mesh], [{ name: 'jiggle-Hair', extras: surfaceExtras() }], fakeLockstep(), 'test')!
    const onFrame = (reader as unknown as { onFrame(): void }).onFrame.bind(reader)
    onFrame() // first frame: seeds prevT, no kick possible yet
    for (let i = 0; i < 10; i++) {
      // The owner nods — tip never moves relative to it, so its bind-frame position is constant.
      r.owner.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), 0.1 * Math.sin(i))
      onFrame()
    }
    // Ten frames of matrix inversion carry the usual double-precision noise; the point of the
    // test is that it stays near machine epsilon, not exactly 0 bit-for-bit.
    expect(Math.abs(influenceOf(r.manager, 'surface.Hair.1'))).toBeLessThan(1e-6)
  })

  it('gain 0: the tip swings locally but no motion is ever kicked', () => {
    const r = rig(['surface.Hair.1'])
    const reader = SurfaceJiggleReader.attach(r.root, r.scene, [r.mesh], [{ name: 'jiggle-Hair', extras: surfaceExtras({ gain: 0 }) }], fakeLockstep(), 'test')!
    const onFrame = (reader as unknown as { onFrame(): void }).onFrame.bind(reader)
    const z = [-0.1, -0.08, -0.05, -0.09, -0.11]
    for (const zi of z) {
      r.tip.position.z = zi
      onFrame()
    }
    expect(influenceOf(r.manager, 'surface.Hair.1')).toBe(0)
  })

  it('a hand-computed tip swing matches an independently-driven oscillator (the reference ordering: kick THEN step, same frame)', () => {
    const r = rig(['surface.Hair.1'])
    const extras = surfaceExtras()
    const reader = SurfaceJiggleReader.attach(r.root, r.scene, [r.mesh], [{ name: 'jiggle-Hair', extras }], fakeLockstep(), 'test')!
    const onFrame = (reader as unknown as { onFrame(): void }).onFrame.bind(reader)

    // Reference oscillator, built from the SAME mode numbers, driven by hand from the SAME
    // tip-position script using plain arithmetic (no Babylon) — an independent cross-check
    // of SurfaceJiggleReader's node resolution, bind-frame math and frame sequencing.
    const ref = createModalOscillator([{ freqHz: 5, zeta: 0.3, max: 1 }])
    const dt = FRAME_DT
    const gain = 1
    const participationZ = 1
    // Owner is static here, so T (the tip's position in the owner's BIND frame) reduces to
    // the tip's own world z — exercising the kick/step pipeline without re-deriving the
    // (separately tested) bind-frame transform.
    const zPositions = [-0.1, -0.08, -0.05, -0.09]
    let prevT: number | null = null
    let prevV: number | null = null
    for (const z of zPositions) {
      r.tip.position.z = z
      const T = z // owner fixed at y=1.5, x=0 — only z varies, and participation is all-Z
      if (prevT !== null) {
        const vel = (T - prevT) / dt
        if (prevV !== null) {
          const dv = vel - prevV
          ref.kick(0, gain * dv * participationZ)
        }
        prevV = vel
      }
      prevT = T
      ref.step(dt)
      onFrame()
      // Checked after EVERY frame, not just the last: a kick-vs-step ordering bug would
      // show up as a one-frame lag, which a final-value-only check could miss. Babylon's
      // Matrix is Float32Array-backed, so the reader's path (two matrix transforms) carries
      // single-precision noise the plain-number reference does not — bound it, don't demand
      // bit-exactness.
      expect(Math.abs(influenceOf(r.manager, 'surface.Hair.1') - ref.weights()[0]!)).toBeLessThan(1e-7)
    }
  })

  it('a throwing model logs once, rests every weight it was driving, and detaches — never freezes the render loop', () => {
    const r = rig(['surface.Hair.1'])
    const reader = SurfaceJiggleReader.attach(r.root, r.scene, [r.mesh], [{ name: 'jiggle-Hair', extras: surfaceExtras() }], fakeLockstep(), 'test')!
    const onFrame = (reader as unknown as { onFrame(): void }).onFrame.bind(reader)
    // Drive real motion first, so there is a NONZERO weight on the mesh when it breaks —
    // the fix under test is that the error path rests it, not just freezes it mid-swing.
    onFrame()
    r.tip.position.z = -0.3
    onFrame()
    r.tip.position.z = -0.05
    onFrame()
    expect(influenceOf(r.manager, 'surface.Hair.1')).not.toBe(0)

    // Force the next step to throw, as if a corrupt model broke the math mid-frame.
    const internal = reader as unknown as { regions: Array<{ osc: { step(dt: number): void } }>; observer: unknown }
    expect(internal.observer).not.toBeNull() // attached
    internal.regions[0]!.osc.step = () => {
      throw new Error('synthetic failure')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => onFrame()).not.toThrow()
    expect(() => onFrame()).not.toThrow() // called again directly — must not warn or throw a second time
    expect(warn).toHaveBeenCalledTimes(1)
    // Babylon's Observable.remove() defers the array splice (setTimeout 0): the reliable,
    // synchronous signal that THIS code detached is its own observer handle going null.
    expect(internal.observer).toBeNull()
    expect(influenceOf(r.manager, 'surface.Hair.1')).toBe(0) // rested, not frozen mid-swing
    warn.mockRestore()
  })

  it('dispose() removes the observer and zeroes every morph weight it was driving', () => {
    const r = rig(['surface.Hair.1'])
    const reader = SurfaceJiggleReader.attach(r.root, r.scene, [r.mesh], [{ name: 'jiggle-Hair', extras: surfaceExtras() }], fakeLockstep(), 'test')!
    const onFrame = (reader as unknown as { onFrame(): void }).onFrame.bind(reader)
    onFrame()
    r.tip.position.z = -0.2
    onFrame()
    r.tip.position.z = 0
    onFrame()
    reader.dispose()
    expect((reader as unknown as { observer: unknown }).observer).toBeNull()
    expect(influenceOf(r.manager, 'surface.Hair.1')).toBe(0)
  })

  it('TIER GATE: DeclaredSpringBones.globalPaused settles every weight to rest ONCE and skips all per-frame work thereafter', () => {
    const r = rig(['surface.Hair.1'])
    const lockstep = fakeLockstep()
    const reader = SurfaceJiggleReader.attach(r.root, r.scene, [r.mesh], [{ name: 'jiggle-Hair', extras: surfaceExtras() }], lockstep, 'test')!
    const onFrame = (reader as unknown as { onFrame(): void }).onFrame.bind(reader)
    onFrame()
    r.tip.position.z = -0.3
    onFrame()
    r.tip.position.z = -0.05
    onFrame()
    expect(influenceOf(r.manager, 'surface.Hair.1')).not.toBe(0) // confirm it was actually jiggling

    DeclaredSpringBones.globalPaused = true
    onFrame() // the transition frame: settles to rest
    expect(influenceOf(r.manager, 'surface.Hair.1')).toBe(0)

    // The tip keeps "moving" (as if a clip were still playing under a paused tier) — must
    // never be read while paused: no kick accumulates, so unpausing never pops.
    r.tip.position.z = -0.9
    onFrame()
    r.tip.position.z = 0.4
    onFrame()
    expect(influenceOf(r.manager, 'surface.Hair.1')).toBe(0)

    DeclaredSpringBones.globalPaused = false
    onFrame() // resumes seeding prevT fresh — no spurious kick from the gap
    onFrame()
    expect(influenceOf(r.manager, 'surface.Hair.1')).toBe(0) // first frame back just reseeds prevT
  })

  it('LOD CADENCE: a static owner/tip produces no kick across held + advanced frames', () => {
    const r = rig(['surface.Hair.1'])
    const lockstep = fakeLockstep({ kind: 'advanced', dt: FRAME_DT })
    const reader = SurfaceJiggleReader.attach(r.root, r.scene, [r.mesh], [{ name: 'jiggle-Hair', extras: surfaceExtras() }], lockstep, 'test')!
    const onFrame = (reader as unknown as { onFrame(): void }).onFrame.bind(reader)
    // Nothing ever moves — the exact DeclaredSpringBones far-LOD cadence (2 held, 1 advanced).
    onFrame()
    lockstep.set({ kind: 'held' })
    onFrame()
    onFrame()
    lockstep.set({ kind: 'advanced', dt: FRAME_DT * 3 })
    onFrame()
    expect(influenceOf(r.manager, 'surface.Hair.1')).toBe(0)
  })

  it('LOD CADENCE: the kick uses the ACCUMULATED dt from the lockstep signal, not a per-frame delta', () => {
    const r = rig(['surface.Hair.1'])
    const lockstep = fakeLockstep({ kind: 'advanced', dt: FRAME_DT })
    const reader = SurfaceJiggleReader.attach(r.root, r.scene, [r.mesh], [{ name: 'jiggle-Hair', extras: surfaceExtras() }], lockstep, 'test')!
    const onFrame = (reader as unknown as { onFrame(): void }).onFrame.bind(reader)

    // Reference: the SAME two-sample sequence, but the reference's "frames" are advanced
    // calls ONLY — exactly mirroring what the reader should do when it honours the signal.
    const ref = createModalOscillator([{ freqHz: 5, zeta: 0.3, max: 1 }])
    const accumulatedDt = FRAME_DT * 3

    r.tip.position.z = -0.1 // frame 1: advanced, dt = FRAME_DT — seeds prevT only (no prevV yet)
    onFrame()
    ref.step(FRAME_DT)

    // Two held frames: DeclaredSpringBones would have accumulated their dt into pendingDt.
    // The reader must do NOTHING on these — not read position, not step, not kick.
    lockstep.set({ kind: 'held' })
    r.tip.position.z = -0.5 // moves while held — must be invisible to the reader
    onFrame()
    r.tip.position.z = -0.9 // moves again — still invisible
    onFrame()

    // The advance frame: dt is the FULL accumulated span, and the tip is read ONLY here.
    lockstep.set({ kind: 'advanced', dt: accumulatedDt })
    r.tip.position.z = -0.08
    onFrame()
    // vel = (T2 - T1) / accumulatedDt using the positions actually SEEN by the reader
    // (frame 1's -0.1 and this frame's -0.08) — the held frames' positions never counted.
    const vel = (-0.08 - -0.1) / accumulatedDt
    // Reference had no prevV yet either (its second sample), so still no kick — only step.
    ref.step(accumulatedDt)
    expect(Math.abs(influenceOf(r.manager, 'surface.Hair.1') - ref.weights()[0]!)).toBeLessThan(1e-7)

    // One more advance, with a NEW accumulated dt, produces the dv kick — verify it is
    // computed against accumulatedDt, i.e. a mutation dividing by FRAME_DT would be
    // roughly 3x too large and fail this bound.
    lockstep.set({ kind: 'held' })
    onFrame()
    onFrame()
    lockstep.set({ kind: 'advanced', dt: accumulatedDt })
    r.tip.position.z = -0.02
    onFrame()
    const vel2 = (-0.02 - -0.08) / accumulatedDt
    const dv = vel2 - vel
    ref.kick(0, 1 * dv * 1) // gain 1, participation z = 1
    ref.step(accumulatedDt)
    expect(Math.abs(influenceOf(r.manager, 'surface.Hair.1') - ref.weights()[0]!)).toBeLessThan(1e-7)
  })
})
