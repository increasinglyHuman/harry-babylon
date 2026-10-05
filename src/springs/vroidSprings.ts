/**
 * vroidSprings — the Babylon side of the VRoid synthesis: a VRoid body whose file declares no
 * springs but still NAMES its spring bones (`J_Sec_*`, `J_Opt_*`) gets the declaration VRoid
 * Studio would have written, with VRoid's own settings (vroidSpringSynthesis.ts), scheduled by
 * DeclaredSpringBones like any declared spring.
 *
 * Kept out of DeclaredSpringBones so the springs entry point does not carry the synthesis;
 * `attachHarryPhysics` uses it only once `registerVRoidSynthesis()` has been called (the main
 * `harry-babylon` entry does that for you).
 */

import { TransformNode, Vector3, type Scene } from '@babylonjs/core'
import { DeclaredSpringBones } from './DeclaredSpringBones.js'
import type { SpringBoneDeclaration } from './springBoneDeclaration.js'
import { synthesizeVRoidSprings, type RestSpace, type SynthNode, type VRoidSpringCategory } from './vroidSpringSynthesis.js'
import { setVRoidSynthesisHook } from '../vroidHook.js'

/** A Babylon node seen through the synthesis's Babylon-free interface. */
export interface BabylonSynthNode extends SynthNode {
  node: TransformNode
  children: BabylonSynthNode[]
}

/** The body's current pose as the synthesis's rest space (called at load, on the bind pose). */
export function restSpace(root: TransformNode): RestSpace<BabylonSynthNode> {
  root.computeWorldMatrix(true)
  for (const n of root.getDescendants(false)) if (n instanceof TransformNode) n.computeWorldMatrix(true)
  return {
    toWorld: (n, local) => {
      const v = Vector3.TransformCoordinates(new Vector3(local[0], local[1], local[2]), n.node.getWorldMatrix())
      return [v.x, v.y, v.z]
    },
    scaleOf: (n) => Math.cbrt(Math.abs(n.node.getWorldMatrix().determinant())),
  }
}

export function toSynthNode(node: TransformNode): BabylonSynthNode {
  const p = node.position
  return {
    node,
    name: node.name,
    position: [p.x, p.y, p.z],
    children: node.getChildren((c): c is TransformNode => c instanceof TransformNode, true).map((c) => toSynthNode(c as TransformNode)),
  }
}

export interface VRoidSprings {
  springs: DeclaredSpringBones
  counts: Record<VRoidSpringCategory, number>
  scale: number
  declaration: SpringBoneDeclaration
}

/**
 * A VRoid body whose file declares no springs but still NAMES its spring bones: the synthesized
 * declaration, running. Null when the body has no spring chain.
 */
export function springsFromVRoidNames(root: TransformNode, scene: Scene, label: string): VRoidSprings | null {
  const synth = synthesizeVRoidSprings(toSynthNode(root), restSpace(root))
  if (!synth) return null
  const warn = (m: string): void => console.warn(`[springs] ${label}: ${m}`)
  for (const w of synth.declaration.warnings) warn(w)
  const springs = DeclaredSpringBones.fromDeclaration(
    root,
    scene,
    label,
    synth.declaration,
    synth.nodes.map((n) => n.node),
  )
  return { springs, counts: synth.counts, scale: synth.scale, declaration: synth.declaration }
}

/**
 * The springs of any loaded body, in the one order every consumer uses: what the FILE declares
 * (VRMC_springBone) wins; a file that declares none but names VRoid spring bones gets the
 * synthesized declaration; otherwise none. A declaring file fails CLOSED (never falls back to
 * the name guess). Build it after the body's final transform is set and before any clip plays.
 */
export function springsForBody(
  root: TransformNode,
  scene: Scene,
  label: string,
): { springs: DeclaredSpringBones | null; source: 'declared' | 'vroid-names' | 'none' } {
  try {
    const declared = DeclaredSpringBones.fromLoad(root, scene, label)
    if (declared.declared) return { springs: declared.springs, source: 'declared' }
  } catch (e) {
    console.warn(`[springs] ${label}: VRMC_springBone declared but could not run (no springs play):`, e)
    return { springs: null, source: 'declared' }
  }
  const names = root.getChildTransformNodes(false).some((n) => /^J_(Sec|Opt)_/.test(n.name))
  if (!names) return { springs: null, source: 'none' }
  try {
    const vroid = springsFromVRoidNames(root, scene, label)
    return { springs: vroid?.springs ?? null, source: 'vroid-names' }
  } catch (e) {
    console.warn(`[springs] ${label}: VRoid spring synthesis failed (no springs play):`, e)
    return { springs: null, source: 'vroid-names' }
  }
}

/** Let `attachHarryPhysics` fall back to the VRoid synthesis. Idempotent. */
export function registerVRoidSynthesis(): void {
  setVRoidSynthesisHook(springsFromVRoidNames)
}
