/**
 * The optional VRoid synthesis door for `attachHarryPhysics`. Empty until
 * `registerVRoidSynthesis()` fills it, so a build that never imports the VRoid
 * module does not carry it.
 */
import type { Scene, TransformNode } from '@babylonjs/core'
import type { DeclaredSpringBones } from './springs/DeclaredSpringBones.js'
import type { SpringBoneDeclaration } from './springs/springBoneDeclaration.js'

export type VRoidSynthesisHook = (
  root: TransformNode,
  scene: Scene,
  label: string,
) => { springs: DeclaredSpringBones; declaration: SpringBoneDeclaration } | null

let hook: VRoidSynthesisHook | null = null

export function setVRoidSynthesisHook(h: VRoidSynthesisHook | null): void {
  hook = h
}

export function getVRoidSynthesisHook(): VRoidSynthesisHook | null {
  return hook
}
