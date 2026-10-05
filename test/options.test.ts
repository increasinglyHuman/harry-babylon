/**
 * attachHarryPhysics options on a synthetic avatar (no file): enable toggles, distance LOD bands
 * (and the far-rate dt reaching the jiggle reader), the off-screen hold, the crowd budget, and
 * the import-time absence of debug globals.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FreeCamera, Mesh, MeshBuilder, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import { MorphTarget } from '@babylonjs/core/Morph/morphTarget'
import { MorphTargetManager } from '@babylonjs/core/Morph/morphTargetManager'
import * as harry from '../src/index.js'
import { attachHarryPhysics, createHarryBudget, registerSpringBoneSource, type HarryPhysics } from '../src/index.js'

const FRAME_DT = 1 / 60

let engine: NullEngine | null = null
afterEach(() => {
  engine?.dispose()
  engine = null
  delete (globalThis as Record<string, unknown>).__tailMood
  delete (globalThis as Record<string, unknown>).__surfaceJiggle
})

function world() {
  engine = new NullEngine()
  const scene = new Scene(engine)
  ;(engine as unknown as { getDeltaTime(): number }).getDeltaTime = () => 1000 / 60
  const camera = new FreeCamera('cam', new Vector3(0, 1, 5), scene)
  camera.setTarget(new Vector3(0, 1, 0))
  scene.activeCamera = camera
  return { scene, camera }
}

/** One frame as the render loop runs it: animations, then the before-render observers (springs, then jiggle). */
function frame(scene: Scene): void {
  scene.incrementRenderId() // a new frame: cameras refresh their view matrix / frustum on next use
  scene.activeCamera?.computeWorldMatrix()
  for (const m of scene.meshes) m.computeWorldMatrix(true)
  scene.onBeforeAnimationsObservable.notifyObservers(scene)
  scene.onBeforeRenderObservable.notifyObservers(scene)
}

/** root → hip → Tail1..4, a box body mesh with one morph target; a 'tail' spring and a 'jiggle-Hair' surface spring. */
function avatar(scene: Scene, x = 0) {
  const root = new TransformNode('__root__', scene)
  root.position.set(x, 0, 0)
  const hip = new TransformNode('hip', scene)
  hip.parent = root
  hip.position.set(0, 1, 0)
  hip.rotationQuaternion = Quaternion.Identity()
  const tail: TransformNode[] = []
  let parent = hip
  for (let i = 0; i < 4; i++) {
    const n = new TransformNode(`Tail${i + 1}`, scene)
    n.parent = parent
    n.position.set(0, 0, -0.1)
    n.rotationQuaternion = Quaternion.Identity()
    tail.push(n)
    parent = n
  }
  const body = MeshBuilder.CreateBox('body', { size: 0.5 }, scene)
  body.parent = hip
  const manager = new MorphTargetManager(scene)
  manager.addTarget(new MorphTarget('surface.Hair.1'))
  ;(body as unknown as { morphTargetManager: MorphTargetManager }).morphTargetManager = manager
  const nodes = [root, hip, ...tail]
  const extension = {
    specVersion: '1.0',
    springs: [
      { name: 'tail', joints: [2, 3, 4, 5].map((node) => ({ node, stiffness: 0.5, gravityPower: 1, dragForce: 0.4 })) },
      {
        name: 'jiggle-Hair',
        joints: [{ node: 4 }, { node: 5 }],
        extras: {
          poqpoq: {
            surface: { version: 1, tip: 'Tail4', owner: 'hip', gain: 1, modes: [{ target: 'surface.Hair.1', freqHz: 5, zeta: 0.3, max: 1, participation: [1, 1, 1] }] },
          },
        },
      },
    ],
  }
  registerSpringBoneSource(root, { extension, nodes })
  return { root, hip, tail, body, manager, meshes: [body as Mesh] }
}

const weight = (m: MorphTargetManager): number => m.getTarget(0).influence

/** Swing the hip so the tail and the jiggle have something to react to. */
function wiggle(hip: TransformNode, i: number): void {
  hip.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), 0.6 * Math.sin(i * 0.4))
  hip.position.x = 0.2 * Math.sin(i * 0.3)
}

describe('import has no global side effects', () => {
  it('neither debug probe is on globalThis after importing the package', () => {
    expect(typeof harry.attachHarryPhysics).toBe('function')
    expect('__tailMood' in globalThis).toBe(false)
    expect('__surfaceJiggle' in globalThis).toBe(false)
  })

  it('options.debug installs both probes; installHarryDebugGlobals does the same explicitly', () => {
    const { scene } = world()
    const a = avatar(scene)
    attachHarryPhysics(a.root, scene, a.meshes, { debug: true })
    expect(typeof (globalThis as Record<string, unknown>).__tailMood).toBe('function')
    expect(typeof (globalThis as Record<string, unknown>).__surfaceJiggle).toBe('function')
    delete (globalThis as Record<string, unknown>).__tailMood
    delete (globalThis as Record<string, unknown>).__surfaceJiggle
    harry.installHarryDebugGlobals()
    expect('__tailMood' in globalThis && '__surfaceJiggle' in globalThis).toBe(true)
  })

  it('the legacy positional label still works', () => {
    const { scene } = world()
    const a = avatar(scene)
    const p = attachHarryPhysics(a.root, scene, a.meshes, 'legacy-label')
    expect(p.springs?.label).toBe('legacy-label')
  })
})

describe('enable toggles', () => {
  it('springs off: bones return to bind and stay there (no drift) while the body moves; on again resets', () => {
    const { scene } = world()
    const a = avatar(scene)
    const p = attachHarryPhysics(a.root, scene, a.meshes)
    for (let i = 0; i < 30; i++) {
      wiggle(a.hip, i)
      frame(scene)
    }
    expect(a.tail.some((t) => !t.rotationQuaternion!.equalsWithEpsilon(Quaternion.Identity(), 1e-6))).toBe(true)
    p.setSpringsEnabled(false)
    for (const t of a.tail) expect(t.rotationQuaternion!.equalsWithEpsilon(Quaternion.Identity(), 1e-12)).toBe(true)
    for (let i = 30; i < 60; i++) {
      wiggle(a.hip, i)
      frame(scene)
      expect(p.springs!.frameSignal().kind).toBe('held')
      for (const t of a.tail) expect(t.rotationQuaternion!.equalsWithEpsilon(Quaternion.Identity(), 1e-12)).toBe(true)
    }
    // Springs off also rests the jiggle (it runs in lockstep).
    expect(weight(a.manager)).toBe(0)
    p.setSpringsEnabled(true)
    frame(scene)
    expect(p.springs!.frameSignal().kind).toBe('reset')
    frame(scene)
    expect(p.springs!.frameSignal().kind).toBe('advanced')
  })

  it('jiggle off: weights go to 0 and stay there while the springs keep advancing; on again resumes', () => {
    const { scene } = world()
    const a = avatar(scene)
    const p = attachHarryPhysics(a.root, scene, a.meshes)
    expect(p.jiggle).not.toBeNull()
    for (let i = 0; i < 30; i++) {
      wiggle(a.hip, i)
      frame(scene)
    }
    expect(Math.abs(weight(a.manager))).toBeGreaterThan(0)
    p.setJiggleEnabled(false)
    expect(weight(a.manager)).toBe(0)
    for (let i = 30; i < 50; i++) {
      wiggle(a.hip, i)
      frame(scene)
      expect(p.springs!.frameSignal().kind).toBe('advanced')
      expect(weight(a.manager)).toBe(0)
    }
    p.setJiggleEnabled(true)
    for (let i = 50; i < 80; i++) {
      wiggle(a.hip, i)
      frame(scene)
    }
    expect(Math.abs(weight(a.manager))).toBeGreaterThan(0)
  })

  it('springs: false / jiggle: false at attach start disabled', () => {
    const { scene } = world()
    const a = avatar(scene)
    const p = attachHarryPhysics(a.root, scene, a.meshes, { springs: false, jiggle: false })
    frame(scene)
    expect(p.springs!.isEnabled).toBe(false)
    expect(p.jiggle!.isEnabled).toBe(false)
    expect(p.springs!.frameSignal().kind).toBe('held')
  })
})

describe('distance LOD', () => {
  it('no lod option: full rate at any distance', () => {
    const { scene, camera } = world()
    const a = avatar(scene)
    const p = attachHarryPhysics(a.root, scene, a.meshes)
    camera.position.set(0, 1, 500)
    frame(scene) // first frame resets
    for (let i = 0; i < 5; i++) {
      frame(scene)
      expect(p.springs!.frameSignal()).toEqual({ kind: 'advanced', dt: FRAME_DT })
    }
  })

  it('near: every frame; between near and far: farHz with the accumulated dt; beyond far: held; back near: reset', () => {
    const { scene, camera } = world()
    const a = avatar(scene)
    const p = attachHarryPhysics(a.root, scene, a.meshes, { lod: { near: 10, far: 30, farHz: 15 } })
    const signals = (n: number) => Array.from({ length: n }, () => (frame(scene), p.springs!.frameSignal()))

    camera.position.set(0, 1, 5)
    signals(1) // reset
    expect(signals(4).every((s) => s.kind === 'advanced' && Math.abs(s.dt - FRAME_DT) < 1e-12)).toBe(true)

    camera.position.set(0, 1, 20) // the reduced band: 15 Hz at 60 fps = every 4th frame
    const mid = signals(12)
    const advanced = mid.filter((s): s is { kind: 'advanced'; dt: number } => s.kind === 'advanced')
    expect(advanced.length).toBe(3)
    for (const s of advanced) expect(s.dt).toBeCloseTo(4 * FRAME_DT, 9)
    expect(mid.filter((s) => s.kind === 'held').length).toBe(9)

    expect(p.springs!.simulationState).toBe('reduced')

    camera.position.set(0, 1, 40)
    expect(signals(10).every((s) => s.kind === 'held')).toBe(true)
    expect(p.springs!.simulationState).toBe('held')

    camera.position.set(0, 1, 5)
    expect(signals(1)[0]!.kind).toBe('reset')
    expect(signals(1)[0]!.kind).toBe('advanced')
    expect(p.springs!.simulationState).toBe('full')
    p.setSpringsEnabled(false)
    signals(1)
    expect(p.springs!.simulationState).toBe('off')
  })

  it('the jiggle reader steps with the far-rate (accumulated) dt, never the raw frame dt', () => {
    const { scene, camera } = world()
    const a = avatar(scene)
    const p = attachHarryPhysics(a.root, scene, a.meshes, { lod: { near: 10, far: 30, farHz: 15 } })
    const stepRegion = vi.spyOn(p.jiggle as unknown as { stepRegion(r: unknown, dt: number): void }, 'stepRegion')
    camera.position.set(0, 1, 20)
    for (let i = 0; i < 16; i++) {
      wiggle(a.hip, i)
      frame(scene)
    }
    const dts = stepRegion.mock.calls.map((c) => c[1] as number)
    expect(dts.length).toBeGreaterThan(0)
    for (const dt of dts) expect(dt).toBeCloseTo(4 * FRAME_DT, 9)
  })

  it('lod.camera overrides the scene camera; setLod(null) turns LOD off', () => {
    const { scene, camera } = world()
    const far = new FreeCamera('far', new Vector3(0, 1, 100), scene)
    far.computeWorldMatrix()
    const a = avatar(scene)
    const p = attachHarryPhysics(a.root, scene, a.meshes, { lod: { near: 10, far: 30, camera: far } })
    camera.position.set(0, 1, 2)
    frame(scene)
    frame(scene)
    expect(p.springs!.frameSignal().kind).toBe('held')
    p.setLod(null)
    frame(scene)
    expect(p.springs!.frameSignal().kind).toBe('reset')
    frame(scene)
    expect(p.springs!.frameSignal().kind).toBe('advanced')
  })
})

describe('pauseOffscreen', () => {
  it('holds while every mesh is outside the frustum and resets when it comes back', () => {
    const { scene, camera } = world()
    const a = avatar(scene)
    const p = attachHarryPhysics(a.root, scene, a.meshes, { pauseOffscreen: true })
    frame(scene)
    frame(scene)
    expect(p.springs!.frameSignal().kind).toBe('advanced')
    camera.setTarget(new Vector3(0, 1, 50)) // look away
    frame(scene)
    expect(harry.isOffscreen(a.meshes, camera)).toBe(true)
    expect(p.springs!.frameSignal().kind).toBe('held')
    camera.setTarget(new Vector3(0, 1, 0))
    frame(scene)
    expect(p.springs!.frameSignal().kind).toBe('reset')
    frame(scene)
    expect(p.springs!.frameSignal().kind).toBe('advanced')
  })

  it('default (off): an off-screen avatar keeps simulating', () => {
    const { scene, camera } = world()
    const a = avatar(scene)
    const p = attachHarryPhysics(a.root, scene, a.meshes)
    camera.setTarget(new Vector3(0, 1, 50))
    frame(scene)
    frame(scene)
    expect(p.springs!.frameSignal().kind).toBe('advanced')
  })
})

describe('crowd budget', () => {
  it('only the nearest maxActive avatars simulate; re-ranking follows the camera', () => {
    const { scene, camera } = world()
    camera.position.set(0, 1, 5)
    const budget = createHarryBudget(scene, { maxActive: 2, everyNFrames: 30 })
    const crowd: HarryPhysics[] = []
    for (let i = 0; i < 5; i++) {
      const a = avatar(scene, i * 3) // x = 0, 3, 6, 9, 12
      crowd.push(attachHarryPhysics(a.root, scene, a.meshes, { budget, label: `a${i}` }))
    }
    camera.computeWorldMatrix()
    budget.rank()
    expect(budget.size).toBe(5)
    expect(budget.activeCount).toBe(2)
    frame(scene)
    frame(scene)
    const kinds = () => crowd.map((p) => p.springs!.frameSignal().kind)
    expect(kinds()).toEqual(['advanced', 'advanced', 'held', 'held', 'held'])
    expect(crowd.map((p) => p.springs!.simulationState)).toEqual(['full', 'full', 'held', 'held', 'held'])

    // Walk the camera to the other end; the next periodic ranking swaps the active set.
    camera.position.set(12, 1, 5)
    for (let i = 0; i < 30; i++) frame(scene)
    frame(scene)
    const k = kinds()
    expect(k[3]).toBe('advanced')
    expect(k[4]).toBe('advanced')
    expect(k.slice(0, 3).every((x) => x === 'held')).toBe(true)

    // Disposing an active avatar frees its slot.
    crowd[4]!.dispose()
    expect(budget.size).toBe(4)
    expect(budget.activeCount).toBe(2)
    budget.dispose()
  })
})
