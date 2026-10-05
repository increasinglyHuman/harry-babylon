/**
 * The tail ground plane (without it, tails pass through the floor and platforms).
 * A horizontal chain under strong gravity sags through y = 0 without the plane and rests on
 * it with the plane; the airborne hold keeps the last plane briefly, then drops it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import { SpringBoneRuntime } from './SpringBoneRuntime.js'
import type { SpringBoneDeclaration, SpringJointSettings } from './springBoneDeclaration.js'

let engine: NullEngine
let scene: Scene
beforeEach(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
})
afterEach(() => {
  scene.dispose()
  engine.dispose()
})

const HIT = 0.02

/** A 4-joint tail sticking out sideways from a hip `hipY` above the ground; heavy, soft. */
function tail(hipY = 0.2): { runtime: SpringBoneRuntime; nodes: TransformNode[] } {
  const hip = new TransformNode('Hip', scene)
  hip.position.set(0, hipY, 0)
  const nodes: TransformNode[] = [hip]
  let parent = hip
  for (let k = 0; k < 4; k++) {
    const n = new TransformNode(`Tail${k}`, scene)
    n.parent = parent
    n.position.set(k === 0 ? 0 : 0.15, 0, 0)
    nodes.push(n)
    parent = n
  }
  const settings: SpringJointSettings = { hitRadius: HIT, stiffness: 0.05, gravityPower: 3, gravityDir: [0, -1, 0], dragForce: 0.4 }
  const joints = [1, 2, 3, 4]
  const declaration: SpringBoneDeclaration = {
    specVersion: '1.0',
    colliders: [],
    springs: [{ name: 'tail', jointNodes: joints, segments: joints.slice(0, -1).map((node, i) => ({ node, child: joints[i + 1], settings })), colliders: [], center: null, extras: undefined }],
    warnings: [],
  }
  const runtime = new SpringBoneRuntime(declaration, nodes)
  runtime.reset()
  return { runtime, nodes }
}

const tipY = (nodes: TransformNode[]): number => {
  const tip = nodes[nodes.length - 1]
  tip.computeWorldMatrix(true)
  return tip.getAbsolutePosition().y
}

describe('SpringBoneRuntime ground plane', () => {
  it('without a plane, the heavy tail sags through the ground', () => {
    const { runtime, nodes } = tail()
    for (let i = 0; i < 180; i++) runtime.advance(1 / 60)
    expect(tipY(nodes)).toBeLessThan(-0.05)
    expect(runtime.probe().groundPushes).toBe(0)
  })

  it('with a plane at y = 0, it rests on the ground (within its hit radius)', () => {
    const { runtime, nodes } = tail()
    runtime.setGroundPlane({ point: new Vector3(0, 0, 0), normal: new Vector3(0, 1, 0) })
    for (let i = 0; i < 180; i++) runtime.advance(1 / 60)
    expect(tipY(nodes)).toBeGreaterThan(-0.005)
    expect(runtime.probe().groundPushes).toBeGreaterThan(0)
  })

  it('a tilted plane holds it along the slope normal; clearing the plane lets it fall again', () => {
    const { runtime, nodes } = tail()
    const n = new Vector3(0.3, 1, 0).normalize()
    runtime.setGroundPlane({ point: new Vector3(0, 0, 0), normal: n })
    for (let i = 0; i < 180; i++) runtime.advance(1 / 60)
    const tip = nodes[nodes.length - 1]
    tip.computeWorldMatrix(true)
    expect(Vector3.Dot(tip.getAbsolutePosition(), n)).toBeGreaterThan(-0.005)
    runtime.setGroundPlane(null)
    for (let i = 0; i < 180; i++) runtime.advance(1 / 60)
    expect(tipY(nodes)).toBeLessThan(-0.05)
  })

  it('a joint less than one bone length above the floor stays on it: no push-then-renormalise sink', () => {
    // Hip 0.05 m up, 0.15 m segments: the first joint's tail can only clear the floor by swinging
    // sideways, which a renormalise-after-push misses (it would land at y ≈ -0.10).
    const { runtime, nodes } = tail(0.05)
    runtime.setGroundPlane({ point: new Vector3(0, 0, 0), normal: new Vector3(0, 1, 0) })
    for (let i = 0; i < 180; i++) runtime.advance(1 / 60)
    for (const n of nodes.slice(1)) {
      n.computeWorldMatrix(true)
      expect(n.getAbsolutePosition().y).toBeGreaterThan(-0.005)
    }
  })
})
