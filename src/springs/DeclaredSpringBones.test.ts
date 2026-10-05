/**
 * DeclaredSpringBones — the scheduling wrapper, on a synthetic rig (no file):
 * a declaring file fails CLOSED, and the far LOD keeps the spring's solution
 * on show on the frames it skips.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { FreeCamera, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import { DeclaredSpringBones } from './DeclaredSpringBones.js'
import { registerSpringBoneSource } from './vrmcSpringBoneLoaderExtension.js'

let engine: NullEngine | null = null
afterEach(() => {
  engine?.dispose()
  engine = null
})

function rig() {
  engine = new NullEngine()
  const scene = new Scene(engine)
  ;(engine as unknown as { getDeltaTime(): number }).getDeltaTime = () => 1000 / 60
  const root = new TransformNode('__root__', scene)
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
  return { scene, root, tail, nodes: [root, hip, ...tail] }
}

const springs = {
  specVersion: '1.0',
  springs: [{ name: 'tail', joints: [2, 3, 4, 5].map((node) => ({ node, stiffness: 0.5, gravityPower: 1, dragForce: 0.4 })) }],
}

describe('DeclaredSpringBones.fromLoad', () => {
  it('no declaration: declared false (the caller may use the legacy J_Sec_ door)', () => {
    const r = rig()
    expect(DeclaredSpringBones.fromLoad(r.root, r.scene, 't')).toEqual({ springs: null, declared: false })
  })

  it('a declaration it cannot use still counts as DECLARED — the file fails closed, never into the J_Sec_ guess', () => {
    const r = rig()
    registerSpringBoneSource(r.root, { extension: { specVersion: '9.9', springs: [] }, nodes: r.nodes })
    expect(DeclaredSpringBones.fromLoad(r.root, r.scene, 't')).toEqual({ springs: null, declared: true })
  })
})

describe('DeclaredSpringBones far LOD', () => {
  it('on a frame the far LOD skips, a clip’s keyed rotation is replaced by the spring’s solution', () => {
    const r = rig()
    registerSpringBoneSource(r.root, { extension: springs, nodes: r.nodes })
    const { springs: s } = DeclaredSpringBones.fromLoad(r.root, r.scene, 't')
    const cam = new FreeCamera('cam', new Vector3(0, 1, 30), r.scene) // 30 m: every 3rd frame steps
    r.scene.activeCamera = cam
    cam.computeWorldMatrix() // globalPosition is the ORIGIN until computed — the render loop does this each frame
    expect(Vector3.Distance(cam.globalPosition, r.root.getAbsolutePosition())).toBeGreaterThan(20)
    const onFrame = (s as unknown as { onFrame(): void }).onFrame.bind(s)
    for (let i = 0; i < 12; i++) onFrame() // settle into the droop
    const clipValue = Quaternion.RotationAxis(Vector3.Right(), 1.2)
    let rawShown = 0
    for (let i = 0; i < 9; i++) {
      r.tail[0].rotationQuaternion!.copyFrom(clipValue) // a clip keys the tail base this frame
      onFrame()
      if (r.tail[0].rotationQuaternion!.equalsWithEpsilon(clipValue, 1e-9)) rawShown++
    }
    expect(rawShown).toBe(0)
    s!.dispose()
  })

  it('re-entering from beyond 50 m on a skipped frame resets onto the current pose, never holds the stale one', () => {
    const r = rig()
    registerSpringBoneSource(r.root, { extension: springs, nodes: r.nodes })
    const { springs: s } = DeclaredSpringBones.fromLoad(r.root, r.scene, 't')
    const cam = new FreeCamera('cam', new Vector3(0, 1, 5), r.scene)
    r.scene.activeCamera = cam
    cam.computeWorldMatrix()
    const onFrame = (s as unknown as { onFrame(): void; frame: number }).onFrame.bind(s)
    for (let i = 0; i < 30; i++) onFrame() // near: the tail droops into its solution
    const drooped = r.tail[0].rotationQuaternion!.clone()
    expect(drooped.equalsWithEpsilon(Quaternion.Identity(), 1e-6)).toBe(false)
    cam.position.set(0, 1, 80) // beyond 50 m: disabled
    cam.computeWorldMatrix()
    onFrame()
    r.root.position.x += 5 // the avatar walks off while disabled (a "teleport"-sized move)
    cam.position.x += 5
    cam.computeWorldMatrix()
    cam.position.set(0, 1, 30) // back to 20–50 m
    cam.computeWorldMatrix()
    // Line up the re-entry on a SKIPPED frame of the far LOD (frame % 3 !== 0 after the increment).
    while (((s as unknown as { frame: number }).frame + 1) % 3 === 0) onFrame()
    onFrame()
    // A reset puts the chain back on its bind rest in the current pose — not the pre-disable droop.
    expect(r.tail[0].rotationQuaternion!.equalsWithEpsilon(drooped, 1e-6)).toBe(false)
    // And the NEXT eligible far-LOD frame steps (no second, teleport-triggered reset) — even
    // though the avatar moved 5 m while it was disabled.
    const steps = s!.runtime.probe().steps
    for (let i = 0; i < 3; i++) onFrame()
    expect(s!.runtime.probe().steps).toBeGreaterThan(steps)
    s!.dispose()
  })
})

describe('DeclaredSpringBones camera choice', () => {
  it('measures LOD from the WORLD camera (activeCameras[0]), not the HUD camera left in activeCamera', () => {
    const r = rig()
    registerSpringBoneSource(r.root, { extension: springs, nodes: r.nodes })
    const { springs: s } = DeclaredSpringBones.fromLoad(r.root, r.scene, 't')
    const world = new FreeCamera('world', new Vector3(0, 1, 3), r.scene) // right next to the avatar
    const hud = new FreeCamera('hud', new Vector3(0, 1, 500), r.scene) // a HUD camera far off at its own origin
    world.computeWorldMatrix()
    hud.computeWorldMatrix()
    r.scene.activeCameras = [world, hud]
    r.scene.activeCamera = hud // what Babylon leaves between frames
    const onFrame = (s as unknown as { onFrame(): void }).onFrame.bind(s)
    for (let i = 0; i < 6; i++) onFrame()
    expect(s!.runtime.probe().steps).toBeGreaterThan(0) // not LOD-disabled by the HUD camera's 500 m
    s!.dispose()
  })
})

describe('DeclaredSpringBones disabled root', () => {
  it('a disabled root is not stepped, and re-enabling re-seats onto the current pose', () => {
    const r = rig()
    registerSpringBoneSource(r.root, { extension: springs, nodes: r.nodes })
    const { springs: s } = DeclaredSpringBones.fromLoad(r.root, r.scene, 't')
    const cam = new FreeCamera('cam', new Vector3(0, 1, 5), r.scene)
    r.scene.activeCamera = cam
    cam.computeWorldMatrix()
    const onFrame = (s as unknown as { onFrame(): void }).onFrame.bind(s)
    for (let i = 0; i < 30; i++) onFrame()
    const drooped = r.tail[0].rotationQuaternion!.clone()
    expect(drooped.equalsWithEpsilon(Quaternion.Identity(), 1e-6)).toBe(false)
    r.root.setEnabled(false) // e.g. a host hides a despawned body
    const steps = s!.runtime.probe().steps
    for (let i = 0; i < 20; i++) onFrame()
    expect(s!.runtime.probe().steps).toBe(steps)
    r.root.setEnabled(true)
    onFrame() // the first shown frame resets rather than integrating across the hidden gap
    expect(s!.runtime.probe().steps).toBe(steps)
    expect(r.tail[0].rotationQuaternion!.equalsWithEpsilon(drooped, 1e-6)).toBe(false)
    onFrame()
    expect(s!.runtime.probe().steps).toBeGreaterThan(steps)
    s!.dispose()
  })
})
